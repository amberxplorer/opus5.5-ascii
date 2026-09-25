// Render the soundtrack in Node, write a WAV + a spectrogram PNG, print level stats.
// usage: node tools/audio.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SYNTH = require(path.join(here, '../src/synth.js'));
const outDir = process.argv[2] || path.join(here, '../.out');
fs.mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const dbg = {};
const g = SYNTH.renderGen({ sampleRate: 44100, debug: dbg });
let r;
while (!(r = g.next()).done);
const res = r.value;
const ms = performance.now() - t0;
const { L, R, sampleRate: SR } = res;
console.log("pre-master peak", dbg.prePeak, "at", dbg.prePeakAt);
console.log(`rendered ${(L.length / SR).toFixed(2)} s in ${(ms / 1000).toFixed(2)} s`);

let nan = 0;
for (let i = 0; i < L.length; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) nan++;
console.log('non-finite samples:', nan);

// ---- WAV (16-bit) ----
{
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(path.join(outDir, 'track.wav'), buf);
}

// ---- stats per 4 bars ----
const BAR = SYNTH.BAR;
const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');
console.log('bars     peak(dB)  rms(dB)');
for (let b = 0; b < 48; b += 4) {
  const a = Math.floor(b * BAR * SR), e = Math.floor((b + 4) * BAR * SR);
  let pk = 0, s = 0;
  for (let i = a; i < e; i++) { pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); s += L[i] * L[i] + R[i] * R[i]; }
  console.log(`${String(b).padStart(2)}-${String(b + 3).padEnd(4)}  ${db(pk).padStart(7)}  ${db(Math.sqrt(s / (2 * (e - a)))).padStart(7)}`);
}
// stereo correlation + clicks: big sample-to-sample jumps
let maxJump = 0, jumpAt = 0;
for (let i = 1; i < L.length; i++) { const j = Math.abs(L[i] - L[i - 1]); if (j > maxJump) { maxJump = j; jumpAt = i; } }
console.log('max sample jump', maxJump.toFixed(3), 'at', (jumpAt / SR).toFixed(3), 's');

// stem envelopes: mean per section
const { env, frames, stems } = res;
const secs = [[0, 8], [8, 16], [16, 24], [24, 32], [32, 40], [40, 48]];
console.log('stem   ' + secs.map(([a, b]) => `${a}-${b}`.padStart(7)).join(''));
stems.forEach((s, si) => {
  const row = secs.map(([a, b]) => {
    const fa = Math.floor(a * BAR * 100), fb = Math.floor(b * BAR * 100);
    let m = 0; for (let f = fa; f < fb; f++) m += env[si * frames + f];
    return (m / (fb - fa)).toFixed(2).padStart(7);
  }).join('');
  console.log(s.padEnd(7) + row);
});

// absolute stem levels (dB RMS, pre-master) per section
{
  const E = dbg.energy, F = dbg.frames, FL = dbg.frameLen;
  console.log('stem dB ' + secs.map(([a, b]) => `${a}-${b}`.padStart(7)).join(''));
  stems.forEach((s, si) => {
    const row = secs.map(([a, b]) => {
      const fa = Math.floor(a * BAR * 100), fb = Math.floor(b * BAR * 100);
      let m = 0; for (let f = fa; f < fb; f++) m += E[si * F + f];
      const rms = Math.sqrt(m / ((fb - fa) * FL * 2));
      return db(rms).padStart(7);
    }).join('');
    console.log(s.padEnd(8) + row);
  });
}

// ---- spectrogram PNG ----
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
function png(w, h, rgb) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
{
  const W = 1800, H = 420, NF = 4096;
  const hop = Math.floor(L.length / W);
  const img = Buffer.alloc(W * H * 3);
  const win = new Float32Array(NF).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NF));
  for (let x = 0; x < W; x++) {
    const re = new Float64Array(NF), im = new Float64Array(NF);
    const a = x * hop;
    for (let i = 0; i < NF; i++) { const k = a + i; re[i] = k < L.length ? (L[k] + R[k]) * 0.5 * win[i] : 0; }
    fft(re, im);
    for (let y = 0; y < H; y++) {
      const f = 30 * Math.pow(18000 / 30, 1 - y / (H - 1));
      const bin = Math.min(NF / 2 - 1, Math.round((f / SR) * NF));
      const m = Math.hypot(re[bin], im[bin]) / (NF / 4);
      const d = Math.max(0, Math.min(1, (20 * Math.log10(m + 1e-9) + 100) / 90));
      const o = (y * W + x) * 3;
      // inferno-ish ramp
      const stops = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
      const q = d * (stops.length - 1), qi = Math.min(stops.length - 2, Math.floor(q)), qf = q - qi;
      for (let c = 0; c < 3; c++) img[o + c] = Math.round(stops[qi][c] + (stops[qi + 1][c] - stops[qi][c]) * qf);
    }
  }
  for (let b = 0; b <= 48; b++) {
    const x = Math.min(W - 1, Math.round((b * BAR * SR) / hop));
    for (let y = 0; y < H; y += (b % 8 === 0 ? 1 : 4)) { const o = (y * W + x) * 3; img[o] = 60; img[o + 1] = 160; img[o + 2] = 255; }
  }
  fs.writeFileSync(path.join(outDir, 'spectrogram.png'), png(W, H, img));
}
console.log('wrote', outDir);
