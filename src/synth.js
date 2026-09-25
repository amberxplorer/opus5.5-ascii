/* ─────────────────────────────────────────────────────────────────────────
   synth.js — the whole soundtrack, composed and synthesized sample by sample.

   128 BPM · 48 bars · exactly 90 seconds.
   Runs inside a Web Worker (or on the main thread / in Node for testing).
   Exposes a global SYNTH with a generator `renderGen(opts)` that yields
   progress (0‥1) and finally returns the stereo mix, per-stem envelopes
   for the visuals, and the score itself.
   ───────────────────────────────────────────────────────────────────────── */
var SYNTH = (function () {
'use strict';

const BPM = 128;
const BEAT = 60 / BPM;          // 0.46875 s
const STEP = BEAT / 4;          // one 16th
const BAR = BEAT * 4;           // 1.875 s
const BARS = 48;
const DURATION = BARS * BAR;    // 90 s
const T = (bar, step) => (bar * 16 + (step || 0)) * STEP;
const TAU = Math.PI * 2;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

const STEMS = ['kick', 'snare', 'hat', 'bass', 'pad', 'lead', 'arp', 'pluck', 'bell', 'fx', 'drone'];
const ST = {}; STEMS.forEach((s, i) => (ST[s] = i));

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ═════════════════════════════ THE SCORE ═════════════════════════════ */

// chord voicings (pad notes) and bass roots, MIDI numbers
const CH = {
  // D major
  Bm9:   { pad: [50, 54, 57, 61], root: 35 },
  Gmaj9: { pad: [54, 57, 59, 62], root: 31 },
  Gmaj7: { pad: [55, 59, 62, 66], root: 31 },
  A7:    { pad: [55, 57, 61, 64], root: 33 },
  Fsm7:  { pad: [54, 57, 61, 64], root: 30 },
  Bm7:   { pad: [54, 57, 59, 62], root: 35 },
  D:     { pad: [54, 57, 62, 64], root: 38 },
  Em7:   { pad: [55, 59, 62, 64], root: 40 },
  Asus4: { pad: [57, 62, 64, 69], root: 33 },
  A:     { pad: [57, 61, 64, 69], root: 33 },
  // E major (the lift)
  Amaj7: { pad: [57, 61, 64, 68], root: 33 },
  B7:    { pad: [57, 59, 63, 66], root: 35 },
  Gsm7:  { pad: [56, 59, 63, 66], root: 32 },
  Csm7:  { pad: [56, 59, 61, 64], root: 37 },
  E:     { pad: [56, 59, 64, 66], root: 40 },
  Bsus:  { pad: [59, 64, 66, 71], root: 35 },
  B:     { pad: [59, 63, 66, 71], root: 35 },
  Emaj9: { pad: [52, 56, 59, 63, 66], root: 28 },
};

// the hook — [midi, step, lengthInSteps] per bar (D major)
const HOOK = [
  [[78, 0, 3], [76, 3, 3], [74, 6, 2], [71, 8, 3], [69, 11, 3], [71, 14, 2]],
  [[74, 0, 3], [76, 3, 3], [78, 6, 6], [81, 12, 4]],
  [[76, 0, 3], [78, 3, 3], [76, 6, 2], [73, 8, 3], [69, 11, 3], [73, 14, 2]],
  [[74, 0, 6], [69, 8, 2], [71, 10, 2], [74, 12, 2], [76, 14, 2]],
  [[78, 0, 3], [76, 3, 3], [74, 6, 2], [71, 8, 3], [69, 11, 3], [71, 14, 2]],
  [[74, 0, 3], [76, 3, 3], [78, 6, 2], [81, 8, 4], [83, 12, 4]],
  [[81, 0, 3], [78, 3, 3], [76, 6, 2], [74, 8, 3], [76, 11, 3], [78, 14, 2]],
  [[76, 0, 2], [74, 2, 12]],
];

// breakdown bells (bars 24–31)
const BELLS_BD = [
  [[83, 0, 6], [81, 6, 2], [79, 8, 4], [76, 12, 4]],
  [[76, 0, 4], [81, 4, 4], [85, 8, 8]],
  [[81, 0, 6], [76, 6, 2], [78, 8, 8]],
  [[86, 0, 4], [85, 4, 4], [83, 8, 8]],
  [[83, 0, 6], [81, 6, 2], [78, 8, 4], [74, 12, 4]],
  [[76, 0, 4], [81, 4, 4], [85, 8, 6], [86, 14, 2]],
  [[86, 0, 4], [85, 4, 2], [83, 6, 2], [81, 8, 8]],
  [[76, 0, 8], [79, 8, 4], [81, 12, 4]],
];

// outro melody on the plucked thread (E major, bars 40–45)
const OUTRO = [
  [[80, 0, 3], [78, 3, 3], [76, 6, 2], [73, 8, 3], [71, 11, 3], [73, 14, 2]],
  [[76, 0, 3], [78, 3, 3], [80, 6, 6], [83, 12, 4]],
  [[78, 0, 3], [80, 3, 3], [78, 6, 2], [75, 8, 3], [71, 11, 3], [75, 14, 2]],
  [[76, 0, 10]],
  [[73, 0, 4], [76, 4, 4], [78, 8, 4], [80, 12, 4]],
  [[76, 0, 16]],
];

// intro plucks: the thread being strung, one bead per note
const INTRO_PLUCKS = [
  [3, 0, 74], [3, 6, 81], [3, 10, 78],
  [4, 0, 76], [4, 8, 71], [4, 12, 74],
  [5, 0, 78], [5, 6, 81], [5, 10, 83], [5, 14, 81],
  [6, 0, 78], [6, 8, 74], [6, 12, 76],
  [7, 0, 78], [7, 4, 81], [7, 8, 83], [7, 12, 86],
];

function buildScore() {
  const R = rng(20260925);
  const S = {
    kick: [], kickM: [], clap: [], snare: [], hatC: [], hatO: [], rim: [], crash: [], impact: [],
    revCym: [], heart: [], riser: [], downlifter: [], whoosh: [], wind: [], shimmer: [], drone: [],
    pad: [], bass: [], lead: [], lead2: [], arp: [], pluck: [], bell: [], chords: [],
  };

  /* chords */
  const put = (bar, step, len, ch) => S.chords.push({ t: T(bar, step), dur: len * STEP, bar, step, ch });
  put(4, 0, 32, CH.Bm9); put(6, 0, 32, CH.Gmaj9);
  [CH.Gmaj7, CH.A7, CH.Fsm7, CH.Bm7, CH.Gmaj7, CH.A7, CH.Bm7].forEach((c, i) => put(8 + i, 0, 16, c));
  put(15, 0, 8, CH.Asus4); put(15, 8, 8, CH.A);
  [CH.Gmaj7, CH.A7, CH.Fsm7, CH.Bm7, CH.Gmaj7, CH.A7, CH.D, CH.D].forEach((c, i) => put(16 + i, 0, 16, c));
  [CH.Em7, CH.A, CH.Fsm7, CH.Bm7, CH.Gmaj7, CH.A, CH.Bm7].forEach((c, i) => put(24 + i, 0, 16, c));
  put(31, 0, 8, CH.Asus4); put(31, 8, 8, CH.A);
  [CH.Amaj7, CH.B7, CH.Gsm7, CH.Csm7, CH.Amaj7, CH.B7, CH.E, CH.E].forEach((c, i) => put(32 + i, 0, 16, c));
  [CH.Amaj7, CH.B, CH.Gsm7, CH.Csm7].forEach((c, i) => put(40 + i, 0, 16, c));
  put(44, 0, 8, CH.Amaj7); put(44, 8, 4, CH.Bsus); put(44, 12, 4, CH.B); put(45, 0, 48, CH.Emaj9);

  /* pads */
  for (const c of S.chords) {
    const b = c.bar;
    let o;
    if (b < 8) o = { att: 1.4, rel: 1.6, vel: 0.75, bright: 1.0, det: 0.8, fenv: 0 };
    else if (b < 16) o = { att: 0.35, rel: 0.5, vel: 0.8, bright: 1.0, det: 1.0, fenv: 0.3 };
    else if (b < 24) o = { att: 0.012, rel: 0.3, vel: 1.0, bright: 1.0, det: 1.25, fenv: 0.8 };
    else if (b < 32) o = { att: 0.5, rel: 1.0, vel: 0.85, bright: 1.0, det: 1.0, fenv: 0.2 };
    else if (b < 40) o = { att: 0.012, rel: 0.3, vel: 1.05, bright: 1.0, det: 1.35, fenv: 0.9 };
    else o = { att: 0.7, rel: b >= 45 ? 3.2 : 1.8, vel: 0.8, bright: 1.0, det: 0.9, fenv: 0 };
    // bars 15 & 31: release the sus chord into the gap before the drop
    let dur = c.dur;
    if ((b === 15 || b === 31) && c.step === 8) dur = 4 * STEP;
    S.pad.push({ t: c.t, dur, notes: c.ch.pad, ...o });
  }

  /* drone */
  S.drone.push({ t: 0, dur: T(8, 8), notes: [38, 45], fadeIn: 5, fadeOut: 3.5, vel: 1 });
  S.drone.push({ t: T(40), dur: DURATION - T(40), notes: [40, 47], fadeIn: 4, fadeOut: 5, vel: 0.55 });

  /* bass */
  const chordAt = (bar, step) => {
    const t = T(bar, step) + 1e-6;
    let best = null;
    for (const c of S.chords) if (c.t <= t && t < c.t + c.dur) best = c;
    return best ? best.ch : null;
  };
  for (let b = 12; b < 16; b++) {
    for (let s = 0; s < 16; s += 2) {
      if (b === 15 && s >= 12) break;
      const c = chordAt(b, s);
      S.bass.push({ t: T(b, s), dur: 1.6 * STEP, note: c.root, vel: 0.55 + 0.35 * ((b - 12) * 16 + s) / 64 });
    }
  }
  const dropBass = (b0) => {
    for (let b = b0; b < b0 + 8; b++) {
      for (const s of [2, 6, 10, 14]) {
        const c = chordAt(b, s);
        let note = c.root;
        if (s === 14 && (b & 1)) note += 12;
        S.bass.push({ t: T(b, s), dur: 1.75 * STEP, note, vel: 1 });
      }
    }
  };
  dropBass(16); dropBass(32);
  for (let b = 28; b < 31; b++) S.bass.push({ t: T(b), dur: 15.5 * STEP, note: chordAt(b, 0).root, vel: 0.6, sub: true });
  for (let s = 0; s < 12; s += 2) S.bass.push({ t: T(31, s), dur: 1.6 * STEP, note: 33, vel: 0.7 + s * 0.02 });
  for (let b = 40; b < 44; b++) S.bass.push({ t: T(b), dur: 15.5 * STEP, note: chordAt(b, 0).root, vel: 0.5, sub: true });
  S.bass.push({ t: T(44), dur: 7.5 * STEP, note: 33, vel: 0.5, sub: true });
  S.bass.push({ t: T(44, 8), dur: 7.5 * STEP, note: 35, vel: 0.5, sub: true });
  S.bass.push({ t: T(45), dur: 2.6 * BAR, note: 28, vel: 0.6, sub: true });

  /* drums */
  const hum = (amt) => (R() - 0.5) * amt;
  for (let b = 8; b < 12; b++) for (let s = 0; s < 16; s += 4) S.kickM.push({ t: T(b, s), vel: 0.55 + (b - 8) * 0.1 });
  for (let b = 28; b < 30; b++) for (let s = 0; s < 16; s += 4) S.kickM.push({ t: T(b, s), vel: 0.6 + (b - 28) * 0.15 });
  const kicks = (b0, b1, lastStep) => {
    for (let b = b0; b < b1; b++) for (let s = 0; s < 16; s += 4) {
      if (b === b1 - 1 && s > lastStep) break;
      S.kick.push({ t: T(b, s), vel: 1 });
    }
  };
  kicks(12, 16, 8); kicks(16, 24, 12); kicks(30, 32, 8); kicks(32, 40, 12);
  S.kick.push({ t: T(40), vel: 0.9 });

  for (let b = 12; b < 14; b++) for (const s of [4, 12]) S.clap.push({ t: T(b, s), vel: 0.8 });
  for (const b0 of [16, 32]) for (let b = b0; b < b0 + 8; b++) for (const s of [4, 12]) S.clap.push({ t: T(b, s), vel: 1 });
  for (let b = 30; b < 31; b++) for (const s of [4, 12]) S.clap.push({ t: T(b, s), vel: 0.7 });

  const roll = (b) => {
    for (let s = 0; s < 16; s += 2) S.snare.push({ t: T(b, s), vel: 0.28 + s * 0.018, rate: 1 });
    for (let s = 0; s < 8; s++) S.snare.push({ t: T(b + 1, s), vel: 0.55 + s * 0.025, rate: 1 + s * 0.01 });
    for (let i = 0; i < 8; i++) S.snare.push({ t: T(b + 1, 8 + i * 0.5), vel: 0.75 + i * 0.035, rate: 1.08 + i * 0.03 });
  };
  roll(14); roll(30);
  for (const b of [23, 39]) {
    for (let s = 8; s < 16; s++) S.snare.push({ t: T(b, s), vel: 0.5 + (s - 8) * 0.06, rate: 0.95 + (s - 8) * 0.04 });
  }

  for (let b = 10; b < 12; b++) for (const s of [2, 6, 10, 14]) S.hatC.push({ t: T(b, s) + hum(0.004), vel: 0.45 });
  for (let b = 12; b < 16; b++) for (let s = 0; s < 16; s++) {
    if (b === 15 && s >= 12) break;
    S.hatC.push({ t: T(b, s) + hum(0.004), vel: (s % 4 === 2 ? 0.7 : 0.35) + R() * 0.1 });
  }
  for (const b0 of [16, 32]) for (let b = b0; b < b0 + 8; b++) for (let s = 0; s < 16; s++) {
    if (b === b0 + 7 && s >= 8) break;
    if (s % 4 === 2) S.hatO.push({ t: T(b, s) + hum(0.003), vel: 0.75 });
    else S.hatC.push({ t: T(b, s) + hum(0.004), vel: (s % 2 ? 0.42 : 0.3) + R() * 0.12 });
  }
  for (let b = 29; b < 32; b++) for (let s = 2; s < 16; s += 4) {
    if (b === 31 && s >= 12) break;
    S.hatC.push({ t: T(b, s) + hum(0.004), vel: 0.5 });
  }
  for (let b = 32; b < 40; b++) for (const s of [3, 7, 10, 13]) {
    if (b === 39 && s >= 8) break;
    S.rim.push({ t: T(b, s) + hum(0.003), vel: 0.35 + R() * 0.15, pan: s < 8 ? -0.35 : 0.35 });
  }

  for (const b of [16, 20, 24, 32, 36, 40]) S.crash.push({ t: T(b), vel: b === 24 || b === 40 ? 0.8 : 1 });
  for (const b of [16, 24, 32, 40]) S.impact.push({ t: T(b), vel: b === 24 ? 0.6 : b === 40 ? 0.85 : 1 });
  S.revCym.push({ t: T(15, 8), vel: 1 }, { t: T(31, 8), vel: 1 });
  for (let b = 4; b < 8; b++) for (const s of [0, 8]) {
    S.heart.push({ t: T(b, s), vel: 0.8 }, { t: T(b, s + 2) + 0.01, vel: 0.5 });
  }
  for (const [b, s] of [[45, 0], [45, 8], [46, 0], [46, 10], [47, 4]]) {
    S.heart.push({ t: T(b, s), vel: 0.6 }, { t: T(b, s + 2) + 0.01, vel: 0.38 });
  }

  /* fx */
  S.riser.push({ t: T(12), dur: T(15, 12) - T(12), vel: 1 });
  S.riser.push({ t: T(28), dur: T(31, 12) - T(28), vel: 1 });
  S.downlifter.push({ t: T(24), dur: 3.0, vel: 0.8 }, { t: T(40), dur: 3.5, vel: 0.7 });
  S.whoosh.push({ t: 0.0, dur: 0.95, vel: 0.7 }, { t: T(2, 4), dur: T(3) - T(2, 4), vel: 0.8 });
  S.shimmer.push({ t: 0, dur: T(9), vel: 1 });
  S.wind.push({ t: T(40), dur: DURATION - T(40), vel: 1 });

  /* lead: the hook, twice (second time lifted a whole step, doubled an octave up) */
  const lead = (b0, transpose, arr, gain) => {
    let prev = null;
    HOOK.forEach((bar, i) => {
      for (const [m, s, l] of bar) {
        const t = T(b0 + i, s);
        const dur = l * STEP * (l >= 4 ? 0.96 : 0.86);
        arr.push({ t, dur, note: m + transpose, prev: prev === null ? null : prev + transpose, vel: gain });
        prev = m;
      }
    });
  };
  lead(16, 0, S.lead, 1);
  lead(32, 2, S.lead, 1);
  lead(32, 14, S.lead2, 0.5);

  /* arps */
  const arpPat = [0, 1, 2, 3, 4, 3, 2, 1];
  const arps = (b0, b1, velFn, brightFn, oct) => {
    for (let b = b0; b < b1; b++) for (let s = 0; s < 16; s++) {
      if ((b === 15 || b === 31) && s >= 12) break;
      if ((b === 23 || b === 39) && s >= 8) break;
      const c = chordAt(b, s);
      if (!c) continue;
      const p = c.pad; const idx = arpPat[(b * 16 + s) % 8];
      const note = (idx === 4 ? p[0] + 12 : p[idx]) + 12 * oct;
      const x = ((b - b0) * 16 + s) / ((b1 - b0) * 16);
      S.arp.push({ t: T(b, s), note, vel: velFn(x, s), bright: brightFn(x), pan: (s & 1) ? 0.45 : -0.45 });
    }
  };
  arps(12, 16, (x) => 0.45 + 0.4 * x, (x) => 0.15 + 0.7 * x * x, 1);
  arps(16, 24, (x, s) => (s % 4 === 0 ? 0.8 : 0.6), () => 0.9, 1);
  arps(28, 32, (x) => 0.35 + 0.45 * x, (x) => 0.12 + 0.75 * x * x, 1);
  arps(32, 40, (x, s) => (s % 4 === 0 ? 0.8 : 0.6), () => 1.0, 1);

  /* plucks — the thread */
  for (const [b, s, m] of INTRO_PLUCKS) S.pluck.push({ t: T(b, s), note: m, vel: 0.85, pan: (R() - 0.5) * 0.6, sustain: 3.2 });
  for (let b = 24; b < 32; b++) {
    const c = chordAt(b, 0);
    for (let s = 2; s < 16; s += 4) {
      if (b === 31 && s >= 12) break;
      const idx = ((b * 4 + s) >> 1) % c.pad.length;
      S.pluck.push({ t: T(b, s), note: c.pad[idx] + 12, vel: b < 28 ? 0.4 : 0.5, pan: (R() - 0.5) * 1.1, sustain: 2.2 });
    }
  }
  OUTRO.forEach((bar, i) => {
    for (const [m, s] of bar) S.pluck.push({ t: T(40 + i, s), note: m, vel: 0.8, pan: (R() - 0.5) * 0.4, sustain: i === 5 ? 5 : 3 });
  });

  /* bells */
  [[0, 8, 81], [0, 11, 86], [0, 14, 90], [1, 2, 93]].forEach(([b, s, m], i) =>
    S.bell.push({ t: T(b, s), note: m, vel: 0.45 - i * 0.05, decay: 2.6, pan: -0.4 + i * 0.27 }));
  S.bell.push({ t: T(3), note: 86, vel: 0.35, decay: 3, pan: 0 });
  BELLS_BD.forEach((bar, i) => {
    for (const [m, s, l] of bar) S.bell.push({ t: T(24 + i, s), note: m, vel: 0.6, decay: 1.2 + l * 0.08, pan: (R() - 0.5) * 0.5 });
  });
  [95, 93, 91, 88, 86, 83, 81, 79, 76].forEach((m, i) =>
    S.bell.push({ t: T(43, 8) + i * STEP * 0.5, note: m, vel: 0.28 - i * 0.015, decay: 1.4, pan: 0.7 - i * 0.16 }));
  S.bell.push({ t: T(45), note: 88, vel: 0.35, decay: 4, pan: 0.1 });
  S.bell.push({ t: T(47), note: 88, vel: 0.42, decay: 3.2, pan: 0 });

  return S;
}

/* ═════════════════════════════ THE ENGINE ═════════════════════════════ */

function* renderGen(opts) {
  opts = opts || {};
  const SR = Math.min(48000, opts.sampleRate || 44100);
  const N = Math.round(DURATION * SR);
  const S = buildScore();
  const RND = rng(4242);

  /* ---------- building blocks ---------- */
  const SIN_N = 4096;
  const SIN = new Float32Array(SIN_N + 1);
  for (let i = 0; i <= SIN_N; i++) SIN[i] = Math.sin((i / SIN_N) * TAU);
  const fsin = (ph) => {
    ph -= Math.floor(ph);
    const x = ph * SIN_N, i = x | 0;
    return SIN[i] + (SIN[i + 1] - SIN[i]) * (x - i);
  };
  let noiseSeed = 0x9E3779B9;
  const noise = () => {
    noiseSeed ^= noiseSeed << 13; noiseSeed ^= noiseSeed >>> 17; noiseSeed ^= noiseSeed << 5;
    return (noiseSeed >>> 0) / 2147483648 - 1;
  };
  const svfCoef = (fc, q) => {
    const g = Math.tan(Math.PI * Math.max(20, Math.min(fc, SR * 0.45)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    return [a1, g * a1, g * g * a1, k];
  };
  // simple SVF processing on an array (static cutoff), mode 0=lp 1=bp 2=hp
  const svfArray = (x, fc, q, mode) => {
    const [a1, a2, a3, k] = svfCoef(fc, q);
    let ic1 = 0, ic2 = 0;
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v0 = x[i], v3 = v0 - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
      y[i] = mode === 0 ? v2 : mode === 1 ? v1 : v0 - k * v1 - v2;
    }
    return y;
  };
  const panGains = (p) => { const a = (p + 1) * Math.PI / 4; return [Math.cos(a), Math.sin(a)]; };

  /* ---------- one-shot samples ---------- */
  const mk = (sec) => new Float32Array(Math.round(sec * SR));
  // every one-shot ends on a short fade so nothing stops on a step
  const tail = (x, ms) => { const n = Math.min(x.length, Math.round((ms || 12) * SR / 1000)); for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n; return x; };

  function makeKick(click) {
    const x = mk(0.42);
    let ph = 0, clk = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const f = 46 + 115 * Math.exp(-t / 0.028) + 60 * Math.exp(-t / 0.004);
      ph += f / SR;
      const amp = Math.min(1, t / 0.0015) * Math.exp(-t / 0.19) * Math.min(1, (0.42 - t) / 0.04);
      let s = Math.sin(TAU * ph) * amp;
      clk += (noise() - clk) * 0.35;
      s += clk * Math.min(1, t / 0.0004) * Math.exp(-t / 0.0022) * 0.5 * click;
      x[i] = Math.tanh(s * 1.8) / Math.tanh(1.8);
    }
    return x;
  }
  const kickFull = tail(makeKick(1));
  const kickMuf = tail(svfArray(svfArray(makeKick(0), 260, 0.7, 0), 260, 0.7, 0));

  function makeClap() {
    const n = Math.round(0.42 * SR);
    const out = [new Float32Array(n), new Float32Array(n)];
    for (let ch = 0; ch < 2; ch++) {
      const raw = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        let e = 0;
        for (const tk of [0, 0.0105, 0.0215]) if (t >= tk) e += Math.exp(-(t - tk) / 0.0038);
        if (t >= 0.031) e += 0.85 * Math.exp(-(t - 0.031) / (0.12 + ch * 0.01));
        raw[i] = noise() * e;
      }
      const bp = svfArray(raw, 1150 + ch * 90, 1.1, 1);
      const hp = svfArray(raw, 2400, 0.7, 2);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const body = Math.sin(TAU * 185 * t) * Math.exp(-t / 0.03) * 0.35;
        out[ch][i] = (bp[i] * 1.5 + hp[i] * 0.35 + body) * 0.6;
      }
    }
    return out;
  }
  const clapS = makeClap().map((x) => tail(x, 30));

  function makeSnare() {
    const n = Math.round(0.3 * SR);
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = noise();
    const nz = svfArray(raw, 3200, 0.6, 1);
    const x = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (175 + 60 * Math.exp(-t / 0.02)) / SR;
      x[i] = Math.sin(TAU * ph) * Math.exp(-t / 0.045) * 0.7 + nz[i] * Math.exp(-t / 0.075) * 1.2;
    }
    return x;
  }
  const snareS = tail(makeSnare(), 30);

  function makeMetal(len, decay, hpf) {
    const n = Math.round(len * SR);
    const fr = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0].map((f) => f * 1.75);
    const ph = fr.map(() => RND());
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < 6; j++) { ph[j] += fr[j] / SR; s += (ph[j] % 1) < 0.5 ? 1 : -1; }
      raw[i] = s / 6 * 0.7 + noise() * 0.45;
    }
    const bp = svfArray(raw, 9500, 0.8, 1);
    const hp = svfArray(bp, hpf, 0.7, 2);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      x[i] = hp[i] * Math.exp(-t / decay) * Math.min(1, t / 0.0006) * Math.min(1, (len - t) / 0.01) * 1.6;
    }
    return x;
  }
  const hatC = makeMetal(0.09, 0.022, 7000);
  const hatO = makeMetal(0.42, 0.13, 6500);

  function makeRim() {
    const x = mk(0.08);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      x[i] = (Math.sin(TAU * 1650 * t) * 0.6 + Math.sin(TAU * 820 * t) * 0.4) * Math.exp(-t / 0.012) + noise() * Math.exp(-t / 0.003) * 0.3;
    }
    return x;
  }
  const rimS = tail(makeRim());

  function makeCrash() {
    const n = Math.round(3.2 * SR);
    const out = [];
    for (let ch = 0; ch < 2; ch++) {
      const raw = new Float32Array(n);
      const fr = [311, 437, 587, 733, 881, 1133, 1437, 1789].map((f) => f * (1 + ch * 0.013));
      const ph = fr.map(() => RND());
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < fr.length; j++) { ph[j] += fr[j] / SR; s += (ph[j] % 1) < 0.5 ? 1 : -1; }
        raw[i] = noise() * 0.8 + s * 0.05;
      }
      const hp = svfArray(svfArray(raw, 3800, 0.7, 2), 12500, 0.7, 0);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        x[i] = hp[i] * (Math.exp(-t / 0.9) * 0.8 + Math.exp(-t / 0.08) * 0.6) * Math.min(1, t / 0.002) * Math.min(1, (3.2 - t) / 0.3);
      }
      out.push(x);
    }
    return out;
  }
  const crashS = makeCrash();
  const revS = (() => {
    const len = Math.round(2 * BEAT * SR);
    const out = [];
    for (let ch = 0; ch < 2; ch++) {
      const x = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const src = crashS[ch][len - 1 - i];
        const t = i / len;
        x[i] = src * t * t * 1.2;
      }
      out.push(x);
    }
    return out;
  })();

  function makeImpact() {
    const n = Math.round(3.0 * SR);
    const x = new Float32Array(n);
    let ph = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (27 + 58 * Math.exp(-t / 0.35)) / SR;
      const sub = Math.sin(TAU * ph) * Math.exp(-t / 1.0) * Math.min(1, t / 0.004);
      const c = 1 - Math.exp(-TAU * (90 + 2400 * Math.exp(-t / 0.12)) / SR);
      lp += (noise() - lp) * c;
      x[i] = Math.tanh((sub * 0.9 + lp * Math.exp(-t / 0.35) * 0.9) * 1.3) * Math.min(1, (3 - t) / 0.3);
    }
    return x;
  }
  const impactS = makeImpact();

  function makeHeart() {
    const x = mk(0.3);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      ph += (44 + 36 * Math.exp(-t / 0.025)) / SR;
      x[i] = Math.sin(TAU * ph) * Math.min(1, t / 0.006) * Math.exp(-t / 0.075);
    }
    return svfArray(x, 180, 0.7, 0);
  }
  const heartS = tail(makeHeart(), 30);

  /* ---------- automation ---------- */
  function padCut(t) {
    const b = t / BAR;
    if (b < 8) return 650 + 450 * (b / 8);
    if (b < 16) return 900 * Math.pow(6.5, (b - 8) / 8);
    if (b < 24) return 5600;
    if (b < 28) return 1300 + 1200 * ((b - 24) / 4);
    if (b < 32) return 2500 * Math.pow(2.8, (b - 28) / 4);
    if (b < 40) return 7000;
    return 4200 * Math.pow(0.32, (b - 40) / 8);
  }
  function duckDepth(t) {
    const b = t / BAR;
    if ((b >= 16 && b < 24) || (b >= 32 && b < 40)) return 0.62;
    if ((b >= 12 && b < 16) || (b >= 30 && b < 32)) return 0.42;
    if ((b >= 8 && b < 12) || (b >= 28 && b < 30)) return 0.22;
    return 0;
  }

  /* ---------- voices ---------- */
  // Every voice: start, end (samples), stem, bus (0 dry, 1 ducked), gain, rev, dly,
  //              process(L, R, off, len, abs) → writes (not adds) its output.
  const voices = [];
  const V = (v, o) => { Object.assign(v, o); voices.push(v); return v; };

  function SampleVoice(t, L, R, rate, pan) {
    this.start = Math.round(t * SR);
    this.L = L; this.R = R || L;
    this.rate = rate || 1;
    this.end = this.start + Math.floor((this.L.length - 2) / this.rate);
    const [gl, gr] = panGains(pan || 0);
    this.gl = gl * Math.SQRT2; this.gr = gr * Math.SQRT2;
  }
  SampleVoice.prototype.process = function (L, R, off, len, abs) {
    const dL = this.L, dR = this.R, rate = this.rate, gl = this.gl, gr = this.gr;
    let l = abs - this.start;
    if (rate === 1) {
      for (let k = 0; k < len; k++, l++) { L[off + k] = dL[l] * gl; R[off + k] = dR[l] * gr; }
    } else {
      for (let k = 0; k < len; k++, l++) {
        const x = l * rate, i = x | 0, f = x - i;
        L[off + k] = (dL[i] + (dL[i + 1] - dL[i]) * f) * gl;
        R[off + k] = (dR[i] + (dR[i + 1] - dR[i]) * f) * gr;
      }
    }
  };

  function PadVoice(p, R) {
    this.start = Math.round(p.t * SR);
    this.noteLen = Math.round(p.dur * SR);
    this.att = Math.max(1, Math.round(p.att * SR));
    this.rel = Math.max(1, Math.round(p.rel * SR));
    this.end = Math.min(N, this.start + this.noteLen + this.rel);
    const det = [-0.16, -0.07, 0, 0.07, 0.16].map((d) => d * p.det);
    const spread = [-0.9, -0.45, 0, 0.45, 0.9];
    const n = p.notes.length * det.length;
    this.n = n;
    this.ph = new Float64Array(n); this.dt = new Float64Array(n);
    this.gl = new Float32Array(n); this.gr = new Float32Array(n);
    let j = 0;
    p.notes.forEach((m, ni) => {
      det.forEach((d, di) => {
        this.ph[j] = R();
        this.dt[j] = mtof(m + d) / SR;
        const sp = spread[ni & 1 ? det.length - 1 - di : di] * 0.85;
        const [gl, gr] = panGains(sp);
        const w = 1 / Math.sqrt(n) * (di === 2 ? 1.1 : 1);
        this.gl[j] = gl * w; this.gr[j] = gr * w;
        j++;
      });
    });
    this.bright = p.bright; this.fenv = p.fenv;
    this.l1 = this.l2 = this.r1 = this.r2 = 0;
    this.c = [0, 0, 0];
  }
  PadVoice.prototype.process = function (L, R, off, len, abs) {
    const n = this.n, ph = this.ph, dt = this.dt, GL = this.gl, GR = this.gr;
    let l1 = this.l1, l2 = this.l2, r1 = this.r1, r2 = this.r2;
    let a1 = this.c[0], a2 = this.c[1], a3 = this.c[2];
    const att = this.att, noteLen = this.noteLen, rel = this.rel;
    let local = abs - this.start;
    for (let k = 0; k < len; k++, local++) {
      if ((local & 31) === 0 || k === 0) {
        let fc = padCut((abs + k) / SR) * this.bright * (1 + this.fenv * Math.exp(-local / (0.11 * SR)));
        if (fc > 15000) fc = 15000;
        const g = Math.tan(Math.PI * fc / SR);
        a1 = 1 / (1 + g * (g + 1.25)); a2 = g * a1; a3 = g * a2;
      }
      let sl = 0, sr = 0;
      for (let j = 0; j < n; j++) {
        let p = ph[j]; const d = dt[j];
        let v = 2 * p - 1;
        if (p < d) { const x = p / d; v -= x + x - x * x - 1; }
        else if (p > 1 - d) { const x = (p - 1) / d; v -= x * x + x + x + 1; }
        p += d; if (p >= 1) p -= 1; ph[j] = p;
        sl += v * GL[j]; sr += v * GR[j];
      }
      let e = local < att ? local / att : 1;
      e = e * e * (3 - 2 * e);
      if (local >= noteLen) { const x = 1 - (local - noteLen) / rel; e *= x > 0 ? x * x : 0; }
      let v3 = sl - l2, v1 = a1 * l1 + a2 * v3, v2 = l2 + a2 * l1 + a3 * v3;
      l1 = 2 * v1 - l1; l2 = 2 * v2 - l2;
      L[off + k] = v2 * e;
      v3 = sr - r2; v1 = a1 * r1 + a2 * v3; v2 = r2 + a2 * r1 + a3 * v3;
      r1 = 2 * v1 - r1; r2 = 2 * v2 - r2;
      R[off + k] = v2 * e;
    }
    this.l1 = l1; this.l2 = l2; this.r1 = r1; this.r2 = r2;
    this.c[0] = a1; this.c[1] = a2; this.c[2] = a3;
  };

  function BassVoice(p) {
    this.start = Math.round(p.t * SR);
    this.noteLen = Math.round(p.dur * SR);
    this.rel = Math.round((p.sub ? 0.25 : 0.035) * SR);
    this.end = Math.min(N, this.start + this.noteLen + this.rel);
    this.dt = mtof(p.note) / SR;
    this.ph = 0; this.ps = 0; this.i1 = 0; this.i2 = 0;
    this.sub = !!p.sub;
    this.c = [0, 0, 0];
  }
  BassVoice.prototype.process = function (L, R, off, len, abs) {
    let ph = this.ph, ps = this.ps, i1 = this.i1, i2 = this.i2;
    let a1 = this.c[0], a2 = this.c[1], a3 = this.c[2];
    const dt = this.dt, noteLen = this.noteLen, rel = this.rel, sub = this.sub;
    const att = Math.round((sub ? 0.06 : 0.003) * SR);
    let local = abs - this.start;
    for (let k = 0; k < len; k++, local++) {
      if ((local & 15) === 0 || k === 0) {
        const fc = sub ? 220 : 170 + 1500 * Math.exp(-local / (0.065 * SR));
        const g = Math.tan(Math.PI * fc / SR);
        a1 = 1 / (1 + g * (g + 1.1)); a2 = g * a1; a3 = g * a2;
      }
      let v = 2 * ph - 1;
      if (ph < dt) { const x = ph / dt; v -= x + x - x * x - 1; }
      else if (ph > 1 - dt) { const x = (ph - 1) / dt; v -= x * x + x + x + 1; }
      ph += dt; if (ph >= 1) ph -= 1;
      ps += dt; if (ps >= 1) ps -= 1;
      const v3 = v - i2, v1 = a1 * i1 + a2 * v3, v2 = i2 + a2 * i1 + a3 * v3;
      i1 = 2 * v1 - i1; i2 = 2 * v2 - i2;
      let e = local < att ? local / att : sub ? 1 : 0.72 + 0.28 * Math.exp(-(local - att) / (0.09 * SR));
      if (local >= noteLen) { const x = 1 - (local - noteLen) / rel; e *= x > 0 ? x : 0; }
      const s = Math.tanh((fsin(ps) * 0.85 + v2 * (sub ? 0.25 : 0.55)) * 1.5) * e;
      L[off + k] = s; R[off + k] = s;
    }
    this.ph = ph; this.ps = ps; this.i1 = i1; this.i2 = i2;
    this.c[0] = a1; this.c[1] = a2; this.c[2] = a3;
  };

  function LeadVoice(p) {
    this.start = Math.round(p.t * SR);
    this.noteLen = Math.round(p.dur * SR);
    this.rel = Math.round(0.14 * SR);
    this.end = Math.min(N, this.start + this.noteLen + this.rel);
    this.f1 = mtof(p.note);
    this.f0 = p.prev != null ? mtof(p.prev) : this.f1;
    this.pa = RND(); this.pb = RND(); this.pq = RND(); this.pv = 0;
    this.s = [0, 0, 0, 0];
    this.c = [0, 0, 0];
    this.bright = p.bright || 1;
  }
  LeadVoice.prototype.process = function (L, R, off, len, abs) {
    let pa = this.pa, pb = this.pb, pq = this.pq, pv = this.pv;
    const s = this.s;
    let a1 = this.c[0], a2 = this.c[1], a3 = this.c[2];
    const f0 = this.f0, f1 = this.f1, noteLen = this.noteLen, rel = this.rel;
    const glide = 0.028 * SR, att = 0.007 * SR;
    let local = abs - this.start;
    for (let k = 0; k < len; k++, local++) {
      if ((local & 15) === 0 || k === 0) {
        const fc = (1700 + 4600 * Math.exp(-local / (0.16 * SR))) * this.bright;
        const g = Math.tan(Math.PI * Math.min(fc, 14000) / SR);
        a1 = 1 / (1 + g * (g + 1.05)); a2 = g * a1; a3 = g * a2;
      }
      const tt = local / SR;
      const vibD = Math.min(1, Math.max(0, (tt - 0.16) / 0.25)) * 0.0105;
      pv += 5.6 / SR;
      let f = f1 + (f0 - f1) * Math.exp(-local / glide);
      f *= 1 + vibD * fsin(pv);
      const da = f * 1.0041 / SR, db = f * 0.9959 / SR, dq = f * 0.5 / SR;
      let va = 2 * pa - 1;
      if (pa < da) { const x = pa / da; va -= x + x - x * x - 1; } else if (pa > 1 - da) { const x = (pa - 1) / da; va -= x * x + x + x + 1; }
      let vb = 2 * pb - 1;
      if (pb < db) { const x = pb / db; vb -= x + x - x * x - 1; } else if (pb > 1 - db) { const x = (pb - 1) / db; vb -= x * x + x + x + 1; }
      let vq = pq < 0.5 ? 1 : -1;
      if (pq < dq) { const x = pq / dq; vq += x + x - x * x - 1; } else if (pq > 1 - dq) { const x = (pq - 1) / dq; vq += x * x + x + x + 1; }
      const pq2 = pq + 0.5 >= 1 ? pq - 0.5 : pq + 0.5;
      if (pq2 < dq) { const x = pq2 / dq; vq -= x + x - x * x - 1; } else if (pq2 > 1 - dq) { const x = (pq2 - 1) / dq; vq -= x * x + x + x + 1; }
      pa += da; if (pa >= 1) pa -= 1;
      pb += db; if (pb >= 1) pb -= 1;
      pq += dq; if (pq >= 1) pq -= 1;
      const inL = va * 0.55 + vq * 0.2, inR = vb * 0.55 + vq * 0.2;
      let v3 = inL - s[1], v1 = a1 * s[0] + a2 * v3, v2 = s[1] + a2 * s[0] + a3 * v3;
      s[0] = 2 * v1 - s[0]; s[1] = 2 * v2 - s[1];
      const oL = v2;
      v3 = inR - s[3]; v1 = a1 * s[2] + a2 * v3; v2 = s[3] + a2 * s[2] + a3 * v3;
      s[2] = 2 * v1 - s[2]; s[3] = 2 * v2 - s[3];
      const oR = v2;
      let e = local < att ? local / att : 0.78 + 0.22 * Math.exp(-(local - att) / (0.22 * SR));
      if (local >= noteLen) { const x = 1 - (local - noteLen) / rel; e *= x > 0 ? x * x : 0; }
      L[off + k] = oL * e; R[off + k] = oR * e;
    }
    this.pa = pa; this.pb = pb; this.pq = pq; this.pv = pv;
    this.c[0] = a1; this.c[1] = a2; this.c[2] = a3;
  };

  function ArpVoice(p) {
    this.start = Math.round(p.t * SR);
    this.end = Math.min(N, this.start + Math.round(0.42 * SR));
    this.dt = mtof(p.note) / SR;
    this.ph = RND(); this.pq = RND();
    this.i1 = 0; this.i2 = 0;
    this.bright = p.bright;
    const [gl, gr] = panGains(p.pan);
    this.gl = gl; this.gr = gr;
    this.c = [0, 0, 0];
  }
  ArpVoice.prototype.process = function (L, R, off, len, abs) {
    let ph = this.ph, pq = this.pq, i1 = this.i1, i2 = this.i2;
    let a1 = this.c[0], a2 = this.c[1], a3 = this.c[2];
    const dt = this.dt, gl = this.gl, gr = this.gr, total = this.end - this.start;
    let local = abs - this.start;
    for (let k = 0; k < len; k++, local++) {
      if ((local & 15) === 0 || k === 0) {
        const fc = 260 + 6200 * this.bright * Math.exp(-local / (0.055 * SR));
        const g = Math.tan(Math.PI * Math.min(fc, 14000) / SR);
        a1 = 1 / (1 + g * (g + 0.8)); a2 = g * a1; a3 = g * a2;
      }
      let v = 2 * ph - 1;
      if (ph < dt) { const x = ph / dt; v -= x + x - x * x - 1; } else if (ph > 1 - dt) { const x = (ph - 1) / dt; v -= x * x + x + x + 1; }
      ph += dt; if (ph >= 1) ph -= 1;
      const d2 = dt * 2;
      let w = 2 * pq - 1;
      if (pq < d2) { const x = pq / d2; w -= x + x - x * x - 1; } else if (pq > 1 - d2) { const x = (pq - 1) / d2; w -= x * x + x + x + 1; }
      pq += d2; if (pq >= 1) pq -= 1;
      const inp = v * 0.7 + w * 0.3;
      const v3 = inp - i2, v1 = a1 * i1 + a2 * v3, v2 = i2 + a2 * i1 + a3 * v3;
      i1 = 2 * v1 - i1; i2 = 2 * v2 - i2;
      const e = Math.min(1, local / (0.002 * SR)) * Math.exp(-local / (0.13 * SR)) * Math.min(1, (total - local) / (0.02 * SR));
      L[off + k] = v2 * e * gl; R[off + k] = v2 * e * gr;
    }
    this.ph = ph; this.pq = pq; this.i1 = i1; this.i2 = i2;
    this.c[0] = a1; this.c[1] = a2; this.c[2] = a3;
  };

  function PluckVoice(p) {
    this.start = Math.round(p.t * SR);
    const sus = p.sustain || 3;
    this.end = Math.min(N, this.start + Math.round((sus + 0.2) * SR));
    const f = mtof(p.note);
    let D = SR / f - 0.5;
    let Ni = Math.floor(D), fr = D - Ni;
    if (fr < 0.2) { Ni -= 1; fr += 1; }
    this.C = (1 - fr) / (1 + fr);
    this.buf = new Float32Array(Ni);
    this.n = Ni; this.p = 0;
    this.rho = Math.pow(10, -3 / (f * sus));
    // excitation: bright-ish noise burst, softened, with a pick-position comb
    let lp = 0;
    const tmp = new Float32Array(Ni);
    for (let i = 0; i < Ni; i++) { lp += (noise() - lp) * 0.7; tmp[i] = lp; }
    const pick = Math.max(1, Math.round(Ni * 0.13));
    let mean = 0;
    for (let i = 0; i < Ni; i++) { this.buf[i] = tmp[i] - 0.6 * tmp[(i + pick) % Ni]; mean += this.buf[i]; }
    mean /= Ni;
    let mx = 1e-9;
    for (let i = 0; i < Ni; i++) { this.buf[i] -= mean; mx = Math.max(mx, Math.abs(this.buf[i])); }
    for (let i = 0; i < Ni; i++) this.buf[i] /= mx;
    this.x1 = 0; this.y1 = 0; this.prev = 0; this.hp = 0;
    const [gl, gr] = panGains(p.pan || 0);
    this.gl = gl; this.gr = gr;
    this.tail = Math.round(0.2 * SR); this.total = this.end - this.start;
  }
  PluckVoice.prototype.process = function (L, R, off, len, abs) {
    const buf = this.buf, n = this.n, C = this.C, rho = this.rho, gl = this.gl, gr = this.gr;
    let p = this.p, x1 = this.x1, y1 = this.y1, prev = this.prev, hp = this.hp;
    let local = abs - this.start;
    const total = this.total, tail = this.tail;
    for (let k = 0; k < len; k++, local++) {
      const out = buf[p];
      const avg = 0.5 * (out + prev) * rho;
      prev = out;
      const y = C * avg + x1 - C * y1;
      x1 = avg; y1 = y;
      buf[p] = y;
      p++; if (p >= n) p = 0;
      hp += (out - hp) * 0.004;
      let e = Math.min(1, local / 24);
      if (local > total - tail) e *= (total - local) / tail;
      const s = (out - hp) * e;
      L[off + k] = s * gl; R[off + k] = s * gr;
    }
    this.p = p; this.x1 = x1; this.y1 = y1; this.prev = prev; this.hp = hp;
  };

  function BellVoice(p) {
    this.start = Math.round(p.t * SR);
    this.decay = p.decay || 2;
    this.end = Math.min(N, this.start + Math.round(this.decay * 3.2 * SR));
    this.f = mtof(p.note);
    this.pc = 0; this.pm = 0; this.pc2 = 0; this.pm2 = 0;
    const [gl, gr] = panGains(p.pan || 0);
    this.gl = gl; this.gr = gr;
  }
  BellVoice.prototype.process = function (L, R, off, len, abs) {
    const f = this.f, gl = this.gl, gr = this.gr;
    let pc = this.pc, pm = this.pm, pc2 = this.pc2, pm2 = this.pm2;
    const dc = f / SR, dm = f * 3.5 / SR, dc2 = f * 2.001 / SR, dm2 = f * 1.001 / SR;
    const tauA = this.decay * SR, total = this.end - this.start;
    let local = abs - this.start;
    // decaying envelopes as running products (no per-sample exp)
    let eI = Math.exp(-local / (0.11 * SR)), eM = Math.exp(-local / (0.2 * SR));
    let eA = Math.exp(-local / tauA), eP = Math.exp(-local / (tauA * 0.4));
    const kI = Math.exp(-1 / (0.11 * SR)), kM = Math.exp(-1 / (0.2 * SR)), kA = Math.exp(-1 / tauA), kP = Math.exp(-1 / (tauA * 0.4));
    const att = 0.0015 * SR;
    for (let k = 0; k < len; k++, local++) {
      const s1 = fsin(pc + (3.0 * eI + 0.55) * fsin(pm) * 0.15915494);
      const s2 = fsin(pc2 + 0.15 * eM * fsin(pm2));
      pc += dc; pm += dm; pc2 += dc2; pm2 += dm2;
      let e = (local < att ? local / att : 1) * eA;
      if (local > total - 2000) e *= (total - local) / 2000;
      const s = (s1 * 0.8 + s2 * 0.3 * eP) * e;
      eI *= kI; eM *= kM; eA *= kA; eP *= kP;
      L[off + k] = s * gl; R[off + k] = s * gr;
    }
    if (pc > 1e4) { pc -= Math.floor(pc); pm -= Math.floor(pm); pc2 -= Math.floor(pc2); pm2 -= Math.floor(pm2); }
    this.pc = pc; this.pm = pm; this.pc2 = pc2; this.pm2 = pm2;
  };

  function DroneVoice(p) {
    this.start = Math.round(p.t * SR);
    this.end = Math.min(N, this.start + Math.round(p.dur * SR));
    this.fin = p.fadeIn * SR; this.fout = p.fadeOut * SR; this.total = this.end - this.start;
    const dets = [-0.05, 0.05];
    this.dt = []; this.ph = []; this.pan = [];
    p.notes.forEach((m, i) => dets.forEach((d, j) => {
      this.dt.push(mtof(m + d) / SR); this.ph.push(RND()); this.pan.push(panGains((j ? 0.6 : -0.6) * (i ? -1 : 1)));
    }));
    this.sdt = mtof(p.notes[0]) / SR; this.sph = 0;
    this.s = [0, 0, 0, 0]; this.lfo = 0;
  }
  DroneVoice.prototype.process = function (L, R, off, len, abs) {
    const s = this.s, dt = this.dt, ph = this.ph, pan = this.pan, n = dt.length;
    let a1 = 0, a2 = 0, a3 = 0, lfo = this.lfo, sph = this.sph;
    let local = abs - this.start;
    for (let k = 0; k < len; k++, local++) {
      if ((local & 31) === 0 || k === 0) {
        const x = local / this.total;
        const fc = 180 + 900 * Math.sin(Math.PI * Math.min(1, x * 1.3)) * (0.75 + 0.25 * fsin(lfo));
        const g = Math.tan(Math.PI * fc / SR);
        a1 = 1 / (1 + g * (g + 1.2)); a2 = g * a1; a3 = g * a2;
      }
      lfo += 0.11 / SR;
      let sl = 0, sr = 0;
      for (let j = 0; j < n; j++) {
        let q = ph[j] + dt[j]; if (q >= 1) q -= 1; ph[j] = q;
        const v = 2 * q - 1;
        sl += v * pan[j][0]; sr += v * pan[j][1];
      }
      sph += this.sdt; if (sph >= 1) sph -= 1;
      let v3 = sl - s[1], v1 = a1 * s[0] + a2 * v3, v2 = s[1] + a2 * s[0] + a3 * v3;
      s[0] = 2 * v1 - s[0]; s[1] = 2 * v2 - s[1];
      const oL = v2;
      v3 = sr - s[3]; v1 = a1 * s[2] + a2 * v3; v2 = s[3] + a2 * s[2] + a3 * v3;
      s[2] = 2 * v1 - s[2]; s[3] = 2 * v2 - s[3];
      const oR = v2;
      let e = Math.min(1, local / this.fin, (this.total - local) / this.fout);
      e = e * e;
      const sub = fsin(sph) * 0.5;
      L[off + k] = (oL * 0.5 + sub) * e; R[off + k] = (oR * 0.5 + sub) * e;
    }
    this.lfo = lfo; this.sph = sph;
  };

  // noise effects: mode 'riser' | 'down' | 'whoosh' | 'wind' | 'shimmer'
  function NoiseVoice(p, mode) {
    this.start = Math.round(p.t * SR);
    this.end = Math.min(N, this.start + Math.round(p.dur * SR));
    this.total = this.end - this.start;
    this.mode = mode;
    this.s = [0, 0, 0, 0];
    this.seedL = 0x1234567 + this.start; this.seedR = 0x7654321 + this.start * 3;
    this.ph = 0; this.lfo = 0;
  }
  NoiseVoice.prototype.process = function (L, R, off, len, abs) {
    const s = this.s, total = this.total, mode = this.mode;
    let sL = this.seedL | 0, sR = this.seedR | 0, ph = this.ph, lfo = this.lfo;
    let a1 = 0, a2 = 0, a3 = 0, kq = 1, gain = 0;
    let local = abs - this.start;
    for (let k = 0; k < len; k++, local++) {
      const x = local / total;
      if ((local & 31) === 0 || k === 0) {
        let fc, q;
        if (mode === 'riser') { fc = 220 * Math.pow(38, x * x * 0.3 + x * 0.7); q = 2.2; gain = x * x * 0.9 * Math.min(1, (total - local) / (0.015 * SR)); }
        else if (mode === 'down') { fc = 5000 * Math.pow(0.03, Math.sqrt(x)); q = 1.6; gain = Math.pow(1 - x, 2) * 0.7; }
        else if (mode === 'whoosh') { fc = 300 * Math.pow(22, x); q = 0.9; gain = Math.pow(x, 2.5) * Math.min(1, (1 - x) * 25); }
        else if (mode === 'wind') { fc = 450 + 350 * fsin(lfo) + 150 * fsin(lfo * 2.7); q = 1.4; gain = 0.16 * Math.min(1, x * 5, (1 - x) * 3) * (0.7 + 0.3 * fsin(lfo * 1.9)); }
        else { fc = 7500; q = 0.7; gain = 0.05 * Math.min(1, x * 4, (1 - x) * 3) * (0.6 + 0.4 * fsin(lfo * 3.1)); }
        const g = Math.tan(Math.PI * Math.max(40, Math.min(fc, 16000)) / SR);
        kq = 1 / q; a1 = 1 / (1 + g * (g + kq)); a2 = g * a1; a3 = g * a2;
      }
      lfo += 0.13 / SR;
      sL ^= sL << 13; sL ^= sL >>> 17; sL ^= sL << 5;
      sR ^= sR << 13; sR ^= sR >>> 17; sR ^= sR << 5;
      const nL = (sL >>> 0) / 2147483648 - 1, nR = (sR >>> 0) / 2147483648 - 1;
      let v3 = nL - s[1], v1 = a1 * s[0] + a2 * v3, v2 = s[1] + a2 * s[0] + a3 * v3;
      s[0] = 2 * v1 - s[0]; s[1] = 2 * v2 - s[1];
      let oL = mode === 'shimmer' ? nL - kq * v1 - v2 : mode === 'wind' ? v2 : v1;
      v3 = nR - s[3]; v1 = a1 * s[2] + a2 * v3; v2 = s[3] + a2 * s[2] + a3 * v3;
      s[2] = 2 * v1 - s[2]; s[3] = 2 * v2 - s[3];
      let oR = mode === 'shimmer' ? nR - kq * v1 - v2 : mode === 'wind' ? v2 : v1;
      if (mode === 'riser') {
        ph += (55 * Math.pow(4, x)) / SR; if (ph >= 1) ph -= 1;
        const saw = (2 * ph - 1) * 0.08 * x;
        oL += saw; oR += saw;
      }
      L[off + k] = oL * gain; R[off + k] = oR * gain;
    }
    this.seedL = sL; this.seedR = sR; this.ph = ph; this.lfo = lfo;
  };

  /* ---------- instantiate the score ---------- */
  const R = rng(777);
  for (const e of S.kick) V(new SampleVoice(e.t, kickFull, null, 1, 0), { stem: ST.kick, bus: 0, gain: 0.8 * e.vel, rev: 0, dly: 0 });
  for (const e of S.kickM) V(new SampleVoice(e.t, kickMuf, null, 1, 0), { stem: ST.kick, bus: 0, gain: 0.85 * e.vel, rev: 0, dly: 0 });
  for (const e of S.clap) V(new SampleVoice(e.t, clapS[0], clapS[1], 1, 0), { stem: ST.snare, bus: 0, gain: 0.95 * e.vel, rev: 0.22, dly: 0 });
  for (const e of S.snare) V(new SampleVoice(e.t, snareS, null, e.rate, 0), { stem: ST.snare, bus: 0, gain: 0.6 * e.vel, rev: 0.25, dly: 0 });
  for (const e of S.hatC) V(new SampleVoice(e.t, hatC, null, 1, 0.25), { stem: ST.hat, bus: 0, gain: 0.4 * e.vel, rev: 0.03, dly: 0 });
  for (const e of S.hatO) V(new SampleVoice(e.t, hatO, null, 1, -0.2), { stem: ST.hat, bus: 0, gain: 0.3 * e.vel, rev: 0.06, dly: 0 });
  for (const e of S.rim) V(new SampleVoice(e.t, rimS, null, 1, e.pan), { stem: ST.hat, bus: 0, gain: 0.3 * e.vel, rev: 0.15, dly: 0.12 });
  for (const e of S.crash) V(new SampleVoice(e.t, crashS[0], crashS[1], 1, 0), { stem: ST.hat, bus: 0, gain: 0.3 * e.vel, rev: 0.2, dly: 0 });
  for (const e of S.revCym) V(new SampleVoice(e.t, revS[0], revS[1], 1, 0), { stem: ST.fx, bus: 0, gain: 0.3 * e.vel, rev: 0.25, dly: 0 });
  for (const e of S.impact) V(new SampleVoice(e.t, impactS, null, 1, 0), { stem: ST.fx, bus: 0, gain: 0.55 * e.vel, rev: 0.35, dly: 0 });
  for (const e of S.heart) V(new SampleVoice(e.t, heartS, null, 1, 0), { stem: ST.kick, bus: 0, gain: 0.85 * e.vel, rev: 0.05, dly: 0 });
  for (const e of S.pad) V(new PadVoice(e, R), { stem: ST.pad, bus: 1, gain: 0.3 * e.vel, rev: 0.32, dly: 0 });
  for (const e of S.drone) V(new DroneVoice(e), { stem: ST.drone, bus: 0, gain: 0.15 * e.vel, rev: 0.35, dly: 0 });
  for (const e of S.bass) V(new BassVoice(e), { stem: ST.bass, bus: 1, gain: 0.55 * e.vel, rev: 0, dly: 0 });
  for (const e of S.lead) V(new LeadVoice(e), { stem: ST.lead, bus: 0, gain: 0.45 * e.vel, rev: 0.22, dly: 0.24 });
  for (const e of S.lead2) V(new LeadVoice({ ...e, bright: 0.8 }), { stem: ST.lead, bus: 0, gain: 0.45 * e.vel, rev: 0.3, dly: 0.2 });
  for (const e of S.arp) V(new ArpVoice(e), { stem: ST.arp, bus: 1, gain: 0.28 * e.vel, rev: 0.12, dly: 0.2 });
  for (const e of S.pluck) V(new PluckVoice(e), { stem: ST.pluck, bus: 0, gain: 0.85 * e.vel, rev: 0.34, dly: 0.2 });
  for (const e of S.bell) V(new BellVoice(e), { stem: ST.bell, bus: 0, gain: 0.3 * e.vel, rev: 0.45, dly: 0.28 });
  for (const e of S.riser) V(new NoiseVoice(e, 'riser'), { stem: ST.fx, bus: 0, gain: 0.3 * e.vel, rev: 0.3, dly: 0 });
  for (const e of S.downlifter) V(new NoiseVoice(e, 'down'), { stem: ST.fx, bus: 0, gain: 0.28 * e.vel, rev: 0.4, dly: 0 });
  for (const e of S.whoosh) V(new NoiseVoice(e, 'whoosh'), { stem: ST.fx, bus: 0, gain: 0.3 * e.vel, rev: 0.45, dly: 0 });
  for (const e of S.wind) V(new NoiseVoice(e, 'wind'), { stem: ST.fx, bus: 0, gain: 0.35 * e.vel, rev: 0.2, dly: 0 });
  for (const e of S.shimmer) V(new NoiseVoice(e, 'shimmer'), { stem: ST.fx, bus: 0, gain: 0.5 * e.vel, rev: 0.6, dly: 0 });
  voices.sort((a, b) => a.start - b.start);

  /* ---------- sends: plate reverb + ping-pong delay ---------- */
  function makePlate(p) {
    const sc = SR / 29761;
    const Lx = (x) => Math.max(2, Math.round(x * sc));
    const ring = (n) => ({ b: new Float32Array(n), n, w: 0 });
    const pre = ring(Math.max(2, Math.round(p.predelay * SR)));
    const ins = [Lx(142), Lx(107), Lx(379), Lx(277)].map(ring);
    const inG = [p.inDiff1, p.inDiff1, p.inDiff2, p.inDiff2];
    const exc = p.excursion * sc;
    const mAn = Lx(672), mBn = Lx(908);
    const mA = ring(mAn + Math.ceil(exc) + 3), mB = ring(mBn + Math.ceil(exc) + 3);
    const dA1 = ring(Lx(4453)), aA2 = ring(Lx(1800)), dA2 = ring(Lx(3720));
    const dB1 = ring(Lx(4217)), aB2 = ring(Lx(2656)), dB2 = ring(Lx(3163));
    const tap = (r, d) => { let i = r.w - d; if (i < 0) i += r.n; return r.b[i]; };
    const tL = [[dB1, Lx(266), 1], [dB1, Lx(2974), 1], [aB2, Lx(1913), -1], [dB2, Lx(1996), 1], [dA1, Lx(1990), -1], [aA2, Lx(187), -1], [dA2, Lx(1066), -1]];
    const tR = [[dA1, Lx(353), 1], [dA1, Lx(3627), 1], [aA2, Lx(1228), -1], [dA2, Lx(2673), 1], [dB1, Lx(2111), -1], [aB2, Lx(335), -1], [dB2, Lx(121), -1]];
    let bw = 0, dampA = 0, dampB = 0, lfo = 0;
    const decay = p.decay, damp = p.damping, band = p.bandwidth, dd1 = p.decDiff1, dd2 = p.decDiff2;
    const push = (r, v) => { r.b[r.w] = v; r.w = r.w + 1 === r.n ? 0 : r.w + 1; };
    const ap = (r, x, g) => { // Schroeder allpass with the full ring length as the delay
      const d = r.b[r.w];
      const v = x + g * d;
      push(r, v);
      return d - g * v;
    };
    const modAp = (r, x, g, len, off) => {
      let fp = r.w - len - off; if (fp < 0) fp += r.n;
      const i0 = Math.floor(fp), fr = fp - i0;
      const i1 = i0 + 1 >= r.n ? 0 : i0 + 1;
      const d0 = r.b[i0], d1 = r.b[i1];
      const d = d0 + (d1 - d0) * fr;
      const v = x + g * d;
      push(r, v);
      return d - g * v;
    };
    return function (inp, outL, outR, n) {
      for (let i = 0; i < n; i++) {
        // predelay
        const x0 = pre.b[pre.w]; push(pre, inp[i]);
        bw += (x0 - bw) * band;
        let x = bw;
        for (let j = 0; j < 4; j++) x = ap(ins[j], x, -inG[j] * (j & 1 ? 1 : 1));
        lfo += 0.9 / SR; if (lfo > 1) lfo -= 1;
        const m = Math.sin(lfo * TAU) * exc;
        const lastA = tap(dA2, dA2.n), lastB = tap(dB2, dB2.n);
        // tank A
        let a = modAp(mA, x + decay * lastB, dd1, mAn, m);
        const a1o = tap(dA1, dA1.n); push(dA1, a);
        dampA += (a1o - dampA) * (1 - damp);
        let a2 = ap(aA2, dampA * decay, -dd2);
        push(dA2, a2);
        // tank B
        let b = modAp(mB, x + decay * lastA, dd1, mBn, -m);
        const b1o = tap(dB1, dB1.n); push(dB1, b);
        dampB += (b1o - dampB) * (1 - damp);
        let b2 = ap(aB2, dampB * decay, -dd2);
        push(dB2, b2);
        let yl = 0, yr = 0;
        for (let j = 0; j < 7; j++) { yl += tap(tL[j][0], tL[j][1]) * tL[j][2]; yr += tap(tR[j][0], tR[j][1]) * tR[j][2]; }
        outL[i] += yl * 0.6; outR[i] += yr * 0.6;
      }
    };
  }
  const plate = makePlate({ predelay: 0.022, bandwidth: 0.62, inDiff1: 0.75, inDiff2: 0.625, decay: 0.74, damping: 0.42, decDiff1: 0.7, decDiff2: 0.5, excursion: 12 });

  function makeDelay(time, fb) {
    const n = Math.round(time * SR);
    const bl = new Float32Array(n), br = new Float32Array(n);
    let w = 0, lpL = 0, lpR = 0, hpL = 0, hpR = 0;
    const cl = 1 - Math.exp(-TAU * 3200 / SR), ch = 1 - Math.exp(-TAU * 280 / SR);
    return function (inp, outL, outR, len) {
      for (let i = 0; i < len; i++) {
        const l = bl[w], r = br[w];
        lpL += (l - lpL) * cl; hpL += (lpL - hpL) * ch;
        lpR += (r - lpR) * cl; hpR += (lpR - hpR) * ch;
        const fl = lpL - hpL, fr = lpR - hpR;
        bl[w] = inp[i] + fr * fb;
        br[w] = fl;
        w++; if (w >= n) w = 0;
        outL[i] += fl; outR[i] += fr;
      }
    };
  }
  const delay = makeDelay(3 * STEP, 0.42);

  /* ---------- sidechain curve ---------- */
  const duckTimes = S.kick.map((k) => k.t).concat(S.kickM.map((k) => k.t)).sort((a, b) => a - b);

  /* ---------- the render loop ---------- */
  const BLOCK = 1024;
  const outL = new Float32Array(N), outR = new Float32Array(N);
  const dL = new Float32Array(BLOCK), dR = new Float32Array(BLOCK);
  const uL = new Float32Array(BLOCK), uR = new Float32Array(BLOCK);
  const rv = new Float32Array(BLOCK), dy = new Float32Array(BLOCK);
  const wL = new Float32Array(BLOCK), wR = new Float32Array(BLOCK);
  const sL = new Float32Array(BLOCK), sR = new Float32Array(BLOCK);
  const ENV_RATE = 100;
  const frames = Math.ceil(DURATION * ENV_RATE);
  const frameLen = SR / ENV_RATE;
  const energy = new Float32Array(STEMS.length * frames);
  let active = [];
  let vi = 0, di = 0;
  const invFrame = 1 / frameLen;

  for (let pos = 0; pos < N; pos += BLOCK) {
    const len = Math.min(BLOCK, N - pos);
    dL.fill(0); dR.fill(0); uL.fill(0); uR.fill(0); rv.fill(0); dy.fill(0); wL.fill(0); wR.fill(0);
    while (vi < voices.length && voices[vi].start < pos + len) active.push(voices[vi++]);
    const still = [];
    for (const v of active) {
      const from = Math.max(pos, v.start), to = Math.min(pos + len, v.end);
      if (to > from) {
        const off = from - pos, n = to - from;
        v.process(sL, sR, off, n, from);
        const g = v.gain, rs = v.rev * 0.5, ds = v.dly * 0.5;
        const oL = v.bus ? uL : dL, oR = v.bus ? uR : dR;
        const eb = v.stem * frames;
        const end = off + n;
        for (let k = off; k < end; k++) { oL[k] += sL[k] * g; oR[k] += sR[k] * g; }
        if (rs) { const q = rs * g; for (let k = off; k < end; k++) rv[k] += (sL[k] + sR[k]) * q; }
        if (ds) { const q = ds * g; for (let k = off; k < end; k++) dy[k] += (sL[k] + sR[k]) * q; }
        const g2 = g * g * 4;
        for (let k = off + ((4 - ((pos + off) & 3)) & 3); k < end; k += 4) {
          energy[eb + (((pos + k) * invFrame) | 0)] += (sL[k] * sL[k] + sR[k] * sR[k]) * g2;
        }
      }
      if (v.end > pos + len) still.push(v);
    }
    active = still;
    // sidechain the ducked bus
    for (let k = 0; k < len; k++) {
      const t = (pos + k) / SR;
      while (di + 1 < duckTimes.length && duckTimes[di + 1] <= t) di++;
      let g = 1;
      if (duckTimes[di] <= t) {
        const d = duckDepth(duckTimes[di]);
        if (d > 0) {
          const dt = t - duckTimes[di];
          const env = dt < 0.006 ? dt / 0.006 : Math.exp(-(dt - 0.006) / 0.11);
          g = 1 - d * env;
        }
      }
      dL[k] += uL[k] * g; dR[k] += uR[k] * g;
    }
    plate(rv, wL, wR, len);
    delay(dy, wL, wR, len);
    for (let k = 0; k < len; k++) {
      outL[pos + k] = dL[k] + wL[k] * 0.85;
      outR[pos + k] = dR[k] + wR[k] * 0.85;
    }
    if (((pos / BLOCK) & 63) === 0) yield 0.9 * pos / N;
  }

  if (opts.debug) {
    opts.debug.energy = energy.slice(); opts.debug.frames = frames; opts.debug.frameLen = frameLen;
    let pk = 0, at = 0;
    for (let i = 0; i < N; i++) { const a = Math.max(Math.abs(outL[i]), Math.abs(outR[i])); if (a > pk) { pk = a; at = i; } }
    opts.debug.prePeak = pk; opts.debug.prePeakAt = at / SR;
  }

  /* ---------- master: high-pass, glue compression, look-ahead limiter ---------- */
  (function master() {
    // 2nd-order high-pass at 28 Hz (RBJ)
    const w0 = TAU * 28 / SR, cs = Math.cos(w0), al = Math.sin(w0) / (2 * 0.707);
    const b0 = (1 + cs) / 2, b1 = -(1 + cs), b2 = (1 + cs) / 2, a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
    for (const x of [outL, outR]) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < N; i++) {
        const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
      }
    }
    // glue compressor (stereo linked)
    const aA = Math.exp(-1 / (0.008 * SR)), aR = Math.exp(-1 / (0.16 * SR));
    const thr = -16, ratio = 2.2, makeup = Math.pow(10, 3 / 20);
    let env = 0, gPrev = makeup;
    const gainOf = (e) => {
      const over = 20 * Math.log10(e + 1e-9) - thr;
      return over > 0 ? Math.pow(10, -over * (1 - 1 / ratio) / 20) * makeup : makeup;
    };
    for (let i0 = 0; i0 < N; i0 += 16) {
      const i1 = Math.min(N, i0 + 16);
      for (let i = i0; i < i1; i++) {
        const x = Math.max(Math.abs(outL[i]), Math.abs(outR[i]));
        env = x > env ? x + (env - x) * aA : x + (env - x) * aR;
      }
      const gNext = gainOf(env);
      const step = (gNext - gPrev) / (i1 - i0);
      let g = gPrev;
      for (let i = i0; i < i1; i++) { g += step; outL[i] *= g; outR[i] *= g; }
      gPrev = gNext;
    }
  })();
  yield 0.94;
  (function limiter() {
    const ceil = 0.93;
    // pre-gain so the loudest sections hit the limiter a little
    let peak = 0;
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
    const pre = Math.min(4, (ceil / peak) * 1.35);
    const la = Math.round(0.004 * SR);
    const tgt = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const p = Math.max(Math.abs(outL[i]), Math.abs(outR[i])) * pre;
      tgt[i] = p > ceil ? ceil / p : 1;
    }
    // sliding minimum over [i-la, i+la]
    const mn = new Float32Array(N);
    const dq = new Int32Array(N); let h = 0, tl = 0;
    for (let j = 0; j < N + la; j++) {
      if (j < N) { while (tl > h && tgt[dq[tl - 1]] >= tgt[j]) tl--; dq[tl++] = j; }
      const i = j - la;
      if (i >= 0) { while (dq[h] < i - la) h++; mn[i] = tgt[dq[h]]; }
    }
    // box average over [i-la/2, i+la/2], then release smoothing
    const half = la >> 1, w = 2 * half + 1;
    let sum = 0;
    for (let j = 0; j < Math.min(N, half + 1); j++) sum += mn[j];
    sum += half * 1;
    const aRel = Math.exp(-1 / (0.08 * SR));
    let g = 1;
    for (let i = 0; i < N; i++) {
      const avg = sum / w;
      g = avg < g ? avg : avg + (g - avg) * aRel;
      outL[i] *= g * pre; outR[i] *= g * pre;
      const add = i + half + 1 < N ? mn[i + half + 1] : 1;
      const rem = i - half >= 0 ? mn[i - half] : 1;
      sum += add - rem;
    }
    // safety + edge fades
    const fin = Math.round(0.008 * SR), fout = Math.round(1.6 * SR);
    for (let i = 0; i < N; i++) {
      let e = 1;
      if (i < fin) e = i / fin;
      if (i > N - fout) { const x = (N - i) / fout; e = x * x; }
      let l = outL[i] * e, r = outR[i] * e;
      if (l > ceil) l = ceil; else if (l < -ceil) l = -ceil;
      if (r > ceil) r = ceil; else if (r < -ceil) r = -ceil;
      outL[i] = l; outR[i] = r;
    }
  })();
  yield 0.98;

  /* ---------- envelopes for the visuals ---------- */
  const env = new Float32Array(STEMS.length * frames);
  for (let s = 0; s < STEMS.length; s++) {
    let mx = 1e-9;
    for (let f = 0; f < frames; f++) {
      const v = Math.sqrt(energy[s * frames + f] / frameLen);
      env[s * frames + f] = v; if (v > mx) mx = v;
    }
    let sm = 0;
    for (let f = 0; f < frames; f++) {
      const v = env[s * frames + f] / mx;
      sm = v > sm ? v : sm * 0.86 + v * 0.14;
      env[s * frames + f] = sm;
    }
  }
  const master = new Float32Array(frames);
  {
    let mx = 1e-9;
    for (let f = 0; f < frames; f++) {
      let e = 0; const a = Math.floor(f * frameLen), b = Math.min(N, Math.floor((f + 1) * frameLen));
      for (let i = a; i < b; i++) e += outL[i] * outL[i] + outR[i] * outR[i];
      master[f] = Math.sqrt(e / Math.max(1, b - a)); if (master[f] > mx) mx = master[f];
    }
    for (let f = 0; f < frames; f++) master[f] /= mx;
  }

  // compact score for the visuals
  const pick = (arr, f) => arr.map(f);
  const score = {
    kick: pick(S.kick, (e) => e.t), kickM: pick(S.kickM, (e) => e.t), clap: pick(S.clap, (e) => e.t),
    snare: pick(S.snare, (e) => [e.t, e.vel]), hatO: pick(S.hatO, (e) => e.t), crash: pick(S.crash, (e) => e.t),
    impact: pick(S.impact, (e) => e.t), heart: pick(S.heart, (e) => [e.t, e.vel]),
    pluck: pick(S.pluck, (e) => [e.t, e.note, e.vel]), bell: pick(S.bell, (e) => [e.t, e.note, e.vel]),
    lead: pick(S.lead, (e) => [e.t, e.note, e.dur]), arp: pick(S.arp, (e) => [e.t, e.note]),
    bass: pick(S.bass, (e) => [e.t, e.note, e.dur]),
    chords: S.chords.map((c) => [c.t, c.dur, c.ch.root, c.ch.pad]),
  };
  yield 1;
  return { sampleRate: SR, L: outL, R: outR, env, master, envRate: ENV_RATE, frames, stems: STEMS, score };
}

function render(opts) {
  const g = renderGen(opts);
  let r;
  while (!(r = g.next()).done) { /* spin */ }
  return r.value;
}

return { BPM, BEAT, STEP, BAR, BARS, DURATION, STEMS, T, buildScore, renderGen, render };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SYNTH;
