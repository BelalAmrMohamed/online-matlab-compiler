declare const __WORKER_SRC__: string;
declare const __ASSETS__: Record<string, { width: number; height: number; channels: 1 | 3; b64: string; bitDepth: number; format: string; fileSize: number; colorType: string; filename: string; fileModDate: string; colormap?: number[][] }>;
interface Lesson { id: string; title: string; group: string; files: string[]; cells: { type: 'code' | 'md'; src: string }[] }
declare const __LESSONS__: Lesson[];

type Out = { k: 'text' | 'err' | 'warn'; s: string } | { k: 'img'; fig: number; w: number; h: number; rgb: Uint8Array; tool: boolean };
interface Cell { id: number; type: 'code' | 'md'; src: string; outs: Out[]; count: number | null; running: boolean; mdEdit: boolean }
interface FileRec { name: string; img: any }

const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) (e as any)[k] = v; else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : String(v)); }
  for (const c of kids) e.append(c);
  return e;
};
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } } };

// ---------------- state ----------------
let nextId = 1;
let cells: Cell[] = [];
let sel = 0;
const files = new Map<string, any>();
let vars: { name: string; size: string; cls: string; bytes: number }[] = [];
let cmdHist: string[] = [];
let execCount = 0;
let worker: Worker; let workerReady = false;
let curRun: { id: number; resolve: () => void; timer: number; fig: number } | null = null;

const mkCell = (type: 'code' | 'md', src: string): Cell => ({ id: nextId++, type, src, outs: [], count: null, running: false, mdEdit: false });

// ---------------- worker ----------------
function startWorker() {
  if (worker) worker.terminate();
  const url = URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' }));
  worker = new Worker(url); workerReady = false;
  worker.onmessage = onWorkerMsg;
  worker.onerror = ev => { appendOut('err', 'Worker error: ' + ev.message); finishRun(); };
  for (const [name, img] of files) worker.postMessage({ t: 'putFile', name, img });
}
function appendOut(k: 'text' | 'err' | 'warn', s: string) {
  if (!curRun) return; const c = cells.find(x => x.id === curRun!.id); if (!c) return;
  const last = c.outs[c.outs.length - 1];
  if (k === 'text' && last && last.k === 'text') last.s += s; else c.outs.push({ k, s: k === 'warn' ? s.replace(/\n?$/, '\n') : s });
  scheduleRender();
}
function onWorkerMsg(e: MessageEvent) {
  const m = e.data;
  switch (m.t) {
    case 'ready': workerReady = true; break;
    case 'print': appendOut('text', m.s); break;
    case 'warn': appendOut('warn', m.s); break;
    case 'clc': if (curRun) { const c = cells.find(x => x.id === curRun!.id)!; c.outs = c.outs.filter(o => o.k === 'err'); scheduleRender(); } break;
    case 'fig': if (curRun) curRun.fig++; break;
    case 'img': if (curRun) {
      const c = cells.find(x => x.id === curRun!.id)!;
      if (curRun.fig === 0) curRun.fig = 1;
      const fig = m.tool ? -curRun.fig : curRun.fig;
      if (!m.tool) c.outs = c.outs.filter(o => !(o.k === 'img' && o.fig === fig));   // imshow into the same figure replaces the previous image
      c.outs.push({ k: 'img', fig, w: m.w, h: m.h, rgb: m.rgb, tool: m.tool }); scheduleRender();
    } break;
    case 'wrote': files.set(m.name, m.img); renderSide(); break;
    case 'vars': vars = m.vars; renderSide(); break;
    case 'done': if (curRun && curRun.id === m.id) {
      const c = cells.find(x => x.id === m.id);
      if (c && m.error) c.outs.push({ k: 'err', s: m.error + '\n' });
      vars = m.vars; finishRun(); renderSide();
    } break;
  }
}
function finishRun() {
  if (!curRun) return; clearTimeout(curRun.timer);
  const c = cells.find(x => x.id === curRun!.id); if (c) c.running = false;
  const r = curRun.resolve; curRun = null; setStatus('Idle'); render(); r();
}
function runCell(c: Cell): Promise<void> {
  if (c.type !== 'code') return Promise.resolve();
  if (curRun) return Promise.resolve();
  return new Promise(resolve => {
    c.outs = []; c.running = true; c.count = ++execCount;
    for (const ln of c.src.split(/\r?\n/)) { const t = ln.trim(); if (t && !t.startsWith('%') && t !== 'end') cmdHist.push(t); }
    cmdHist = cmdHist.slice(-300); store.set('mlweb.hist', JSON.stringify(cmdHist));
    const timer = window.setTimeout(() => {
      appendOut('err', 'Execution stopped: time limit (60 s) exceeded. The workspace was reset.\n'); startWorker(); vars = []; finishRun(); renderSide();
    }, 60000);
    curRun = { id: c.id, resolve, timer, fig: 0 };
    setStatus('Running…'); render();
    worker.postMessage({ t: 'run', id: c.id, src: c.src });
  });
}
function stopRun() {
  if (!curRun) return; appendOut('err', 'Execution interrupted by user. The workspace was reset.\n'); startWorker(); vars = []; finishRun(); renderSide();
}
async function runAll() { for (const c of cells) { if (c.type === 'code') await runCell(c); if (c.outs.some(o => o.k === 'err')) break; } }
function resetWorkspace() { if (curRun) return; worker.postMessage({ t: 'reset' }); vars = []; renderSide(); }

// ---------------- lessons ----------------
let curLesson: string | null = null;
function loadAsset(name: string) {
  if (files.has(name)) return; const s = __ASSETS__[name]; if (!s) return;
  const bin = atob(s.b64), d = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i);
  const { b64, ...rest } = s; void b64; files.set(name, { ...rest, data: d });
}
function openLesson(id: string, ask = true) {
  const L = __LESSONS__.find(l => l.id === id); if (!L || curRun) return;
  if (ask && !confirm(`Open "${L.title}"?\nThe current notebook will be replaced (use .ipynb / .m export first if you want to keep it).`)) return;
  L.files.forEach(loadAsset); cells = L.cells.map(c => mkCell(c.type, c.src)); sel = 0; curLesson = id;
  store.set('mlweb.lesson', id); save(); startWorker(); vars = []; render(); renderSide(); window.scrollTo(0, 0);
  history_.replaceState(null, '', '#' + id); const s = document.getElementById('lessons') as HTMLSelectElement | null; if (s) s.value = id;
  document.title = L.title + ' – MLWeb | Belal Amr Mohamed';
}
const history_ = window.history;
function lessonNav(): HTMLElement | null {
  const i = __LESSONS__.findIndex(l => l.id === curLesson); if (i < 0) return null;
  const go = (d: number) => $('button', { disabled: !__LESSONS__[i + d], onclick: () => openLesson(__LESSONS__[i + d].id) }, d < 0 ? '← Previous lesson' : 'Next lesson →');
  return $('div', { class: 'lessonnav' }, go(-1), $('span', {}, `Lesson ${i + 1} of ${__LESSONS__.length}: ${__LESSONS__[i].title}`), go(1));
}

// ---------------- persistence ----------------
const save = () => store.set('mlweb.nb', JSON.stringify(cells.map(c => ({ type: c.type, src: c.src }))));
function load(): Cell[] | null {
  const s = store.get('mlweb.nb'); if (!s) return null;
  try { const a = JSON.parse(s); if (Array.isArray(a) && a.length) return a.map((x: any) => mkCell(x.type === 'md' ? 'md' : 'code', String(x.src ?? ''))); } catch { /* ignore */ }
  return null;
}
function defaultNotebook(): Cell[] {
  return [
    mkCell('md', '# Welcome to MLWeb\nAn open, in-browser MATLAB-style notebook for image processing. Press **Shift+Enter** to run a cell.\n\nThe *Current Folder* panel already holds `test.png` (RGB) and `testgray.png` (grayscale) from Section 1.'),
    mkCell('code', "a = imread('test.png');\nsize(a)"),
    mkCell('code', "imshow(a), figure, imshow(rgb2gray(a));"),
    mkCell('code', "imfinfo('test.png')"),
    mkCell('code', "x = uint8([200 200 200]);\n(x(1)+x(2)+x(3))/3      % saturates at 255 first\nx(1)/3+x(2)/3+x(3)/3"),
  ];
}

// ---------------- markdown (tiny) ----------------
const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
function md(src: string): string {
  const inline = (t: string) => esc(t).replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>');
  const out: string[] = []; let list: 'ul' | 'ol' | null = null, para: string[] = [], code: string[] | null = null, tbl: string[][] | null = null;
  const flushT = () => { if (tbl) { out.push('<table>' + tbl.map((r, i) => '<tr>' + r.map(c => (i === 0 ? '<th>' : '<td>') + inline(c) + (i === 0 ? '</th>' : '</td>')).join('') + '</tr>').join('') + '</table>'); tbl = null; } };
  const flushP = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushL = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const ln of src.split(/\r?\n/)) {
    if (code) { if (/^```/.test(ln)) { out.push('<pre>' + esc(code.join('\n')) + '</pre>'); code = null; } else code.push(ln); continue; }
    if (/^```/.test(ln)) { flushP(); flushL(); code = []; continue; }
    let m;
    if (/^\s*\|.*\|\s*$/.test(ln)) { flushP(); flushL(); if (!tbl) tbl = []; if (!/^\s*\|[\s:|-]+\|\s*$/.test(ln)) tbl.push(ln.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim())); continue; }
    if (tbl) flushT();
    if ((m = /^(#{1,3})\s+(.*)/.exec(ln))) { flushP(); flushL(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = /^\s*[-*]\s+(.*)/.exec(ln))) { flushP(); if (list !== 'ul') { flushL(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(m[1]) + '</li>'); }
    else if ((m = /^\s*\d+\.\s+(.*)/.exec(ln))) { flushP(); if (list !== 'ol') { flushL(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(m[1]) + '</li>'); }
    else if (!ln.trim()) { flushP(); flushL(); } else { flushL(); para.push(ln.trim()); }
  }
  if (code) out.push('<pre>' + esc(code.join('\n')) + '</pre>'); flushP(); flushL(); flushT();
  return out.join('\n');
}

// ---------------- image helpers ----------------
function rawToCanvas(img: { width: number; height: number; channels: number; data: Uint8Array; colormap?: number[][] }): HTMLCanvasElement {
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const id = new ImageData(img.width, img.height), n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    if (img.channels === 1 && img.colormap) { const c = img.colormap[Math.min(img.colormap.length - 1, img.data[i])]; id.data[i * 4] = c[0] * 255; id.data[i * 4 + 1] = c[1] * 255; id.data[i * 4 + 2] = c[2] * 255; }
    else if (img.channels === 1) { const v = img.data[i]; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; }
    else { id.data[i * 4] = img.data[i * 3]; id.data[i * 4 + 1] = img.data[i * 3 + 1]; id.data[i * 4 + 2] = img.data[i * 3 + 2]; }
    id.data[i * 4 + 3] = 255;
  }
  cv.getContext('2d')!.putImageData(id, 0, 0); return cv;
}
function rgbToCanvas(w: number, h: number, rgb: Uint8Array): HTMLCanvasElement { return rawToCanvas({ width: w, height: h, channels: 3, data: rgb }); }
const toBlob = (cv: HTMLCanvasElement, type: string) => new Promise<Blob>(res => cv.toBlob(b => res(b!), type, 0.92));
function download(name: string, blob: Blob) { const a = $('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); }
async function downloadImage(name: string, img: any) {
  const ext = (name.split('.').pop() || 'png').toLowerCase(), type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  download(type === 'image/png' && ext !== 'png' ? name.replace(/\.\w+$/, '') + '.png' : name, await toBlob(rawToCanvas(img), type));
}
async function addUpload(f: File) {
  const bmp = await createImageBitmap(f), cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const g = cv.getContext('2d')!; g.drawImage(bmp, 0, 0); const px = g.getImageData(0, 0, bmp.width, bmp.height).data, n = bmp.width * bmp.height, d = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { d[i * 3] = px[i * 4]; d[i * 3 + 1] = px[i * 4 + 1]; d[i * 3 + 2] = px[i * 4 + 2]; }
  const ext = (f.name.split('.').pop() || 'png').toLowerCase();
  const img = { width: bmp.width, height: bmp.height, channels: 3, data: d, bitDepth: 24, format: ext === 'jpeg' ? 'jpg' : ext, fileSize: f.size, colorType: 'truecolor', filename: '/vfs/' + f.name, fileModDate: new Date(f.lastModified).toUTCString() };
  files.set(f.name, img); worker.postMessage({ t: 'putFile', name: f.name, img }); renderSide();
}

// ---------------- rendering ----------------
let renderQ = 0;
function scheduleRender() { if (!renderQ) renderQ = requestAnimationFrame(() => { renderQ = 0; render(); }); }
const nb = () => document.getElementById('nb')!;
function setStatus(s: string) { const el = document.getElementById('status'); if (el) el.textContent = s; document.getElementById('stop')?.toggleAttribute('disabled', !curRun); }

function figureEl(o: Extract<Out, { k: 'img' }>): HTMLElement {
  const cv = rgbToCanvas(o.w, o.h, o.rgb), px = $('div', { class: 'px' }, ' ');
  let zoom = 1; const apply = () => { cv.style.width = o.w * zoom + 'px'; cv.style.height = o.h * zoom + 'px'; cv.style.imageRendering = zoom > 1 ? 'pixelated' : 'auto'; };
  if (o.w > 640) zoom = 640 / o.w; apply();
  cv.onmousemove = ev => {
    const r = cv.getBoundingClientRect(), x = Math.floor((ev.clientX - r.left) / r.width * o.w), y = Math.floor((ev.clientY - r.top) / r.height * o.h);
    if (x < 0 || y < 0 || x >= o.w || y >= o.h) return; const i = (y * o.w + x) * 3, d = o.rgb;
    px.textContent = `Pixel info: (row ${y + 1}, col ${x + 1})  [${d[i]} ${d[i + 1]} ${d[i + 2]}]`;
  };
  cv.onmouseleave = () => { px.textContent = ' '; };
  const cap = $('div', { class: 'cap' }, o.tool ? `Image Tool · ${o.w}×${o.h}` : `Figure ${o.fig} · ${o.w}×${o.h}`);
  const zb = (t: string, f: () => void) => $('button', { title: 'Zoom', onclick: () => { f(); apply(); } }, t);
  cap.append(zb('+', () => { zoom *= 1.5; }), zb('−', () => { zoom /= 1.5; }), zb('100%', () => { zoom = 1; }));
  cap.append($('button', { onclick: async () => download(`figure${Math.abs(o.fig)}.png`, await toBlob(cv, 'image/png')) }, 'PNG'));
  return $('div', { class: 'fig' }, cap, $('div', { class: 'scroll' }, cv), px);
}
function cellEl(c: Cell, i: number): HTMLElement {
  const mv = (d: number) => () => { const j = i + d; if (j < 0 || j >= cells.length) return; [cells[i], cells[j]] = [cells[j], cells[i]]; sel = j; save(); render(); };
  const tools = $('div', { class: 'tools' }, $('span', { class: 'idx' }, c.type === 'md' ? 'md' : c.running ? '[*]' : `[${c.count ?? ' '}]`));
  if (c.type === 'code') tools.append($('button', { class: 'primary', disabled: !!curRun, onclick: () => runCell(c) }, '▶ Run'));
  else tools.append($('button', { onclick: () => { c.mdEdit = !c.mdEdit; render(); } }, c.mdEdit ? 'Done' : 'Edit'));
  tools.append($('span', { class: 'sp' }), $('button', { title: 'Move up', onclick: mv(-1) }, '↑'), $('button', { title: 'Move down', onclick: mv(1) }, '↓'),
    $('button', { title: c.type === 'md' ? 'Convert to code' : 'Convert to text', onclick: () => { c.type = c.type === 'md' ? 'code' : 'md'; c.outs = []; c.mdEdit = c.type === 'md'; save(); render(); } }, c.type === 'md' ? '→ code' : '→ text'),
    $('button', { title: 'Delete cell', onclick: () => { cells.splice(i, 1); if (!cells.length) cells.push(mkCell('code', '')); sel = Math.min(sel, cells.length - 1); save(); render(); } }, '✕'));
  const el = $('section', { class: 'cell' + (i === sel ? ' sel' : '') + (c.running ? ' running' : '') }, tools);
  el.addEventListener('focusin', () => { if (sel !== i) { sel = i; document.querySelectorAll('.cell').forEach((n, k) => n.classList.toggle('sel', k === i)); } });
  if (c.type === 'md' && !c.mdEdit) { const v = $('div', { class: 'md' }); v.innerHTML = md(c.src); v.ondblclick = () => { c.mdEdit = true; render(); }; el.append(v); }
  else {
    const ta = $('textarea', { class: 'src', spellcheck: false, rows: 1, 'data-cell': c.id });
    ta.value = c.src; const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; }; requestAnimationFrame(fit);
    ta.oninput = () => { c.src = ta.value; fit(); save(); };
    ta.onkeydown = ev => {
      if (ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey)) {
        ev.preventDefault();
        if (c.type === 'md') { c.mdEdit = false; render(); return; }
        runCell(c).then(() => { if (ev.shiftKey) { if (i === cells.length - 1) { cells.push(mkCell('code', '')); save(); } sel = i + 1; focusCell(cells[sel].id); } });
      } else if (ev.key === 'Tab') { ev.preventDefault(); const s = ta.selectionStart; ta.setRangeText('    ', s, ta.selectionEnd, 'end'); ta.oninput!(null as any); }
    };
    el.append(ta);
  }
  const outs = $('div', { class: 'outs' });
  for (const o of c.outs) {
    if (o.k === 'img') outs.append(figureEl(o)); else outs.append($('pre', { class: 'o' + (o.k === 'text' ? '' : ' ' + o.k) }, o.s.replace(/\n+$/, '\n')));
  }
  el.append(outs); return el;
}
let focusId: number | null = null;
function focusCell(id: number) { focusId = id; render(); }
function render() {
  const root = nb(), y = window.scrollY, active = document.activeElement as HTMLTextAreaElement | null;
  let keep: { id: string; s: number; e: number } | null = active && active.dataset?.cell ? { id: active.dataset.cell, s: active.selectionStart, e: active.selectionEnd } : null;
  root.replaceChildren();
  const ln = lessonNav(); if (ln) root.append(ln);
  cells.forEach((c, i) => root.append(cellEl(c, i)));
  root.append($('div', { class: 'addbar' }, $('button', { onclick: () => { cells.push(mkCell('code', '')); sel = cells.length - 1; save(); focusCell(cells[sel].id); } }, '+ Code'),
    $('button', { onclick: () => { const c = mkCell('md', '## Heading'); c.mdEdit = true; cells.push(c); sel = cells.length - 1; save(); focusCell(c.id); } }, '+ Text')));
  if (focusId !== null) { const t = document.querySelector<HTMLTextAreaElement>(`textarea[data-cell="${focusId}"]`); focusId = null; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); t.scrollIntoView({ block: 'nearest' }); keep = null; } }
  if (keep) { const t = document.querySelector<HTMLTextAreaElement>(`textarea[data-cell="${keep.id}"]`); if (t) { t.focus({ preventScroll: true }); t.setSelectionRange(keep.s, keep.e); } }
  window.scrollTo(0, y); document.getElementById('stop')?.toggleAttribute('disabled', !curRun);
}
function fmtBytes(n: number) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
function renderSide() {
  const side = document.getElementById('side')!; side.replaceChildren();
  const ws = $('div', { class: 'body' });
  if (!vars.length) ws.append($('div', { class: 'empty' }, 'No variables yet.'));
  else { const t = $('table', { class: 'ws' }, $('tr', {}, ...['Name', 'Size', 'Class'].map(h => $('th', {}, h)))); for (const v of vars) t.append($('tr', {}, $('td', {}, v.name), $('td', {}, v.size), $('td', {}, v.cls))); ws.append(t); }
  side.append($('div', { class: 'panel' }, $('h3', {}, 'Workspace', $('button', { onclick: resetWorkspace }, 'clear')), ws));

  const fb = $('div', { class: 'body' });
  for (const [name, img] of files) {
    const cv = rawToCanvas(img);
    fb.append($('div', { class: 'file' }, cv, $('span', { class: 'n', title: name }, name + ' · ' + fmtBytes(img.fileSize)),
      $('button', { title: 'Download', onclick: () => downloadImage(name, img) }, '↓'),
      $('button', { title: 'Remove', onclick: () => { files.delete(name); worker.postMessage({ t: 'delFile', name }); renderSide(); } }, '✕')));
  }
  if (!files.size) fb.append($('div', { class: 'empty' }, 'Empty. Upload an image.'));
  const inp = $('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' }); inp.onchange = async () => { for (const f of Array.from(inp.files ?? [])) await addUpload(f); };
  side.append($('div', { class: 'panel' }, $('h3', {}, 'Current Folder', $('button', { onclick: () => inp.click() }, 'Upload'), inp), fb));

  const hb = $('div', { class: 'body hist' });
  if (!cmdHist.length) hb.append($('div', { class: 'empty' }, 'Executed lines appear here. Click one to add it as a cell.'));
  for (const h of cmdHist.slice().reverse().slice(0, 60)) hb.append($('div', { title: h, onclick: () => { cells.push(mkCell('code', h)); sel = cells.length - 1; save(); render(); } }, h));
  side.append($('div', { class: 'panel' }, $('h3', {}, 'Command History', $('button', { onclick: () => { cmdHist = []; store.set('mlweb.hist', '[]'); renderSide(); } }, 'clear')), hb));
}

// ---------------- import / export ----------------
function exportIpynb() {
  const nbk = { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'mlweb', display_name: 'MLWeb (MATLAB subset)', language: 'matlab' }, language_info: { name: 'matlab', file_extension: '.m' } },
    cells: cells.map(c => {
      const lines = c.src.split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l));
      if (c.type === 'md') return { cell_type: 'markdown', metadata: {}, source: lines };
      const outputs: any[] = []; let txt = '';
      for (const o of c.outs) {
        if (o.k === 'img') outputs.push({ output_type: 'display_data', metadata: {}, data: { 'image/png': rgbToCanvas(o.w, o.h, o.rgb).toDataURL('image/png').split(',')[1], 'text/plain': ['<image>'] } });
        else if (o.k === 'text') txt += o.s;
        else outputs.push({ output_type: 'stream', name: 'stderr', text: [o.s] });
      }
      if (txt) outputs.unshift({ output_type: 'stream', name: 'stdout', text: txt.split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l)) });
      return { cell_type: 'code', metadata: {}, execution_count: c.count, source: lines, outputs };
    }) };
  download('notebook.ipynb', new Blob([JSON.stringify(nbk, null, 1)], { type: 'application/json' }));
}
function exportM() {
  const s = cells.map(c => c.type === 'md' ? c.src.split('\n').map(l => '% ' + l).join('\n') : c.src).join('\n\n%%\n');
  download('notebook.m', new Blob([('% Exported from MLWeb - Belal Amr Mohamed\n\n' + s).replace(/\n/g, '\r\n')], { type: 'text/plain' }));
}
async function importFile(f: File) {
  const text = await f.text();
  if (/\.ipynb$/i.test(f.name)) {
    const j = JSON.parse(text); const arr = (j.cells ?? []).map((c: any) => mkCell(c.cell_type === 'markdown' ? 'md' : 'code', Array.isArray(c.source) ? c.source.join('') : String(c.source ?? '')));
    if (arr.length) cells = arr;
  } else {
    const parts = text.replace(/\r\n?/g, '\n').split(/^%%.*$/m).map(s => s.replace(/^\n+|\n+$/g, '')).filter(s => s.trim());
    cells = (parts.length ? parts : ['']).map(p => mkCell('code', p));
  }
  sel = 0; save(); render();
}

// ---------------- boot ----------------
function boot() {
  ['test.png', 'testgray.png'].forEach(loadAsset);
  try { cmdHist = JSON.parse(store.get('mlweb.hist') ?? '[]'); } catch { cmdHist = []; }
  const hashId = decodeURIComponent(location.hash.slice(1)), saved = load();
  curLesson = store.get('mlweb.lesson') || null;
  if (curLesson) __LESSONS__.find(l => l.id === curLesson)?.files.forEach(loadAsset);
  cells = saved ?? defaultNotebook();
  const act = document.getElementById('actions')!;
  const imp = $('input', { type: 'file', accept: '.m,.ipynb', style: 'display:none' }); imp.onchange = () => { if (imp.files?.[0]) importFile(imp.files[0]); imp.value = ''; };
  const sl = $('select', { id: 'lessons', title: 'Ready-made lessons' }, $('option', { value: '' }, 'Lessons…'));
  for (const g of ['Sections', 'Lectures']) { const og = $('optgroup', { label: g }); for (const l of __LESSONS__.filter(x => x.group === g)) og.append($('option', { value: l.id }, l.title)); sl.append(og); }
  sl.value = curLesson ?? ''; sl.onchange = () => { if (sl.value) openLesson(sl.value); else sl.value = curLesson ?? ''; };
  act.append(sl, $('button', { class: 'primary', id: 'runall', onclick: () => runAll() }, '▶▶ Run all'), $('button', { id: 'stop', disabled: true, onclick: stopRun }, '■ Stop'),
    $('span', { id: 'status' }, 'Idle'), $('button', { onclick: () => { cells.push(mkCell('code', '')); sel = cells.length - 1; save(); focusCell(cells[sel].id); } }, '+ Cell'),
    $('button', { onclick: () => imp.click() }, 'Import'), imp, $('button', { onclick: exportIpynb }, '.ipynb'), $('button', { onclick: exportM }, '.m'),
    $('button', { title: 'Replace notebook with the starter notebook', onclick: () => { if (confirm('Replace the current notebook with the starter notebook?')) { cells = defaultNotebook(); sel = 0; curLesson = null; store.set('mlweb.lesson', ''); history_.replaceState(null, '', location.pathname); save(); render(); } } }, 'New'));
  startWorker(); render(); renderSide();
  if (hashId && __LESSONS__.some(l => l.id === hashId) && hashId !== curLesson) openLesson(hashId, false);
  else if (curLesson) document.title = (__LESSONS__.find(l => l.id === curLesson)?.title ?? 'MLWeb') + ' – MLWeb | Belal Amr Mohamed';
  window.addEventListener('hashchange', () => { const h = decodeURIComponent(location.hash.slice(1)); if (h && h !== curLesson && __LESSONS__.some(l => l.id === h)) openLesson(h); });
}
boot();
(window as any).__mlweb = { get cells() { return cells; }, runAll, runCell, files };
