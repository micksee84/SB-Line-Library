#!/usr/bin/env node
/*
 * Import line-art PNGs into the library.
 *
 *   npm run import -- "/path/to/Krea Batch 01" "/path/to/Krea Batch 02"
 *   npm run import -- --dry "/path/to/folder"      (report only, write nothing)
 *
 * File names follow the redraw convention:  NN-section_name[_vN].png
 *   e.g. 01-farm_barn.png -> library/farm/barn.sbline.json
 * The section prefix is mapped to a category in categories.json.
 * Re-importing a picture replaces its line data but keeps any name/tags you edited.
 * The worksheet builder only reads the published catalogue, so nothing here goes live until you push.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const T = require('./vendor/sb-line-trace.cjs')();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATS = JSON.parse(fs.readFileSync(path.join(ROOT, 'categories.json'), 'utf8'));
const prefixToCat = {};
for (const [id, c] of Object.entries(CATS)) for (const p of c.prefixes) prefixToCat[p] = id;

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const dirs = args.filter(a => !a.startsWith('--'));
if (!dirs.length) { console.error('Usage: npm run import -- <folder> [folder...]'); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
const titleCase = s => s.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
let ok = 0, skipped = 0, flagged = [];

for (const dir of dirs) {
  const files = fs.readdirSync(dir).filter(f => /\.png$/i.test(f) && !f.startsWith('_') && !f.startsWith('.')).sort();
  for (const f of files) {
    const m = /^(\d+-[a-z]+)_(.+?)(?:_v\d+)?\.png$/i.exec(f);
    const cat = m && prefixToCat[m[1].toLowerCase()];
    if (!cat) { console.warn(`skip  ${f}  (no category for prefix "${m ? m[1] : '?'}")`); skipped++; continue; }
    const id = m[2].toLowerCase();
    const png = PNG.sync.read(fs.readFileSync(path.join(dir, f)));
    const data = T.trace(png.data, png.width, png.height);
    const out = path.join(ROOT, 'library', cat, id + '.sbline.json');
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) {}
    const rec = {
      id, category: cat,
      name: prev.name || titleCase(id),
      tags: prev.tags || id.split('-'),
      source: path.basename(dir) + '/' + f,
      added: prev.added || today, updated: today,
      ...data,
    };
    delete rec.stats; delete rec.threshold;
    if (rec.flags.length) flagged.push(`${cat}/${id}: ${rec.flags.join('; ')}`);
    if (!dry) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rec) + '\n'); }
    ok++;
    process.stdout.write(`${dry ? 'check' : 'saved'} ${cat}/${id}  (${data.strokes.length} strokes)\n`);
  }
}
console.log(`\n${ok} imported, ${skipped} skipped${dry ? ' (dry run, nothing written)' : ''}`);
if (flagged.length) console.log('\nTo check:\n  ' + flagged.join('\n  '));
