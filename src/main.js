/* ─────────────────────────────────────────────────────────────────────────
   main.js — boot, sound, clock, input, loop.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
'use strict';
const BG = [8, 7, 14];
const DURATION = 90;
const params = new URLSearchParams(location.search);
const CAPTURE = params.has('capture');
const START_AT = Math.max(0, Math.min(89, parseFloat(params.get('t') || '0') || 0));
const canvas = document.getElementById('screen');
const F = {};
const MONO = '"JetBrains Mono", "DejaVu Sans Mono", Menlo, Consolas, "Liberation Mono", monospace';
// for viewers who ask for less motion: keep the piece, drop the shakes, glitches and flashes
const calm = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
function soften(F) { if (!calm()) return; F.shake = null; F.glitch = 0; F.chroma = 0; F.flash *= 0.25; F.scramble *= 0.3; }

let music = null, progress = 0, ready = false, pendingStart = false;
let actx = null, buffer = null, source = null;
let playing = false, paused = false, pausedAt = 0, startCtx = 0, offset = 0;
let hover = false, idleSince = 0, lastMove = 0;
const boot = performance.now();
const wall = () => (performance.now() - boot) / 1000;

/* ───────── fonts ───────── */
async function loadFonts() {
  if (!document.fonts || !document.fonts.load) return;
  const tasks = [
    document.fonts.load('700 32px "JetBrains Mono"'),
    document.fonts.load('800 64px "Shippori Mincho"', SCENES.TITLE),
  ];
  await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, 3000))]);
}
function pickTitleFont() {
  try {
    if (document.fonts && document.fonts.check('800 64px "Shippori Mincho"', SCENES.TITLE)) {
      // check() is true for families that were never declared too, so make sure the face really loaded
      for (const f of document.fonts) if (f.family.replace(/"/g, '') === 'Shippori Mincho' && f.status === 'loaded') return ['"Shippori Mincho", serif', true];
    }
  } catch (e) { /* ignore */ }
  const probe = document.createElement('canvas').getContext('2d');
  const width = (fam) => { probe.font = `100px ${fam}`; return probe.measureText('mmmmmmmmmmlli赤い糸').width; };
  const base = width('monospace');
  const cands = ['Hiragino Mincho ProN', 'Yu Mincho', 'MS Mincho', 'Noto Serif CJK JP', 'Noto Serif JP', 'Source Han Serif',
    'Hiragino Sans', 'Yu Gothic', 'Meiryo', 'Noto Sans CJK JP', 'Noto Sans JP', 'PingFang SC', 'Microsoft YaHei', 'SimSun',
    'Malgun Gothic', 'Apple SD Gothic Neo', 'WenQuanYi Zen Hei', 'Droid Sans Fallback'];
  for (const c of cands) if (Math.abs(width(`"${c}", monospace`) - base) > 0.5) return [`"${c}", serif`, true];
  return ['Georgia, "Times New Roman", serif', false];
}

/* ───────── the soundtrack ───────── */
function onMusic(out) {
  music = out;
  SCENES.setMusic(out.score);
  progress = 1;
  ready = true;
  if (CAPTURE) window.__ready = true;
  if (pendingStart) start(START_AT);
}
function synthOnMain(src, sampleRate) {
  window.__synthPath = 'main';
  const SY = new Function(src + '\nreturn SYNTH;')();
  const g = SY.renderGen({ sampleRate });
  const step = () => {
    const t0 = performance.now();
    for (;;) {
      const r = g.next();
      if (r.done) { onMusic(r.value); return; }
      progress = r.value;
      if (performance.now() - t0 > 24) break;
    }
    setTimeout(step, 0);
  };
  step();
}
function startSynth(sampleRate) {
  const src = document.getElementById('synth-src').textContent;
  const bootSrc = `
self.onmessage = function (e) {
  try {
    var g = SYNTH.renderGen(e.data), r, last = 0;
    while (!(r = g.next()).done) { var now = Date.now(); if (now - last > 50) { self.postMessage({ progress: r.value }); last = now; } }
    var o = r.value;
    self.postMessage({ done: true, out: o }, [o.L.buffer, o.R.buffer, o.env.buffer, o.master.buffer]);
  } catch (err) { self.postMessage({ error: String((err && err.stack) || err) }); }
};`;
  let worker = null, settled = false;
  const fallback = () => { if (settled) return; settled = true; try { worker && worker.terminate(); } catch (e) { /* */ } synthOnMain(src, sampleRate); };
  try {
    const url = URL.createObjectURL(new Blob([src, bootSrc], { type: 'text/javascript' }));
    worker = new Worker(url);
    window.__synthPath = 'worker';
  } catch (e) { fallback(); return; }
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.progress !== undefined) progress = d.progress;
    else if (d.done) { settled = true; worker.terminate(); onMusic(d.out); }
    else if (d.error) { console.warn(d.error); fallback(); }
  };
  worker.onerror = (e) => { e.preventDefault && e.preventDefault(); fallback(); };
  worker.postMessage({ sampleRate });
}

/* ───────── envelopes → frame uniforms ───────── */
const ENVS = { kick: 0, snare: 0, hat: 0, bass: 0, pad: 0, lead: 0, arp: 0, pluck: 0, bell: 0, fx: 0, drone: 0, master: 0 };
function setEnv(T) {
  if (music) {
    const f = T * music.envRate, i = Math.max(0, Math.min(music.frames - 2, Math.floor(f))), fr = Math.max(0, Math.min(1, f - i));
    for (let s = 0; s < music.stems.length; s++) {
      const b = s * music.frames;
      ENVS[music.stems[s]] = music.env[b + i] + (music.env[b + i + 1] - music.env[b + i]) * fr;
    }
    ENVS.master = music.master[i] + (music.master[i + 1] - music.master[i]) * fr;
  }
  F.T = T;
  F.beat = T / SCENES.BEAT;
  F.e0 = [ENVS.kick, ENVS.snare, ENVS.hat, ENVS.bass];
  F.e1 = [ENVS.pad, ENVS.lead, ENVS.arp, ENVS.pluck];
  F.e2 = [ENVS.bell, ENVS.fx, ENVS.drone, ENVS.master];
  SCENES.setEnv(ENVS);
}

/* ───────── playback & clock ───────── */
function ensureAudio() {
  if (actx) return actx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { actx = new AC({ latencyHint: 'playback' }); } catch (e) { actx = new AC(); }
  return actx;
}
function stopSource() {
  if (!source) return;
  try { source.onended = null; source.stop(); } catch (e) { /* already stopped */ }
  try { source.disconnect(); } catch (e) { /* */ }
  source = null;
}
function playFrom(t) {
  stopSource();
  offset = Math.max(0, Math.min(DURATION - 0.05, t));
  source = actx.createBufferSource();
  source.buffer = buffer;
  source.connect(actx.destination);
  startCtx = actx.currentTime + 0.1;
  source.start(startCtx, offset);
  playing = true; paused = false;
}
function musicTime() {
  if (!playing) return 0;
  if (paused) return pausedAt;
  let ct;
  if (actx.getOutputTimestamp) {
    const ts = actx.getOutputTimestamp();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) ct = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  }
  if (ct === undefined) ct = actx.currentTime - (actx.outputLatency || 0) - (actx.baseLatency || 0);
  return Math.max(0, ct - startCtx) + offset;
}
async function start(at) {
  if (!ready) { pendingStart = true; return; }
  pendingStart = false;
  const ctx = ensureAudio();
  if (!ctx) return;
  try { await ctx.resume(); } catch (e) { /* */ }
  if (!buffer || buffer.sampleRate !== music.sampleRate) {
    buffer = ctx.createBuffer(2, music.L.length, music.sampleRate);
    buffer.copyToChannel(music.L, 0);
    buffer.copyToChannel(music.R, 1);
  }
  playFrom(at || 0);
  document.body.classList.remove('play');
  goFullscreen();
}
function togglePause() {
  if (!playing || !actx) return;
  if (!paused) { pausedAt = musicTime(); paused = true; actx.suspend(); }
  else { actx.resume().then(() => { playFrom(pausedAt); }); }
}
function goFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!fn || document.fullscreenElement || document.webkitFullscreenElement) return;
  try { const p = fn.call(el); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not allowed here */ }
}
function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    const x = document.exitFullscreen || document.webkitExitFullscreen;
    if (x) try { const p = x.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* */ }
  } else goFullscreen();
}

/* ───────── input ───────── */
function activate() {
  if (playing) return;
  if (!ready) { pendingStart = true; ensureAudio(); if (actx) actx.resume().catch(() => {}); return; }
  start(START_AT);
}
window.addEventListener('pointerup', (e) => { if (e.button === 0 || e.pointerType !== 'mouse') activate(); });
window.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (playing) togglePause(); else activate(); }
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (playing && e.key === 'ArrowRight') playFrom(musicTime() + 5);
  else if (playing && e.key === 'ArrowLeft') playFrom(musicTime() - 5);
  else if (playing && (e.key === 'r' || e.key === 'R')) playFrom(0);
});
window.addEventListener('pointermove', (e) => {
  lastMove = wall();
  document.body.classList.remove('hide');
  if (!playing) {
    const r = canvas.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / r.height, dy = (e.clientY - (r.top + r.height / 2)) / r.height;
    hover = Math.hypot(dx, dy) < 0.3;
  }
});
window.addEventListener('resize', () => { if (ENGINE.gl) ENGINE.layout(); });

/* ───────── loop ───────── */
function frame() {
  requestAnimationFrame(frame);
  const tw = wall();
  if (playing) {
    const T = musicTime();
    if (T >= DURATION + 0.9) {
      playing = false; stopSource(); idleSince = tw;
    } else {
      setEnv(Math.min(T, DURATION));
      SCENES.frame(T, F);
      soften(F);
      ENGINE.render(F);
      document.body.classList.toggle('hide', tw - lastMove > 1.5);
      return;
    }
  }
  document.body.classList.toggle('play', ready);
  setEnv(0);
  SCENES.idle(tw - idleSince, F, { progress, ready, hover });
  ENGINE.render(F);
}

/* ───────── boot ───────── */
(async function main() {
  await loadFonts();
  const [tf, cjk] = pickTitleFont();
  SCENES.setTitleFont(tf, cjk);
  try {
    await ENGINE.init({ canvas, bg: BG, fontFamily: MONO, fontWeight: 700, capture: CAPTURE });
    SCENES.compileAll();
  } catch (err) {
    console.error(err);
    document.body.classList.add('nogl');
    return;
  }
  let rate = 44100;
  if (!CAPTURE) { const ctx = ensureAudio(); if (ctx) rate = Math.min(48000, ctx.sampleRate || 44100); }
  startSynth(rate);
  if (CAPTURE) {
    window.__frame = (T) => { setEnv(T); SCENES.frame(T, F); ENGINE.render(F); };
    window.__idle = (tw, p, r) => { setEnv(0); SCENES.idle(tw, F, { progress: p, ready: r, hover: false }); ENGINE.render(F); };
    window.__layout = () => ENGINE.layout();
    return;
  }
  window.__state = () => ({ ready, playing, paused, T: playing ? musicTime() : 0, synth: window.__synthPath, cols: ENGINE.cols, rows: ENGINE.rows });
  requestAnimationFrame(frame);
})();
})();
