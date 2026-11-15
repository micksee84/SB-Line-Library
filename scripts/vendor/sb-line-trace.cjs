/*
 * Sunshine Brigade line tracer
 * ----------------------------
 * Raster line art -> centerline "SB Line" data:
 *   { version, width, height, lineWidth, strokes:[{points, closed, ends}], fills:[{rings}] }
 *
 * The data holds only geometry. Line weight, wobble, taper and brush are applied
 * at render time (sb-line-render.js), so the same picture can be drawn in any
 * style, at any size, with the line weight set in real page units.
 *
 * Self-contained factory (no imports) so it can run on the main thread, in a
 * Web Worker (via Function#toString) and inside the worksheet builder.
 */
function SBLineTraceFactory() {
  'use strict';

  const DEFAULTS = {
    threshold: 0,        // 0 = automatic (Otsu); otherwise 1-254
    minSpeck: 30,        // ink specks smaller than this (px) are removed
    spur: 2.5,           // prune dangling branches shorter than spur × half-width
    smooth: 0.35,        // centerline smoothing, × half-width
    fillRatio: 1.5,      // component counts as a solid fill when area / line-area > this
    fillCore: 2.4,       // local patch counts as a solid fill when thicker than this × half-width
    simplify: 0.25,      // point simplification tolerance (px)
  };

  // ---------- image prep ----------------------------------------------------

  function toGray(rgba, W, H) {
    const g = new Float32Array(W * H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      const a = rgba[j + 3] / 255;                       // transparent = white paper
      const l = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
      g[i] = l * a + 255 * (1 - a);
    }
    // 3×3 blur
    const o = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue;
          const w = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1); s += g[yy * W + xx] * w; n += w; } }
      o[y * W + x] = s / n;
    }
    return o;
  }

  function otsu(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, g[i] | 0))]++;
    const total = g.length; let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }

  function morph(src, W, H, erode) {
    const o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = erode ? 1 : 0;
      for (let dy = -1; dy <= 1 && v === (erode ? 1 : 0); dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        const p = (yy < 0 || yy >= H || xx < 0 || xx >= W) ? 0 : src[yy * W + xx];
        if (erode && !p) { v = 0; break; }
        if (!erode && p) { v = 1; break; }
      }
      o[y * W + x] = v;
    }
    return o;
  }

  // 8-connected component labels; returns {lab:Int32Array, n, area:[]}
  function label(mask, W, H) {
    const lab = new Int32Array(W * H); const area = [0]; let n = 0;
    const stack = new Int32Array(W * H);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || lab[i]) continue;
      n++; let sp = 0, a = 0; stack[sp++] = i; lab[i] = n;
      while (sp) {
        const p = stack[--sp]; a++;
        const x = p % W, y = (p / W) | 0;
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue;
            const q = yy * W + xx; if (mask[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; } } }
      }
      area.push(a);
    }
    return { lab, n, area };
  }

  // ---------- Euclidean distance transform (Felzenszwalb & Huttenlocher) ----

  function edt(mask, W, H) {   // distance of each set pixel to nearest unset pixel
    const INF = 1e20, f = new Float64Array(Math.max(W, H)), d = new Float64Array(Math.max(W, H));
    const v = new Int32Array(Math.max(W, H)), z = new Float64Array(Math.max(W, H) + 1);
    const out = new Float64Array(W * H);
    function pass(n) {
      let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) f[y] = mask[y * W + x] ? INF : 0;
      pass(H); for (let y = 0; y < H; y++) out[y * W + x] = d[y];
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) f[x] = out[y * W + x];
      pass(W); for (let x = 0; x < W; x++) out[y * W + x] = Math.sqrt(d[x]);
    }
    return out;
  }

  // ---------- skeleton (Zhang–Suen + staircase cleanup) ----------------------

  function skeletonize(mask, W, H) {
    const s = new Uint8Array(mask);
    for (let x = 0; x < W; x++) { s[x] = 0; s[(H - 1) * W + x] = 0; }
    for (let y = 0; y < H; y++) { s[y * W] = 0; s[y * W + W - 1] = 0; }
    let cand = []; for (let i = 0; i < s.length; i++) if (s[i]) cand.push(i);
    const del = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        del.length = 0;
        for (const p of cand) {
          if (!s[p]) continue;
          const p2 = s[p - W], p3 = s[p - W + 1], p4 = s[p + 1], p5 = s[p + W + 1],
                p6 = s[p + W], p7 = s[p + W - 1], p8 = s[p - 1], p9 = s[p - W - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (step === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(p);
        }
        if (del.length) { changed = true; for (const p of del) s[p] = 0; }
      }
      if (changed) cand = cand.filter(p => s[p]);
    }
    // remove staircase corners so every line pixel has exactly two neighbours
    const OFF = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
    const simple = p => {          // neighbours form exactly one 8-connected group
      const on = []; for (let k = 0; k < 8; k++) if (s[p + OFF[k][1] * W + OFF[k][0]]) on.push(OFF[k]);
      if (on.length < 2) return false;
      const seen = new Uint8Array(on.length); const st = [0]; seen[0] = 1; let c = 1;
      while (st.length) { const a = on[st.pop()];
        for (let j = 0; j < on.length; j++) if (!seen[j] && Math.abs(on[j][0] - a[0]) <= 1 && Math.abs(on[j][1] - a[1]) <= 1) { seen[j] = 1; c++; st.push(j); } }
      return c === on.length;
    };
    for (let it = 0; it < 2; it++) for (const p of cand) {
      if (!s[p]) continue;
      const n = s[p - W], e = s[p + 1], so = s[p + W], w = s[p - 1];
      if (!((n && e) || (e && so) || (so && w) || (w && n))) continue;
      if (simple(p)) s[p] = 0;
    }
    return s;
  }

  // ---------- skeleton -> graph of strokes -----------------------------------

  const NB = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

  function traceGraph(sk, W, H) {
    const deg = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const p = y * W + x; if (!sk[p]) continue;
      let c = 0; for (const [dx, dy] of NB) c += sk[p + dy * W + dx]; deg[p] = c;
    }
    const isNode = new Uint8Array(W * H);
    for (let p = 0; p < sk.length; p++) if (sk[p] && deg[p] !== 2) isNode[p] = 1;
    const { lab: nodeLab, n: nNodes } = label(isNode, W, H);
    // node centroids
    const cx = new Float64Array(nNodes + 1), cy = new Float64Array(nNodes + 1), cn = new Float64Array(nNodes + 1);
    for (let p = 0; p < sk.length; p++) { const l = nodeLab[p]; if (l) { cx[l] += p % W; cy[l] += (p / W) | 0; cn[l]++; } }
    for (let l = 1; l <= nNodes; l++) { cx[l] /= cn[l]; cy[l] /= cn[l]; }

    const visited = new Uint8Array(W * H);
    const edges = [];   // {pts:[x,y,...], a, b, closed}
    for (let p = 0; p < sk.length; p++) {
      if (!isNode[p]) continue;
      const sid = nodeLab[p], px0 = p % W, py0 = (p / W) | 0;
      for (const [dx, dy] of NB) {
        const q = p + dy * W + dx;
        if (!sk[q] || isNode[q] || visited[q]) continue;
        const pts = [px0, py0, q % W, (q / W) | 0]; visited[q] = 1;
        let prev = p, cur = q, eid = 0;
        for (;;) {
          let next = -1;
          for (const [ex, ey] of NB) {
            const r = cur + ey * W + ex;
            if (r === prev || !sk[r]) continue;
            if (isNode[r]) { if (nodeLab[r] !== sid || pts.length > 6) { next = r; eid = nodeLab[r]; break; } continue; }
            if (!visited[r]) next = r;
          }
          if (next < 0) break;
          pts.push(next % W, (next / W) | 0);
          if (eid) break;
          visited[next] = 1; prev = cur; cur = next;
        }
        edges.push({ pts, a: sid, b: eid, closed: false });
      }
    }
    // free-standing loops (no junctions or ends)
    for (let p = 0; p < sk.length; p++) {
      if (!sk[p] || isNode[p] || visited[p]) continue;
      const pts = [p % W, (p / W) | 0]; visited[p] = 1; let cur = p;
      for (;;) {
        let next = -1;
        for (const [ex, ey] of NB) { const r = cur + ey * W + ex; if (sk[r] && !isNode[r] && !visited[r]) { next = r; break; } }
        if (next < 0) break;
        visited[next] = 1; pts.push(next % W, (next / W) | 0); cur = next;
      }
      if (pts.length > 16) edges.push({ pts, a: 0, b: 0, closed: true });
    }
    return { edges, cx, cy, nNodes };
  }

  function nodeDegrees(edges) {
    const d = new Map();
    for (const e of edges) { if (e.a) d.set(e.a, (d.get(e.a) || 0) + 1); if (e.b) d.set(e.b, (d.get(e.b) || 0) + 1); }
    return d;
  }

  function polyLen(pts) {
    let L = 0; for (let i = 2; i < pts.length; i += 2) L += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]); return L;
  }

  // Merge edges through nodes that have exactly two edges (left behind after pruning)
  function mergeChains(edges) {
    let merged = true;
    while (merged) {
      merged = false;
      const deg = nodeDegrees(edges);
      for (const [node, dg] of deg) {
        if (dg !== 2) continue;
        const ix = []; edges.forEach((e, i) => { if (e.a === node || e.b === node) ix.push(i); });
        if (ix.length !== 2) {     // same edge both ends -> closed loop
          if (ix.length === 1) { const e = edges[ix[0]]; if (e.a === node && e.b === node) { e.closed = true; e.a = e.b = 0; merged = true; } }
          continue;
        }
        const [e1, e2] = [edges[ix[0]], edges[ix[1]]];
        const p1 = e1.b === node ? e1.pts : reversePts(e1.pts), o1 = e1.b === node ? e1.a : e1.b;
        const p2 = e2.a === node ? e2.pts : reversePts(e2.pts), o2 = e2.a === node ? e2.b : e2.a;
        const pts = p1.concat(p2.slice(2));
        const ne = { pts, a: o1, b: o2, closed: false };
        if (o1 === o2 && o1 !== 0 && deg.get(o1) === 2) { ne.closed = true; ne.a = ne.b = 0; }
        edges.splice(Math.max(ix[0], ix[1]), 1); edges.splice(Math.min(ix[0], ix[1]), 1); edges.push(ne);
        merged = true; break;
      }
    }
    return edges;
  }

  function reversePts(p) { const o = new Array(p.length); for (let i = 0; i < p.length; i += 2) { o[p.length - 2 - i] = p[i]; o[p.length - 1 - i] = p[i + 1]; } return o; }

  // ---------- polyline utilities ---------------------------------------------

  function resample(pts, step, closed) {
    const P = closed ? pts.concat(pts.slice(0, 2)) : pts;
    const n = P.length / 2; if (n < 2) return pts.slice();
    const s = [0]; for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(P[2 * i] - P[2 * i - 2], P[2 * i + 1] - P[2 * i - 1]));
    const L = s[n - 1]; if (L < 1e-6) return pts.slice(0, 2);
    const m = Math.max(2, Math.round(L / step)), out = [];
    const count = closed ? m : m + 1;
    for (let k = 0, j = 0; k < count; k++) {
      const t = (k / m) * L;
      while (j < n - 2 && s[j + 1] < t) j++;
      const u = (t - s[j]) / Math.max(1e-9, s[j + 1] - s[j]);
      out.push(P[2 * j] + (P[2 * j + 2] - P[2 * j]) * u, P[2 * j + 1] + (P[2 * j + 3] - P[2 * j + 1]) * u);
    }
    return out;
  }

  function gaussSmooth(pts, sigma, closed, pinStart, pinEnd) {
    const n = pts.length / 2; if (n < 4 || sigma < 0.3) return pts.slice();
    const r = Math.ceil(sigma * 3), k = []; let ks = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
    const out = new Array(pts.length);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0;
      for (let j = -r; j <= r; j++) {
        let q = i + j;
        if (closed) q = ((q % n) + n) % n; else q = Math.max(0, Math.min(n - 1, q));
        sx += pts[2 * q] * k[j + r]; sy += pts[2 * q + 1] * k[j + r];
      }
      out[2 * i] = sx / ks; out[2 * i + 1] = sy / ks;
    }
    if (!closed) {
      if (pinStart) { out[0] = pts[0]; out[1] = pts[1]; }
      if (pinEnd) { out[2 * n - 2] = pts[2 * n - 2]; out[2 * n - 1] = pts[2 * n - 1]; }
    }
    return out;
  }

  function rdp(pts, eps, closed) {
    const n = pts.length / 2; if (n < 3) return pts.slice();
    if (closed) {   // split loop at farthest point pair to keep it closed nicely
      const half = Math.floor(n / 2);
      const a = rdp(pts.slice(0, (half + 1) * 2), eps, false);
      const b = rdp(pts.slice(half * 2).concat(pts.slice(0, 2)), eps, false);
      return a.slice(0, -2).concat(b.slice(0, -2));
    }
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const st = [[0, n - 1]];
    while (st.length) {
      const [i0, i1] = st.pop();
      const ax = pts[2 * i0], ay = pts[2 * i0 + 1], bx = pts[2 * i1], by = pts[2 * i1 + 1];
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
      let best = -1, bi = -1;
      for (let i = i0 + 1; i < i1; i++) {
        const d = Math.abs((pts[2 * i] - ax) * dy - (pts[2 * i + 1] - ay) * dx) / L;
        if (d > best) { best = d; bi = i; }
      }
      if (best > eps) { keep[bi] = 1; st.push([i0, bi], [bi, i1]); }
    }
    const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
    return out;
  }

  // ---------- solid fills ----------------------------------------------------

  function findFills(ink, dt, sk0, hw, W, H, o) {
    const fill = new Uint8Array(W * H);
    // (a) whole components with far more area than a line of their skeleton length (eye dots)
    const { lab, n, area } = label(ink, W, H);
    const skl = new Float64Array(n + 1);
    for (let p = 0; p < sk0.length; p++) if (sk0[p]) skl[lab[p]]++;
    const solid = new Uint8Array(n + 1);
    for (let i = 1; i <= n; i++) if (area[i] / (skl[i] * 2 * hw + Math.PI * hw * hw) > o.fillRatio) solid[i] = 1;
    for (let p = 0; p < fill.length; p++) if (solid[lab[p]]) fill[p] = 1;
    // (b) local patches far thicker than the line (hooves, filled tips)
    const core = new Uint8Array(W * H);
    for (let p = 0; p < core.length; p++) core[p] = dt[p] > hw * 1.3 ? 1 : 0;
    const C = label(core, W, H);
    const cmax = new Float64Array(C.n + 1);
    for (let p = 0; p < core.length; p++) if (C.lab[p]) cmax[C.lab[p]] = Math.max(cmax[C.lab[p]], dt[p]);
    const big = new Uint8Array(W * H); let any = false;
    for (let p = 0; p < core.length; p++) if (C.lab[p] && cmax[C.lab[p]] > hw * o.fillCore) { big[p] = 1; any = true; }
    if (any) {
      const inv = new Uint8Array(W * H); for (let p = 0; p < inv.length; p++) inv[p] = big[p] ? 0 : 1;
      const d = edt(inv, W, H), r = hw * 1.3 + 2;
      for (let p = 0; p < fill.length; p++) if (d[p] <= r && ink[p]) fill[p] = 1;
    }
    return fill;
  }

  // marching squares -> closed rings (even-odd fill)
  function contours(mask, W, H) {
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : mask[y * W + x];
    const segs = new Map();  // key "x,y" of start -> list of [sx,sy,ex,ey]
    const key = (x, y) => x * 2 + ',' + y * 2;
    const add = (ax, ay, bx, by) => { const k = key(ax, ay); if (!segs.has(k)) segs.set(k, []); segs.get(k).push([ax, ay, bx, by]); };
    for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
      const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
      const c = tl * 8 + tr * 4 + br * 2 + bl;
      if (c === 0 || c === 15) continue;
      const T = [x + 1, y + 0.5], R = [x + 1.5, y + 1], B = [x + 1, y + 1.5], L = [x + 0.5, y + 1];
      // pixel centres sit at integer+0.5 after the +0.5 shift; segments wind with ink on the left
      switch (c) {
        case 1: add(...B, ...L); break;   case 2: add(...R, ...B); break;
        case 3: add(...R, ...L); break;   case 4: add(...T, ...R); break;
        case 5: add(...T, ...L); add(...B, ...R); break;
        case 6: add(...T, ...B); break;   case 7: add(...T, ...L); break;
        case 8: add(...L, ...T); break;   case 9: add(...B, ...T); break;
        case 10: add(...L, ...B); add(...R, ...T); break;
        case 11: add(...R, ...T); break;  case 12: add(...L, ...R); break;
        case 13: add(...B, ...R); break;  case 14: add(...L, ...B); break;
      }
    }
    const rings = [];
    for (const [k0, list] of segs) {
      while (list.length) {
        const s0 = list.pop(); const ring = [s0[0] - 0.5, s0[1] - 0.5];
        let ex = s0[2], ey = s0[3], guard = 0;
        while (guard++ < 1e6) {
          const k = key(ex, ey); const nx = segs.get(k);
          if (!nx || !nx.length) break;
          const s = nx.pop(); ring.push(s[0] - 0.5, s[1] - 0.5); ex = s[2]; ey = s[3];
        }
        if (ring.length >= 12) rings.push(ring);
      }
    }
    return rings;
  }

  // ---------- main -----------------------------------------------------------

  function trace(rgba, W, H, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const gray = toGray(rgba, W, H);
    const thr = o.threshold > 0 ? o.threshold : otsu(gray);
    let ink = new Uint8Array(W * H);
    for (let i = 0; i < ink.length; i++) ink[i] = gray[i] <= thr ? 1 : 0;
    ink = morph(morph(ink, W, H, true), W, H, false);       // opening
    ink = morph(morph(ink, W, H, false), W, H, true);       // closing
    { const { lab, area } = label(ink, W, H);
      for (let i = 0; i < ink.length; i++) if (ink[i] && area[lab[i]] < o.minSpeck) ink[i] = 0; }

    const dt = edt(ink, W, H);
    const sk0 = skeletonize(ink, W, H);
    const vals = []; for (let p = 0; p < sk0.length; p++) if (sk0[p]) vals.push(dt[p]);
    if (!vals.length) return emptyResult(W, H, 'No line art found');
    vals.sort((a, b) => a - b);
    const hw = vals[vals.length >> 1];

    const fill = findFills(ink, dt, sk0, hw, W, H, o);
    const lineInk = new Uint8Array(W * H); for (let p = 0; p < ink.length; p++) lineInk[p] = ink[p] && !fill[p] ? 1 : 0;
    const sk = skeletonize(lineInk, W, H);
    const g = traceGraph(sk, W, H);
    let edges = g.edges;

    // prune short spurs: dangling end attached to a junction
    for (let pass = 0; pass < 2; pass++) {
      const deg = nodeDegrees(edges);
      edges = edges.filter(e => {
        if (e.closed) return polyLen(e.pts) > 6;
        const L = polyLen(e.pts);
        if (L < 3) return false;
        const da = deg.get(e.a) || 0, db = deg.get(e.b) || 0;
        const dangling = (da === 1) + (db === 1), joined = da >= 3 || db >= 3;
        return !(dangling === 1 && joined && L < o.spur * hw);
      });
      edges = mergeChains(edges);
    }

    const deg = nodeDegrees(edges);
    const strokes = [];
    for (const e of edges) {
      let pts = e.pts.slice();
      const freeA = !e.closed && (deg.get(e.a) || 0) <= 1, freeB = !e.closed && (deg.get(e.b) || 0) <= 1;
      if (!e.closed) {   // snap junction ends to the junction centre so strokes meet cleanly
        if (!freeA && e.a) { pts[0] = g.cx[e.a]; pts[1] = g.cy[e.a]; }
        if (!freeB && e.b) { pts[pts.length - 2] = g.cx[e.b]; pts[pts.length - 1] = g.cy[e.b]; }
      }
      let q = resample(pts, 1.5, e.closed);
      q = gaussSmooth(q, Math.max(2, hw * o.smooth), e.closed, freeA, freeB);
      q = rdp(resample(q, 1.0, e.closed), o.simplify, e.closed);
      if (q.length < 4) continue;
      strokes.push({ points: q.map(v => Math.round(v * 10) / 10), closed: e.closed, ends: e.closed ? [0, 0] : [freeA ? 1 : 0, freeB ? 1 : 0] });
    }

    const rings = contours(fill, W, H).map(r => rdp(gaussSmooth(r, 1.5, true), 0.3, true).map(v => Math.round(v * 10) / 10)).filter(r => r.length >= 8);
    const fills = rings.length ? [{ rings }] : [];

    // quality flags for review
    const flags = [];
    const tiny = strokes.filter(s => !s.closed && polyLen(s.points) < 3 * hw).length;
    if (strokes.length > 160) flags.push('Very many strokes: may be noisy or textured');
    if (tiny > 25) flags.push('Lots of tiny marks');
    let fillPx = 0, inkPx = 0; for (let p = 0; p < ink.length; p++) { inkPx += ink[p]; fillPx += fill[p]; }
    if (inkPx && fillPx / inkPx > 0.3) flags.push('Large solid areas: check fills');
    return {
      version: 1, width: W, height: H, lineWidth: Math.round(hw * 2 * 100) / 100,
      threshold: thr, strokes, fills, flags,
      stats: { strokes: strokes.length, fills: rings.length, inkPx, fillPx },
    };
  }

  function emptyResult(W, H, why) {
    return { version: 1, width: W, height: H, lineWidth: 0, strokes: [], fills: [], flags: [why], stats: { strokes: 0, fills: 0 } };
  }

  // ---------- export ---------------------------------------------------------

  // Catmull-Rom -> cubic Bézier path data (shared with the renderer)
  function pathData(pts, closed, sx = 1, sy = 1, ox = 0, oy = 0) {
    const n = pts.length / 2; if (n < 2) return '';
    const X = i => pts[2 * i] * sx + ox, Y = i => pts[2 * i + 1] * sy + oy;
    const f = v => (Math.round(v * 10) / 10).toString();
    let d = 'M' + f(X(0)) + ' ' + f(Y(0));
    const idx = i => closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const i0 = idx(i - 1), i1 = idx(i), i2 = idx(i + 1), i3 = idx(i + 2);
      const c1x = X(i1) + (X(i2) - X(i0)) / 6, c1y = Y(i1) + (Y(i2) - Y(i0)) / 6;
      const c2x = X(i2) - (X(i3) - X(i1)) / 6, c2y = Y(i2) - (Y(i3) - Y(i1)) / 6;
      d += 'C' + f(c1x) + ' ' + f(c1y) + ' ' + f(c2x) + ' ' + f(c2y) + ' ' + f(X(i2)) + ' ' + f(Y(i2));
    }
    return closed ? d + 'Z' : d;
  }

  // Editable centerline SVG: open strokes for Affinity (apply any brush there), fills as shapes
  function toSVG(data, opts) {
    const o = Object.assign({ lineScale: 1, color: '#000000', background: null }, opts || {});
    const lw = (data.lineWidth || 2) * o.lineScale;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${data.width} ${data.height}" width="${data.width}" height="${data.height}">\n`;
    if (o.background) s += `<rect width="100%" height="100%" fill="${o.background}"/>\n`;
    s += `<g id="lines" fill="none" stroke="${o.color}" stroke-width="${lw.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">\n`;
    for (const st of data.strokes) s += `<path d="${pathData(st.points, st.closed)}"/>\n`;
    s += '</g>\n';
    if (data.fills.length) {
      s += `<g id="fills" fill="${o.color}" fill-rule="evenodd">\n`;
      for (const f of data.fills) s += `<path d="${f.rings.map(r => pathData(r, true)).join(' ')}"/>\n`;
      s += '</g>\n';
    }
    return s + '</svg>\n';
  }

  return { trace, toSVG, pathData, DEFAULTS, resample, rdp };
}

if (typeof self !== 'undefined') self.SBLineTrace = SBLineTraceFactory();
if (typeof module !== 'undefined') module.exports = SBLineTraceFactory;
