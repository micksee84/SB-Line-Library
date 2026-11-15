# Sunshine Brigade Line Library

The master copy of the Sunshine Brigade line art, stored as **centerline vector data**.
The worksheet builder loads pictures from the published copy of this repo and draws them in
whichever style the user picks (clean line, fine liner, brush pen, wax crayon), at any size,
with the line weight set for the printed page.

## What's in here

```
library/<category>/<id>.sbline.json   one file per picture (the source of truth)
categories.json                       category names, order, and which file prefixes map to them
scripts/import.mjs                    PNG folder -> library files
scripts/build.mjs                     library -> dist/ (catalogue, pictures, thumbnails, gallery)
site/index.html                       the gallery page
```

Each `.sbline.json` holds the picture's centerlines and solid fills plus its `name` and `tags`.
You can edit `name` and `tags` by hand; re-importing keeps them.

## Adding pictures

**With the Line Converter app** (recommended): open a batch, choose **Save to: Library**, pick this
repo folder, and convert. Files land in the right category folders.

**From the command line:**

```
npm install
npm run import -- "/path/to/Krea Batch 09"
```

File names follow the redraw convention `NN-section_name.png` (e.g. `01-farm_barn.png`).
A new section needs a line in `categories.json` first.

Then commit and push. A push runs the check (GitHub Actions) and Cloudflare Pages republishes.

## Publishing with GitHub Pages (while the repo is public)

Repo **Settings → Pages → Source: GitHub Actions**. Every push to `main` then publishes to
`https://micksee84.github.io/sb-line-library/` (gallery at that address, catalogue at `/catalog.json`).
GitHub Pages needs a public repo on the free plan; switch to Cloudflare Pages below if you make it private.

## Publishing (Cloudflare Pages, one-time setup)

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick `SB-Line-Library`.
2. Build command: `npm run build` · Build output directory: `dist` · Environment variable `NODE_VERSION=22`.
3. Deploy. Every push to `main` republishes; other branches get preview URLs for testing a batch first.

Published layout (what the builder reads):

| URL | Contents |
|---|---|
| `/catalog.json` | every picture grouped by category, with names, tags, file and thumbnail paths |
| `/pictures/<category>/<id>.json` | line data for one picture |
| `/thumbs/<category>/<id>.svg` | small clean-line preview |
| `/` | browsable gallery with style previews |

## Versions

Bump `version` in `package.json` and tag a release (`v1.1`, `v1.2`…) when a batch is ready.
The catalogue reports its version so the builder can show or check it.
