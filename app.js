/* Plow — live Plymouth, MN plow tracker (Long Exposure)
 * Static page. Data: City of Plymouth ArcGIS (PreCise AVL) via JSONP,
 * forecast: National Weather Service. No backend, no database. */
(function () {
'use strict';

var ARCGIS = 'https://plymap.plymouthmn.gov/webgis/rest/services/PreCiseAssets/MapServer';
var NWS_GRID = 'https://api.weather.gov/gridpoints/MPX/102,74';
var POLL_LIVE_MS = 5000;
var POLL_HIST_MS = 60000;
var POLL_WX_MS = 30 * 60 * 1000;
var TRAIL_WINDOW_MS = 2 * 3600 * 1000;
var SNOW_MM = 25; // ~1 inch of forecast snow in 24h wakes AUTO mode

var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/* ---------------- map ---------------- */
var map = L.map('map', { zoomControl: false });
map.attributionControl.setPrefix(false);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: '&copy; Esri, HERE, Garmin, OpenStreetMap contributors | City of Plymouth'
}).addTo(map);
map.setView([45.0105, -93.4553], 12);

var liveLayer = L.layerGroup().addTo(map);
var trailLayer = L.layerGroup().addTo(map);

function plowIcon() {
  return L.divIcon({ className: '', html: '<div class="plowdot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
}

/* ---------------- JSONP (city feed sends no CORS headers) ---------------- */
var cbSeq = 0;
function jsonp(url, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var name = '__plowcb' + (++cbSeq);
    var script = document.createElement('script');
    var done = false;
    var timer = setTimeout(function () { cleanup(); reject(new Error('timeout')); }, timeoutMs || 20000);
    function cleanup() {
      if (done) return; done = true;
      clearTimeout(timer);
      try { delete window[name]; } catch (e) { window[name] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[name] = function (data) { cleanup(); resolve(data); };
    script.onerror = function () { cleanup(); reject(new Error('load error')); };
    script.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'callback=' + name;
    document.body.appendChild(script);
  });
}
function arcgisQuery(layer, params) {
  var q = 'where=1%3D1&f=json&outSR=4326&returnGeometry=true';
  Object.keys(params).forEach(function (k) { q += '&' + k + '=' + encodeURIComponent(params[k]); });
  return jsonp(ARCGIS + '/' + layer + '/query?' + q);
}

/* ---------------- state ---------------- */
var mode = 'auto';            // on | auto | off
var snowComing = false;
var snowLabel = '';
var lastOk = 0;
var lastErr = '';
var plowCount = 0;
var miles2h = 0;
var roadTemp = null;
var liveTimer = null, histTimer = null, wxTimer = null;

var statusText = document.getElementById('statusText');
var wxText = document.getElementById('wxText');
var tempText = document.getElementById('tempText');
var ageText = document.getElementById('ageText');
var asleepEl = document.getElementById('asleep');
var mapEl = document.getElementById('map');
var toggleBtn = document.getElementById('toggle');
var toggleLabel = document.getElementById('toggleLabel');

/* ---------------- live plows ---------------- */
var vehicles = {}; // key -> {marker, lat, lng, tLat, tLng, lastSeen}

function featureLatLng(f) {
  var a = f.attributes || {};
  var g = f.geometry;
  if (g && g.y != null && g.x != null) return [g.y, g.x];
  if (a.Latitude != null && a.Longitude != null) return [a.Latitude, a.Longitude];
  return null;
}

function upsertLive(feats) {
  var now = Date.now();
  var seen = {};
  var temps = [];
  feats.forEach(function (f) {
    var a = f.attributes || {};
    var key = a.VehicleID != null ? 'v' + a.VehicleID : 'a' + a.AssetName;
    var ll = featureLatLng(f);
    if (!ll) return;
    seen[key] = true;
    if (a.RoadTemp != null && !isNaN(a.RoadTemp)) temps.push(a.RoadTemp);
    var v = vehicles[key];
    if (!v) {
      var marker = L.marker(ll, { icon: plowIcon(), interactive: false, keyboard: false }).addTo(liveLayer);
      v = vehicles[key] = { marker: marker, lat: ll[0], lng: ll[1], tLat: ll[0], tLng: ll[1], lastSeen: now };
    } else {
      v.tLat = ll[0]; v.tLng = ll[1]; v.lastSeen = now;
      if (reduceMotion) { v.lat = ll[0]; v.lng = ll[1]; v.marker.setLatLng(ll); }
    }
  });
  Object.keys(vehicles).forEach(function (k) {
    if (!seen[k] && now - vehicles[k].lastSeen > POLL_LIVE_MS * 3) {
      liveLayer.removeLayer(vehicles[k].marker);
      delete vehicles[k];
    }
  });
  plowCount = Object.keys(vehicles).length;
  roadTemp = temps.length ? Math.round(temps.reduce(function (x, y) { return x + y; }, 0) / temps.length) : null;
}

/* fluid motion: ease markers toward their latest polled position */
function glide() {
  if (!reduceMotion) {
    Object.keys(vehicles).forEach(function (k) {
      var v = vehicles[k];
      v.lat += (v.tLat - v.lat) * 0.12;
      v.lng += (v.tLng - v.lng) * 0.12;
      v.marker.setLatLng([v.lat, v.lng]);
    });
  }
  requestAnimationFrame(glide);
}

/* ---------------- 2-hour trails ---------------- */
function milesBetween(a, b) {
  var R = 3958.8;
  var dLa = (b[0] - a[0]) * Math.PI / 180, dLo = (b[1] - a[1]) * Math.PI / 180;
  var s = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
          Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) *
          Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.asin(Math.sqrt(s));
}

function renderHistory(feats) {
  trailLayer.clearLayers();
  var now = Date.now(), cutoff = now - TRAIL_WINDOW_MS, hourCut = now - 3600 * 1000;
  var byV = {};
  feats.forEach(function (f) {
    var a = f.attributes || {};
    var t = a.RecordDateTime;
    if (t == null || t < cutoff) return;
    var ll = featureLatLng(f);
    if (!ll) return;
    var key = a.VehicleID != null ? 'v' + a.VehicleID : 'a' + a.AssetName;
    (byV[key] = byV[key] || []).push({ t: t, p: ll });
  });
  var total = 0;
  Object.keys(byV).forEach(function (k) {
    var pts = byV[k].sort(function (x, y) { return x.t - y.t; });
    var oldPts = [], newPts = [];
    for (var i = 0; i < pts.length; i++) {
      (pts[i].t < hourCut ? oldPts : newPts).push(pts[i].p);
      if (i > 0) total += milesBetween(pts[i - 1].p, pts[i].p);
    }
    if (oldPts.length > 1) L.polyline(oldPts, { color: '#b26a00', weight: 2, opacity: 0.18, interactive: false }).addTo(trailLayer);
    if (newPts.length > 1) L.polyline(newPts, { color: '#b26a00', weight: 2, opacity: 0.5, interactive: false }).addTo(trailLayer);
  });
  miles2h = Math.round(total);
}

/* ---------------- polling ---------------- */
function pollLive(once) {
  return arcgisQuery(0, { outFields: 'AssetName,VehicleID,RecordDateTime,Speed,Heading,RoadTemp' })
    .then(function (d) {
      lastOk = Date.now(); lastErr = '';
      upsertLive(d.features || []);
      renderStatus();
    })
    .catch(function (e) {
      // In AUTO idle there is no repeat timer, so don't promise a retry.
      lastErr = once ? 'feed-idle' : 'feed';
      renderStatus();
    });
}
function pollHistory() {
  return arcgisQuery(2, {
      outFields: 'AssetName,VehicleID,RecordDateTime',
      orderByFields: 'RecordDateTime',
      resultRecordCount: '10000'
    })
    .then(function (d) { renderHistory(d.features || []); renderStatus(); })
    .catch(function () { /* trails are best-effort; live dots matter more */ });
}

function applyMode() {
  var want = mode === 'on' ? true : mode === 'off' ? false : snowComing;
  if (want && !liveTimer) {
    pollLive(); pollHistory();
    liveTimer = setInterval(pollLive, POLL_LIVE_MS);
    histTimer = setInterval(pollHistory, POLL_HIST_MS);
  } else if (!want && liveTimer) {
    clearInterval(liveTimer); clearInterval(histTimer);
    liveTimer = histTimer = null;
  }
  // AUTO with no snow never polls, so the page would sit on "Waking up…"
  // forever. Do a single poll so it can show the off-season state instead.
  if (mode === 'auto' && !snowComing && lastOk === 0 && !lastErr) pollLive(true);
  renderStatus();
}

/* ---------------- weather (NWS, free, no key) ---------------- */
function checkWeather() {
  fetch(NWS_GRID, { headers: { 'Accept': 'application/geo+json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var vals = (((d.properties || {}).snowfallAmount) || {}).values || [];
      var now = Date.now(), sum = 0;
      vals.forEach(function (v) {
        var start = Date.parse(String(v.validTime).split('/')[0]);
        if (start >= now - 3600 * 1000 && start < now + 24 * 3600 * 1000) sum += (v.value || 0);
      });
      snowComing = sum >= SNOW_MM;
      return fetch(NWS_GRID + '/forecast', { headers: { 'Accept': 'application/geo+json' } })
        .then(function (r) { return r.json(); })
        .then(function (fd) {
          var periods = ((fd.properties || {}).periods || []).slice(0, 4);
          var hit = null;
          for (var i = 0; i < periods.length; i++) {
            if (/snow/i.test(periods[i].detailedForecast || '')) { hit = periods[i]; break; }
          }
          snowLabel = hit ? 'Snow ' + String(hit.name).toLowerCase() : (snowComing ? 'Snow in forecast' : '');
        })
        .catch(function () { snowLabel = snowComing ? 'Snow in forecast' : ''; });
    })
    .catch(function () { snowComing = false; snowLabel = ''; })
    .then(function () { renderWx(); applyMode(); });
}

/* ---------------- UI ---------------- */
function renderStatus() {
  var asleep = plowCount === 0 && !lastErr && lastOk > 0;
  asleepEl.hidden = !asleep;
  if (asleep) mapEl.classList.add('dim'); else mapEl.classList.remove('dim');

  if (lastErr === 'feed-idle') {
    statusText.textContent = 'Can\u2019t reach the city\u2019s feed';
  } else if (lastErr) {
    statusText.textContent = 'Can\u2019t reach the city\u2019s feed \u2014 retrying';
  } else if (lastOk === 0) {
    statusText.textContent = 'Waking up\u2026';
  } else if (asleep) {
    statusText.innerHTML = '<span class="n">0</span> plows out <span class="sub">\u00B7 off-season</span>';
  } else {
    statusText.innerHTML = '<span class="n">' + plowCount + '</span> plow' + (plowCount === 1 ? '' : 's') + ' out ' +
      '<span class="sub">\u00B7 ' + miles2h + ' mi over the last 2 hrs</span>';
  }
  tempText.textContent = roadTemp != null ? 'road ' + roadTemp + '\u00B0F \u00B7 ' : '';
  renderWx();
}
function renderWx() {
  if (mode === 'auto' && snowComing && snowLabel) {
    wxText.textContent = snowLabel + ' \u00B7 auto-enabled';
  } else if (mode === 'auto' && !snowComing) {
    wxText.textContent = 'No snow in forecast';
  } else {
    wxText.textContent = snowLabel;
  }
}
function renderAge() {
  if (lastOk > 0 && liveTimer) {
    var s = Math.round((Date.now() - lastOk) / 1000);
    ageText.textContent = 'updated ' + s + 's ago';
  } else if (!liveTimer && lastOk > 0) {
    ageText.textContent = 'paused';
  } else {
    ageText.textContent = '';
  }
}

var order = ['on', 'auto', 'off'];
toggleBtn.addEventListener('click', function () {
  mode = order[(order.indexOf(mode) + 1) % order.length];
  toggleBtn.dataset.s = mode;
  toggleLabel.textContent = mode.toUpperCase();
  applyMode();
});

/* ---------------- boot ---------------- */
requestAnimationFrame(glide);
setInterval(renderAge, 1000);
checkWeather();
wxTimer = setInterval(checkWeather, POLL_WX_MS);
renderStatus();

})();
