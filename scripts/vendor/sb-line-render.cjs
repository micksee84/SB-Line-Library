/*
 * Sunshine Brigade line renderer
 * ------------------------------
 * Draws SB Line data (from sb-line-trace.js) with a natural-media brush.
 *
 *   const canvas = SBLineRender.render(data, { size: 1024, style: 'ink', lineWidth: 8 });
 *
 * lineWidth is in OUTPUT pixels, independent of the picture size. That is the
 * fix for small layouts turning into blobs: the builder works out lineWidth
 * from a real page unit (e.g. 0.8 mm at 300 dpi = ~9.4 px) for every picture,
 * so small pictures get proportionally thinner lines.
 *
 * Self-contained factory: works on the main thread and in Web Workers
 * (OffscreenCanvas), and is meant to be dropped into the worksheet builder.
 */
function SBLineRenderFactory() {
  'use strict';

  // Style presets. wobble = width variation (0-1), wobbleLength = × line width,
  // taper = end thickness at free ends (1 = no taper).
  const STYLES = {
    clean:     { label: 'Clean line',    dab: 'round',    spacing: 0.15, sizeJitter: 0,     angleJitter: 0,    wobble: 0,    taper: 1,    bead: 0,    post: 'none' },
    fineliner: { label: 'Fine liner',    dab: 'round',    spacing: 0.08, sizeJitter: 0.015, angleJitter: 0,    wobble: 0.05, taper: 0.9,  bead: 1.12, post: 'fineliner' },
    ink:       { label: 'Brush pen ink', dab: 'ink',      spacing: 0.10, sizeJitter: 0.04,  angleJitter: 0.25, wobble: 0.18, taper: 0.55, bead: 0,    post: 'ink' },
    crayon:    { label: 'Wax crayon',    dab: 'crayon',   spacing: 0.08, sizeJitter: 0.08,  angleJitter: 0.6,  wobble: 0.18, taper: 0.7,  bead: 0,    post: 'crayon' },
  };

  // ---------- helpers ---------------------------------------------------------

  function rng(seed) {             // mulberry32
    let a = (seed >>> 0) || 1;
    const f = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    f.normal = () => { let u = 0, v = 0; while (!u) u = f(); while (!v) v = f(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    return f;
  }

  function makeCanvas(w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#000000'); const v = m ? parseInt(m[1], 16) : 0;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // ---------- dabs -------------------------------------------------------------

  const dabCache = {};
  function dab(kind, variant) {
    const key = kind + variant; if (dabCache[key]) return dabCache[key];
    const n = 128, c = makeCanvas(n, n), ctx = c.getContext('2d'), img = ctx.createImageData(n, n);
    const r = rng(1000 + variant * 77 + kind.length);
    const ph = [r() * 6.28, r() * 6.28, r() * 6.28];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n * 2 - 1, v = (y + 0.5) / n * 2 - 1;
      const ang = Math.atan2(v, u), rad = Math.hypot(u, v);
      let a;
      if (kind === 'ink') {           // firm, slightly elliptical brush-pen tip, wavy edge
        const edge = 0.92 + 0.05 * Math.sin(3 * ang + ph[0]) + 0.03 * Math.sin(7 * ang + ph[1]);
        a = (edge - Math.hypot(u, v / 0.78)) * 18;
      } else if (kind === 'crayon') { // waxy flat tip with a chewed edge
        const edge = 0.88 + 0.08 * Math.sin(5 * ang + ph[0]) + 0.04 * Math.sin(11 * ang + ph[2]);
        a = (edge - rad) * 10;
      } else {                        // round felt / technical tip
        a = (0.96 - rad) * 40;
      }
      const i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.max(0, Math.min(1, a)) * 255;
    }
    ctx.putImageData(img, 0, 0);
    return (dabCache[key] = c);
  }

  // ---------- noise ------------------------------------------------------------

  function valueNoise(W, H, period, rnd) {
    const gw = Math.ceil(W / period) + 2, gh = Math.ceil(H / period) + 2;
    const g = new Float32Array(gw * gh); for (let i = 0; i < g.length; i++) g[i] = rnd();
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const fy = y / period, iy = fy | 0; let ty = fy - iy; ty = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < W; x++) {
        const fx = x / period, ix = fx | 0; let tx = fx - ix; tx = tx * tx * (3 - 2 * tx);
        const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
        out[y * W + x] = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
      }
    }
    return out;
  }

  function fbm(W, H, rnd, octaves) {      // octaves: [[periodPx, amp], ...]
    const out = new Float32Array(W * H);
    for (const [p, amp] of octaves) { const n = valueNoise(W, H, Math.max(1, p), rnd); for (let i = 0; i < out.length; i++) out[i] += amp * n[i]; }
    return normalize(out);
  }

  function normalize(a) {
    let lo = Infinity, hi = -Infinity; for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const s = 1 / Math.max(1e-9, hi - lo); for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * s; return a;
  }

  function equalize(a) {                  // map to uniform [0,1] so thresholds behave predictably
    const B = 1024, h = new Float64Array(B);
    for (const v of a) h[Math.min(B - 1, (v * B) | 0)]++;
    for (let i = 1; i < B; i++) h[i] += h[i - 1];
    for (let i = 0; i < a.length; i++) a[i] = h[Math.min(B - 1, (a[i] * B) | 0)] / a.length;
    return a;
  }

  function blur(src, W, H, sx, sy) {      // separable gaussian
    if (sy === undefined) sy = sx;
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    const kern = s => { if (s < 0.2) return [1]; const r = Math.ceil(s * 3), k = []; let t = 0;
      for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * s * s)); k.push(v); t += v; } return k.map(v => v / t); };
    const kx = kern(sx), ky = kern(sy), rx = kx.length >> 1, ry = ky.length >> 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0; for (let k = -rx; k <= rx; k++) { const xx = Math.max(0, Math.min(W - 1, x + k)); s += src[y * W + xx] * kx[k + rx]; } tmp[y * W + x] = s;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0; for (let k = -ry; k <= ry; k++) { const yy = Math.max(0, Math.min(H - 1, y + k)); s += tmp[yy * W + x] * ky[k + ry]; } out[y * W + x] = s;
    }
    return out;
  }

  function paperGrain(W, H, rnd, tooth) {
    const fine = blur(valueNoise(W, H, tooth, rnd), W, H, 0.6);
    const fibre = blur(valueNoise(W, H, 1, rnd), W, H, 5, 0.7);
    normalize(fibre);
    const big = fbm(W, H, rnd, [[256, 1], [51, 0.6], [13, 0.4]]);
    const g = new Float32Array(W * H);
    for (let i = 0; i < g.length; i++) g[i] = 0.65 * fine[i] + 0.2 * fibre[i] + 0.35 * big[i];
    return equalize(normalize(g));
  }

  // ---------- geometry -----------------------------------------------------------

  // Catmull-Rom densify to ~1 output px spacing; returns {x, y, s} arrays
  function densify(pts, closed, k, ox, oy) {
    const n = pts.length / 2, X = [], Y = [];
    const idx = i => closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    const P = i => [pts[2 * idx(i)] * k + ox, pts[2 * idx(i) + 1] * k + oy];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      const steps = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])));
      for (let j = 0; j < steps; j++) {
        const t = j / steps, t2 = t * t, t3 = t2 * t;
        X.push(0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3));
        Y.push(0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3));
      }
    }
    const last = closed ? P(0) : P(n - 1); X.push(last[0]); Y.push(last[1]);
    const S = [0]; for (let i = 1; i < X.length; i++) S.push(S[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]));
    return { X, Y, S };
  }

  function sample(d, t) {          // position + direction at arclength t
    const { X, Y, S } = d; let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] < t) lo = m; else hi = m; }
    const u = (t - S[lo]) / Math.max(1e-9, S[hi] - S[lo]);
    return [X[lo] + (X[hi] - X[lo]) * u, Y[lo] + (Y[hi] - Y[lo]) * u, Math.atan2(Y[hi] - Y[lo], X[hi] - X[lo])];
  }

  // ---------- render -----------------------------------------------------------

  /**
   * opts:
   *   size        output px of the longest side (or use scale)
   *   scale       output px per source px (overrides size)
   *   lineWidth   output px; default = source line width × scale × lineScale
   *   lineScale   multiplier when lineWidth isn't given (default 1)
   *   style       'clean' | 'fineliner' | 'ink' | 'crayon'
   *   wobble, wobbleLength, taper   override the style preset
   *   minDetail   skip open strokes shorter than this × lineWidth (tiny-size cleanup), default 0
   *   seed, color ('#rrggbb'), background ('#ffffff' or null for transparent), padding (px)
   */
  function render(data, opts) {
    const o = Object.assign({ style: 'ink', lineScale: 1, seed: 7, color: '#000000', background: '#ffffff', padding: 0, minDetail: 0, wobbleLength: 7 }, opts || {});
    const st = Object.assign({}, STYLES[o.style] || STYLES.ink);
    if (o.wobble != null) st.wobble = o.wobble;
    if (o.taper != null) st.taper = o.taper;
    const pad = o.padding;
    const k = o.scale || ((o.size || 1024) - 2 * pad) / Math.max(data.width, data.height);
    const W = Math.round(data.width * k + 2 * pad), H = Math.round(data.height * k + 2 * pad);
    const lw = o.lineWidth || Math.max(0.5, (data.lineWidth || 2) * k * o.lineScale);
    const rnd = rng(o.seed);

    // 1. coverage mask: white dabs on black
    const mc = makeCanvas(W, H), m = mc.getContext('2d');
    m.fillStyle = '#000'; m.fillRect(0, 0, W, H);
    const dabs = [0, 1, 2, 3, 4, 5].map(v => dab(st.dab, v));
    data.strokes.forEach((s, si) => {
      const d = densify(s.points, s.closed, k, pad, pad);
      const L = d.S[d.S.length - 1];
      if (L < 0.5) return;
      if (!s.closed && o.minDetail && L < o.minDetail * lw) return;
      const sr = rng(o.seed * 7919 + si * 104729);
      const f1 = (0.8 + sr() * 0.45) / (o.wobbleLength * lw), f2 = 2.1 * (0.8 + sr() * 0.45) / (o.wobbleLength * lw);
      const p1 = sr() * 6.283, p2 = sr() * 6.283;
      const tl = Math.min(2.5 * lw, L / 2);
      const ramp = dist => { let t = Math.max(0, Math.min(1, dist / Math.max(tl, 1e-6))); t = t * t * (3 - 2 * t); return st.taper + (1 - st.taper) * t; };
      const width = t => {
        let w = lw * (1 + st.wobble * (Math.sin(6.283 * f1 * t + p1) + 0.35 * Math.sin(6.283 * f2 * t + p2)) / 1.35);
        if (!s.closed && s.ends[0]) w *= ramp(t);
        if (!s.closed && s.ends[1]) w *= ramp(L - t);
        return w;
      };
      for (let t = 0; t <= L; ) {
        const [x, y, a] = sample(d, t), wd = width(t);
        const size = wd * (1 + st.sizeJitter * rnd.normal());
        const ang = a + st.angleJitter * rnd.normal();
        const jx = rnd.normal() * wd * 0.03, jy = rnd.normal() * wd * 0.03;
        m.setTransform(Math.cos(ang), Math.sin(ang), -Math.sin(ang), Math.cos(ang), x + jx, y + jy);
        m.drawImage(dabs[(rnd() * dabs.length) | 0], -size / 2, -size / 2, size, size);
        t += Math.max(0.35, wd * st.spacing * (0.7 + 0.6 * rnd()));
      }
      if (st.bead && !s.closed) {            // ink pools where the pen lands and lifts
        for (const t of [0, L]) { const [x, y] = sample(d, t); const b = lw * st.bead;
          m.setTransform(1, 0, 0, 1, x, y); m.drawImage(dabs[0], -b / 2, -b / 2, b, b); }
      }
    });
    m.setTransform(1, 0, 0, 1, 0, 0);
    if (data.fills.length) {                 // solid shapes (eyes, hooves)
      m.fillStyle = '#fff'; m.beginPath();
      for (const f of data.fills) for (const r of f.rings) {
        const d = densify(r, true, k, pad, pad);
        m.moveTo(d.X[0], d.Y[0]); for (let i = 1; i < d.X.length; i++) m.lineTo(d.X[i], d.Y[i]); m.closePath();
      }
      m.fill('evenodd');
    }

    // 2. medium: turn coverage into ink on paper
    const px = m.getImageData(0, 0, W, H).data;
    let a = new Float32Array(W * H);
    for (let i = 0; i < a.length; i++) a[i] = px[i * 4] / 255;
    if (st.post === 'fineliner') {
      const rough = fbm(W, H, rnd, [[16, 1], [4, 0.5], [2.3, 0.3]]), grain = paperGrain(W, H, rnd, 1.6);
      a = blur(a, W, H, 0.9);
      for (let i = 0; i < a.length; i++) a[i] = Math.max(0, Math.min(1, (a[i] + (rough[i] - 0.5) * 0.12 - 0.5) * 5)) * (0.96 + 0.04 * grain[i]);
    } else if (st.post === 'ink') {
      const rough = fbm(W, H, rnd, [[32, 1], [8, 0.6], [2.9, 0.4]]), grain = paperGrain(W, H, rnd, 1.6);
      a = blur(a, W, H, 1.2);
      for (let i = 0; i < a.length; i++) a[i] = Math.max(0, Math.min(1, (a[i] + (rough[i] - 0.5) * 0.35 - 0.45) * 6)) * (0.93 + 0.07 * grain[i]);
    } else if (st.post === 'crayon') {
      const grain = paperGrain(W, H, rnd, 1.6), tooth = paperGrain(W, H, rnd, 3.5);
      a = blur(a, W, H, 0.8);
      for (let i = 0; i < a.length; i++) { const t = 0.75 * tooth[i] + 0.25 * grain[i]; a[i] = Math.max(0, Math.min(1, (a[i] - (1 - t) * 0.95) * 3.5)); }
    }

    // 3. compose
    const out = makeCanvas(W, H), oc = out.getContext('2d'), img = oc.createImageData(W, H);
    const [r, g, b] = hexToRgb(o.color), bg = o.background ? hexToRgb(o.background) : null;
    for (let i = 0; i < a.length; i++) {
      const j = i * 4, al = a[i];
      if (bg) { img.data[j] = bg[0] + (r - bg[0]) * al; img.data[j + 1] = bg[1] + (g - bg[1]) * al; img.data[j + 2] = bg[2] + (b - bg[2]) * al; img.data[j + 3] = 255; }
      else { img.data[j] = r; img.data[j + 1] = g; img.data[j + 2] = b; img.data[j + 3] = al * 255; }
    }
    oc.putImageData(img, 0, 0);
    return out;
  }

  // Line width in output px for a real page unit, e.g. lineWidthFor(0.8, 'mm', 300)
  function lineWidthFor(value, unit, dpi) {
    const inch = unit === 'mm' ? value / 25.4 : unit === 'pt' ? value / 72 : value;
    return inch * (dpi || 300);
  }

  return { render, STYLES, lineWidthFor };
}

if (typeof self !== 'undefined') self.SBLineRender = SBLineRenderFactory();
if (typeof module !== 'undefined') module.exports = SBLineRenderFactory;
