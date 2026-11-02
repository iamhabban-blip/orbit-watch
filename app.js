'use strict';
/* Orbit Watch: client. Reads data/history.json (built by scripts/collect.py),
   classifies each aircraft, detects orbits / refuelling / emergencies and draws them. */

// ---------- Roles and classification ----------
const ROLES = {
  tanker:    {label: 'Tanker',     color: '#ffc53d', w: 50},
  isr:       {label: 'ISR / AEW',  color: '#c08cff', w: 50},
  bomber:    {label: 'Bomber',     color: '#ff5d5d', w: 45},
  uav:       {label: 'Drone',      color: '#ff7ac6', w: 40},
  vip:       {label: 'VIP / Gov',  color: '#3fe0d0', w: 30},
  fighter:   {label: 'Fighter',    color: '#ff8a3d', w: 25},
  transport: {label: 'Transport',  color: '#5cb8ff', w: 15},
  heli:      {label: 'Helicopter', color: '#8fd16a', w: 10},
  trainer:   {label: 'Trainer',    color: '#9aa7b3', w: 5},
  other:     {label: 'Other',      color: '#6f8796', w: 5},
};
const TYPES = {
  tanker: 'K35R K35E K35T KC46 K46 KC10 KC30 KC39',
  isr: 'E3TF E3CF E737 E7 R135 RC35 E6 P8 P1 P3 P3C E2 E2C E2D E8 U2 EP3 A50 S340 SB20 GLF5AEW',
  bomber: 'B52 B1 B2 B21 TU95 TU22 TU16 TU60 H6',
  uav: 'RQ4 Q4 MQ4 MQ9 Q9 HRON TB2 MQ1',
  fighter: 'F15 F16 F18 F18H F18S F22 F35 F5 EUFI TOR RFAL GRIF JAS39 A10 M2000 MIR2 SU27 SU30 SU35 MG29 J10 JF17 F14',
  heli: 'H60 H47 H64 H53 EC35 EC45 EC25 EC55 EC75 A139 A169 NH90 EH10 AS32 AS65 S92 S61 UH1 B412 LYNX WILD MI8 MI17 AS50 H160 B06',
  vip: 'GLF4 GLF5 GLF6 GLEX GL5T GL7T CL60 CL30 FA7X FA8X F900 F2TH LJ35 LJ45 C560 C680 C750 E35L E135',
  trainer: 'PC21 PC7 PC9 TEX2 T6 T38 T7 M346 HAWK L39 K8 DA40 DA42 SR22 G120 G115 TUCA SF26 PC6',
  transport: 'C17 C5 C5M C130 C30J A400 C295 CN35 C160 KC2 C2 IL76 AN12 AN26 AN32 C27J E390 C390 BE20 BE30 B350 DHC6 D228 C208 PC12 B737 B738 B752 B762 B763 B742 B744 B748 A319 A320 A321 A332 A333 A342 A343 A310 B712 E145 E190',
};
const TYPE_ROLE = {};
for (const [role, list] of Object.entries(TYPES)) for (const t of list.split(' ')) TYPE_ROLE[t] = role;
const CALLSIGN_ROLE = [
  [/^(SAM|EXEC)\d/, 'vip'], [/^(MMF|QID|PACK|TEAL|ARCO)\d/, 'tanker'], [/^(FORTE|LAGR)\d/, 'uav'],
  [/^(JAKE|HOMER|NATO|DUKE|SNTRY)\d/, 'isr'],
];

function classify(rec) {
  const t = (rec.t || '').toUpperCase(), c = (rec.c || '').toUpperCase();
  for (const [re, role] of CALLSIGN_ROLE) {
    if (re.test(c)) {
      // A tanker callsign on an airliner-type aircraft is a strong hint; an ISR callsign on a trainer is not.
      if (role === 'tanker' && !['A332', 'A333', 'K35R', 'KC46', 'K46', 'B762', 'A310', 'B763'].includes(t) && TYPE_ROLE[t]) break;
      return role;
    }
  }
  if (TYPE_ROLE[t]) return TYPE_ROLE[t];
  if (/^F\d/.test(t)) return 'fighter';
  if (rec.cat === 'A7') return 'heli';
  return 'other';
}

// ---------- Geometry ----------
const R_EARTH = 6371;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function distKm(a1, o1, a2, o2) {
  const p1 = rad(a1), p2 = rad(a2), dp = p2 - p1, dl = rad(o2 - o1);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a1, o1, a2, o2) {
  const p1 = rad(a1), p2 = rad(a2), dl = rad(o2 - o1);
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Sustained same-direction turning inside a small area = orbit / racetrack.
function detectOrbit(pts) {
  if (pts.length < 6) return null;
  const end = pts[pts.length - 1][0];
  const win = pts.filter(p => p[0] >= end - 90 * 60);
  if (win.length < 6) return null;
  let cum = 0, path = 0, prevB = null, prev = win[0];
  for (let i = 1; i < win.length; i++) {
    const p = win[i], d = distKm(prev[1], prev[2], p[1], p[2]);
    if (d < 0.4) continue;
    const b = bearing(prev[1], prev[2], p[1], p[2]);
    if (prevB !== null) cum += ((b - prevB + 540) % 360) - 180;
    prevB = b; path += d; prev = p;
  }
  const lat = win.reduce((s, p) => s + p[1], 0) / win.length, lon = win.reduce((s, p) => s + p[2], 0) / win.length;
  const radius = Math.max(...win.map(p => distKm(lat, lon, p[1], p[2])));
  if (Math.abs(cum) < 330 || radius > 90 || path < 2.2 * Math.max(radius, 3)) return null;
  let k = pts.length - 1;
  while (k > 0 && distKm(lat, lon, pts[k - 1][1], pts[k - 1][2]) <= radius * 1.25) k--;
  const alts = win.map(p => p[3]).filter(a => a != null).sort((a, b) => a - b);
  const alt = alts.length ? alts[Math.floor(alts.length / 2)] : null;
  const kind = alt != null && alt < 6000 && radius < 20 ? 'circuits' : 'orbit';
  return {kind, lat, lon, radius, minutes: Math.round((end - pts[k][0]) / 60), laps: Math.abs(cum) / 360, alt};
}

// ---------- State ----------
const state = {
  data: null, list: [], byHex: new Map(), roles: new Set(Object.keys(ROLES)), tab: 'flagged',
  search: '', onlyView: false, showGround: false, showLost: false, trails: 'flagged', sel: null,
  markers: new Map(), lines: L.layerGroup(), orbitRings: L.layerGroup(), firstFit: true,
};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const LOST_SEC = 30 * 60, STALE_SEC = 10 * 60;

const REGIONS = {
  global: [[-50, -150], [70, 170]], europe: [[35, -12], [63, 35]], blacksea: [[40, 26], [50, 42]],
  mideast: [[12, 30], [40, 62]], namerica: [[18, -128], [54, -64]], pacific: [[0, 100], [46, 150]],
};

// ---------- Analysis ----------
function analyse(data) {
  const now = data.generatedAt || Math.floor(Date.now() / 1000);
  const list = [];
  for (const [hex, rec] of Object.entries(data.aircraft || {})) {
    const pts = rec.pts || [];
    if (!pts.length) continue;
    const last = pts[pts.length - 1];
    const role = classify(rec);
    const age = Math.max(0, now - (rec.last || last[0]));
    const ground = rec.gnd || last[3] === 0;
    const a = {hex, rec, role, pts, lat: last[1], lon: last[2], alt: last[3], trk: last[4], gs: last[5],
      age, lost: age > LOST_SEC, ground, first: pts[0][0], flags: [], score: ROLES[role].w / 10,
      name: rec.c || rec.r || hex.toUpperCase()};
    const sq = String(rec.sq || '');
    if (rec.em || ['7500', '7600', '7700'].includes(sq)) {
      const what = {7500: 'hijack code', 7600: 'radio failure', 7700: 'general emergency'}[sq] || rec.em;
      a.flags.push({k: 'emergency', label: `Squawk ${sq || 'EMER'}`, text: `Emergency squawk ${sq}${what ? ` (${what})` : ''}. Often precautionary, but worth watching.`, s: 100});
    } else if (sq === '7400') {
      a.flags.push({k: 'emergency', label: 'Lost link', text: 'Squawking 7400: an uncrewed aircraft reporting lost control link.', s: 90});
    }
    if (!ground && age < STALE_SEC * 2) {
      const o = detectOrbit(pts);
      if (o && o.kind === 'orbit') {
        a.orbit = o;
        const hi = ['tanker', 'isr', 'uav'].includes(role);
        a.flags.push({k: 'orbit', label: `Orbiting ${fmtDur(o.minutes)}`,
          text: `Flying a racetrack or orbit about ${Math.round(o.radius)} km across${o.alt ? ` at ${fmtAlt(o.alt)}` : ''} for ${fmtDur(o.minutes)} (${o.laps.toFixed(1)} laps seen).${hi ? ' Typical of a tanker track or surveillance station.' : ''}`,
          s: hi ? 60 : 35});
      } else if (o && o.kind === 'circuits') {
        a.orbit = o;
        a.flags.push({k: 'circuits', label: 'Circuits', text: `Low, tight loops for ${fmtDur(o.minutes)}: most likely training circuits around an airfield.`, s: 8});
      }
    }
    list.push(a);
  }
  // Air-to-air refuelling: fresh tanker with receivers close by at similar altitude.
  const live = list.filter(a => !a.ground && a.age < STALE_SEC && a.alt != null);
  for (const t of live.filter(a => a.role === 'tanker')) {
    const rec = live.filter(b => b !== t && ['fighter', 'bomber', 'transport', 'isr', 'uav'].includes(b.role)
      && Math.abs(b.alt - t.alt) < 4000 && distKm(t.lat, t.lon, b.lat, b.lon) < 30);
    if (rec.length) {
      const names = rec.map(r => r.name).join(', ');
      t.flags.push({k: 'aar', label: 'Possible refuelling', text: `${rec.length} aircraft within 30 km at a similar altitude: ${names}. Looks like air-to-air refuelling.`, s: 80});
      for (const r of rec) r.flags.push({k: 'aar', label: 'Near tanker', text: `Close to tanker ${t.name} at a similar altitude. Possibly refuelling.`, s: 55});
    }
  }
  for (const a of list) {
    if (['bomber', 'isr', 'tanker', 'uav', 'vip'].includes(a.role) && !a.ground && !a.lost && !a.flags.length) {
      a.flags.push({k: 'type', label: 'High-interest type', text: `${ROLES[a.role].label} aircraft airborne.`, s: 20 + ROLES[a.role].w / 5});
    }
    a.score += a.flags.reduce((m, f) => Math.max(m, f.s), 0);
    a.flagged = a.flags.some(f => f.k !== 'circuits');
  }
  list.sort((x, y) => y.score - x.score || x.age - y.age);
  return list;
}

// ---------- Formatting ----------
function fmtDur(min) { if (min < 60) return `${min} min`; const h = Math.floor(min / 60); return `${h} h ${String(min % 60).padStart(2, '0')}`; }
function fmtAgo(sec) { if (sec < 90) return 'just now'; if (sec < 3600) return `${Math.round(sec / 60)} min ago`; return `${fmtDur(Math.round(sec / 60))} ago`; }
function fmtAlt(ft) { if (ft == null) return '–'; if (ft === 0) return 'Ground'; return ft >= 18000 ? `FL${Math.round(ft / 100)}` : `${ft.toLocaleString('en-US')} ft`; }
function fmtPos(lat, lon) { return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`; }
function fmtUTC(ts) { return new Date(ts * 1000).toISOString().slice(11, 16) + 'Z'; }

// ---------- Map ----------
const map = L.map('map', {zoomControl: true, worldCopyJump: true, minZoom: 2}).fitBounds(REGIONS.global);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd', maxZoom: 12,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · data: adsb.lol / adsb.fi / airplanes.live',
}).addTo(map);
state.orbitRings.addTo(map);
state.lines.addTo(map);

function planeSvg(color, trk) {
  return `<svg width="22" height="22" viewBox="-11 -11 22 22" style="transform:rotate(${trk || 0}deg)"><path d="M0-10 L2 -3 L9 2 L9 4 L2 2 L1.5 7 L4 9 L4 10 L0 9 L-4 10 L-4 9 L-1.5 7 L-2 2 L-9 4 L-9 2 L-2 -3 Z" fill="${color}" stroke="#04110b" stroke-width="1"/></svg>`;
}
function iconFor(a) {
  const cls = ['ac-icon', a.flagged ? 'flagged' : '', a.flags.some(f => f.k === 'emergency') ? 'emergency' : '', a.lost ? 'lost' : '', state.sel === a.hex ? 'sel' : ''].join(' ');
  return L.divIcon({className: cls, html: planeSvg(ROLES[a.role].color, a.trk), iconSize: [22, 22], iconAnchor: [11, 11]});
}

function visible(a) {
  if (!state.roles.has(a.role)) return false;
  if (a.lost && !state.showLost) return false;
  if (a.ground && !state.showGround) return false;
  if (state.search) {
    const q = state.search;
    if (![a.rec.c, a.rec.r, a.rec.t, a.hex, ROLES[a.role].label].some(v => (v || '').toLowerCase().includes(q))) return false;
  }
  return true;
}

function drawMap() {
  const seen = new Set();
  state.lines.clearLayers();
  state.orbitRings.clearLayers();
  for (const a of state.list) {
    if (!visible(a)) continue;
    seen.add(a.hex);
    let m = state.markers.get(a.hex);
    if (!m) {
      m = L.marker([a.lat, a.lon], {icon: iconFor(a), keyboard: true, title: a.name}).addTo(map);
      m.on('click', () => select(a.hex, false));
      m.bindTooltip('', {className: 'ac-label', direction: 'right', offset: [10, 0]});
      state.markers.set(a.hex, m);
    } else {
      m.setLatLng([a.lat, a.lon]);
      m.setIcon(iconFor(a));
    }
    m.setTooltipContent(`${esc(a.name)} · ${esc(a.rec.t || '?')}`);
    m.setZIndexOffset(a.flagged ? 1000 : 0);
    const showTrail = state.sel === a.hex || state.trails === 'all' || (state.trails === 'flagged' && a.flagged);
    if (showTrail && a.pts.length > 1) {
      const isSel = state.sel === a.hex;
      L.polyline(a.pts.map(p => [p[1], p[2]]), {color: ROLES[a.role].color, weight: isSel ? 2.5 : 1.4, opacity: isSel ? .95 : .45, interactive: false}).addTo(state.lines);
    }
    if (a.orbit && a.orbit.kind === 'orbit') {
      L.circle([a.orbit.lat, a.orbit.lon], {radius: a.orbit.radius * 1000, color: '#ffc53d', weight: 1, dashArray: '4 6', fill: false, interactive: false}).addTo(state.orbitRings);
    }
  }
  for (const [hex, m] of state.markers) if (!seen.has(hex)) { map.removeLayer(m); state.markers.delete(hex); }
}

// ---------- Sidebar ----------
function renderStats() {
  const air = state.list.filter(a => !a.lost && !a.ground);
  const flagged = air.filter(a => a.flagged).length;
  const emerg = state.list.filter(a => a.flags.some(f => f.k === 'emergency') && !a.lost).length;
  const orbit = air.filter(a => a.orbit && a.orbit.kind === 'orbit').length;
  $('stats').innerHTML = `
    <div class="stat green"><b>${air.length}</b><span>Airborne</span></div>
    <div class="stat amber"><b>${flagged}</b><span>Flagged</span></div>
    <div class="stat amber"><b>${orbit}</b><span>Orbiting</span></div>
    <div class="stat ${emerg ? 'alert' : ''}"><b>${emerg}</b><span>Emergency</span></div>`;
  const counts = {};
  for (const a of state.list) if (!a.lost) counts[a.role] = (counts[a.role] || 0) + 1;
  $('roles').innerHTML = Object.entries(ROLES).map(([k, r]) =>
    `<button type="button" class="role" style="--c:${r.color}" data-role="${k}" aria-pressed="${state.roles.has(k)}"><i></i>${r.label} <span class="ct">${counts[k] || 0}</span></button>`).join('');
  $('legend').innerHTML = Object.entries(ROLES).filter(([k]) => counts[k]).map(([, r]) => `<span style="--c:${r.color}"><i></i>${r.label}</span>`).join('');
}

function renderList() {
  const bounds = map.getBounds();
  const all = state.list.filter(a => visible(a) && (!state.onlyView || bounds.contains([a.lat, a.lon])));
  const flagged = all.filter(a => a.flagged);
  $('n-flagged').textContent = flagged.length;
  $('n-all').textContent = all.length;
  const rows = (state.tab === 'flagged' ? flagged : all).slice(0, 300);
  if (!rows.length) {
    $('list').innerHTML = `<li class="empty">${state.tab === 'flagged' ? 'Nothing flagged with the current filters. Quiet skies, or try another region.' : 'No aircraft match these filters.'}</li>`;
    return;
  }
  $('list').innerHTML = rows.map(a => `
    <li class="item${a.lost ? ' lost' : ''}${state.sel === a.hex ? ' sel' : ''}" data-hex="${esc(a.hex)}" tabindex="0" style="--c:${ROLES[a.role].color}">
      <span class="bar-c"></span>
      <div style="min-width:0">
        <div class="top"><span class="cs">${esc(a.name)}</span><span class="ty">${esc(a.rec.t || 'Unknown type')} · ${ROLES[a.role].label}</span></div>
        ${a.flags.length ? `<div class="flags">${a.flags.map(f => `<span class="flag ${f.k}">${esc(f.label)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="right"><b>${fmtAlt(a.alt)}</b>${fmtAgo(a.age)}</div>
    </li>`).join('');
}

function renderDetail() {
  const el = $('detail');
  const a = state.byHex.get(state.sel);
  if (!a) { el.hidden = true; return; }
  const r = ROLES[a.role];
  const alts = a.pts.map(p => p[3]).filter(v => v != null);
  let spark = '';
  if (alts.length > 1) {
    const max = Math.max(...alts, 1000), t0 = a.pts[0][0], t1 = a.pts[a.pts.length - 1][0] || t0 + 1;
    const d = a.pts.filter(p => p[3] != null).map((p, i) => `${i ? 'L' : 'M'}${((p[0] - t0) / Math.max(1, t1 - t0) * 300).toFixed(1)} ${(52 - p[3] / max * 48).toFixed(1)}`).join(' ');
    spark = `<div><div class="spark-h"><span>Altitude, ${fmtUTC(t0)} to ${fmtUTC(t1)}</span><span>max ${fmtAlt(Math.max(...alts))}</span></div>
      <svg class="spark" viewBox="0 0 300 56" preserveAspectRatio="none"><line x1="0" x2="300" y1="52" y2="52" stroke="#1f3029"/><path d="${d}" fill="none" stroke="${r.color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg></div>`;
  }
  el.innerHTML = `
    <div class="hd"><div><h2>${esc(a.name)}</h2><div class="sub">${esc(a.rec.desc || a.rec.t || 'Unknown type')}</div></div>
      <button type="button" class="close" id="close" aria-label="Close details">✕</button></div>
    <div><span class="badge" style="--c:${r.color}">${r.label}</span></div>
    ${a.flags.length ? `<div class="why">${a.flags.map(f => `<p class="${f.k}">${esc(f.text)}</p>`).join('')}</div>` : ''}
    <dl class="kv">
      <div><dt>Type</dt><dd>${esc(a.rec.t || '–')}</dd></div>
      <div><dt>Registration</dt><dd>${esc(a.rec.r || '–')}</dd></div>
      <div><dt>ICAO hex</dt><dd>${esc(a.hex.toUpperCase())}</dd></div>
      <div><dt>Squawk</dt><dd>${esc(a.rec.sq || '–')}</dd></div>
      <div><dt>Altitude</dt><dd>${fmtAlt(a.alt)}</dd></div>
      <div><dt>Ground speed</dt><dd>${a.gs != null ? a.gs + ' kt' : '–'}</dd></div>
      <div><dt>Heading</dt><dd>${a.trk != null ? a.trk + '°' : '–'}</dd></div>
      <div><dt>Last seen</dt><dd>${fmtAgo(a.age)}</dd></div>
      <div style="grid-column:1/-1"><dt>Position</dt><dd>${fmtPos(a.lat, a.lon)}</dd></div>
      <div style="grid-column:1/-1"><dt>Tracked</dt><dd>${fmtUTC(a.first)} to ${fmtUTC(a.rec.last || a.pts[a.pts.length - 1][0])} · ${a.pts.length} points</dd></div>
    </dl>
    ${spark}
    <div class="links">
      <a href="https://globe.adsb.lol/?icao=${encodeURIComponent(a.hex)}" target="_blank" rel="noopener">ADSB.lol ↗</a>
      <a href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(a.hex)}" target="_blank" rel="noopener">ADS-B Exchange ↗</a>
      <button type="button" id="share">Copy link</button>
    </div>
    <p class="note">Role is inferred from the type code${a.rec.c ? ' and callsign' : ''}; treat it as a best guess.</p>`;
  el.hidden = false;
  $('close').onclick = () => select(null);
  $('share').onclick = async e => {
    const url = location.href.split('#')[0] + '#' + a.hex;
    try { await navigator.clipboard.writeText(url); e.target.textContent = 'Link copied'; }
    catch { e.target.textContent = url; }
  };
}

function select(hex, pan = true) {
  state.sel = hex;
  try { history.replaceState(null, '', hex ? '#' + hex : location.pathname + location.search); } catch {}
  const a = state.byHex.get(hex);
  if (a && pan) map.setView([a.lat, a.lon], Math.max(map.getZoom(), 6));
  drawMap(); renderList(); renderDetail();
}

function render() { renderStats(); drawMap(); renderList(); renderDetail(); }

// ---------- Data loading ----------
function setStatus(cls, text) { $('status').className = 'status ' + cls; $('status-text').textContent = text; }

async function load() {
  try {
    const res = await fetch('data/history.json?t=' + Date.now(), {cache: 'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (state.data && data.generatedAt === state.data.generatedAt) { updateAge(); return; }
    state.data = data;
    state.list = analyse(data);
    state.byHex = new Map(state.list.map(a => [a.hex, a]));
    updateAge();
    if (state.firstFit) {
      state.firstFit = false;
      const h = location.hash.slice(1).toLowerCase();
      if (h && state.byHex.has(h)) { render(); select(h); return; }
    }
    render();
  } catch (e) {
    setStatus('bad', state.data ? 'Update failed; showing last data' : 'No flight data yet. The collector publishes the first batch within ~15 minutes.');
    if (!state.data) $('list').innerHTML = '<li class="empty">Waiting for the first data collection.</li>';
  }
}
function updateAge() {
  const d = state.data;
  if (!d || !d.generatedAt) return;
  const age = Math.floor(Date.now() / 1000) - d.generatedAt;
  const n = state.list.filter(a => !a.lost).length;
  const cls = age < 20 * 60 ? 'ok' : age < 60 * 60 ? 'warn' : 'bad';
  const tail = age >= 60 * 60 ? ' · collector may be paused' : '';
  setStatus(cls, `Updated ${fmtAgo(age)} · ${n} aircraft · ${d.source || 'feed'}${tail}`);
}

// ---------- Controls ----------
$('roles').addEventListener('click', e => {
  const b = e.target.closest('.role'); if (!b) return;
  const k = b.dataset.role;
  if (e.shiftKey || e.altKey) { state.roles = new Set([k]); }
  else if (state.roles.has(k)) state.roles.delete(k); else state.roles.add(k);
  if (!state.roles.size) state.roles = new Set(Object.keys(ROLES));
  render();
});
$('search').addEventListener('input', e => { state.search = e.target.value.trim().toLowerCase(); drawMap(); renderList(); });
$('region').addEventListener('change', e => map.fitBounds(REGIONS[e.target.value]));
$('only-view').addEventListener('change', e => { state.onlyView = e.target.checked; renderList(); });
$('show-ground').addEventListener('change', e => { state.showGround = e.target.checked; render(); });
$('show-lost').addEventListener('change', e => { state.showLost = e.target.checked; render(); });
$('trails').addEventListener('change', e => { state.trails = e.target.value; drawMap(); });
for (const id of ['tab-flagged', 'tab-all']) $(id).addEventListener('click', () => {
  state.tab = id === 'tab-flagged' ? 'flagged' : 'all';
  $('tab-flagged').setAttribute('aria-selected', state.tab === 'flagged');
  $('tab-all').setAttribute('aria-selected', state.tab === 'all');
  renderList();
});
$('list').addEventListener('click', e => { const li = e.target.closest('.item'); if (li) select(li.dataset.hex); });
$('list').addEventListener('keydown', e => { if (e.key === 'Enter') { const li = e.target.closest('.item'); if (li) select(li.dataset.hex); } });
map.on('moveend', () => { if (state.onlyView) renderList(); });
$('fit-flagged').addEventListener('click', () => {
  const f = state.list.filter(a => a.flagged && visible(a));
  if (f.length) map.fitBounds(L.latLngBounds(f.map(a => [a.lat, a.lon])).pad(0.3), {maxZoom: 7});
});
$('csv').addEventListener('click', () => {
  const rows = state.list.filter(visible);
  const head = ['hex', 'callsign', 'registration', 'type', 'role', 'lat', 'lon', 'altitude_ft', 'ground_speed_kt', 'track_deg', 'squawk', 'last_seen_utc', 'flags'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map(a => [a.hex, a.rec.c, a.rec.r, a.rec.t, ROLES[a.role].label, a.lat, a.lon, a.alt, a.gs, a.trk, a.rec.sq,
    new Date((a.rec.last || a.pts[a.pts.length - 1][0]) * 1000).toISOString(), a.flags.map(f => f.label).join('; ')].map(q).join(','));
  const blob = new Blob([head.join(',') + '\n' + lines.join('\n')], {type: 'text/csv'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `orbit-watch-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
});
window.addEventListener('hashchange', () => { const h = location.hash.slice(1).toLowerCase(); if (h !== state.sel && state.byHex.has(h)) select(h); });

load();
setInterval(load, 60 * 1000);
setInterval(updateAge, 30 * 1000);
