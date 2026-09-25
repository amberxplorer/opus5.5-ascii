// Render frames of the piece headlessly (no audio playback) for visual checks.
// usage: node tools/shoot.mjs <outDir> <WxH[@dpr]> <t1,t2,...|sheet:t1,t2,...> [fontDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const here = path.dirname(fileURLToPath(import.meta.url));
const [outDir, size = '1280x720', spec = '0', fontDir] = process.argv.slice(2);
const [wh, dprS] = size.split('@');
const [W, H] = wh.split('x').map(Number);
const dpr = parseFloat(dprS || '1');
const sheet = spec.startsWith('sheet:');
const idle = spec.startsWith('idle:');
const times = spec.replace(/^(sheet|idle):/, '').split(',').map(Number);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().slice(0, 2000)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
if (fontDir && fs.existsSync(path.join(fontDir, 'map.txt'))) {
  const map = Object.fromEntries(fs.readFileSync(path.join(fontDir, 'map.txt'), 'utf8').trim().split('\n').map((l) => { const [i, u] = l.split(' '); return [u, `f${i}.woff2`]; }));
  await page.route('https://fonts.googleapis.com/**', (r) => {
    const u = r.request().url();
    const css = fs.readFileSync(path.join(fontDir, u.includes('Shippori') ? 'sm.css' : 'jb.css'), 'utf8');
    r.fulfill({ status: 200, contentType: 'text/css', body: css, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route('https://fonts.gstatic.com/**', (r) => {
    const f = map[r.request().url()];
    if (!f) return r.abort();
    r.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(path.join(fontDir, f)), headers: { 'access-control-allow-origin': '*' } });
  });
} else {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
}
const t0 = Date.now();
await page.goto('file://' + path.join(here, '../index.html') + '?capture' + (process.env.Q ? '&' + process.env.Q : ''));
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
console.log('ready in', ((Date.now() - t0) / 1000).toFixed(1), 's');
if (sheet) {
  const url = await page.evaluate(({ times, cols }) => {
    const src = document.getElementById('screen');
    const tw = 480, th = Math.round(tw * src.height / src.width);
    const rows = Math.ceil(times.length / cols);
    const c = document.createElement('canvas'); c.width = cols * tw; c.height = rows * th;
    const g = c.getContext('2d'); g.fillStyle = '#333'; g.fillRect(0, 0, c.width, c.height);
    times.forEach((t, i) => { window.__frame(t); g.drawImage(src, (i % cols) * tw + 1, Math.floor(i / cols) * th + 1, tw - 2, th - 2); });
    return c.toDataURL('image/png');
  }, { times, cols: 4 });
  fs.writeFileSync(path.join(outDir, 'sheet.png'), Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote sheet');
} else {
  for (const t of times) {
    const t1 = Date.now();
    if (idle) await page.evaluate((t) => window.__idle(t, t < 2 ? t / 2 : 1, t >= 2), t);
    else await page.evaluate((t) => window.__frame(t), t);
    const f = path.join(outDir, `${idle ? 'idle' : 'f'}_${t.toFixed(2)}.png`);
    await page.screenshot({ path: f });
    console.log('wrote', path.basename(f), Date.now() - t1, 'ms');
  }
}
await browser.close();
