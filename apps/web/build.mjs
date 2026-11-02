// Bundles worker + app + samples into ONE static dist/index.html (deployable anywhere, incl. Vercel static).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { PNG } from 'pngjs';
import path from 'node:path';
const here = import.meta.dirname, A = path.join(here, '../../packages/interp/test/assets');

const w = await build({ entryPoints: [path.join(here, 'src/worker.ts')], bundle: true, write: false, format: 'iife', target: 'es2022', minify: true });
const workerSrc = w.outputFiles[0].text;

const samples = {};
for (const [name, gray] of [['test.png', false], ['testgray.png', true]]) {
  const fp = path.join(A, name), png = PNG.sync.read(readFileSync(fp)), ch = gray ? 1 : 3;
  const d = Buffer.alloc(png.width * png.height * ch);
  for (let i = 0; i < png.width * png.height; i++) for (let k = 0; k < ch; k++) d[i * ch + k] = png.data[i * 4 + (gray ? 0 : k)];
  samples[name] = { width: png.width, height: png.height, channels: ch, b64: d.toString('base64'), bitDepth: 8 * ch, format: 'png', fileSize: statSync(fp).size,
    colorType: gray ? 'grayscale' : 'truecolor', filename: '/vfs/' + name, fileModDate: '02-Nov-2026 10:00:00' };
}
const m = await build({ entryPoints: [path.join(here, 'src/main.ts')], bundle: true, write: false, format: 'iife', target: 'es2022', minify: true,
  define: { __WORKER_SRC__: JSON.stringify(workerSrc), __SAMPLES__: JSON.stringify(samples) } });
const js = m.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(path.join(here, 'src/style.css'), 'utf8');
const html = readFileSync(path.join(here, 'src/index.html'), 'utf8').replace('/*CSS*/', () => css).replace('/*JS*/', () => js);
mkdirSync(path.join(here, 'dist'), { recursive: true });
writeFileSync(path.join(here, 'dist/index.html'), html);
console.log('dist/index.html', (html.length / 1024).toFixed(0) + ' KB');
