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

var LIVE_MS = 5000;
var HIST_MS = 30000;
var WX_MS = 15 * 60 * 1000;
var MOVING_MS = 3 * 60 * 1000;    // a speed reading older than this isn't "moving"
var ACTIVE_MS = 20 * 60 * 1000;   // no report for this long = parked
var GAP_MS = 10 * 60 * 1000;      // break a trail across reporting gaps
var JUMP_MI = 0.6;                // ...and across GPS jumps
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

/* trail age buckets: one blue ramp, newest darkest (light) / brightest (dark) */
var BUCKETS = [
  { h: 1,  label: 'Under 1 hr', light: '#104281', dark: '#cde2fb', op: 0.95 },
  { h: 3,  label: '1–3 hrs',    light: '#2a78d6', dark: '#6da7ec', op: 0.85 },
  { h: 12, label: '3–12 hrs',   light: '#6da7ec', dark: '#2a78d6', op: 0.75 },
  { h: 24, label: '12–24 hrs',  light: '#86b6ef', dark: '#256abf', op: 0.65 }
];
var SALT = { light: '#eb6834', dark: '#d95926' };

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
L.control.zoom({ position: 'bottomright' }).addTo(map);
map.attributionControl.setPrefix(false);
map.setView([45.0205, -93.4553], 12);

var baseLayer = null, refLayer = null;
function setTiles() {
  var d = isDark() ? 'Dark' : 'Light';
  if (baseLayer) map.removeLayer(baseLayer);
  if (refLayer) map.removeLayer(refLayer);
  var u = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_' + d + '_Gray_';
  baseLayer = L.tileLayer(u + 'Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, maxNativeZoom: 16,
    attribution: '&copy; Esri, OpenStreetMap | Data: City of Plymouth, NWS'
  }).addTo(map);
  refLayer = L.tileLayer(u + 'Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, pane: 'overlayPane' }).addTo(map);
  refLayer.setZIndex(1);
}
setTiles();

var canvas = L.canvas({ padding: 0.5 });
var trailLayer = L.layerGroup().addTo(map);
var markerLayer = L.layerGroup().addTo(map);
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
function num(v) { return v == null || isNaN(v) ? null : +v; }
function spreading(a) { return (num(a.GranularSetting) || 0) > 0 || (num(a.PrewetSetting) || 0) > 0 || (num(a.DirectSetting) || 0) > 0; }
function isSnow(fleetName) { return !!SNOW_FLEETS[fleetName]; }
function inFilter(v) { return fleet === 'all' || isSnow(v.fleet); }
function fleetLabel(f) { return FLEET_LABEL[f] || f || 'Vehicle'; }
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
function compass(deg) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8]; }
function ago(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'just now';
  var m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  var h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return h + ' hr' + (r && h < 6 ? ' ' + r + ' min' : '') + ' ago';
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
function nameSort(a, b) {
  var x = parseInt(a.name, 10), y = parseInt(b.name, 10);
  if (!isNaN(x) && !isNaN(y) && x !== y) return x - y;
  return a.name.localeCompare(b.name);
}
function ensureVehicle(a) {
  var id = a.AssetID;
  var v = vehicles[id];
  if (!v) v = vehicles[id] = { id: id, name: '', fleet: '', t: 0, live: false, marker: null, miles: 0 };
  if (a.AssetName) v.name = String(a.AssetName).trim();
  if (a.FleetName) v.fleet = a.FleetName;
  return v;
}
function status(v, now) {
  if (!v.live || now - v.t > ACTIVE_MS) return 'parked';
  if ((v.speed || 0) > 0 && now - v.t < MOVING_MS) return 'moving';
  return 'stopped';
}

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
    renderMarkers(); renderSummary(); renderList(); renderLive();
  }).catch(function () {
    liveErr = true; renderLive(); renderNotice();
  });
}

/* ---------------- history (trails) ---------------- */
function fetchRange(from, to) {
  var where = 'RecordDateTime >= ' + sqlTime(from) + (to ? ' AND RecordDateTime < ' + sqlTime(to) : '');
  var got = 0;
  function page(n) {
    return query(HIST_LAYER, {
      where: where,
      outFields: 'OBJECTID,AssetID,AssetName,FleetName,RecordDateTime,Latitude,Longitude,GranularSetting,PrewetSetting,DirectSetting',
      orderByFields: 'RecordDateTime,OBJECTID',
      resultOffset: String(n * PAGE),
      resultRecordCount: String(PAGE)
    }).then(function (d) {
      var feats = d.features || [];
      got += ingest(feats);
      if (d.exceededTransferLimit && feats.length && n + 1 < MAX_PAGES) return page(n + 1);
      return got;
    });
  }
  return page(0);
}
function ingest(feats) {
  var touched = {}, n = 0;
  feats.forEach(function (f) {
    var a = f.attributes || {};
    if (seenIds[a.OBJECTID] || a.AssetID == null || a.Latitude == null || a.RecordDateTime == null) return;
    seenIds[a.OBJECTID] = true;
    var v = ensureVehicle(a);
    if (!v.live && a.RecordDateTime >= v.t) { v.t = a.RecordDateTime; v.lat = v.tLat = a.Latitude; v.lng = v.tLng = a.Longitude; }
    (tracks[a.AssetID] = tracks[a.AssetID] || []).push({ id: a.OBJECTID, t: a.RecordDateTime, lat: a.Latitude, lng: a.Longitude, s: spreading(a) });
    touched[a.AssetID] = true;
    if (a.RecordDateTime > histMax) histMax = a.RecordDateTime;
    n++;
  });
  Object.keys(touched).forEach(function (k) { tracks[k].sort(function (x, y) { return x.t - y.t; }); });
  return n;
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
  var now = Date.now(), want = now - win * 3600e3, jobs = [];
  histBusy = true;
  if (!loadedFrom) {
    jobs.push(fetchRange(want));
  } else {
    if (want < loadedFrom) jobs.push(fetchRange(want, loadedFrom));
    jobs.push(fetchRange(Math.max(histMax, now - 3600e3) - 60e3)); // small overlap; OBJECTID dedupes
  }
  var slow = setTimeout(function () { loadingEl.hidden = false; }, 400);
  return Promise.all(jobs).then(function () {
    loadedFrom = loadedFrom ? Math.min(loadedFrom, want) : want;
    prune();
  }).catch(function () { /* trails are best-effort; live dots matter more */ })
    .then(function () {
      clearTimeout(slow); loadingEl.hidden = true; histBusy = false;
      renderTrails(); renderSummary(); renderList(); renderNotice();
    });
}

function bucketOf(ageMs) {
  for (var i = 0; i < BUCKETS.length; i++) if (ageMs < BUCKETS[i].h * 3600e3) return i;
  return BUCKETS.length - 1;
}
function renderTrails() {
  trailLayer.clearLayers();
  var now = Date.now(), cut = now - win * 3600e3, dark = isDark();
  var byBucket = BUCKETS.map(function () { return []; });
  var salt = [], selLines = [], selSalt = [];
  Object.keys(tracks).forEach(function (k) {
    var v = vehicles[k], pts = tracks[k], total = 0;
    var mine = String(k) === String(selected);
    var draw = mine || !v || inFilter(v); // miles still count for filtered-out fleets
    var run = null, srun = null;
    function endRun() { if (draw && run && run.pts.length > 1) (mine ? selLines : byBucket[run.b]).push(run.pts); run = null; }
    function endSalt() { if (draw && srun && srun.length > 1) (mine ? selSalt : salt).push(srun); srun = null; }
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.t < cut) continue;
      var prev = i > 0 && pts[i - 1].t >= cut ? pts[i - 1] : null;
      if (!prev || p.t - prev.t > GAP_MS) { endRun(); endSalt(); continue; }
      var d = miles(prev, p);
      if (d > JUMP_MI) { endRun(); endSalt(); continue; }
      total += d;
      var b = bucketOf(now - p.t);
      if (!run || run.b !== b) { endRun(); run = { b: b, pts: [[prev.lat, prev.lng]] }; }
      run.pts.push([p.lat, p.lng]);
      if (p.s) { if (!srun) srun = [[prev.lat, prev.lng]]; srun.push([p.lat, p.lng]); }
      else endSalt();
    }
    endRun(); endSalt();
    if (v) v.miles = total;
  });
  var dim = selected != null;
  for (var b = BUCKETS.length - 1; b >= 0; b--) {
    if (byBucket[b].length) L.polyline(byBucket[b], {
      renderer: canvas, interactive: false, color: dark ? BUCKETS[b].dark : BUCKETS[b].light,
      weight: 3, opacity: BUCKETS[b].op * (dim ? 0.35 : 1), lineCap: 'round', lineJoin: 'round'
    }).addTo(trailLayer);
  }
  if (salt.length) L.polyline(salt, { renderer: canvas, interactive: false, color: dark ? SALT.dark : SALT.light, weight: 2, opacity: dim ? 0.35 : 0.95 }).addTo(trailLayer);
  if (selLines.length) {
    L.polyline(selLines, { renderer: canvas, interactive: false, color: dark ? '#ffffff' : '#0b0b0b', weight: 7, opacity: 0.25, lineCap: 'round', lineJoin: 'round' }).addTo(trailLayer);
    L.polyline(selLines, { renderer: canvas, interactive: false, color: dark ? BUCKETS[0].dark : BUCKETS[0].light, weight: 4, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(trailLayer);
  }
  if (selSalt.length) L.polyline(selSalt, { renderer: canvas, interactive: false, color: dark ? SALT.dark : SALT.light, weight: 2.5, opacity: 1 }).addTo(trailLayer);
  renderLegend();
}

/* ---------------- markers ---------------- */
function iconFor(v, st) {
  var cls = 'tk ' + st + (v.salting && st !== 'parked' ? ' salting' : '') + (String(v.id) === String(selected) ? ' sel' : '');
  var arrow = st === 'moving' && v.heading != null ? '<div class="arrow" style="transform:rotate(' + Math.round(v.heading) + 'deg)"></div>' : '';
  var sig = cls + '|' + (arrow ? Math.round(v.heading / 10) : '') + '|' + v.name;
  return { sig: sig, icon: L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14],
    html: '<div class="' + cls + '">' + arrow + '<div class="body"></div><div class="lab">' + esc(v.name) + '</div></div>' }) };
}
function renderMarkers() {
  var now = Date.now();
  Object.keys(vehicles).forEach(function (k) {
    var v = vehicles[k], st = status(v, now);
    var show = v.lat != null && inFilter(v) && (st !== 'parked' || String(k) === String(selected));
    if (!show) { if (v.marker) { markerLayer.removeLayer(v.marker); v.marker = null; } return; }
    var ic = iconFor(v, st);
    if (!v.marker) {
      v.marker = L.marker([v.lat, v.lng], { icon: ic.icon, keyboard: false, title: fleetLabel(v.fleet) + ' ' + v.name }).addTo(markerLayer);
      v.marker.on('click', function () { select(v.id, false); });
      v.sig = ic.sig;
    } else if (v.sig !== ic.sig) {
      v.marker.setIcon(ic.icon); v.sig = ic.sig;
    }
    if (st === 'moving') v.marker.setZIndexOffset(500); else v.marker.setZIndexOffset(0);
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

/* ---------------- panel ---------------- */
var $ = function (id) { return document.getElementById(id); };
var loadingEl = $('loading');

function renderLive() {
  var el = $('live'), txt = $('liveText');
  if (document.hidden) { el.className = 'live'; txt.textContent = 'Paused'; return; }
  if (liveErr) { el.className = 'live err'; txt.textContent = liveOk ? 'Feed unreachable · retrying' : 'Can’t reach the city feed · retrying'; return; }
  if (!liveOk) { el.className = 'live'; txt.textContent = 'Connecting…'; return; }
  el.className = 'live ok';
  var s = Math.round((Date.now() - liveOk) / 1000);
  txt.textContent = 'Live · updated ' + (s < 2 ? 'now' : s + 's ago');
}

function renderSummary() {
  var now = Date.now(), moving = 0, active = 0, salting = 0, mat = {}, temps = [], air = [], mi = 0;
  Object.keys(vehicles).forEach(function (k) {
    var v = vehicles[k];
    if (!isSnow(v.fleet)) return;
    mi += v.miles || 0;
    var st = status(v, now);
    if (st === 'parked') return;
    active++;
    if (st === 'moving') moving++;
    if (v.salting) { salting++; if (v.material) mat[v.material.toLowerCase()] = 1; }
    if (v.roadTemp != null) temps.push(v.roadTemp);
    if (v.airTemp != null) air.push(v.airTemp);
  });
  $('tMoving').textContent = liveOk ? moving : '–';
  $('tMovingLabel').textContent = moving === 1 ? 'truck moving' : 'trucks moving';
  $('tMovingSub').textContent = liveOk ? (active ? active + ' on the road' : 'none on the road') : '';
  $('tSalting').textContent = liveOk ? salting : '–';
  var m = Object.keys(mat);
  $('tSaltingSub').textContent = salting ? (m.length ? m.join(', ') : '') : (liveOk ? 'no spreaders running' : '');
  $('tMiles').textContent = loadedFrom ? (mi >= 100 ? Math.round(mi) : mi.toFixed(1)) : '–';
  $('tMilesLabel').textContent = 'miles in last ' + win + ' hr' + (win === 1 ? '' : 's');
  var avg = function (xs) { return Math.round(xs.reduce(function (x, y) { return x + y; }, 0) / xs.length); };
  if (temps.length) {
    $('tTemp').innerHTML = avg(temps) + '<small>°F</small>';
    $('tTempSub').textContent = (air.length ? 'air ' + avg(air) + '°F · ' : '') + temps.length + ' truck sensor' + (temps.length === 1 ? '' : 's');
  } else {
    $('tTemp').textContent = '–';
    $('tTempSub').textContent = 'no truck sensors reporting';
  }
}

function renderList() {
  var now = Date.now(), cut = now - win * 3600e3;
  var rows = Object.keys(vehicles).map(function (k) { return vehicles[k]; }).filter(function (v) {
    if (!inFilter(v) || !v.name) return false;
    return (v.live && now - v.t < ACTIVE_MS) || v.t >= cut || String(v.id) === String(selected);
  });
  var rank = { moving: 0, stopped: 1, parked: 2 };
  rows.sort(function (a, b) {
    var d = rank[status(a, now)] - rank[status(b, now)];
    return d || nameSort(a, b);
  });
  var ul = $('trucks');
  if (!rows.length) {
    ul.innerHTML = '<li class="empty">' + (liveOk || loadedFrom ? 'No ' + (fleet === 'snow' ? 'snow trucks' : 'city vehicles') + ' out in the last ' + win + ' hr' + (win === 1 ? '' : 's') + '.' : 'Loading…') + '</li>';
    return;
  }
  ul.innerHTML = rows.map(function (v) {
    var st = status(v, now), sub;
    if (st === 'moving') sub = 'Moving ' + Math.round(v.speed) + ' mph' + (v.heading != null ? ' ' + compass(v.heading) : '');
    else if (st === 'stopped') sub = 'Stopped · reported ' + ago(now - v.t);
    else sub = 'Parked · last seen ' + ago(now - v.t);
    var chip = v.salting && st !== 'parked' ? '<span class="chip">Salting</span>' : '';
    var mi = v.miles ? '<b>' + (v.miles >= 10 ? Math.round(v.miles) : v.miles.toFixed(1)) + '</b> mi' : '';
    return '<li' + (String(v.id) === String(selected) ? ' class="sel"' : '') + '><button data-id="' + esc(v.id) + '" aria-pressed="' + (String(v.id) === String(selected)) + '">' +
      '<span class="dot ' + st + '" aria-hidden="true"></span>' +
      '<span><span class="tn">' + esc(v.name) + '</span><span class="tf">' + esc(fleetLabel(v.fleet)) + '</span>' + chip +
      '<br><span class="tsub">' + sub + '</span></span>' +
      '<span class="tr">' + mi + '</span></button></li>';
  }).join('');
}

function renderNotice() {
  var el = $('notice'), msg = '', err = false;
  if (liveErr && !liveOk) { msg = 'Can’t reach the City of Plymouth’s vehicle feed right now. It will keep retrying.'; err = true; }
  else if (forecast && forecast.s48 === 0 && !anySaltInWindow()) {
    msg = 'No snow in the forecast. Trucks on the map are doing regular street work, not plowing.';
  }
  el.hidden = !msg; el.textContent = msg; el.className = 'notice' + (err ? ' err' : '');
}
function anySaltInWindow() {
  var cut = Date.now() - win * 3600e3;
  return Object.keys(tracks).some(function (k) {
    return tracks[k].some(function (p) { return p.s && p.t >= cut; });
  }) || Object.keys(vehicles).some(function (k) { return vehicles[k].salting && vehicles[k].live; });
}

function renderLegend() {
  var dark = isDark(), html = '<div class="lt">Trail age</div>';
  BUCKETS.forEach(function (b, i) {
    if (i > 0 && BUCKETS[i - 1].h >= win) return;
    html += '<div class="row"><span class="sw" style="background:' + (dark ? b.dark : b.light) + '"></span>' + b.label + '</div>';
  });
  html += '<div class="row"><span class="sw" style="background:' + (dark ? SALT.dark : SALT.light) + '"></span>Salting</div>';
  $('legend').innerHTML = html;
}

/* ---------------- selection & controls ---------------- */
function select(id, fly) {
  selected = selected != null && String(selected) === String(id) ? null : id;
  renderMarkers(); renderTrails(); renderList();
  var v = selected != null ? vehicles[selected] : null;
  if (!v) return;
  if (fly !== false && v.lat != null) map.flyTo([v.lat, v.lng], Math.max(map.getZoom(), 15), { animate: !reduceMotion, duration: 0.8 });
  if (fly === false) {
    var row = document.querySelector('.trucks li.sel');
    if (row && row.scrollIntoView && window.innerWidth > 760) row.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }
}
$('trucks').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-id]');
  if (b) select(b.getAttribute('data-id'), true);
});
map.on('click', function () { if (selected != null) select(selected); });

function pressed(group, attr, val) {
  document.querySelectorAll(group + ' button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute(attr) === String(val))); });
}
document.querySelectorAll('[data-fleet]').forEach(function (b) {
  b.addEventListener('click', function () {
    fleet = b.getAttribute('data-fleet'); store('fleet', fleet);
    pressed('.cardhead .seg', 'data-fleet', fleet);
    if (selected != null && vehicles[selected] && !inFilter(vehicles[selected])) selected = null;
    renderMarkers(); renderTrails(); renderList();
  });
});
document.querySelectorAll('[data-win]').forEach(function (b) {
  b.addEventListener('click', function () {
    win = +b.getAttribute('data-win'); store('win', win);
    pressed('.mapctl .seg', 'data-win', win);
    renderTrails(); renderSummary(); renderList(); renderNotice();
    if (Date.now() - win * 3600e3 < loadedFrom) pollHistory();
  });
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
  else map.setView([45.0205, -93.4553], 12);
});
pressed('.cardhead .seg', 'data-fleet', fleet);
pressed('.mapctl .seg', 'data-win', win);

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
function snowInches(values, fromMs, toMs) {
  var mm = 0;
  (values || []).forEach(function (v) {
    var parts = String(v.validTime).split('/');
    var s = Date.parse(parts[0]), e = s + isoDurMs(parts[1]);
    var overlap = Math.min(e, toMs) - Math.max(s, fromMs);
    if (overlap > 0 && e > s) mm += (v.value || 0) * overlap / (e - s);
  });
  return mm / 25.4;
}
function fmtIn(x) {
  if (x == null) return '–';
  if (x < 0.05) return x > 0.005 ? 'Trace' : '0 in';
  return (x < 10 ? x.toFixed(1) : Math.round(x)) + ' in';
}
function checkWeather() {
  nws(NWS_GRID).then(function (d) {
    var vals = ((d.properties || {}).snowfallAmount || {}).values || [];
    var now = Date.now();
    var s24 = snowInches(vals, now, now + 24 * 3600e3), s48 = snowInches(vals, now, now + 48 * 3600e3);
    forecast = { s24: s24 < 0.005 ? 0 : s24, s48: s48 < 0.005 ? 0 : s48 };
    $('snow24').textContent = fmtIn(forecast.s24);
    $('snow48').textContent = fmtIn(forecast.s48);
    renderNotice();
  }).catch(function () { $('snow24').textContent = $('snow48').textContent = 'n/a'; });

  nws(NWS_GRID + '/forecast').then(function (d) {
    var ps = ((d.properties || {}).periods || []).slice(0, 4);
    $('periods').innerHTML = ps.map(function (p) {
      var snowy = /snow|flurr|sleet|freezing|wintry|blizzard/i.test(p.shortForecast || '');
      var pop = p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value;
      return '<li><span class="pn">' + esc(p.name) + '</span><span class="pt">' + esc(p.temperature) + '°</span>' +
        '<span class="pf' + (snowy ? ' snowy' : '') + '">' + esc(p.shortForecast) + (pop ? ' · ' + pop + '%' : '') + '</span></li>';
    }).join('');
  }).catch(function () { $('periods').innerHTML = '<li><span class="pf">Forecast unavailable right now.</span></li>'; });

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
setInterval(function () { renderLive(); }, 1000);
setInterval(function () { if (!document.hidden) { renderTrails(); renderList(); } }, 60000); // age buckets drift
renderLegend(); renderSummary(); renderList();
if (!document.hidden) start(); else renderLive();
checkWeather();
setInterval(checkWeather, WX_MS);

})();
