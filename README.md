# mlweb – open online MATLAB-style notebook (image-processing subset)

Everything runs in the browser (interpreter in a Web Worker). No server needed; Vercel only serves one static file.

    cd packages/interp && npm install && npm test        # 31 headless tests
    cd packages/interp && npx tsx test/lessons.ts        # runs every code cell of the 9 lessons headless
    cd apps/web && npm install && npm run build          # -> apps/web/dist/index.html (single file, ~265 KB)

Deploy on Vercel: import the repo; `vercel.json` already sets install/build/output.

## Layout
- `packages/interp` – lexer/parser, N-d arrays with uint8 saturation, indexing, printing, builtins, image toolbox (DOM-free).
- `apps/web` – notebook UI: cells (code/text), Run / Run all / Stop (60 s limit), Workspace, Current Folder (upload/download),
  Command History, figures with pixel inspector and zoom, `.m` and `.ipynb` import/export, autosave in localStorage.

## Known gaps
switch, cell arrays, struct field syntax (`s.x`); `histeq`; `imresize` bicubic; `imrotate` non-90° angles; `imhist` plot;
`help`/`doc` are no-ops (function reference page planned). Uploaded images are always treated as RGB; `imwrite` file sizes are raw bytes.
Matrix print spacing and `imfinfo`/`whos` layout are unverified against real MATLAB.

## Lessons
`apps/web/lessons/*.txt` (Sections 1-4, Lectures 1-5). Format: header lines `@id`, `@title`, `@group`, `@files a.png b.png`, then cells separated by `%% md` / `%% code`.
Images live in `apps/web/assets/assets.json` (raw pixels + colormap for indexed GIF). Deep links: `/#section-2`, `/#lecture-5`.
Add a lesson: drop a new `.txt` in `lessons/`, add its id to `order` in `apps/web/lessons.mjs`, rebuild.

## SEO / deployment (Vercel)
`public/` (favicon, apple-touch-icon, og-image.jpg, manifest) is copied to `dist/`; the build also writes `robots.txt` and `sitemap.xml`.
Set the real domain: Vercel > Settings > Environment Variables > `SITE_URL=https://your-domain` (otherwise Vercel's production URL is used).
Replace `public/favicon.*` and `public/og-image.jpg` with your own art, keeping the same file names (og-image: 1200x630).
