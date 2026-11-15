#!/usr/bin/env node
/*
 * Build the published library into dist/ (what Cloudflare Pages serves).
 *
 *   dist/catalog.json                    every picture, grouped by category
 *   dist/pictures/<category>/<id>.json   line data the builder draws from
 *   dist/thumbs/<category>/<id>.svg      small clean-line previews
 *   dist/index.html                      a browsable gallery of the library
 *
 * Also validates every file, so a broken picture fails the build instead of reaching the builder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const T = require('./vendor/sb-line-trace.cjs')();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'library'), DIST = path.join(ROOT, 'dist');
const CATS = JSON.parse(fs.readFileSync(path.join(ROOT, 'categories.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const errors = [], categories = [];
let count = 0;
for (const [catId, cat] of Object.entries(CATS).sort((a, b) => a[1].order - b[1].order)) {
  const dir = path.join(LIB, catId);
  if (!fs.existsSync(dir)) continue;
  const items = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sbline.json')).sort()) {
    const rel = `${catId}/${f}`;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { errors.push(`${rel}: not valid JSON`); continue; }
    const id = f.replace('.sbline.json', '');
    const problems = [];
    if (d.id !== id) problems.push(`id "${d.id}" does not match file name`);
    if (d.category !== catId) problems.push(`category "${d.category}" does not match folder`);
    if (!(d.width > 0 && d.height > 0)) problems.push('missing width/height');
    if (!Array.isArray(d.strokes) || !Array.isArray(d.fills)) problems.push('missing strokes/fills');
    else {
      if (!d.strokes.length && !d.fills.length) problems.push('empty picture');
      d.strokes.forEach((s, i) => { if (!Array.isArray(s.points) || s.points.length < 4 || s.points.length % 2) problems.push(`stroke ${i} has bad points`); });
    }
    if (problems.length) { errors.push(`${rel}: ${problems.join(', ')}`); continue; }

    const pic = { version: d.version || 1, id, category: catId, name: d.name, width: d.width, height: d.height, lineWidth: d.lineWidth, strokes: d.strokes, fills: d.fills };
    fs.mkdirSync(path.join(DIST, 'pictures', catId), { recursive: true });
    fs.mkdirSync(path.join(DIST, 'thumbs', catId), { recursive: true });
    fs.writeFileSync(path.join(DIST, 'pictures', catId, id + '.json'), JSON.stringify(pic));
    fs.writeFileSync(path.join(DIST, 'thumbs', catId, id + '.svg'), T.toSVG(pic, { lineScale: 0.8 }));
    items.push({ id, name: d.name, tags: d.tags || [], width: d.width, height: d.height,
      file: `pictures/${catId}/${id}.json`, thumb: `thumbs/${catId}/${id}.svg`, added: d.added, flags: (d.flags || []).length ? d.flags : undefined });
    count++;
  }
  if (items.length) categories.push({ id: catId, label: cat.label, order: cat.order, items });
}

if (errors.length) {
  console.error(`Build failed: ${errors.length} problem(s)\n  ` + errors.join('\n  '));
  process.exit(1);
}

const catalog = { library: 'Sunshine Brigade line art', version: pkg.version, generated: new Date().toISOString(), count, categories };
fs.writeFileSync(path.join(DIST, 'catalog.json'), JSON.stringify(catalog));
fs.copyFileSync(path.join(ROOT, 'site', 'index.html'), path.join(DIST, 'index.html'));
fs.mkdirSync(path.join(DIST, 'engine'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'scripts', 'vendor', 'sb-line-render.cjs'), path.join(DIST, 'engine', 'sb-line-render.js'));
fs.copyFileSync(path.join(ROOT, 'scripts', 'vendor', 'sb-line-trace.cjs'), path.join(DIST, 'engine', 'sb-line-trace.js'));
// Cloudflare Pages headers: the builder (another origin) may read the library; short cache on the catalogue
fs.writeFileSync(path.join(DIST, '_headers'), `/*\n  Access-Control-Allow-Origin: *\n/catalog.json\n  Cache-Control: public, max-age=300\n/pictures/*\n  Cache-Control: public, max-age=86400\n`);
console.log(`Built ${count} pictures in ${categories.length} categories -> dist/`);
