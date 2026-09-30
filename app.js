/* Plow — live Plymouth, MN plow dashboard.
 * Static page. Vehicle data: City of Plymouth ArcGIS (PreCise AVL) via JSONP.
 * Forecast and alerts: National Weather Service. No backend, no database. */
(function () {
'use strict';

var FEED = 'https://plymap.plymouthmn.gov/webgis/rest/services/PreCiseAssets/MapServer';
var LIVE_LAYER = 5;   // Current Vehicle Location (every city vehicle reporting now)
var HIST_LAYER = 4;   // All Assets (~4 weeks of GPS breadcrumbs, queryable by time)
var NWS_GRID = 'https://api.weather.gov/gridpoints/MPX/102,74';
var NWS_ALERTS = 'https://api.weather.gov/alerts/active?point=45.0105,-93.4553';
var HOME = [45.0205, -93.4553];

var LIVE_MS = 5000;
var HIST_MS = 30000;
var WX_MS = 15 * 60 * 1000;
var MOVING_MS = 3 * 60 * 1000;    // a speed reading older than this isn't "moving"
var ACTIVE_MS = 20 * 60 * 1000;   // no report for this long = parked
var GAP_MS = 10 * 60 * 1000;      // break a trail across reporting gaps
var JUMP_MI = 0.6;                // ...and across GPS jumps
var SALT_DOT_MI = 0.08;           // spacing of salting dots along a trail
var MAX_HOURS = 24;
var PAGE = 5000, MAX_PAGES = 12;

var SNOW_FLEETS = { 'City of Plymouth Streets': 1, 'Streets Cul de sac': 1 };
var FLEET_LABEL = {
  'City of Plymouth Streets': 'Streets',
  'Streets Cul de sac': 'Cul-de-sac',
  'City of Plymouth Streets MISC': 'Streets misc',
  'Streets sweeping': 'Sweeper',
  'Utilities': 'Utilities'
};

/* trail age buckets: one blue ramp, newest strongest */
var BUCKETS = [
  { h: 1,  label: 'Recent (0–1h)', light: '#1a5fd0', dark: '#8fbdf7', w: 4,   op: 1 },
  { h: 3,  label: '1–3h',          light: '#5f9cf0', dark: '#4f93ec', w: 3.5, op: 0.9 },
  { h: 12, label: '3–12h',         light: '#97bff5', dark: '#2f6fc6', w: 3,   op: 0.85 },
  { h: 24, label: '12–24h',        light: '#c3daf9', dark: '#23508f', w: 3,   op: 0.85 }
];
var SALT = { light: '#f07c1b', dark: '#f28a30' };
var TRUCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M2 6.5A1.5 1.5 0 0 1 3.5 5h9A1.5 1.5 0 0 1 14 6.5V8h3.4a1.5 1.5 0 0 1 1.2.6l2.1 2.8a1.5 1.5 0 0 1 .3.9V15a1 1 0 0 1-1 1h-.6a2.5 2.5 0 0 0-4.8 0H9.4a2.5 2.5 0 0 0-4.8 0H3a1 1 0 0 1-1-1zM15 9.5V12h4.2l-1.6-2.1a1 1 0 0 0-.8-.4z"/><circle cx="7" cy="17" r="1.8" fill="#fff"/><circle cx="17" cy="17" r="1.8" fill="#fff"/></svg>';

var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
var darkMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function isDark() {
  var t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return !!(darkMQ && darkMQ.matches);
}
function store(k, v) {
  try { if (v === undefined) return localStorage.getItem('plow.' + k); localStorage.setItem('plow.' + k, v); } catch (e) {}
  return null;
}

/* ---------------- state ---------------- */
var win = +store('win') || 3;
if ([1, 3, 12, 24].indexOf(win) === -1) win = 3;
var fleet = store('fleet') === 'all' ? 'all' : 'snow';
var selected = null;

var vehicles = {};  // assetId -> live/last-known info + marker
var tracks = {};    // assetId -> [{id,t,lat,lng,s}] sorted by t
var seenIds = {};   // OBJECTID dedupe
var loadedFrom = 0; // earliest time we've fetched history from
var histMax = 0;    // newest history record time
var liveOk = 0, liveErr = false, histBusy = false;
var forecast = null; // {s24, s48}

/* ---------------- map ---------------- */
var map = L.map('map', { zoomControl: false, preferCanvas: true });
map.attributionControl.setPrefix(false);
map.setView(HOME, 12);

var baseLayer = null, refLayer = null;
function setTiles() {
  if (baseLayer) map.removeLayer(baseLayer);
  if (refLayer) { map.removeLayer(refLayer); refLayer = null; }
  var esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  var attr = '&copy; Esri, HERE, Garmin, OpenStreetMap contributors | Data: City of Plymouth, NWS';
  if (isDark()) {
    baseLayer = L.tileLayer(esri + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, attribution: attr }).addTo(map);
    refLayer = L.tileLayer(esri + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16 }).addTo(map);
  } else {
    baseLayer = L.tileLayer(esri + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: attr }).addTo(map);
  }
}
setTiles();

function zoomClass() { map.getContainer().classList.toggle('far', map.getZoom() < 14); }
map.on('zoomend', zoomClass);
zoomClass();

var canvas = L.canvas({ padding: 0.5 });
var trailLayer = L.layerGroup().addTo(map);
var markerLayer = L.layerGroup().addTo(map);
var meMarker = null;
setTimeout(function () { map.invalidateSize(); }, 100);

/* ---------------- JSONP (reliable regardless of the city's CORS config) ---------------- */
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
      window[name] = function () {}; // late responses land harmlessly
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[name] = function (data) {
      cleanup();
      if (data && data.error) reject(new Error(data.error.message || 'query error')); else resolve(data);
    };
    script.onerror = function () { cleanup(); reject(new Error('load error')); };
    script.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'callback=' + name;
    document.body.appendChild(script);
  });
}
function query(layer, params) {
  var q = 'f=json&returnGeometry=false';
  Object.keys(params).forEach(function (k) { q += '&' + k + '=' + encodeURIComponent(params[k]); });
  return jsonp(FEED + '/' + layer + '/query?' + q);
}
function sqlTime(ms) { // feed stores UTC
  return "timestamp '" + new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + "'";
}

/* ---------------- helpers ---------------- */
var $ = function (id) { return document.getElementById(id); };
function num(v) { return v == null || isNaN(v) ? null : +v; }
function spreading(a) { return (num(a.GranularSetting) || 0) > 0 || (num(a.PrewetSetting) || 0) > 0 || (num(a.DirectSetting) || 0) > 0; }
function isSnow(fleetName) { return !!SNOW_FLEETS[fleetName]; }
function inFilter(v, f) { return (f || fleet) === 'all' || isSnow(v.fleet); }
function fleetLabel(f) { return FLEET_LABEL[f] || f || 'Vehicle'; }
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
function same(a, b) { return a != null && b != null && String(a) === String(b); }
function midnight() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function shortName(v) { return v.name.split(/\s+/)[0] || v.name; }
function ago(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' sec ago';
  var m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  var h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return h + ' hr' + (r && h < 3 ? ' ' + r + ' min' : '') + ' ago';
  var d = Math.round(h / 24);
  return d + ' day' + (d === 1 ? '' : 's') + ' ago';
}
function miles(a, b) {
  var R = 3958.8, toR = Math.PI / 180;
  var dLa = (b.lat - a.lat) * toR, dLo = (b.lng - a.lng) * toR;
  var s = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
          Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.asin(Math.sqrt(s));
}
function fmtMi(x) { return x >= 100 ? String(Math.round(x)) : x.toFixed(1); }
function nameSort(a, b) {
  var x = parseInt(a.name, 10), y = parseInt(b.name, 10);
  if (!isNaN(x) && !isNaN(y) && x !== y) return x - y;
  return a.name.localeCompare(b.name);
}
function ensureVehicle(a) {
  var id = a.AssetID;
  var v = vehicles[id];
  if (!v) v = vehicles[id] = { id: id, name: '', fleet: '', t: 0, live: false, marker: null, miles: 0, today: 0 };
  if (a.AssetName) v.name = String(a.AssetName).trim();
  if (a.FleetName) v.fleet = a.FleetName;
  return v;
}
function status(v, now) {
  if (!v.live || now - v.t > ACTIVE_MS) return 'parked';
  if ((v.speed || 0) > 0 && now - v.t < MOVING_MS) return 'moving';
  return 'idle';
}
/* call fn(prev, p, dist) for every drawable leg at or after cut */
function eachLeg(pts, cut, fn, onBreak) {
  for (var i = 1; i < pts.length; i++) {
    var p = pts[i], prev = pts[i - 1];
    if (prev.t < cut) continue;
    var d = miles(prev, p);
    if (p.t - prev.t > GAP_MS || d > JUMP_MI) { if (onBreak) onBreak(); continue; }
    fn(prev, p, d);
  }
}
function milesSince(pts, cut) { var m = 0; eachLeg(pts, cut, function (a, b, d) { m += d; }); return m; }

/* ---------------- live positions ---------------- */
function pollLive() {
  return query(LIVE_LAYER, {
    where: '1=1',
    outFields: 'AssetID,AssetName,FleetName,RecordDateTime,Latitude,Longitude,Speed,Heading,' +
               'GranularSetting,PrewetSetting,DirectSetting,GranularMatName,RoadTemp,AirTemp'
  }).then(function (d) {
    liveOk = Date.now(); liveErr = false;
    var seen = {};
    (d.features || []).forEach(function (f) {
      var a = f.attributes || {};
      if (a.AssetID == null || a.Latitude == null || a.Longitude == null) return;
      var v = ensureVehicle(a);
      seen[v.id] = true;
      v.live = true;
      v.t = a.RecordDateTime || v.t;
      v.speed = num(a.Speed) || 0;
      v.heading = num(a.Heading);
      v.salting = spreading(a);
      v.material = a.GranularMatName || '';
      v.roadTemp = num(a.RoadTemp);
      v.airTemp = num(a.AirTemp);
      if (v.tLat == null || reduceMotion) { v.lat = a.Latitude; v.lng = a.Longitude; }
      v.tLat = a.Latitude; v.tLng = a.Longitude;
    });
    Object.keys(vehicles).forEach(function (k) { if (!seen[k]) vehicles[k].live = false; });
    renderMarkers(); renderSummary(); renderList(); renderLive(); renderNotice();
  }).catch(function () {
    liveErr = true; renderLive(); renderNotice();
  });
}

/* ---------------- history (trails) ---------------- */
function fetchRange(from, to) {
  var where = 'RecordDateTime >= ' + sqlTime(from) + (to ? ' AND RecordDateTime < ' + sqlTime(to) : '');
  function page(n) {
    return query(HIST_LAYER, {
      where: where,
      outFields: 'OBJECTID,AssetID,AssetName,FleetName,RecordDateTime,Latitude,Longitude,GranularSetting,PrewetSetting,DirectSetting',
      orderByFields: 'RecordDateTime,OBJECTID',
      resultOffset: String(n * PAGE),
      resultRecordCount: String(PAGE)
    }).then(function (d) {
      var feats = d.features || [];
      ingest(feats);
      if (d.exceededTransferLimit && feats.length && n + 1 < MAX_PAGES) return page(n + 1);
    });
  }
  return page(0);
}
function ingest(feats) {
  var touched = {};
  feats.forEach(function (f) {
    var a = f.attributes || {};
    if (seenIds[a.OBJECTID] || a.AssetID == null || a.Latitude == null || a.RecordDateTime == null) return;
    seenIds[a.OBJECTID] = true;
    var v = ensureVehicle(a);
    if (!v.live && a.RecordDateTime >= v.t) { v.t = a.RecordDateTime; v.lat = v.tLat = a.Latitude; v.lng = v.tLng = a.Longitude; }
    (tracks[a.AssetID] = tracks[a.AssetID] || []).push({ id: a.OBJECTID, t: a.RecordDateTime, lat: a.Latitude, lng: a.Longitude, s: spreading(a) });
    touched[a.AssetID] = true;
    if (a.RecordDateTime > histMax) histMax = a.RecordDateTime;
  });
  Object.keys(touched).forEach(function (k) { tracks[k].sort(function (x, y) { return x.t - y.t; }); });
}
function prune() {
  var cut = Date.now() - MAX_HOURS * 3600e3 - 5 * 60e3;
  Object.keys(tracks).forEach(function (k) {
    var pts = tracks[k], i = 0;
    while (i < pts.length && pts[i].t < cut) { delete seenIds[pts[i].id]; i++; }
    if (i) pts.splice(0, i);
  });
  if (loadedFrom < cut) loadedFrom = cut;
}
function pollHistory() {
  if (histBusy) return Promise.resolve();
  var now = Date.now(), want = Math.min(now - win * 3600e3, midnight()), jobs = [];
  histBusy = true;
  if (!loadedFrom) {
    jobs.push(fetchRange(want));
  } else {
    if (want < loadedFrom) jobs.push(fetchRange(want, loadedFrom));
    jobs.push(fetchRange(Math.max(histMax, now - 3600e3) - 60e3)); // small overlap; OBJECTID dedupes
  }
  var slow = setTimeout(function () { $('loading').hidden = false; }, 400);
  return Promise.all(jobs).then(function () {
    loadedFrom = loadedFrom ? Math.min(loadedFrom, want) : want;
    prune();
  }).catch(function () { /* trails are best-effort; live dots matter more */ })
    .then(function () {
      clearTimeout(slow); $('loading').hidden = true; histBusy = false;
      renderTrails(); renderSummary(); renderList(); renderNotice();
    });
}

function bucketOf(ageMs) {
  for (var i = 0; i < BUCKETS.length; i++) if (ageMs < BUCKETS[i].h * 3600e3) return i;
  return BUCKETS.length - 1;
}
function renderTrails() {
  trailLayer.clearLayers();
  var now = Date.now(), cut = now - win * 3600e3, today = midnight(), dark = isDark();
  var byBucket = BUCKETS.map(function () { return []; });
  var dots = [], selLines = [], selDots = [];
  Object.keys(tracks).forEach(function (k) {
    var v = vehicles[k], pts = tracks[k];
    if (v) v.today = milesSince(pts, today);
    var mine = same(k, selected);
    var draw = mine || !v || inFilter(v);
    var run = null, total = 0, sinceDot = Infinity;
    function endRun() { if (draw && run && run.pts.length > 1) (mine ? selLines : byBucket[run.b]).push(run.pts); run = null; }
    eachLeg(pts, cut, function (prev, p, d) {
      total += d;
      if (!draw) return;
      var b = bucketOf(now - p.t);
      if (!run || run.b !== b) { endRun(); run = { b: b, pts: [[prev.lat, prev.lng]] }; }
      run.pts.push([p.lat, p.lng]);
      sinceDot += d;
      if (p.s && sinceDot >= SALT_DOT_MI) { (mine ? selDots : dots).push([p.lat, p.lng]); sinceDot = 0; }
    }, endRun);
    endRun();
    if (v) v.miles = total;
  });
  var dim = selected != null ? 0.35 : 1;
  var line = function (pts, color, w, op) {
    L.polyline(pts, { renderer: canvas, interactive: false, color: color, weight: w, opacity: op, lineCap: 'round', lineJoin: 'round' }).addTo(trailLayer);
  };
  var dot = function (ll, op) {
    L.circleMarker(ll, { renderer: canvas, interactive: false, radius: 4.5, color: '#fff', weight: 1.5, fillColor: dark ? SALT.dark : SALT.light, fillOpacity: op, opacity: op }).addTo(trailLayer);
  };
  for (var b = BUCKETS.length - 1; b >= 0; b--) {
    if (byBucket[b].length) line(byBucket[b], dark ? BUCKETS[b].dark : BUCKETS[b].light, BUCKETS[b].w, BUCKETS[b].op * dim);
  }
  dots.forEach(function (ll) { dot(ll, dim); });
  if (selLines.length) {
    line(selLines, dark ? '#0b0d10' : '#ffffff', 9, 0.9);
    line(selLines, dark ? BUCKETS[0].dark : BUCKETS[0].light, 5, 1);
  }
  selDots.forEach(function (ll) { dot(ll, 1); });
  renderLegend(); renderChip();
}

/* ---------------- markers ---------------- */
function markerClass(v, st) {
  var c = 'tk ' + st;
  if (v.salting && st === 'moving') c += ' msalt';
  if (v.salting && st === 'idle') c += ' stsalt';
  if (same(v.id, selected)) c += ' sel';
  return c;
}
function renderMarkers() {
  var now = Date.now();
  Object.keys(vehicles).forEach(function (k) {
    var v = vehicles[k], st = status(v, now);
    var show = v.lat != null && inFilter(v) && (st !== 'parked' || same(k, selected));
    if (!show) { if (v.marker) { markerLayer.removeLayer(v.marker); v.marker = null; } return; }
    var cls = markerClass(v, st), sig = cls + '|' + v.name;
    if (!v.marker || v.sig !== sig) {
      var icon = L.divIcon({ className: '', iconSize: [32, 32], iconAnchor: [16, 16],
        html: '<div class="' + cls + '"><div class="body">' + TRUCK_SVG + '</div><div class="lab">' + esc(shortName(v)) + '</div></div>' });
      if (!v.marker) {
        v.marker = L.marker([v.lat, v.lng], { icon: icon, keyboard: false, title: fleetLabel(v.fleet) + ' ' + v.name }).addTo(markerLayer);
        v.marker.on('click', function () { select(v.id, false); });
      } else v.marker.setIcon(icon);
      v.sig = sig;
    }
    v.marker.setZIndexOffset(st === 'moving' ? 500 : 0);
  });
}
function glide() {
  if (!reduceMotion) {
    Object.keys(vehicles).forEach(function (k) {
      var v = vehicles[k];
      if (!v.marker || v.tLat == null) return;
      var dl = v.tLat - v.lat, dn = v.tLng - v.lng;
      if (Math.abs(dl) < 1e-7 && Math.abs(dn) < 1e-7) return;
      v.lat += dl * 0.12; v.lng += dn * 0.12;
      v.marker.setLatLng([v.lat, v.lng]);
    });
  }
  requestAnimationFrame(glide);
}

/* ---------------- motion: rolling digits, sliding toggles, row entrances ---------------- */
var listEnter = false;
function roll(el, text) {
  text = String(text);
  if (el.getAttribute('data-val') === text) return;
  el.setAttribute('data-val', text);
  if (reduceMotion) { el.textContent = text; return; }
  var shape = text.replace(/\d/g, '0');
  var fresh = el.getAttribute('data-shape') !== shape;
  if (fresh) {
    el.setAttribute('data-shape', shape);
    el.innerHTML = '<span class="sr"></span>' + text.split('').map(function (c) {
      if (!/\d/.test(c)) return '<span aria-hidden="true">' + esc(c) + '</span>';
      return '<span class="dg" aria-hidden="true"><span class="strip"><span>0</span><span>1</span><span>2</span><span>3</span><span>4</span>' +
        '<span>5</span><span>6</span><span>7</span><span>8</span><span>9</span></span></span>';
    }).join('');
    void el.offsetWidth; // start each strip at 0 so a new number rolls up
  }
  el.querySelector('.sr').textContent = text;
  var strips = el.querySelectorAll('.strip'), k = 0;
  text.split('').forEach(function (c) {
    if (/\d/.test(c)) strips[k++].style.transform = 'translateY(' + (-10 * +c) + '%)';
  });
}
function initSlider(group) {
  var ind = document.createElement('span');
  ind.className = 'slide'; ind.setAttribute('aria-hidden', 'true');
  group.insertBefore(ind, group.firstChild);
  group.classList.add('has-slide');
}
function moveSliders(instant) {
  document.querySelectorAll('.has-slide').forEach(function (g) {
    var b = g.querySelector('button[aria-pressed="true"]'), ind = g.querySelector('.slide');
    if (!b || !ind) return;
    if (instant || reduceMotion) ind.style.transition = 'none';
    ind.style.width = b.offsetWidth + 'px';
    ind.style.height = b.offsetHeight + 'px';
    ind.style.transform = 'translate(' + b.offsetLeft + 'px,' + b.offsetTop + 'px)';
    if (instant || reduceMotion) { void ind.offsetWidth; ind.style.transition = ''; }
  });
}
function enter(tbody) {
  if (reduceMotion || !tbody) return;
  tbody.classList.remove('enter'); void tbody.offsetWidth; tbody.classList.add('enter');
  clearTimeout(tbody._enterT);
  tbody._enterT = setTimeout(function () { tbody.classList.remove('enter'); }, 250);
}

/* ---------------- panel ---------------- */
function renderLive() {
  var el = $('status'), err = false, txt;
  if (document.hidden) txt = 'Paused';
  else if (liveErr) { txt = 'City feed not responding'; err = true; }
  else if (!liveOk) txt = 'Connecting…';
  else txt = 'Updated ' + new Date(liveOk).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.textContent = txt;
  el.className = 'status' + (err ? ' err' : '');
}

function listRows(f, now) {
  var cut = now - win * 3600e3;
  return Object.keys(vehicles).map(function (k) { return vehicles[k]; }).filter(function (v) {
    if (!inFilter(v, f) || !v.name) return false;
    return (v.live && now - v.t < ACTIVE_MS) || v.t >= cut || same(v.id, selected);
  });
}

function renderSummary() {
  var now = Date.now(), moving = 0, salting = 0, mat = {}, temps = [], today = 0, total = 0;
  Object.keys(vehicles).forEach(function (k) {
    var v = vehicles[k];
    if (!isSnow(v.fleet)) return;
    today += v.today || 0;
    var st = status(v, now);
    if (st !== 'parked' || v.t >= midnight()) total++;
    if (st === 'parked') return;
    if (st === 'moving') moving++;
    if (v.salting) { salting++; if (v.material) mat[v.material.toLowerCase()] = 1; }
    if (v.roadTemp != null) temps.push(v.roadTemp);
  });
  roll($('sMoving'), liveOk ? moving : '–');
  $('sMovingLabel').textContent = moving === 1 ? 'Truck moving' : 'Trucks moving';
  $('sMovingSub').textContent = liveOk ? 'of ' + total + ' today' : ' ';
  roll($('sSalting'), liveOk ? salting : '–');
  var m = Object.keys(mat);
  $('sSaltingSub').textContent = salting ? (m.length ? m.join(', ') : 'spreading') : (liveOk ? 'none now' : ' ');
  roll($('sMiles'), loadedFrom ? fmtMi(today) : '–');
  if (temps.length) {
    roll($('sTemp'), Math.round(temps.reduce(function (x, y) { return x + y; }, 0) / temps.length) + '°F');
    $('sTempSub').textContent = '(avg of ' + temps.length + ')';
  } else {
    roll($('sTemp'), '–');
    $('sTempSub').textContent = 'not reported';
  }
}

function statusCell(v, st) {
  if (st === 'moving') return '<span class="st moving">' + (v.salting ? 'Moving, salting' : 'Moving') + '</span>';
  if (st === 'idle') return v.salting ? '<span class="st stsalt">Salting, stopped</span>' : '<span class="st idle">Idle</span>';
  return '<span class="st parked">Parked</span>';
}
function renderList() {
  var now = Date.now();
  var rows = listRows(fleet, now);
  if (listEnter) { listEnter = false; enter($('trucks')); }
  $('cSnow').textContent = '(' + listRows('snow', now).length + ')';
  $('cAll').textContent = '(' + listRows('all', now).length + ')';
  moveSliders();
  var rank = { moving: 0, idle: 1, parked: 2 };
  rows.sort(function (a, b) { return rank[status(a, now)] - rank[status(b, now)] || nameSort(a, b); });
  var tb = $('trucks');
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty"><td colspan="5">' + (liveOk || loadedFrom ? 'No ' + (fleet === 'snow' ? 'snow trucks' : 'city vehicles') + ' out in the last ' + win + ' hr' + (win === 1 ? '' : 's') + '.' : 'Loading…') + '</td></tr>';
    return;
  }
  $('milesH').textContent = 'Miles (' + win + 'h)';
  tb.innerHTML = rows.map(function (v) {
    var st = status(v, now);
    return '<tr tabindex="0" data-id="' + esc(v.id) + '"' + (same(v.id, selected) ? ' class="sel" aria-selected="true"' : '') + ' title="' + esc(fleetLabel(v.fleet) + ' · ' + v.name) + '">' +
      '<td>' + esc(shortName(v)) + '</td>' +
      '<td>' + statusCell(v, st) + '</td>' +
      '<td class="num">' + (st === 'parked' ? '–' : (st === 'moving' ? Math.round(v.speed || 0) : 0) + ' mph') + '</td>' +
      '<td>' + ago(now - v.t) + '</td>' +
      '<td class="num">' + (v.miles || 0).toFixed(1) + '</td></tr>';
  }).join('');
}

function renderChip() {
  var now = Date.now(), cut = now - win * 3600e3, mi = 0, n = 0;
  Object.keys(vehicles).forEach(function (k) {
    var v = vehicles[k];
    if (!inFilter(v)) return;
    mi += v.miles || 0;
    if (v.miles > 0 || (v.live && status(v, now) !== 'parked')) n++;
  });
  $('chip').innerHTML = loadedFrom ? '<b>' + win + 'h activity</b> · ' + fmtMi(mi) + ' mi tracked · ' + n + ' vehicle' + (n === 1 ? '' : 's') : '';
}

function renderNotice() {
  var el = $('notice'), msg = '', err = false;
  if (liveErr && !liveOk) { msg = 'Can’t reach the City of Plymouth’s vehicle feed right now. It will keep retrying.'; err = true; }
  else if (forecast && forecast.s48 === 0 && !anySaltToday()) {
    msg = 'No snow in the forecast. Trucks out today are on regular street work, not plowing.';
  }
  el.hidden = !msg; el.textContent = msg; el.className = 'note' + (err ? ' err' : '');
}
function anySaltToday() {
  var cut = Date.now() - MAX_HOURS * 3600e3;
  return Object.keys(tracks).some(function (k) {
    return tracks[k].some(function (p) { return p.s && p.t >= cut; });
  }) || Object.keys(vehicles).some(function (k) { return vehicles[k].salting && vehicles[k].live; });
}

function renderLegend() {
  var dark = isDark(), html = '';
  BUCKETS.forEach(function (b, i) {
    if (i > 0 && BUCKETS[i - 1].h >= win) return;
    html += '<div class="row"><span class="sw" style="background:' + (dark ? b.dark : b.light) + '"></span>' + b.label + '</div>';
  });
  html += '<div class="row"><span class="dt"></span>Salting</div>';
  $('legend').innerHTML = html;
}

/* ---------------- selection & controls ---------------- */
function select(id, fly) {
  selected = same(selected, id) ? null : id;
  renderMarkers(); renderTrails(); renderList();
  var v = selected != null ? vehicles[selected] : null;
  if (!v) return;
  if (fly !== false && v.lat != null) map.flyTo([v.lat, v.lng], Math.max(map.getZoom(), 15), { animate: !reduceMotion, duration: 0.8 });
  if (fly === false) {
    var row = document.querySelector('#trucks tr.sel');
    if (row && row.scrollIntoView && window.innerWidth > 760) row.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }
}
$('trucks').addEventListener('click', function (e) {
  var r = e.target.closest('tr[data-id]');
  if (r) select(r.getAttribute('data-id'), true);
});
$('trucks').addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var r = e.target.closest('tr[data-id]');
  if (r) { e.preventDefault(); select(r.getAttribute('data-id'), true); }
});
map.on('click', function () { if (selected != null) select(selected); });

function pressed(sel, attr, val) {
  document.querySelectorAll(sel).forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute(attr) === String(val))); });
  moveSliders();
}
document.querySelectorAll('[data-fleet]').forEach(function (b) {
  b.addEventListener('click', function () {
    fleet = b.getAttribute('data-fleet'); store('fleet', fleet);
    pressed('[data-fleet]', 'data-fleet', fleet);
    if (selected != null && vehicles[selected] && !inFilter(vehicles[selected])) selected = null;
    listEnter = true;
    renderMarkers(); renderTrails(); renderList();
  });
});
document.querySelectorAll('[data-win]').forEach(function (b) {
  b.addEventListener('click', function () {
    win = +b.getAttribute('data-win'); store('win', win);
    pressed('[data-win]', 'data-win', win);
    listEnter = true;
    renderTrails(); renderList();
    if (Date.now() - win * 3600e3 < loadedFrom) pollHistory();
  });
});
$('zin').addEventListener('click', function () { map.zoomIn(); });
$('zout').addEventListener('click', function () { map.zoomOut(); });
$('locate').addEventListener('click', function () {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(function (pos) {
    var ll = [pos.coords.latitude, pos.coords.longitude];
    if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), keyboard: false, interactive: false }).addTo(map);
    else meMarker.setLatLng(ll);
    map.flyTo(ll, Math.max(map.getZoom(), 15), { animate: !reduceMotion });
  }, function () { $('locate').title = 'Location unavailable'; }, { enableHighAccuracy: true, timeout: 10000 });
});
$('fit').addEventListener('click', function () {
  var now = Date.now(), pts = [];
  Object.keys(vehicles).forEach(function (k) {
    var v = vehicles[k];
    if (v.lat != null && inFilter(v) && status(v, now) !== 'parked') pts.push([v.lat, v.lng]);
  });
  if (!pts.length) {
    var cut = now - win * 3600e3;
    Object.keys(tracks).forEach(function (k) {
      if (!vehicles[k] || !inFilter(vehicles[k])) return;
      tracks[k].forEach(function (p) { if (p.t >= cut) pts.push([p.lat, p.lng]); });
    });
  }
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15, animate: !reduceMotion });
  else map.setView(HOME, 12);
});
document.querySelectorAll('.seg, .tabs').forEach(initSlider);
pressed('[data-fleet]', 'data-fleet', fleet);
pressed('[data-win]', 'data-win', win);
moveSliders(true);
window.addEventListener('resize', function () { moveSliders(true); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { moveSliders(true); });

/* ---------------- weather (NWS, free, no key) ---------------- */
function nws(url) {
  return fetch(url, { headers: { 'Accept': 'application/geo+json' } }).then(function (r) {
    if (!r.ok) throw new Error('nws ' + r.status);
    return r.json();
  });
}
function isoDurMs(s) {
  var m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(s || '');
  if (!m) return 3600e3;
  return ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600e3 + (+m[3] || 0) * 60e3;
}
function spans(values) {
  return (values || []).map(function (v) {
    var parts = String(v.validTime).split('/'), s = Date.parse(parts[0]);
    return { s: s, e: s + isoDurMs(parts[1]), v: v.value };
  });
}
function sumOver(sp, from, to) { // accumulations (snow): prorate by overlap
  var t = 0;
  sp.forEach(function (x) {
    var o = Math.min(x.e, to) - Math.max(x.s, from);
    if (o > 0 && x.e > x.s) t += (x.v || 0) * o / (x.e - x.s);
  });
  return t;
}
function rangeOver(sp, from, to) { // instantaneous values (temp, wind): min/max
  var lo = Infinity, hi = -Infinity;
  sp.forEach(function (x) {
    if (x.v == null || x.e <= from || x.s >= to) return;
    lo = Math.min(lo, x.v); hi = Math.max(hi, x.v);
  });
  return lo === Infinity ? null : [lo, hi];
}
function modeDir(sp, from, to) {
  var c = {}, best = null;
  sp.forEach(function (x) {
    if (x.v == null || x.e <= from || x.s >= to) return;
    var d = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((x.v % 360) + 360) % 360 / 45) % 8];
    c[d] = (c[d] || 0) + Math.min(x.e, to) - Math.max(x.s, from);
    if (!best || c[d] > c[best]) best = d;
  });
  return best;
}
var cToF = function (c) { return c * 9 / 5 + 32; };
var kmhToMph = function (k) { return k / 1.609344; };
function fmtRange(r, conv, unit) {
  if (!r) return '–';
  var a = Math.round(conv(r[0])), b = Math.round(conv(r[1]));
  return (a === b ? a : a + '–' + b) + unit;
}
function fmtSnow(inches) {
  if (inches == null) return '–';
  if (inches < 0.05) return inches > 0.005 ? 'Trace' : '0"';
  return (inches < 10 ? inches.toFixed(1) : Math.round(inches)) + '"';
}
var WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
function wordNum(w) { return WORDS[String(w).toLowerCase()] || +w; }
function periodSnow(text) { // NWS writes e.g. "New snow accumulation of 1 to 3 inches possible."
  var t = text || '', m;
  if ((m = /accumulations? of (\w+) to (\w+) inch/i.exec(t))) return wordNum(m[1]) + '–' + wordNum(m[2]) + '"';
  if ((m = /accumulations? of less than (one|a half|half an?) inch/i.exec(t))) return /one/i.test(m[1]) ? '< 1"' : '< ½"';
  if ((m = /accumulations? of (?:around|about) (\w+) inch/i.exec(t))) return '~' + wordNum(m[1]) + '"';
  return null;
}
function checkWeather() {
  var gridP = nws(NWS_GRID).then(function (d) { return d.properties || {}; });
  var fcP = nws(NWS_GRID + '/forecast').then(function (d) { return (d.properties || {}).periods || []; });

  gridP.then(function (p) {
    var snow = spans((p.snowfallAmount || {}).values), temp = spans((p.temperature || {}).values);
    var wind = spans((p.windSpeed || {}).values), dir = spans((p.windDirection || {}).values);
    var now = Date.now();
    var row = function (label, hrs) {
      var to = now + hrs * 3600e3, s = sumOver(snow, now, to) / 25.4;
      var dd = modeDir(dir, now, to);
      return { s: s < 0.005 ? 0 : s, html: '<tr><td>' + label + '</td><td' + (s >= 0.05 ? ' class="snowy"' : '') + '>' + fmtSnow(s) + '</td><td>' +
        fmtRange(rangeOver(temp, now, to), cToF, '°') + '</td><td>' + (dd ? dd + ' ' : '') + fmtRange(rangeOver(wind, now, to), kmhToMph, ' mph') + '</td></tr>' };
    };
    var r24 = row('Next 24 hours', 24), r48 = row('Next 48 hours', 48);
    forecast = { s24: r24.s, s48: r48.s };
    $('fcTotals').innerHTML = r24.html + r48.html;
    enter($('fcTotals'));
    renderNotice();
    return fcP.then(function (periods) {
      $('fcPeriods').innerHTML = periods.slice(0, 4).map(function (per) {
        var s = Date.parse(per.startTime), e = Date.parse(per.endTime);
        var snowTxt = periodSnow(per.detailedForecast);
        if (!snowTxt) snowTxt = fmtSnow(sumOver(snow, s, e) / 25.4);
        var snowy = snowTxt !== '0"' || /snow|flurr|sleet|freezing|wintry|blizzard/i.test(per.shortForecast || '');
        var tr = rangeOver(temp, s, e);
        var wind = String(per.windSpeed || '').replace(/ to /, '–');
        return '<tr title="' + esc(per.shortForecast || '') + '"><td>' + esc(per.name) + '</td><td' + (snowy ? ' class="snowy"' : '') + '>' + esc(snowTxt) + '</td><td>' +
          (tr ? fmtRange(tr, cToF, '°') : esc(per.temperature) + '°') + '</td><td>' + esc(((per.windDirection || '') + ' ' + wind).trim()) + '</td></tr>';
      }).join('');
      enter($('fcPeriods'));
    });
  }).catch(function () {
    $('fcTotals').innerHTML = '<tr><td colspan="4" class="muted">Forecast unavailable right now.</td></tr>';
  });

  nws(NWS_ALERTS).then(function (d) {
    var seen = {};
    $('alerts').innerHTML = (d.features || []).map(function (f) { return f.properties || {}; }).filter(function (p) {
      if (seen[p.event]) return false; seen[p.event] = true; return true;
    }).map(function (p) {
      var until = p.ends || p.expires;
      return '<div class="alert" role="alert"><b>' + esc(p.event) + '</b>' +
        (until ? 'Until ' + esc(new Date(until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })) + '. ' : '') +
        '<a href="https://forecast.weather.gov/MapClick.php?lat=45.0105&amp;lon=-93.4553" target="_blank" rel="noopener">Details</a></div>';
    }).join('');
  }).catch(function () { /* alerts are optional */ });
}

/* ---------------- timers ---------------- */
var liveTimer = null, histTimer = null;
function start() {
  if (liveTimer) return;
  pollLive(); pollHistory();
  liveTimer = setInterval(pollLive, LIVE_MS);
  histTimer = setInterval(pollHistory, HIST_MS);
}
function stop() {
  clearInterval(liveTimer); clearInterval(histTimer);
  liveTimer = histTimer = null;
  renderLive();
}
document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
if (darkMQ && darkMQ.addEventListener) darkMQ.addEventListener('change', function () { setTiles(); renderTrails(); });

requestAnimationFrame(glide);
setInterval(function () { if (!document.hidden) { renderTrails(); renderList(); renderSummary(); } }, 60000); // ages drift
renderLegend(); renderSummary(); renderList();
if (!document.hidden) start(); else renderLive();
checkWeather();
setInterval(checkWeather, WX_MS);

})();
