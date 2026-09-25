// Real playback smoke test: loads the page normally, clicks, lets it run, reports clock + errors + fps.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const here = path.dirname(fileURLToPath(import.meta.url));
const [secs = '6', startAt = '0', fontDir] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
if (fontDir) {
  const map = Object.fromEntries(fs.readFileSync(path.join(fontDir, 'map.txt'), 'utf8').trim().split('\n').map((l) => { const [i, u] = l.split(' '); return [u, `f${i}.woff2`]; }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(fontDir, r.request().url().includes('Shippori') ? 'sm.css' : 'jb.css'), 'utf8') }));
  await page.route('https://fonts.gstatic.com/**', (r) => { const f = map[r.request().url()]; return f ? r.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(path.join(fontDir, f)) }) : r.abort(); });
} else await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
const t0 = Date.now();
await page.goto('file://' + path.join(here, '../index.html') + (startAt !== '0' ? `?t=${startAt}` : ''));
await page.waitForFunction(() => window.__state && window.__state().ready, null, { timeout: 120000 });
console.log('ready after', ((Date.now() - t0) / 1000).toFixed(1), 's', JSON.stringify(await page.evaluate(() => window.__state())));
await page.mouse.click(480, 270);
const samples = [];
for (let i = 0; i < Number(secs); i++) {
  await page.waitForTimeout(1000);
  samples.push(await page.evaluate(() => { const s = window.__state(); return [+(performance.now() / 1000).toFixed(2), +s.T.toFixed(3), s.playing]; }));
}
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 2000) requestAnimationFrame(f); else res(n / 2); }; requestAnimationFrame(f); }));
console.log('wall / music time / playing:', JSON.stringify(samples));
console.log('fps (swiftshader, not representative):', fps);
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
