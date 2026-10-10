const NBRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];

const PARAMS = { v0: 0.9, b_sand: 1.0 };   // v0 = Tobler peak speed (m/s); flat ground = 0.84 * v0
const PRESETS = {
  fast:     { wR: 0,   wSbeta: 0,    maxSlope: null },
  safe:     { wR: 3,   wSbeta: 0,    maxSlope: 18 },   // also avoids tiles with p90 slope > 18 deg
  science:  { wR: 0.5, wSbeta: 0.5,  maxSlope: null, extraStops: 2 },
  balanced: { wR: 1.5, wSbeta: 0.25, maxSlope: 22 },   // widened (guide 3.10): looser slope cap than safe
};  // keep wSbeta <= 0.5 so every edge cost stays positive

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a; a.push([k, v]); let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

function loadGrid(json) {
  const { rows, cols, tile_m } = json.meta, n = rows * cols, t = json.tiles;
  const G = { rows, cols, tile_m, ids: t.map(x => x.id), candidates: json.candidates, meta: json.meta,
    elev: new Float64Array(n), p90: new Float64Array(n), sand: new Float64Array(n),
    risk: new Float64Array(n), sci: new Float64Array(n), ok: new Uint8Array(n),
    steep: new Float64Array(n), mineral: t.map(x => x.mineral), raw: t };
  t.forEach((x, i) => {
    G.elev[i] = x.elev ?? NaN; G.p90[i] = x.p90 ?? NaN; G.sand[i] = x.sand ?? 0;
    G.risk[i] = x.risk ?? 1; G.sci[i] = x.sci ?? NaN; G.ok[i] = x.ok ? 1 : 0;   
    G.steep[i] = x.steep ?? NaN;
  });
  return G;
}

const isOpen = (G, i, W) => G.ok[i] === 1 && (W.maxSlope == null || G.p90[i] <= W.maxSlope);
const isDiag = (G, u, v) =>
  (u % G.cols) !== (v % G.cols) && Math.floor(u / G.cols) !== Math.floor(v / G.cols);

function neighbors(G, u, W) {
  const r = Math.floor(u / G.cols), c = u % G.cols, out = [];
  for (const [dr, dc] of NBRS) {
    const r2 = r + dr, c2 = c + dc;
    if (r2 < 0 || c2 < 0 || r2 >= G.rows || c2 >= G.cols) continue;
    const v = r2 * G.cols + c2;
    if (!isOpen(G, v, W)) continue;
    const diag = dr !== 0 && dc !== 0;   // no diagonal corner-cutting past a blocked tile
    if (diag && (!isOpen(G, r * G.cols + c2, W) || !isOpen(G, r2 * G.cols + c, W))) continue;
    out.push([v, diag]);
  }
  return out;
}

// Tobler walking time (s) for the edge u -> v. Direction-aware: uphill != downhill.
function edgeTime(G, u, v, diag, P = PARAMS) {
  const d = diag ? G.tile_m * Math.SQRT2 : G.tile_m;
  const tan = (G.elev[v] - G.elev[u]) / d;
  const sand = (G.sand[u] + G.sand[v]) / 2;
  const speed = P.v0 * Math.exp(-3.5 * Math.abs(tan + 0.05)) / (1 + P.b_sand * sand);
  return d / speed;
}

// Planning cost: time inflated by risk, discounted by science (unknown science counts as 0).
function edgeCost(G, u, v, diag, W, P = PARAMS) {
  const R = (G.risk[u] + G.risk[v]) / 2;
  const S = ((G.sci[u] || 0) + (G.sci[v] || 0)) / 2;
  return edgeTime(G, u, v, diag, P) * (1 + W.wR * R) * (1 - W.wSbeta * S);
}

// reverse=true answers "cost from every tile TO source" by charging the edge v -> u.
function dijkstra(G, source, costFn, { reverse = false, target = -1, W = {} } = {}) {
  const n = G.rows * G.cols;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const heap = new MinHeap(); dist[source] = 0; heap.push(0, source);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;
    if (u === target) break;
    for (const [v, diag] of neighbors(G, u, W)) {
      const w = reverse ? costFn(v, u, diag) : costFn(u, v, diag);
      if (d + w < dist[v]) { dist[v] = d + w; prev[v] = u; heap.push(dist[v], v); }
    }
  }
  return { dist, prev };
}

// T_home[i]: fastest walking time (s) from tile i back to the habitat. Run once per habitat.
function walkbackMap(G, habitat, P = PARAMS) {
  return dijkstra(G, habitat, (a, b, diag) => edgeTime(G, a, b, diag, P), { reverse: true }).dist;
}

// [ui] T_out[i]: fastest walking time (s) from the habitat out to tile i (for the reach layer).
function outboundMap(G, habitat, P = PARAMS) {
  return dijkstra(G, habitat, (a, b, diag) => edgeTime(G, a, b, diag, P)).dist;
}

function pathTo(prev, source, target) {
  const path = [];
  for (let v = target; v !== -1; v = prev[v]) path.push(v);
  path.reverse();
  return path[0] === source ? path : null;
}

// stops = [habitat, s1, s2, ..., habitat]. Returns the tile path and where each stop sits in it.
function planRoute(G, stops, W, P = PARAMS) {
  const path = [stops[0]], stopAt = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const cost = (a, b, diag) => edgeCost(G, a, b, diag, W, P);
    const { prev } = dijkstra(G, stops[i], cost, { target: stops[i + 1], W });
    const leg = pathTo(prev, stops[i], stops[i + 1]);
    if (!leg) return null;                                  // a stop is unreachable under this preset
    path.push(...leg.slice(1));
    if (i + 2 < stops.length) stopAt.push(path.length - 1);   // intermediate stops only
  }
  return { path, stopAt };
}

// Walkback rule at every point: t_elapsed + T_home + reserve <= budget (all in seconds).
function checkWalkback(G, route, Thome, B, P = PARAMS) {
  const { path, stopAt } = route, stops = new Set(stopAt), margin = new Float64Array(path.length);
  const clock = new Float64Array(path.length);               // [ui] elapsed time at each tile
  let t = 0, minMargin = Infinity;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) t += edgeTime(G, path[i - 1], path[i], isDiag(G, path[i - 1], path[i]), P);
    if (stops.has(i)) t += B.dwell;                          // margin measured after the dwell
    clock[i] = t;
    margin[i] = B.budget - B.reserve - t - Thome[path[i]];
    minMargin = Math.min(minMargin, margin[i]);
  }
  return { margin, clock, minMargin, totalTime: t, ok: minMargin >= 0 };
}

// Science preset only: greedily insert up to k candidate stops with the best science per added second.
function addScienceStops(G, stops, k, W, Thome, B, P = PARAMS) {
  for (let added = 0; added < k; added++) {
    const base = planRoute(G, stops, W, P);
    if (!base) break;
    const baseTime = checkWalkback(G, base, Thome, B, P).totalTime;
    let best = null;
    for (const c of G.candidates) {
      if (stops.includes(c)) continue;
      for (let pos = 1; pos < stops.length; pos++) {
        const trial = [...stops.slice(0, pos), c, ...stops.slice(pos)];
        const route = planRoute(G, trial, W, P);
        if (!route) continue;
        const chk = checkWalkback(G, route, Thome, B, P);
        if (!chk.ok) continue;
        const ratio = (G.sci[c] || 0) / Math.max(1, chk.totalTime - baseTime);
        if (!best || ratio > best.ratio) best = { ratio, stops: trial };
      }
    }
    if (!best) break;
    stops = best.stops;
  }
  return stops;
}

function routeStats(G, route, chk) {
  const { path, stopAt } = route;
  let dist = 0, riskSum = 0, maxRisk = 0, sandTiles = 0, climb = 0, steepTiles = 0;
  const sciSeen = new Set();
  for (let i = 0; i < path.length; i++) {
    const v = path[i];
    if (i > 0) {
      const u = path[i - 1];
      dist += isDiag(G, u, v) ? G.tile_m * Math.SQRT2 : G.tile_m;
      climb += Math.max(0, G.elev[v] - G.elev[u]);
    }
    riskSum += G.risk[v]; maxRisk = Math.max(maxRisk, G.risk[v]);
    if (G.sand[v] >= 0.6) sandTiles++;
    if (G.p90[v] > 18) steepTiles++;
  }
  let stopSci = 0;
  for (const k of stopAt) { const s = G.sci[path[k]]; if (s > 0) { stopSci += s; sciSeen.add(path[k]); } }
  return { dist, meanRisk: riskSum / path.length, maxRisk, sandTiles, steepTiles, climb,
           stopSci, nStops: stopAt.length };
}

if (typeof module !== "undefined") module.exports = { PARAMS, PRESETS, loadGrid, neighbors, edgeTime, edgeCost,
  dijkstra, walkbackMap, outboundMap, pathTo, planRoute, checkWalkback, addScienceStops, routeStats, isDiag };
