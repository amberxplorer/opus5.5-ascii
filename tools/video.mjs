// Render the piece to an MP4 frame by frame (no screen recording, no dropped frames).
// usage: node tools/video.mjs <out.mp4> <track.wav> [WxH] [fps] [cell] [fontDir]
// The WAV comes from tools/audio.mjs; the synth is deterministic, so it matches the page.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const here = path.dirname(fileURLToPath(import.meta.url));
const [out, wav, size = '720x1280', fpsS = '30', cell = '6', fontDir] = process.argv.slice(2);
const [W, H] = size.split('x').map(Number);
const fps = Number(fpsS);
const LEAD = 1.0;          // seconds of the ready screen before the press
const END = 90.6;          // music time to stop at (after the last fade)

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
if (fontDir) {
  const map = Object.fromEntries(fs.readFileSync(path.join(fontDir, 'map.txt'), 'utf8').trim().split('\n').map((l) => { const [i, u] = l.split(' '); return [u, `f${i}.woff2`]; }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(fontDir, r.request().url().includes('Shippori') ? 'sm.css' : 'jb.css'), 'utf8') }));
  await page.route('https://fonts.gstatic.com/**', (r) => { const f = map[r.request().url()]; return f ? r.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(path.join(fontDir, f)) }) : r.abort(); });
} else await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await page.goto('file://' + path.join(here, '../index.html') + `?capture&cell=${cell}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });

const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error',
  '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
  '-i', wav,
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', process.env.CRF || '20', '-tune', 'animation', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-af', `adelay=${LEAD * 1000}:all=1,apad`,
  '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });

const total = Math.round((process.env.LIMIT ? Number(process.env.LIMIT) : LEAD + END) * fps);
const t0 = Date.now();
for (let i = 0; i < total; i++) {
  const s = i / fps;
  if (s < LEAD) await page.evaluate((tw) => window.__idle(tw, 1, true), 2 + s);
  else await page.evaluate((T) => window.__frame(T), s - LEAD);
  const png = await page.screenshot({ type: 'png' });
  if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % 150 === 0) console.log(`frame ${i}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
await browser.close();
console.log('wrote', out, (fs.statSync(out).size / 1048576).toFixed(1), 'MB');
