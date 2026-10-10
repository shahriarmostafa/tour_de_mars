"use strict";

const ROUTES = [
  { key: "fast", name: "Quickest", color: "#ffd166" },
  { key: "safe", name: "Safest", color: "#4cc9f0" },
  { key: "science", name: "Most science", color: "#c792ea" },
  { key: "balanced", name: "Balanced", color: "#7bd88f" },
];
const PLACE = { carbonate: "Carbonate layers", fe_mg_clay: "Clay outcrop", olivine: "Olivine rocks" };
const MAX_PLACES = 4, PX = 10, RESERVE = 30 * 60, DWELL = 15 * 60;

const S = {
  G: null, H: 0, demo: null, base: null, places: [], Thome: null, Tout: null, air: 5,
  routes: {}, sel: "safe", view: "danger", step: 1, example: false,
  play: { on: false, t: 0, last: 0, speed: 360 },
};
let map, L_ = {}, rover = null;
const $ = id => document.getElementById(id);
const DATA = window.MARSWALK_DATA || null;
async function getJSON(n) {
  if (DATA && DATA[n]) return DATA[n];
  const r = await fetch(`data/${n}`); if (!r.ok) throw new Error(n); return r.json();
}

const rc = i => [Math.floor(i / S.G.cols), i % S.G.cols];
const center = i => { const [r, c] = rc(i), s = S.G.tile_m; return [S.H - (r + 0.5) * s, (c + 0.5) * s]; };
function tileAt(ll) {
  const s = S.G.tile_m, c = Math.floor(ll.lng / s), r = Math.floor((S.H - ll.lat) / s);
  return r < 0 || c < 0 || r >= S.G.rows || c >= S.G.cols ? -1 : r * S.G.cols + c;
}
const budget = () => ({ budget: S.air * 3600, reserve: RESERVE, dwell: DWELL });
const hm = s => { const m = Math.max(0, Math.round(s / 60)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
const dur = s => { const m = Math.round(s / 60), h = Math.floor(m / 60); return h ? `${h} h ${m % 60} min` : `${m} min`; };

function describe(i) {
  const x = S.G.raw[i];
  if (!x.ok) return { title: x.p90 == null ? "No map data here" : "Too steep to walk", bad: true };
  let title, why = "";
  if (x.risk < 0.4) title = "Easy ground";
  else {
    title = x.risk < 0.65 ? "Some risk" : "Risky ground";
    why = x.sand >= 0.6 ? "loose sand" : x.p90 >= 15 ? "steep slope" : x.sand >= 0.3 ? "soft, dusty soil" : "rough, rocky ground";
  }
  const sci = x.sci == null ? "No rock data here" : x.mineral && x.sci >= 0.3
    ? `${PLACE[x.mineral]} · ${x.sci >= 0.6 ? "great" : "good"} for science` : "Ordinary rocks";
  return { title, why, sci };
}
function placeName(i) {
  const x = S.G.raw[i];
  return x.mineral && x.sci >= 0.3 ? PLACE[x.mineral] : x.sci == null ? "Unexplored ground" : "Open ground";
}

const CanvasOverlay = L.ImageOverlay.extend({
  _initImage() {
    const c = this._image = this._url;
    L.DomUtil.addClass(c, "leaflet-image-layer");
    if (this._zoomAnimated) L.DomUtil.addClass(c, "leaflet-zoom-animated");
    if (this.options.className) L.DomUtil.addClass(c, this.options.className);
    c.onselectstart = L.Util.falseFn; c.onmousemove = L.Util.falseFn;
  },
});
const canvas = () => { const c = document.createElement("canvas"); c.width = S.G.cols * PX; c.height = S.G.rows * PX; return c; };
let hatch;
function hatchFill(ctx) {
  if (hatch) return hatch;
  const p = document.createElement("canvas"); p.width = p.height = 8; const g = p.getContext("2d");
  g.fillStyle = "rgba(10,9,11,0.78)"; g.fillRect(0, 0, 8, 8);
  g.strokeStyle = "rgba(240,230,225,0.25)"; g.beginPath(); g.moveTo(0, 8); g.lineTo(8, 0); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
  return (hatch = ctx.createPattern(p, "repeat"));
}
function mix(a, b, f) { return a.map((v, k) => v + (b[k] - v) * f); }
function dangerColor(r) {   // green -> amber -> red
  const g = [111, 208, 140, 0.30], y = [255, 189, 74, 0.42], red = [240, 70, 70, 0.62];
  if (r < 0.4) return mix(g, mix(g, y, 0.25), r / 0.4);
  return r < 0.65 ? mix(mix(g, y, 0.25), y, (r - 0.4) / 0.25) : mix(y, red, Math.min(1, (r - 0.65) / 0.25));
}
const css = c => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c[3].toFixed(3)})`;

function drawShade() {
  const G = S.G, ctx = L_.shadeCv.getContext("2d");
  ctx.clearRect(0, 0, L_.shadeCv.width, L_.shadeCv.height);
  for (let i = 0; i < G.rows * G.cols; i++) {
    const [r, c] = rc(i);
    if (!G.ok[i]) continue;
    let col = null;
    if (S.view === "danger") col = dangerColor(G.risk[i]);
    else if (S.view === "science") col = Number.isNaN(G.sci[i]) ? [120, 115, 125, 0.45] : [199, 146, 234, 0.06 + 0.8 * Math.pow(G.sci[i], 1.3)];
    if (col) { ctx.fillStyle = css(col); ctx.fillRect(c * PX, r * PX, PX, PX); }
  }
  ctx.fillStyle = hatchFill(ctx);
  ctx.globalAlpha = S.view === "plain" || S.view === "rover" ? 0.5 : 1;
  for (let i = 0; i < G.rows * G.cols; i++) if (!G.ok[i]) { const [r, c] = rc(i); ctx.fillRect(c * PX, r * PX, PX, PX); }
  ctx.globalAlpha = 1;
  drawLegend();
}
function drawLegend() {
  const rows = [];
  if (S.view === "danger") rows.push(["#6fd08c", "Easy to walk"], ["#ffbd4a", "Some risk (sand, slopes)"], ["#f04646", "Risky"]);
  if (S.view === "science") rows.push(["#d6a2f5", "Interesting rocks"], ["#3a3340", "Ordinary rocks"], ["#78737d", "No rock data"]);
  if (S.view === "rover") rows.push(["#e47b44", "Perseverance's path (tap a dot)"]);
  rows.push(["hatch", "Can't walk here"]);
  if (S.play.on || S.play.t > 0) rows.push(["zone", "You could still get home from here"]);
  $("legend").innerHTML = rows.map(([c, t]) => `<div><i class="sw ${c === "hatch" ? "hatch" : ""}" style="${c === "hatch" ? "" : c === "zone" ? "border:2px solid #8ef0c3" : `background:${c}`}"></i>${t}</div>`).join("");
}
// during playback: dim the places you could no longer get home from in time
function drawZone() {
  const G = S.G, ctx = L_.zoneCv.getContext("2d");
  ctx.clearRect(0, 0, L_.zoneCv.width, L_.zoneCv.height);
  if (!(S.play.on || S.play.t > 0) || !S.Thome) return;
  const lim = S.air * 3600 - RESERVE - S.play.t, n = G.rows * G.cols, inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = G.ok[i] && S.Thome[i] <= lim ? 1 : 0;
  ctx.fillStyle = "rgba(8,7,10,0.55)";
  for (let i = 0; i < n; i++) if (G.ok[i] && !inside[i]) { const [r, c] = rc(i); ctx.fillRect(c * PX, r * PX, PX, PX); }
  const out = j => G.ok[j] && !inside[j];
  ctx.strokeStyle = "rgba(142,240,195,0.95)"; ctx.lineWidth = 2.2; ctx.beginPath();
  for (let i = 0; i < n; i++) {
    if (!inside[i]) continue;
    const [r, c] = rc(i), x = c * PX, y = r * PX;
    if (r > 0 && out(i - G.cols)) { ctx.moveTo(x, y); ctx.lineTo(x + PX, y); }
    if (r < G.rows - 1 && out(i + G.cols)) { ctx.moveTo(x, y + PX); ctx.lineTo(x + PX, y + PX); }
    if (c > 0 && out(i - 1)) { ctx.moveTo(x, y); ctx.lineTo(x, y + PX); }
    if (c < G.cols - 1 && out(i + 1)) { ctx.moveTo(x + PX, y); ctx.lineTo(x + PX, y + PX); }
  }
  ctx.stroke();
}

const ICON = {
  base: L.divIcon({ className: "", iconSize: [34, 34], iconAnchor: [17, 17], html:
    `<svg class="mk-base" viewBox="0 0 30 30"><path d="M15 2.5 L26.5 9 V21 L15 27.5 L3.5 21 V9Z" fill="#e47b44" stroke="#121015" stroke-width="2"/><path d="M8.5 19 a6.5 6.5 0 0 1 13 0Z" fill="#1a0e08"/><rect x="13.5" y="15" width="3" height="4" fill="#e47b44"/></svg>` }),
  stop: n => L.divIcon({ className: "", iconSize: [28, 28], iconAnchor: [14, 14], html: `<div class="mk-stop">${n}</div>` }),
  star: col => L.divIcon({ className: "", iconSize: [24, 24], iconAnchor: [12, 12], html:
    `<svg class="mk-star" viewBox="0 0 22 22"><path d="M11 1.5 L13.6 8 L20.5 8.4 L15.2 12.8 L17 19.6 L11 15.8 L5 19.6 L6.8 12.8 L1.5 8.4 L8.4 8Z" fill="${col}" stroke="#121015" stroke-width="1.6"/></svg>` }),
  astro: col => L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: `<div class="mk-astro" style="--c:${col}"></div>` }),
  pin: L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9], html: `<div class="mk-pin"></div>` }),
};

function initMap(basemap) {
  const G = S.G, b = [[0, 0], [S.H, G.cols * G.tile_m]];
  map = L.map("map", { crs: L.CRS.Simple, minZoom: -4, maxZoom: 1, zoomSnap: 0.25, preferCanvas: true,
    maxBounds: [[-1500, -1500], [S.H + 1500, G.cols * G.tile_m + 1500]] });
  map.attributionControl.setPrefix(false).addAttribution("Demo terrain modelled on Jezero Crater");
  [["base", 250], ["shade", 330], ["zone", 340], ["routes", 410]].forEach(([n, z]) => (map.createPane(n).style.zIndex = z));
  L.imageOverlay(basemap, b, { pane: "base" }).addTo(map);
  L_.shadeCv = canvas(); L_.zoneCv = canvas();
  new CanvasOverlay(L_.shadeCv, b, { pane: "shade", className: "pixelated" }).addTo(map);
  new CanvasOverlay(L_.zoneCv, b, { pane: "zone", className: "pixelated" }).addTo(map);
  L_.renderer = L.canvas({ pane: "routes", padding: 0.5 });
  L_.routes = L.layerGroup().addTo(map);
  L_.marks = L.layerGroup().addTo(map);
  L_.walk = L.layerGroup().addTo(map);
  L_.rover = L.layerGroup();
  L.polyline(rover.path, { color: "#121015", weight: 6, opacity: .7, interactive: false }).addTo(L_.rover);
  L.polyline(rover.path, { color: "#e47b44", weight: 3, interactive: false }).addTo(L_.rover);
  rover.pins.forEach(p => L.marker(p.yx, { icon: ICON.pin })
    .bindPopup(`<h4>${p.name}</h4><div class="d">${p.date}</div>${p.text}`, { maxWidth: 240 }).addTo(L_.rover));
  L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);
  fit();
  map.on("click", e => onMapClick(tileAt(e.latlng)));
  map.on("mousemove", e => showTip(tileAt(e.latlng), e.containerPoint));
  map.on("mouseout", () => ($("tip").hidden = true));
  map.on("zoomend", drawRoutes);
}
function fit() { map.fitBounds([[0, 0], [S.H, S.G.cols * S.G.tile_m]], { padding: [16, 16], paddingTopLeft: [16, 56] }); }

function showTip(i, pt) {
  const tip = $("tip");
  if (i < 0) { tip.hidden = true; return; }
  const d = describe(i);
  tip.innerHTML = d.bad ? `<b class="no">${d.title}</b>` : `<b>${d.title}</b>${d.why ? `<span class="s">${d.why}</span><br>` : ""}<span class="s">${d.sci}</span>`;
  const w = $("map").clientWidth;
  tip.style.left = `${Math.min(pt.x + 16, w - 230)}px`; tip.style.top = `${pt.y + 16}px`;
  tip.hidden = false;
}

let toastT;
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600); }

function onMapClick(i) {
  if (i < 0) return;
  if (S.step === 3 && !S.example) { toast("Tap “Change places” to edit your stops."); return; }
  if (S.step === 3 && S.example) { startOver(); }
  if (!S.G.ok[i]) { toast(describe(i).title + ". Try somewhere else."); return; }
  if (S.base == null) {
    setBase(i); S.step = 2; render(); return;
  }
  if (i === S.base) return;
  if (S.places.includes(i)) { S.places = S.places.filter(p => p !== i); render(); return; }
  if (!Number.isFinite(S.Thome[i])) { toast("You can't walk there from your base."); return; }
  if (S.places.length >= MAX_PLACES) { toast(`Up to ${MAX_PLACES} places per walk.`); return; }
  S.places.push(i); render();
}
function setBase(i) { S.base = i; S.Thome = walkbackMap(S.G, i); S.Tout = outboundMap(S.G, i); }
function startOver() {
  stop(); S.base = null; S.places = []; S.routes = {}; S.example = false; S.step = 1; S.Thome = null;
  render();
}
function loadExample() {
  stop(); setBase(S.demo.habitat); S.places = [...S.demo.stops]; S.air = 5; S.example = true;
  plan(); S.sel = "safe"; S.step = 3; render(); fit();
}

function plan() {
  const G = S.G, B = budget();
  S.routes = {};
  for (const r of ROUTES) {
    const W = PRESETS[r.key];
    let stops = [S.base, ...S.places, S.base];
    if (W.extraStops) stops = addScienceStops(G, stops, W.extraStops, W, S.Thome, B);
    const route = planRoute(G, stops, W);
    if (!route) { S.routes[r.key] = null; continue; }
    const chk = checkWalkback(G, route, S.Thome, B);
    S.routes[r.key] = { route, chk, stats: routeStats(G, route, chk), added: stops.filter(s => s !== S.base && !S.places.includes(s)) };
  }
  if (!S.routes[S.sel]) S.sel = ROUTES.find(r => S.routes[r.key])?.key || "fast";
}

function render() {
  document.querySelectorAll(".steps li").forEach(li => {
    const k = +li.dataset.step; li.className = k === S.step ? "on" : k < S.step ? "done" : "";
  });
  [1, 2, 3].forEach(k => ($(`stage-${k}`).hidden = k !== S.step));
  $("walkhud").hidden = !(S.play.on || S.play.t > 0);
  if (S.step === 2) renderPlaces();
  if (S.step === 3) renderRoutes();
  drawMarks(); drawRoutes(); drawZone(); drawLegend();
}
function renderPlaces() {
  const G = S.G, ul = $("places"), items = [`<li><span class="n base">⌂</span><div><div class="t">Base camp</div><div class="d">Your walk starts and ends here</div></div><span></span></li>`];
  S.places.forEach((p, k) => items.push(`<li><span class="n">${k + 1}</span><div><div class="t">${placeName(p)}</div><div class="d">${dur(S.Tout[p])} walk from base</div></div><button class="x" data-rm="${k}" aria-label="Remove">×</button></li>`));
  if (!S.places.length) items.push(`<li class="empty">Tap the map to add your first place.</li>`);
  ul.innerHTML = items.join("");
  ul.querySelectorAll("[data-rm]").forEach(b => (b.onclick = () => { S.places.splice(+b.dataset.rm, 1); render(); }));
  $("btn-plan").disabled = !S.places.length;
}
function safetyLine(m) {
  if (m < 0) return `<div class="safe bad">✕ Not safe: can't get home in time</div>`;
  if (m < 20 * 60) return `<div class="safe tight">! Cutting it close: ${dur(m)} to spare</div>`;
  return `<div class="safe ok">✓ Home with ${dur(m)} of air to spare</div>`;
}
function renderRoutes() {
  $("example-note").hidden = !S.example;
  const ok = ROUTES.filter(r => S.routes[r.key]);
  const quickest = ok.reduce((a, r) => (!a || S.routes[r.key].chk.totalTime < S.routes[a.key].chk.totalTime ? r : a), null);
  const anySafe = ok.some(r => S.routes[r.key].chk.ok);
  $("routes-sub").textContent = anySafe ? "Four ways to make the same trip. Tap one to see it on the map." : "None of these get home in time. Add more air or pick fewer places.";
  $("routes").innerHTML = ROUTES.map(r => {
    const R = S.routes[r.key];
    if (!R) return `<div class="route na" style="--c:${r.color}"><div class="name">${r.name}</div><div class="why">Can't reach every place this way.</div></div>`;
    const st = R.stats, bits = [];
    bits.push(`${(st.dist / 1000).toFixed(1)} km`);
    bits.push(st.steepTiles ? `${st.steepTiles} steep spot${st.steepTiles > 1 ? "s" : ""}` : "no steep ground");
    if (R.added.length) bits.push(`+${R.added.length} bonus science stop${R.added.length > 1 ? "s" : ""}`);
    else if (st.sandTiles) bits.push(`${st.sandTiles} sandy patch${st.sandTiles > 1 ? "es" : ""}`);
    return `<button class="route" data-r="${r.key}" aria-pressed="${r.key === S.sel}" style="--c:${r.color}">
      <div class="name">${r.name}${r === quickest ? ` <span class="best">fastest</span>` : ""}</div>
      <div class="time">${hm(R.chk.totalTime)}<small>hours</small></div>
      <div class="why">${bits.join(" · ")}</div>
      ${safetyLine(R.chk.minMargin)}
    </button>`;
  }).join("");
  $("routes").querySelectorAll("[data-r]").forEach(b => (b.onclick = () => { stop(); resetWalk(); S.sel = b.dataset.r; render(); }));
  $("air-val").textContent = `${S.air} h`;
  const R = S.routes[S.sel];
  $("btn-watch").disabled = !R;
  $("btn-watch").textContent = S.play.on ? "❚❚ Pause" : S.play.t > 0 && R && S.play.t < R.chk.totalTime ? "▶ Keep walking" : "▶ Watch the walk";
}

function drawMarks() {
  L_.marks.clearLayers();
  if (S.base == null) return;
  const R = S.step === 3 ? S.routes[S.sel] : null;
  if (R) R.added.forEach(a => L.marker(center(a), { icon: ICON.star(ROUTES.find(r => r.key === S.sel).color), interactive: false }).addTo(L_.marks));
  S.places.forEach((p, k) => L.marker(center(p), { icon: ICON.stop(k + 1), interactive: false, zIndexOffset: 500 }).addTo(L_.marks));
  L.marker(center(S.base), { icon: ICON.base, interactive: false, zIndexOffset: 900 }).addTo(L_.marks);
}
function drawRoutes() {
  L_.routes.clearLayers();
  if (S.step !== 3) return;
  const mpp = 1 / map.getZoomScale(map.getZoom(), 0), k = 3.5 * mpp;
  const OFF = { fast: [1, .33], safe: [-.33, 1], science: [-1, -.33], balanced: [.33, -1] };
  const order = ROUTES.filter(r => S.routes[r.key]).sort((a, b) => (a.key === S.sel) - (b.key === S.sel));
  for (const r of order) {
    const R = S.routes[r.key], sel = r.key === S.sel, o = OFF[r.key];
    const pts = R.route.path.map(i => { const c = center(i); return [c[0] + o[0] * k, c[1] + o[1] * k]; });
    if (sel) L.polyline(pts, { renderer: L_.renderer, color: "#121015", weight: 9, opacity: .85, interactive: false }).addTo(L_.routes);
    L.polyline(pts, { renderer: L_.renderer, color: r.color, weight: sel ? 5 : 2.5, opacity: sel ? 1 : .55, lineJoin: "round", interactive: false }).addTo(L_.routes);
    for (let j = 1; j < pts.length; j++) if (R.chk.margin[j] < 0)
      L.polyline([pts[j - 1], pts[j]], { renderer: L_.renderer, color: "#ff5f5f", weight: sel ? 6 : 3.5, dashArray: "7 5", interactive: false }).addTo(L_.routes);
  }
}

function stateAt(t) {
  const R = S.routes[S.sel], path = R.route.path, clock = R.chk.clock, stops = new Set(R.route.stopAt), n = path.length;
  if (t >= clock[n - 1]) return { ll: center(path[n - 1]), j: n - 1, doing: "Back at base. Walk complete!" };
  let j = 0; while (j < n - 1 && clock[j] < t) j++;
  if (stops.has(j) && t >= clock[j] - DWELL) {
    const p = path[j], k = S.places.indexOf(p);
    return { ll: center(p), j, doing: k >= 0 ? `Working at place ${k + 1}: ${placeName(p)}` : "Bonus science stop" };
  }
  const t0 = j ? clock[j - 1] : 0, t1 = stops.has(j) ? clock[j] - DWELL : clock[j], f = (t - t0) / Math.max(1e-6, t1 - t0);
  const a = center(path[Math.max(0, j - 1)]), b = center(path[j]);
  const next = R.route.stopAt.find(s => s >= j);
  const target = next == null ? "Heading home" : (() => { const p = path[next], k = S.places.indexOf(p); return k >= 0 ? `Walking to place ${k + 1}` : "Walking to a bonus science stop"; })();
  return { ll: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], j: f > .5 ? j : Math.max(0, j - 1), walked: Math.max(0, j - 1), doing: target };
}
function resetWalk() { S.play.t = 0; L_.walk.clearLayers(); L_.astro = L_.trail = null; }
function updateWalk() {
  const R = S.routes[S.sel]; if (!R) return;
  const t = S.play.t, st = stateAt(t), path = R.route.path;
  if (!L_.astro) {
    L_.trail = L.polyline([], { renderer: L_.renderer, color: "#fff", weight: 3, opacity: .9, interactive: false }).addTo(L_.walk);
    L_.astro = L.marker(st.ll, { icon: ICON.astro(ROUTES.find(r => r.key === S.sel).color), interactive: false, zIndexOffset: 2000 }).addTo(L_.walk);
  }
  L_.astro.setLatLng(st.ll);
  L_.trail.setLatLngs([...path.slice(0, (st.walked ?? st.j) + 1).map(center), st.ll]);
  const total = S.air * 3600, left = total - t, need = S.Thome[path[st.j]] + RESERVE;
  $("wh-time").textContent = hm(t);
  $("wh-doing").textContent = st.doing;
  $("wh-air").textContent = `${hm(left)} h`;
  const fill = $("wh-fill"); fill.style.width = `${Math.max(0, left / total) * 100}%`;
  fill.style.background = left - need < 0 ? "var(--bad)" : left - need < 1200 ? "var(--warn)" : "var(--easy)";
  $("wh-need").style.left = `calc(${Math.min(1, need / total) * 100}% - 1px)`;
  $("wh-note").textContent = left - need < 0 ? "Not enough air left to get home safely!" : `Getting home from here takes ${dur(S.Thome[path[st.j]])} plus a 30 min reserve.`;
  const now = performance.now();
  if (!L_.zoneT || now - L_.zoneT > 100) { drawZone(); L_.zoneT = now; }
}
function loop(ts) {
  if (!S.play.on) return;
  const R = S.routes[S.sel];
  S.play.t = Math.min(R.chk.totalTime, S.play.t + (S.play.last ? (ts - S.play.last) / 1000 : 0) * S.play.speed);
  S.play.last = ts; updateWalk();
  if (S.play.t >= R.chk.totalTime) { stop(); drawZone(); renderRoutes(); return; }
  requestAnimationFrame(loop);
}
function play() {
  const R = S.routes[S.sel]; if (!R) return;
  if (S.play.t >= R.chk.totalTime) resetWalk();
  S.play.on = true; S.play.last = 0; $("walkhud").hidden = false;
  if (window.matchMedia("(max-width: 860px)").matches) $("map").scrollIntoView({ behavior: "smooth", block: "start" });
  renderRoutes(); drawLegend(); requestAnimationFrame(loop);
}
function stop() { S.play.on = false; }

function setView(v) {
  S.view = v;
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
  if (v === "rover") L_.rover.addTo(map); else map.removeLayer(L_.rover);
  drawShade();
}
function bind() {
  document.querySelectorAll("[data-view]").forEach(b => (b.onclick = () => setView(b.dataset.view)));
  $("btn-plan").onclick = () => { plan(); S.step = 3; S.example = false; resetWalk(); render(); };
  $("btn-watch").onclick = () => (S.play.on ? (stop(), renderRoutes()) : play());
  $("btn-edit").onclick = () => { stop(); resetWalk(); S.example = false; S.step = 2; render(); };
  ["btn-restart-2", "btn-restart-3"].forEach(id => ($(id).onclick = startOver));
  $("btn-own").onclick = startOver;
  $("btn-example").onclick = loadExample;
  const air = d => { S.air = Math.min(8, Math.max(2, S.air + d)); stop(); resetWalk(); plan(); render(); };
  $("air-minus").onclick = () => air(-0.5); $("air-plus").onclick = () => air(0.5);
  const how = $("how");
  $("btn-how").onclick = () => (how.hidden = false);
  $("how-close").onclick = $("how-go").onclick = () => (how.hidden = true);
  how.onclick = e => { if (e.target === how) how.hidden = true; };
  document.addEventListener("keydown", e => { if (e.key === "Escape") how.hidden = true; });
}

async function init() {
  const [grid, demo, trav] = await Promise.all([getJSON("tile_grid.json"), getJSON("demo_scenario.json"), getJSON("rover_traverse.json")]);
  S.G = loadGrid(grid); S.H = S.G.rows * S.G.tile_m; S.demo = demo;
  rover = trav;
  rover.pins.forEach(p => (p.date = p.date + (p.sol ? ` · around sol ${p.sol}` : " · sol 0")));
  initMap((DATA && DATA.basemap) || "data/basemap.jpg");
  bind(); drawShade(); loadExample();
}
init().catch(err => {
  console.error(err);
  $("map").innerHTML = `<p style="padding:24px;color:#ff5f5f">Couldn't load the map. If you opened this file directly, serve the folder instead: python -m http.server</p>`;
});
