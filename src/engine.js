/* ─────────────────────────────────────────────────────────────────────────
   engine.js — a text-mode renderer.

   Everything on screen is a character in a grid over one unchanging
   background colour. Pictures get into the grid three ways:

     1. scene shaders render at 2×4 samples per character cell,
     2. a hidden vector canvas (same resolution) is composited on top,
     3. an explicit character overlay written by the CPU.

   A per-cell pass then picks, for each cell, the glyph whose *shape*
   best matches the 8 samples (or uses a ramp / braille / block mode),
   and a final pass draws those glyphs from an atlas.
   ───────────────────────────────────────────────────────────────────────── */
var ENGINE = (function () {
'use strict';

/* ───────── glyph set ───────── */
const GLYPHS = [];
const GI = Object.create(null);
const addGlyph = (c) => { if (!(c in GI)) { GI[c] = GLYPHS.length; GLYPHS.push(c); } };
for (let c = 32; c < 127; c++) addGlyph(String.fromCharCode(c));
const EXTRA = '·•●○◉◦°˙¯∙✦✧★☆♥♡◆◇■□▪▫▲△▼▽◀▶◢◣◤◥░▒▓█▀▄▌▐▖▗▘▝▚▞▙▛▜▟─│┌┐└┘├┤┬┴┼╭╮╯╰╱╲╳═║╬≈∞⋅∗⁺';
for (const c of EXTRA) addGlyph(c);
const BR0 = GLYPHS.length;
for (let b = 0; b < 256; b++) addGlyph(String.fromCharCode(0x2800 + b));

// the shape-matching alphabet: marks, lines and dense symbols only — no letters, so nothing reads as text
const MATCH = ' .,:;\'`"^~-_=+*<>/\\|()[]{}!#%&@$0Oo8¯';
const QUAD = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█']; // bits: UL=1 UR=2 LL=4 LR=8
const MODE = { SHAPE: 0, RAMP: 1, BRAILLE: 2, BLOCK: 3 };

/* ───────── state ───────── */
let gl, canvas, dpr = 1;
let cols = 0, rows = 0, cw = 0, chh = 0, SW = 0, SH = 0, A = 1;
let fontFamily = 'monospace', fontWeight = 700;
let atlasCols = 32, atlasTex = null, shapeTex = null, matchN = 0;
let sceneTex = [null, null], sceneFB = [null, null];
let cellColorTex = null, cellGlyphTex = null, cellFB = null;
let layerTex = null, ovGTex = null, ovCTex = null;
let vao = null;
let cellProg = null, screenProg = null;
const scenePrograms = Object.create(null);
let layer = null, lctx = null;
let ovG = null, ovC = null;
let bg = [8, 7, 14];
let capture = false;

/* ───────── GL helpers ───────── */
const VERT = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n');
    console.error(log + '\n' + lines);
    throw new Error('shader compile failed: ' + log);
  }
  return s;
}
function program(fsrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link failed: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}
function tex(w, h, internal, format, type, data, filter) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data || null);
  const f = filter || gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function fbo(texs) {
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
  gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return f;
}

/* ───────── scene shader prelude ───────── */
const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uT, uL, uBeat;
uniform vec4 uE0, uE1, uE2;
uniform vec4 uP0, uP1, uP2, uP3, uP4, uP5;
uniform vec4 uQ[16];
uniform float uFit;
out vec4 o;
#define PI 3.14159265
#define TAU 6.28318531
#define KICK uE0.x
#define SNARE uE0.y
#define HAT uE0.z
#define BASS uE0.w
#define PAD uE1.x
#define LEAD uE1.y
#define ARP uE1.z
#define PLUCK uE1.w
#define BELL uE2.x
#define FX uE2.y
#define MASTER uE2.w
vec2 P() { return (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uRes.y) / uFit; }
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 h22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec3 hsv(float h, float s, float v) { vec3 k = clamp(abs(mod(h * 6.0 + vec3(0, 4, 2), 6.0) - 3.0) - 1.0, 0.0, 1.0); return v * mix(vec3(1), k, s); }
vec3 pal(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(TAU * (c * t + d)); }
`;

/* ───────── cell pass: choose a glyph per cell ───────── */
const CELL_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uA, uB, uLayer, uOvG, uOvC, uShape;
uniform ivec2 uGrid;
uniform int uMatchN, uMode, uModeB, uMixMode, uRampN, uBr0, uUseB, uUseLayer;
uniform int uRamp[16];
uniform int uQuad[16];
uniform float uMix, uContrast, uInk, uThresh, uTime, uDissolve, uScramble, uReveal, uRevealSoft, uFlat;
uniform vec2 uRevealDir;
uniform vec3 uDisC;
uniform vec3 uTint;
uniform float uTintAmt;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oGlyph;

float hc(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
// noise glyphs come from the symbol alphabet too (index 0 is the space)
int noiseGlyph(vec2 p) { int k = 1 + int(hc(p) * float(uMatchN - 1)); return int(texelFetch(uShape, ivec2(k, 1), 0).r + 0.5); }

vec4 sampleScene(ivec2 sp, bool useB) {
  vec4 s = useB ? texelFetch(uB, sp, 0) : texelFetch(uA, sp, 0);
  if (uUseLayer == 0) return s;
  vec4 c = texelFetch(uLayer, sp, 0);
  float ia = c.a + s.a * (1.0 - c.a);
  vec3 col = ia > 1e-4 ? (c.rgb * c.a + s.rgb * s.a * (1.0 - c.a)) / ia : vec3(0.0);
  return vec4(col, ia);
}

int pickGlyph(int mode, vec4 v0, vec4 v1, float mx, float avg) {
  if (mode == 1) {
    int i = int(clamp(avg * uInk, 0.0, 0.9999) * float(uRampN));
    return uRamp[i];
  }
  if (mode == 2) {
    // samples: v0 = (r0c0, r0c1, r1c0, r1c1) rows from bottom; v1 = rows 2,3
    int b = 0;
    float t = 0.5;
    if (v1.z > t) b |= 1;   // top-left  (row 3 col 0) → dot 1
    if (v1.x > t) b |= 2;   // row 2 col 0 → dot 2
    if (v0.z > t) b |= 4;   // row 1 col 0 → dot 3
    if (v1.w > t) b |= 8;   // top-right → dot 4
    if (v1.y > t) b |= 16;  // row 2 col 1 → dot 5
    if (v0.w > t) b |= 32;  // row 1 col 1 → dot 6
    if (v0.x > t) b |= 64;  // bottom-left → dot 7
    if (v0.y > t) b |= 128; // bottom-right → dot 8
    return uBr0 + b;
  }
  if (mode == 3) {
    float ul = (v1.z + v1.x) * 0.5, ur = (v1.w + v1.y) * 0.5;
    float ll = (v0.z + v0.x) * 0.5, lr = (v0.w + v0.y) * 0.5;
    int b = (ul > 0.45 ? 1 : 0) | (ur > 0.45 ? 2 : 0) | (ll > 0.45 ? 4 : 0) | (lr > 0.45 ? 8 : 0);
    return uQuad[b];
  }
  // flat cells take a density ramp; cells with structure get a shape match
  vec4 dv0 = v0 - avg, dv1 = v1 - avg;
  float sd = sqrt((dot(dv0, dv0) + dot(dv1, dv1)) * 0.125);
  if (sd < uFlat) {
    int i = int(clamp(avg * uInk, 0.0, 0.9999) * float(uRampN));
    return uRamp[i];
  }
  // shape match with in-cell contrast enhancement
  vec4 w0 = v0, w1 = v1;
  if (mx > 1e-4) {
    w0 = pow(v0 / mx, vec4(uContrast)) * mx;
    w1 = pow(v1 / mx, vec4(uContrast)) * mx;
  }
  w0 = clamp(w0 * uInk, 0.0, 1.0); w1 = clamp(w1 * uInk, 0.0, 1.0);
  int best = 0; float bd = 1e9;
  for (int k = 0; k < 128; k++) {
    if (k >= uMatchN) break;
    vec4 d0 = w0 - texelFetch(uShape, ivec2(2 * k, 0), 0);
    vec4 d1 = w1 - texelFetch(uShape, ivec2(2 * k + 1, 0), 0);
    float d = dot(d0, d0) + dot(d1, d1);
    if (d < bd) { bd = d; best = k; }
  }
  return int(texelFetch(uShape, ivec2(best, 1), 0).r + 0.5);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 cf = vec2(c) / vec2(uGrid);
  bool useB = false;
  if (uUseB == 1) {
    float h = hc(vec2(c) + 7.13);
    if (uMixMode == 0) useB = h < uMix;                                        // dissolve
    else if (uMixMode == 1) useB = cf.x + (h - 0.5) * 0.08 < uMix;             // wipe left→right
    else if (uMixMode == 2) {                                                  // radial from centre
      vec2 q = (vec2(c) + 0.5 - vec2(uGrid) * 0.5) / float(uGrid.y) * vec2(0.5, 1.0) * 2.0;
      useB = length(q) + (h - 0.5) * 0.06 < uMix;
    }
    else useB = uMix > 0.5;                                                    // hard cut
  }
  vec4 s[8];
  vec3 col = vec3(0.0);
  float wsum = 0.0, mx = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 2; i++) {
    vec4 v = sampleScene(c * ivec2(2, 4) + ivec2(i, j), useB);
    s[j * 2 + i] = v;
    col += v.rgb * v.a; wsum += v.a; mx = max(mx, v.a);
  }
  vec4 v0 = vec4(s[0].a, s[1].a, s[2].a, s[3].a);
  vec4 v1 = vec4(s[4].a, s[5].a, s[6].a, s[7].a);
  float avg = wsum * 0.125;
  col = wsum > 1e-4 ? col / wsum : vec3(0.0);
  int mode = useB ? uModeB : uMode;
  int g = 0;
  if (mx * uInk > uThresh) g = pickGlyph(mode, v0, v1, mx, avg);

  // decode / scramble effects
  float h = hc(vec2(c) * 1.7 + 3.1);
  if (uReveal < 2.0 && g != 0) {
    float r = dot(cf - 0.5, uRevealDir) + 0.5;
    float local = uReveal - r * (1.0 - uRevealSoft) - h * uRevealSoft;
    if (local < 0.0) g = 0;
    else if (local < 0.12) { g = noiseGlyph(vec2(c) + floor(uTime * 24.0)); col = mix(col, vec3(0.6, 1.0, 0.8), 0.5); }
  }
  if (uScramble > 0.0 && g != 0 && h < uScramble) g = noiseGlyph(vec2(c) + floor(uTime * 30.0));
  if (uDissolve > 0.0) {
    float hv = hc(vec2(c) + 91.7);
    if (uDisC.z > 0.0) {
      vec2 dq = (cf - uDisC.xy) * vec2(float(uGrid.x) / float(uGrid.y) * 0.5, 1.0);
      hv = mix(hv, clamp(1.0 - length(dq) * 1.1, 0.0, 1.0), uDisC.z);
    }
    if (hv < uDissolve) g = 0;
  }

  // character overlay (CPU): alpha 255 = always on top, lower = only where the cell is empty
  vec4 oc = texelFetch(uOvC, ivec2(c.x, uGrid.y - 1 - c.y), 0);
  if (oc.a > 0.0 && (oc.a > 0.99 || g == 0)) {
    vec2 og = texelFetch(uOvG, ivec2(c.x, uGrid.y - 1 - c.y), 0).rg * 255.0;
    int gi = int(og.x + 0.5) + int(og.y + 0.5) * 256;
    if (gi != 0) { g = gi; col = oc.rgb; }
  }
  col = mix(col, uTint, uTintAmt);
  oColor = vec4(col, 1.0);
  oGlyph = vec4(float(g & 255) / 255.0, float(g >> 8) / 255.0, 0.0, 1.0);
}`;

/* ───────── screen pass: draw the glyphs ───────── */
const SCREEN_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uAtlas, uCol, uGly;
uniform ivec2 uCell, uGrid;
uniform int uAtlasCols;
uniform vec3 uBg;
uniform float uFlash, uGain, uChroma, uGlitch, uSeed, uScan, uTime;
uniform vec2 uShake;
out vec4 o;
float hs(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float glyphAt(vec2 fp, out vec3 col) {
  ivec2 px = ivec2(floor(fp));
  col = vec3(0.0);
  if (px.x < 0 || px.y < 0) return 0.0;
  ivec2 c = px / uCell;
  if (c.x >= uGrid.x || c.y >= uGrid.y) return 0.0;
  vec2 gg = texelFetch(uGly, c, 0).rg * 255.0;
  int g = int(gg.x + 0.5) + int(gg.y + 0.5) * 256;
  if (g == 0) return 0.0;
  col = texelFetch(uCol, c, 0).rgb;
  ivec2 l = px - c * uCell;
  ivec2 ap = ivec2((g % uAtlasCols) * uCell.x + l.x, (g / uAtlasCols) * uCell.y + (uCell.y - 1 - l.y));
  return texelFetch(uAtlas, ap, 0).a;
}
void main() {
  vec2 fp = gl_FragCoord.xy - uShake;
  if (uGlitch > 0.0) {
    float row = floor(fp.y / float(uCell.y));
    float r = hs(row * 7.31 + uSeed);
    if (r < uGlitch) fp.x += (hs(row + uSeed * 3.7) - 0.5) * float(uCell.x) * 24.0 * uGlitch;
  }
  vec3 c0, c1, c2;
  float a = glyphAt(fp, c0);
  vec3 text;
  float alpha;
  if (uChroma > 0.0) {
    float ar = glyphAt(fp + vec2(uChroma, 0.0), c1);
    float ab = glyphAt(fp - vec2(uChroma, 0.0), c2);
    vec3 cr = c1 * uGain + uFlash, cg = c0 * uGain + uFlash, cb = c2 * uGain + uFlash;
    vec3 add = vec3(cr.r * ar, cg.g * a, cb.b * ab);
    alpha = max(a, max(ar, ab));
    text = alpha > 0.0 ? add / alpha : vec3(0.0);
  } else {
    text = c0 * uGain + uFlash;
    alpha = a;
  }
  if (uScan > 0.0) alpha *= 1.0 - uScan * (0.5 + 0.5 * cos(gl_FragCoord.y * 3.14159));
  o = vec4(mix(uBg, clamp(text, 0.0, 1.0), clamp(alpha, 0.0, 1.0)), 1.0);
}`;

/* ───────── atlas ───────── */
const BOX = {
  '─': ['h'], '│': ['v'], '┌': ['r', 'd'], '┐': ['l', 'd'], '└': ['r', 'u'], '┘': ['l', 'u'],
  '├': ['v', 'r'], '┤': ['v', 'l'], '┬': ['h', 'd'], '┴': ['h', 'u'], '┼': ['h', 'v'],
};
function drawGlyph(g, c, x, y, w, h) {
  const code = c.codePointAt(0);
  const t = Math.max(1, Math.round(w / 7));
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  if (code >= 0x2800 && code <= 0x28FF) {
    const bits = code - 0x2800;
    const map = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]];
    const r = Math.max(0.8, w * 0.17);
    for (let b = 0; b < 8; b++) if (bits & (1 << b)) {
      const [i, j] = map[b];
      g.beginPath(); g.arc(x + (i + 0.5) * w / 2, y + (j + 0.5) * h / 4, r, 0, Math.PI * 2); g.fill();
    }
    return;
  }
  const qi = QUAD.indexOf(c);
  if (qi > 0) {
    const hw = Math.round(w / 2), hh = Math.round(h / 2);
    if (qi & 1) g.fillRect(x, y, hw, hh);
    if (qi & 2) g.fillRect(x + hw, y, w - hw, hh);
    if (qi & 4) g.fillRect(x, y + hh, hw, h - hh);
    if (qi & 8) g.fillRect(x + hw, y + hh, w - hw, h - hh);
    return;
  }
  if (c === '░' || c === '▒' || c === '▓') {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const on = c === '▒' ? ((i + j) & 1) === 0 : c === '░' ? ((i + 2 * j) & 3) === 0 : ((i + 2 * j) & 3) !== 0;
      if (on) g.fillRect(x + i, y + j, 1, 1);
    }
    return;
  }
  const cx = x + Math.floor(w / 2), cy = y + Math.floor(h / 2), o = Math.floor(t / 2);
  if (BOX[c]) {
    for (const s of BOX[c]) {
      if (s === 'h') g.fillRect(x, cy - o, w, t);
      if (s === 'v') g.fillRect(cx - o, y, t, h);
      if (s === 'l') g.fillRect(x, cy - o, cx - x + t - o, t);
      if (s === 'r') g.fillRect(cx - o, cy - o, x + w - cx + o, t);
      if (s === 'u') g.fillRect(cx - o, y, t, cy - y + t - o);
      if (s === 'd') g.fillRect(cx - o, cy - o, t, y + h - cy + o);
    }
    return;
  }
  if ('═║╬'.includes(c)) {
    const gap = Math.max(1, Math.round(w / 5));
    if (c !== '║') { g.fillRect(x, cy - gap - t, w, t); g.fillRect(x, cy + gap, w, t); }
    if (c !== '═') { g.fillRect(cx - gap - t, y, t, h); g.fillRect(cx + gap, y, t, h); }
    return;
  }
  if ('╭╮╯╰╱╲╳'.includes(c)) {
    g.lineWidth = t; g.lineCap = 'butt';
    g.beginPath();
    const mx = x + w / 2, my = y + h / 2;
    if (c === '╭') { g.moveTo(x + w, my); g.quadraticCurveTo(mx, my, mx, y + h); }
    if (c === '╮') { g.moveTo(x, my); g.quadraticCurveTo(mx, my, mx, y + h); }
    if (c === '╯') { g.moveTo(x, my); g.quadraticCurveTo(mx, my, mx, y); }
    if (c === '╰') { g.moveTo(x + w, my); g.quadraticCurveTo(mx, my, mx, y); }
    if (c === '╱' || c === '╳') { g.moveTo(x, y + h); g.lineTo(x + w, y); }
    if (c === '╲' || c === '╳') { g.moveTo(x, y); g.lineTo(x + w, y + h); }
    g.stroke();
    return;
  }
  if (SHAPES[c]) { SHAPES[c](g, x + w / 2, y + h / 2, w, t); return; }
  g.fillText(c, x + w / 2, y + h / 2 + h * 0.02);
}
// geometric symbols drawn by hand so they look the same on every system
function star(g, cx, cy, n, ro, ri, rot) {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i * Math.PI) / n, r = i & 1 ? ri : ro;
    const px = cx + Math.sin(a) * r, py = cy - Math.cos(a) * r;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
}
function heart(g, cx, cy, s) {
  g.beginPath();
  g.moveTo(cx, cy + s * 0.85);
  g.bezierCurveTo(cx - s * 1.25, cy + s * 0.05, cx - s * 0.75, cy - s * 0.95, cx, cy - s * 0.35);
  g.bezierCurveTo(cx + s * 0.75, cy - s * 0.95, cx + s * 1.25, cy + s * 0.05, cx, cy + s * 0.85);
  g.closePath();
}
function poly(g, pts) { g.beginPath(); pts.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b))); g.closePath(); }
const SHAPES = {
  '●': (g, x, y, w) => { g.beginPath(); g.arc(x, y, w * 0.48, 0, 7); g.fill(); },
  '○': (g, x, y, w, t) => { g.lineWidth = Math.max(1, w * 0.13); g.beginPath(); g.arc(x, y, w * 0.37, 0, 7); g.stroke(); },
  '◉': (g, x, y, w) => { g.lineWidth = Math.max(1, w * 0.11); g.beginPath(); g.arc(x, y, w * 0.4, 0, 7); g.stroke(); g.beginPath(); g.arc(x, y, w * 0.2, 0, 7); g.fill(); },
  '◦': (g, x, y, w) => { g.lineWidth = Math.max(1, w * 0.1); g.beginPath(); g.arc(x, y, w * 0.2, 0, 7); g.stroke(); },
  '•': (g, x, y, w) => { g.beginPath(); g.arc(x, y, w * 0.26, 0, 7); g.fill(); },
  '∙': (g, x, y, w) => { g.beginPath(); g.arc(x, y, w * 0.17, 0, 7); g.fill(); },
  '✦': (g, x, y, w) => { star(g, x, y, 4, w * 0.62, w * 0.13, 0); g.fill(); },
  '✧': (g, x, y, w) => { g.lineWidth = Math.max(1, w * 0.09); star(g, x, y, 4, w * 0.6, w * 0.15, 0); g.stroke(); },
  '★': (g, x, y, w) => { star(g, x, y, 5, w * 0.5, w * 0.21, 0); g.fill(); },
  '☆': (g, x, y, w) => { g.lineWidth = Math.max(1, w * 0.09); star(g, x, y, 5, w * 0.48, w * 0.21, 0); g.stroke(); },
  '♥': (g, x, y, w) => { heart(g, x, y, w * 0.46); g.fill(); },
  '♡': (g, x, y, w) => { g.lineWidth = Math.max(1, w * 0.1); heart(g, x, y, w * 0.44); g.stroke(); },
  '◆': (g, x, y, w) => { poly(g, [[x, y - w * 0.55], [x + w * 0.45, y], [x, y + w * 0.55], [x - w * 0.45, y]]); g.fill(); },
  '◇': (g, x, y, w) => { g.lineWidth = Math.max(1, w * 0.1); poly(g, [[x, y - w * 0.55], [x + w * 0.43, y], [x, y + w * 0.55], [x - w * 0.43, y]]); g.stroke(); },
  '■': (g, x, y, w) => { g.fillRect(x - w * 0.4, y - w * 0.4, w * 0.8, w * 0.8); },
  '□': (g, x, y, w) => { g.lineWidth = Math.max(1, w * 0.1); g.strokeRect(x - w * 0.36, y - w * 0.36, w * 0.72, w * 0.72); },
  '▪': (g, x, y, w) => { g.fillRect(x - w * 0.24, y - w * 0.24, w * 0.48, w * 0.48); },
  '▫': (g, x, y, w) => { g.lineWidth = Math.max(1, w * 0.09); g.strokeRect(x - w * 0.22, y - w * 0.22, w * 0.44, w * 0.44); },
  '▲': (g, x, y, w) => { poly(g, [[x, y - w * 0.5], [x + w * 0.45, y + w * 0.4], [x - w * 0.45, y + w * 0.4]]); g.fill(); },
  '△': (g, x, y, w) => { g.lineWidth = Math.max(1, w * 0.1); poly(g, [[x, y - w * 0.48], [x + w * 0.42, y + w * 0.38], [x - w * 0.42, y + w * 0.38]]); g.stroke(); },
  '▼': (g, x, y, w) => { poly(g, [[x, y + w * 0.5], [x + w * 0.45, y - w * 0.4], [x - w * 0.45, y - w * 0.4]]); g.fill(); },
  '▽': (g, x, y, w) => { g.lineWidth = Math.max(1, w * 0.1); poly(g, [[x, y + w * 0.48], [x + w * 0.42, y - w * 0.38], [x - w * 0.42, y - w * 0.38]]); g.stroke(); },
  '◀': (g, x, y, w) => { poly(g, [[x - w * 0.45, y], [x + w * 0.4, y - w * 0.5], [x + w * 0.4, y + w * 0.5]]); g.fill(); },
  '▶': (g, x, y, w) => { poly(g, [[x + w * 0.45, y], [x - w * 0.4, y - w * 0.5], [x - w * 0.4, y + w * 0.5]]); g.fill(); },
  '◢': (g, x, y, w) => { poly(g, [[x + w / 2, y - w], [x + w / 2, y + w], [x - w / 2, y + w]]); g.fill(); },
  '◣': (g, x, y, w) => { poly(g, [[x - w / 2, y - w], [x + w / 2, y + w], [x - w / 2, y + w]]); g.fill(); },
  '◤': (g, x, y, w) => { poly(g, [[x - w / 2, y - w], [x + w / 2, y - w], [x - w / 2, y + w]]); g.fill(); },
  '◥': (g, x, y, w) => { poly(g, [[x - w / 2, y - w], [x + w / 2, y - w], [x + w / 2, y + w]]); g.fill(); },
};

function buildAtlas() {
  const n = GLYPHS.length;
  atlasCols = 32;
  const arows = Math.ceil(n / atlasCols);
  const cv = document.createElement('canvas');
  cv.width = atlasCols * cw; cv.height = arows * chh;
  const g = cv.getContext('2d', { willReadFrequently: true });
  // fit the font so that its advance equals the cell width
  g.font = `${fontWeight} 100px ${fontFamily}`;
  const adv = g.measureText('M').width || 60;
  const size = Math.min(cw * 100 / adv, chh * 0.84);
  g.font = `${fontWeight} ${size}px ${fontFamily}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const x = (i % atlasCols) * cw, y = Math.floor(i / atlasCols) * chh;
    g.save();
    g.beginPath(); g.rect(x, y, cw, chh); g.clip();
    drawGlyph(g, GLYPHS[i], x, y, cw, chh);
    g.restore();
  }
  const img = g.getImageData(0, 0, cv.width, cv.height);
  // shape vectors for the match set: coverage in 2×4 regions, rows counted from the bottom
  matchN = MATCH.length;
  const vec = new Float32Array(matchN * 8);
  let vmax = 1e-6;
  for (let k = 0; k < matchN; k++) {
    const gi = GI[MATCH[k]];
    const x0 = (gi % atlasCols) * cw, y0 = Math.floor(gi / atlasCols) * chh;
    for (let jb = 0; jb < 4; jb++) for (let i = 0; i < 2; i++) {
      const jt = 3 - jb;
      const xa = x0 + Math.floor(i * cw / 2), xb = x0 + Math.floor((i + 1) * cw / 2);
      const ya = y0 + Math.floor(jt * chh / 4), yb = y0 + Math.floor((jt + 1) * chh / 4);
      let s = 0;
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) s += img.data[(y * cv.width + x) * 4 + 3];
      const v = s / (255 * (xb - xa) * (yb - ya));
      vec[k * 8 + jb * 2 + i] = v;
      if (v > vmax) vmax = v;
    }
  }
  const shape = new Float32Array(Math.max(2 * matchN, matchN) * 2 * 4);
  const rowW = 2 * matchN;
  for (let k = 0; k < matchN; k++) {
    for (let q = 0; q < 8; q++) shape[(2 * k) * 4 + q] = vec[k * 8 + q] / vmax;
    shape[(rowW + k) * 4] = GI[MATCH[k]];
  }
  if (atlasTex) gl.deleteTexture(atlasTex);
  if (shapeTex) gl.deleteTexture(shapeTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  atlasTex = tex(cv.width, cv.height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
  shapeTex = tex(rowW, 2, gl.RGBA32F, gl.RGBA, gl.FLOAT, shape);
}

/* ───────── layout ───────── */
function layout() {
  const W = window.innerWidth, H = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const cssCell = Math.max(5, Math.min(13, W / 170, H / 40));
  const ncw = Math.max(4, Math.round(cssCell * dpr));
  const nch = ncw * 2;
  const ncols = Math.max(20, Math.floor(W * dpr / ncw));
  const nrows = Math.max(12, Math.floor(H * dpr / nch));
  const changed = ncw !== cw || ncols !== cols || nrows !== rows;
  const cellChanged = ncw !== cw;
  cw = ncw; chh = nch; cols = ncols; rows = nrows;
  SW = cols * 2; SH = rows * 4; A = SW / SH;
  canvas.width = cols * cw; canvas.height = rows * chh;
  canvas.style.width = (cols * cw / dpr) + 'px';
  canvas.style.height = (rows * chh / dpr) + 'px';
  if (!changed) return false;
  if (cellChanged || !atlasTex) buildAtlas();
  for (let i = 0; i < 2; i++) {
    if (sceneTex[i]) { gl.deleteTexture(sceneTex[i]); gl.deleteFramebuffer(sceneFB[i]); }
    sceneTex[i] = tex(SW, SH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
    sceneFB[i] = fbo([sceneTex[i]]);
  }
  if (cellFB) { gl.deleteTexture(cellColorTex); gl.deleteTexture(cellGlyphTex); gl.deleteFramebuffer(cellFB); }
  cellColorTex = tex(cols, rows, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
  cellGlyphTex = tex(cols, rows, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
  cellFB = fbo([cellColorTex, cellGlyphTex]);
  if (layerTex) { gl.deleteTexture(layerTex); gl.deleteTexture(ovGTex); gl.deleteTexture(ovCTex); }
  layerTex = tex(SW, SH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
  ovGTex = tex(cols, rows, gl.RG8, gl.RG, gl.UNSIGNED_BYTE, null);
  ovCTex = tex(cols, rows, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
  layer.width = SW; layer.height = SH;
  ovG = new Uint8Array(cols * rows * 2);
  ovC = new Uint8ClampedArray(cols * rows * 4);
  return true;
}

/* ───────── public: init ───────── */
async function init(opts) {
  canvas = opts.canvas;
  capture = !!opts.capture;
  bg = opts.bg || bg;
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: capture, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 unavailable');
  fontFamily = opts.fontFamily || fontFamily;
  fontWeight = opts.fontWeight || fontWeight;
  vao = gl.createVertexArray();
  cellProg = program(CELL_FS);
  screenProg = program(SCREEN_FS);
  layer = document.createElement('canvas');
  lctx = layer.getContext('2d');
  layout();
}

function addScene(name, body) {
  scenePrograms[name] = program(PRELUDE + body);
}

/* ───────── overlay API (rows counted from the top) ───────── */
function clearOverlay() { ovG.fill(0); ovC.fill(0); }
function put(col, row, glyph, r, g, b, a) {
  if (col < 0 || row < 0 || col >= cols || row >= rows) return;
  const i = row * cols + col;
  ovG[i * 2] = glyph & 255; ovG[i * 2 + 1] = glyph >> 8;
  ovC[i * 4] = r; ovC[i * 4 + 1] = g; ovC[i * 4 + 2] = b; ovC[i * 4 + 3] = a === undefined ? 255 : a;
}
function colOf(x) { return Math.floor((x / A + 1) * 0.5 * cols); }
function rowOf(y) { return Math.floor((1 - y) * 0.5 * rows); }
function plot(x, y, glyph, r, g, b, a) { put(colOf(x), rowOf(y), glyph, r, g, b, a); }
function text(col, row, str, r, g, b, a) {
  let i = 0;
  for (const c of str) { const gi = GI[c]; if (gi !== undefined && c !== ' ') put(col + i, row, gi, r, g, b, a); i++; }
}

/* ───────── layer (hidden vector canvas) ─────────
   Begun lazily: a frame that never draws on it neither clears nor uploads it
   (a clear-only canvas can hand WebGL a stale snapshot). */
let layerUsed = false;
function resetLayer() { layerUsed = false; }
function beginLayer() {
  if (layerUsed) return lctx;
  layerUsed = true;
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.clearRect(0, 0, SW, SH);
  lctx.setTransform(SH / 2, 0, 0, -SH / 2, SW / 2, SH / 2);
  return lctx;
}

/* ───────── render ───────── */
const zero4 = [0, 0, 0, 0];
function setSceneUniforms(u, F, which) {
  const p = which ? F.pB : F.pA;
  gl.uniform2f(u.uRes, SW, SH);
  gl.uniform1f(u.uT, F.T);
  gl.uniform1f(u.uL, which ? F.lB : F.lA);
  gl.uniform1f(u.uBeat, F.beat);
  if (u.uE0) gl.uniform4fv(u.uE0, F.e0);
  if (u.uE1) gl.uniform4fv(u.uE1, F.e1);
  if (u.uE2) gl.uniform4fv(u.uE2, F.e2);
  for (let i = 0; i < 6; i++) { const loc = u['uP' + i]; if (loc) gl.uniform4fv(loc, (p && p[i]) || zero4); }
  if (u.uQ) gl.uniform4fv(u.uQ, (which ? F.qB : F.qA) || zero64);
  if (u.uFit) gl.uniform1f(u.uFit, fit());
}
const zero64 = new Float32Array(64);
function fit() { return Math.min(1, A / 1.3); }
function renderScene(name, F, which) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFB[which]);
  gl.viewport(0, 0, SW, SH);
  const prog = name && scenePrograms[name];
  if (!prog) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); return; }
  gl.useProgram(prog.p);
  setSceneUniforms(prog.u, F, which);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function render(F) {
  gl.bindVertexArray(vao);
  // uploads
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  if (layerUsed) {
    gl.bindTexture(gl.TEXTURE_2D, layerTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, layer);
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.bindTexture(gl.TEXTURE_2D, ovGTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RG, gl.UNSIGNED_BYTE, ovG);
  gl.bindTexture(gl.TEXTURE_2D, ovCTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, ovC);

  // scenes
  renderScene(F.A, F, 0);
  const useB = !!F.B && F.mix > 0;
  if (useB) renderScene(F.B, F, 1);

  // cell pass
  gl.bindFramebuffer(gl.FRAMEBUFFER, cellFB);
  gl.viewport(0, 0, cols, rows);
  const cu = cellProg.u;
  gl.useProgram(cellProg.p);
  const bindT = (unit, t, loc) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(loc, unit); };
  bindT(0, sceneTex[0], cu.uA);
  bindT(1, sceneTex[1], cu.uB);
  bindT(2, layerTex, cu.uLayer);
  bindT(3, ovGTex, cu.uOvG);
  bindT(4, ovCTex, cu.uOvC);
  bindT(5, shapeTex, cu.uShape);
  gl.uniform2i(cu.uGrid, cols, rows);
  gl.uniform1i(cu.uUseLayer, layerUsed ? 1 : 0);
  gl.uniform1i(cu.uMatchN, matchN);
  gl.uniform1i(cu.uMode, F.mode | 0);
  gl.uniform1i(cu.uModeB, (F.modeB === undefined ? F.mode : F.modeB) | 0);
  gl.uniform1i(cu.uUseB, useB ? 1 : 0);
  gl.uniform1i(cu.uMixMode, F.mixMode | 0);
  gl.uniform1f(cu.uMix, F.mix || 0);
  gl.uniform1i(cu.uBr0, BR0);
  const ramp = F.ramp || DEFAULT_RAMP;
  gl.uniform1i(cu.uRampN, ramp.length);
  gl.uniform1iv(cu.uRamp, ramp.concat(new Array(16 - ramp.length).fill(0)));
  gl.uniform1iv(cu.uQuad, QUAD_IDX);
  gl.uniform1f(cu.uContrast, F.contrast || 1.6);
  gl.uniform1f(cu.uInk, F.ink || 1);
  gl.uniform1f(cu.uThresh, F.thresh === undefined ? 0.08 : F.thresh);
  gl.uniform1f(cu.uFlat, F.flat === undefined ? 0.09 : F.flat);
  gl.uniform1f(cu.uTime, F.T);
  gl.uniform1f(cu.uDissolve, F.dissolve || 0);
  gl.uniform1f(cu.uScramble, F.scramble || 0);
  gl.uniform1f(cu.uReveal, F.reveal === undefined ? 9 : F.reveal);
  gl.uniform1f(cu.uRevealSoft, F.revealSoft === undefined ? 0.3 : F.revealSoft);
  gl.uniform2fv(cu.uRevealDir, F.revealDir || [1, 0]);
  gl.uniform3fv(cu.uDisC, F.dissolveC || [0.5, 0.5, 0]);
  gl.uniform3fv(cu.uTint, F.tint || [1, 1, 1]);
  gl.uniform1f(cu.uTintAmt, F.tintAmt || 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // screen pass
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  const su = screenProg.u;
  gl.useProgram(screenProg.p);
  bindT(0, atlasTex, su.uAtlas);
  bindT(1, cellColorTex, su.uCol);
  bindT(2, cellGlyphTex, su.uGly);
  gl.uniform2i(su.uCell, cw, chh);
  gl.uniform2i(su.uGrid, cols, rows);
  gl.uniform1i(su.uAtlasCols, atlasCols);
  gl.uniform3f(su.uBg, bg[0] / 255, bg[1] / 255, bg[2] / 255);
  gl.uniform1f(su.uFlash, F.flash || 0);
  gl.uniform1f(su.uGain, F.gain === undefined ? 1 : F.gain);
  gl.uniform1f(su.uChroma, (F.chroma || 0) * dpr);
  gl.uniform1f(su.uGlitch, F.glitch || 0);
  gl.uniform1f(su.uSeed, F.glitchSeed || 0);
  gl.uniform1f(su.uScan, F.scan || 0);
  gl.uniform1f(su.uTime, F.T);
  gl.uniform2f(su.uShake, (F.shake ? F.shake[0] : 0) * cw, (F.shake ? F.shake[1] : 0) * chh);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

let DEFAULT_RAMP = [], QUAD_IDX = [];
function ramp(str) { return Array.from(str).map((c) => GI[c] || 0).slice(0, 16); }
DEFAULT_RAMP = ramp(" .:-=+*#%@");
QUAD_IDX = QUAD.map((c) => GI[c]);

return {
  init, layout, addScene, render, beginLayer, resetLayer, clearOverlay, put, plot, text, ramp, colOf, rowOf,
  GI, GLYPHS, MODE, BR0,
  get cols() { return cols; }, get rows() { return rows; }, get A() { return A; },
  get SW() { return SW; }, get SH() { return SH; }, get layer() { return layer; }, get lctx() { return lctx; },
  get gl() { return gl; }, get dpr() { return dpr; }, get fit() { return fit(); },
};
})();
