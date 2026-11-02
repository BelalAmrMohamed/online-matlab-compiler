# mlweb – open online MATLAB-style notebook (image-processing subset)

Everything runs in the browser (interpreter in a Web Worker). No server needed; Vercel only serves one static file.

    cd packages/interp && npm install && npm test        # 31 headless tests (uses the real Section 1 images)
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
