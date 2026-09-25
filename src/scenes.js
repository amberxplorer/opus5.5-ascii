/* ─────────────────────────────────────────────────────────────────────────
   scenes.js — what happens when. Every frame is a pure function of the
   music time T (so seeking works and nothing drifts from the audio).

     0:00  title card, then a single bead
     0:05  the bead pulls a thread taut; each plucked note strings a bead
     0:15  threads multiply and weave into cloth
     0:22  the cloth curls up around us into a tunnel
     0:30  drop — flight down the woven tunnel
     0:45  out into space: the thread has tied itself into a knot
     1:00  the knot bursts into a galaxy of beads, a mandala, metaballs
     1:15  home: two figures on a rooftop, tails in a heart, tied with the red thread
   ───────────────────────────────────────────────────────────────────────── */
var SCENES = (function () {
'use strict';
const E = ENGINE;
const G = E.GI;
const TAU = Math.PI * 2;
const BEAT = 60 / 128, BAR = BEAT * 4, STEP = BEAT / 4;
const TB = (b, s) => (b * 16 + (s || 0)) * STEP;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sat = (x) => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeOut = (t) => 1 - Math.pow(1 - sat(t), 3);
const easeIn = (t) => Math.pow(sat(t), 3);
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123; return x - Math.floor(x); };

const TITLE = '赤い糸';
const SUBTITLE = 'a  b e a u t i f u l  t h r e a d';
let TITLE_FONT = '"Shippori Mincho", "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", "Noto Serif JP", "WenQuanYi Zen Hei", serif';
let titleIsCJK = true;

/* palette (0‥255) */
const C = {
  red: [255, 58, 96], pearl: [255, 240, 222], gold: [255, 204, 120], rose: [255, 176, 196],
  violet: [160, 130, 255], teal: [90, 214, 224], dim: [72, 70, 112], star: [196, 204, 255],
};
const mulc = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/* ═════════════════════ music access ═════════════════════ */
let S = null;          // score (event lists)
let ENV = null;        // stem envelopes at the current frame
let bellsBD = [];      // breakdown bells → knot beads
let introPlucks = [];  // intro plucks → beads on the string
const NOENV = { kick: 0, snare: 0, hat: 0, bass: 0, pad: 0, lead: 0, arp: 0, pluck: 0, bell: 0, fx: 0, drone: 0, master: 0 };

function setMusic(score) {
  S = score;
  const tv = (e) => (typeof e === 'number' ? e : e[0]);
  for (const k in S) if (Array.isArray(S[k])) S[k].sort((a, b) => tv(a) - tv(b));
  bellsBD = S.bell.filter((e) => e[0] >= TB(24) - 0.01 && e[0] < TB(32));
  introPlucks = S.pluck.filter((e) => e[0] < TB(8)).map((e, j) => {
    const s = 0.1 + 0.8 * (e[1] - 71) / (86 - 71);
    return { t: e[0], note: e[1], s: clamp(s + (hash(j * 3.3) - 0.5) * 0.05, 0.05, 0.95), j };
  });
}
function lastIdx(arr, T) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = typeof arr[mid] === 'number' ? arr[mid] : arr[mid][0];
    if (t <= T) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function since(arr, T) {
  if (!arr) return 1e9;
  const i = lastIdx(arr, T);
  if (i < 0) return 1e9;
  return T - (typeof arr[i] === 'number' ? arr[i] : arr[i][0]);
}
const RAMP_SOFT = E.ramp(' .:-=+*#%@');
const pulseOf = (arr, T, tau) => { const d = since(arr, T); return d < 8 * tau ? Math.exp(-d / tau) : 0; };

// integral of a piecewise-linear speed curve → seekable positions
function integ(knots, T) {
  let s = 0;
  for (let i = 0; i + 1 < knots.length; i++) {
    const [t0, v0] = knots[i], [t1, v1] = knots[i + 1];
    if (T <= t0) break;
    const te = Math.min(T, t1);
    const vt = v0 + (v1 - v0) * (te - t0) / (t1 - t0);
    s += (v0 + vt) * 0.5 * (te - t0);
  }
  const last = knots[knots.length - 1];
  if (T > last[0]) s += last[1] * (T - last[0]);
  return s;
}

/* ═════════════════════ GLSL scenes ═════════════════════ */
const GLSL = {};

GLSL.weave = `
// uP0 roll, look, curl, pnorm | uP1 travel, fade, pulse, hue | uP2 twist, ripple, spacing, redBoost | uP3 rings, sat, bright, -
void main() {
  vec2 p = P();
  float roll = uP0.x, look = uP0.y, m = uP0.z, pn = uP0.w;
  float travel = uP1.x, fade = uP1.y, pulse = uP1.z, hue = uP1.w;
  float twist = uP2.x, ripple = uP2.y, sp = uP2.z, redB = uP2.w;
  float rings = uP3.x, satu = uP3.y, bright = uP3.z;
  p = rot(roll) * p;
  vec3 rd = normalize(vec3(p, 1.7));
  float la = look * PI * 0.5;
  rd = vec3(rd.x, rd.y * cos(la) - rd.z * sin(la), rd.y * sin(la) + rd.z * cos(la));
  float h = 1.0;
  bool hit = false; vec2 uv = vec2(0.0); float t = 0.0;
  if (m < 0.002) {
    if (rd.y < -1e-3) { t = -h / rd.y; vec3 q = rd * t; uv = vec2(q.x, q.z); hit = true; }
  } else if (m < 0.999) {
    float rho = h / m;
    float Aq = dot(rd.xy, rd.xy);
    float Bq = (h - rho) * rd.y;
    float Cq = h * (h - 2.0 * rho);
    float disc = Bq * Bq - Aq * Cq;
    if (disc > 0.0 && Aq > 1e-8) {
      float sq = sqrt(disc);
      float tt = Bq > 0.0 ? Cq / (-Bq - sq) : (-Bq + sq) / Aq;
      vec3 q = rd * tt;
      vec2 c = vec2(q.x, q.y + h - rho);
      float s = atan(c.x, -c.y) * rho;
      if (abs(s) < PI * h && tt > 0.0) { uv = vec2(s, q.z); t = tt; hit = true; }
    }
  } else {
    vec2 a = abs(rd.xy) + 1e-5;
    float n = pow(pow(a.x, pn) + pow(a.y, pn), 1.0 / pn);
    float R = h * (1.0 - 0.07 * pulse);
    t = R / n;
    vec3 q = rd * t;
    uv = vec2(atan(rd.x, -rd.y) * h, q.z);
    hit = true;
  }
  if (!hit) { o = vec4(0.0); return; }
  if (ripple > 0.0) uv += ripple * 0.03 * vec2(sin(uv.y * 5.0 + uT * 1.3), cos(uv.x * 4.0 - uT * 1.1));
  float v = uv.y + travel;
  float u = uv.x + twist * v;
  vec2 w = vec2(u / sp + 0.5, v / sp);
  float iu = floor(w.x), iv = floor(w.y);
  vec2 f = fract(w) - 0.5;
  float pw = smoothstep(0.42, 0.27, abs(f.x));
  float pf = smoothstep(0.42, 0.27, abs(f.y));
  float hw = cos(PI * (w.y - 0.5 - iu));
  float hf = -cos(PI * (w.x - 0.5 - iv));
  float bw = pw > 0.01 ? hw : -3.0;
  float bf = pf > 0.01 ? hf : -3.0;
  float ink = 0.0; vec3 col = vec3(0.0);
  bool isRed = false;
  if (bw > -2.0 || bf > -2.0) {
    if (bw >= bf) {
      ink = pw * (0.38 + 0.62 * (0.5 + 0.5 * hw)) * cos(f.x * PI * 0.85);
      isRed = abs(iu) < 0.5;
      col = isRed ? vec3(1.0, 0.2, 0.36) : hsv(0.71 + 0.07 * sin(iu * 0.9) + hue, 0.6 * satu, 1.0);
    } else {
      ink = pf * (0.38 + 0.62 * (0.5 + 0.5 * hf)) * cos(f.y * PI * 0.85);
      col = hsv(0.52 + 0.05 * sin(iv * 1.3) + hue, 0.55 * satu, 0.95);
    }
  }
  if (ripple > 0.0) ink *= 1.0 + ripple * 0.35 * sin(uv.x * 3.0 + uv.y * 2.0 + uT * 1.7);
  float fog = exp(-max(t - 1.0, 0.0) * 0.22);
  float detail = smoothstep(7.5, 2.4, t);
  ink = mix(0.1, ink, detail) * fog;
  if (rings > 0.0) {
    float band = pow(0.5 + 0.5 * cos(TAU * v / 3.75), 18.0);
    ink += band * rings * exp(-max(t - 1.0, 0.0) * 0.1) * 0.85;
    col = mix(col, hsv(hue + 0.92 + v * 0.004, 0.4, 1.0), clamp(band * rings, 0.0, 1.0));
  }
  ink *= (1.0 + 0.35 * pulse) * bright;
  if (!isRed) ink *= 1.0 - fade;
  else { ink = max(ink, fade * 0.7 * exp(-t * 0.05)); ink *= 1.0 + redB; }
  o = vec4(col, clamp(ink, 0.0, 1.0));
}`;

GLSL.knot = `
// uP0 rotation xyz, scale | uP1 heat, pulse, R, r | uP2 tube, zoom, beadR, rimHue | uQ[0..7] beads (xyz, glow)
float gR, gr, gth, gbr, gsc;
mat3 gM;
mat3 rotXYZ(vec3 a) {
  float cx = cos(a.x), sx = sin(a.x), cy = cos(a.y), sy = sin(a.y), cz = cos(a.z), sz = sin(a.z);
  mat3 X = mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
  mat3 Y = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  mat3 Z = mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
  return X * Y * Z;
}
vec2 map(vec3 pw) {
  vec3 p = gM * pw / gsc;
  float az = atan(p.z, p.x);
  float lxz = length(p.xz);
  float d = 1e9;
  for (int k = 0; k < 2; k++) {
    float phi = (az + TAU * float(k)) * 0.5;
    float b = 3.0 * phi;
    vec2 c = vec2(gR + gr * cos(b), gr * sin(b));
    d = min(d, length(vec2(lxz, p.y) - c));
  }
  d -= gth;
  float m = 0.0;
  for (int i = 0; i < 8; i++) {
    float db = length(p - uQ[i].xyz) - gbr;
    if (db < d) { d = db; m = float(i + 1); }
  }
  return vec2(d * gsc * 0.72, m);
}
void main() {
  vec2 p = P();
  gR = uP1.z; gr = uP1.w; gth = uP2.x; gbr = uP2.z; gsc = max(uP0.w, 0.001);
  gM = rotXYZ(uP0.xyz);
  vec3 ro = vec3(0.0, 0.0, -3.7 * uP2.y);
  vec3 rd = normalize(vec3(p, 1.9));
  float bound = (gR + gr + max(gth, gbr) + 0.05) * gsc;
  float bb = dot(ro, rd), cc = dot(ro, ro) - bound * bound;
  float disc = bb * bb - cc;
  if (disc < 0.0) { o = vec4(0.0); return; }
  float t = max(0.0, -bb - sqrt(disc));
  float tmax = -bb + sqrt(disc);
  vec2 hm = vec2(0.0); bool hit = false;
  for (int i = 0; i < 96; i++) {
    hm = map(ro + rd * t);
    if (hm.x < 0.0012) { hit = true; break; }
    t += hm.x;
    if (t > tmax) break;
  }
  if (!hit) { o = vec4(0.0); return; }
  vec3 pos = ro + rd * t;
  vec2 e = vec2(0.002, -0.002);
  vec3 n = normalize(e.xyy * map(pos + e.xyy).x + e.yyx * map(pos + e.yyx).x + e.yxy * map(pos + e.yxy).x + e.xxx * map(pos + e.xxx).x);
  vec3 L = normalize(vec3(-0.55, 0.75, -0.6));
  float dif = max(dot(n, L), 0.0);
  float spe = pow(max(dot(reflect(rd, n), L), 0.0), 26.0);
  float fre = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
  float ao = 0.0, sc = 1.0;
  for (int k = 1; k < 4; k++) { float hh = 0.05 * float(k) * gsc; ao += (hh - map(pos + n * hh).x / 0.72) * sc; sc *= 0.6; }
  ao = clamp(1.0 - 2.5 * ao / gsc, 0.0, 1.0);
  float heat = uP1.x;
  vec3 base; float glow = 0.0;
  if (hm.y < 0.5) {
    base = mix(vec3(1.0, 0.14, 0.3), vec3(1.0, 0.7, 0.35), heat);
  } else {
    int bi = int(hm.y - 0.5);
    glow = uQ[bi].w;
    base = mix(vec3(1.0, 0.94, 0.84), vec3(1.0, 0.82, 0.38), clamp(glow, 0.0, 1.0));
  }
  vec3 rim = hsv(uP2.w, 0.55, 1.0);
  float lum = (0.1 + 0.9 * dif) * (0.4 + 0.6 * ao) + spe * 0.9 + fre * 0.5 + glow * 0.55 + heat * 0.3 + uP1.y * 0.12;
  vec3 col = base * (0.6 + 0.4 * dif) + rim * fre * 0.7 + vec3(spe) * 0.8 + vec3(heat * heat * 0.4);
  o = vec4(clamp(col, 0.0, 1.0), clamp(lum, 0.0, 1.0));
}`;

GLSL.nebula = `
// uP0 time, spin, fade, kick | uP1 tilt, xscale, burst, -
void main() {
  vec2 p = P();
  float fade = uP0.z;
  float cs = cos(-uP0.y), sn = sin(-uP0.y);
  p = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
  vec2 q = vec2(p.x / uP1.y, p.y / uP1.x) / max(uP1.z, 0.05);
  float r = length(q), a = atan(q.y, q.x);
  float arm = cos(2.0 * (a - 2.4 * log(max(r, 0.02) / 0.1) - uP0.x * 0.9));
  float dens = pow(max(arm, 0.0), 2.5) * exp(-r * 1.6) * smoothstep(0.03, 0.25, r);
  dens *= 0.55 + 0.9 * fbm(q * 3.2 + vec2(uP0.x * 0.15, 0.0));
  float core = exp(-r * r * 22.0);
  float ink = clamp(dens * 0.62 + core * (0.85 + 0.15 * uP0.w), 0.0, 1.0) * fade;
  vec3 col = mix(vec3(0.72, 0.36, 1.0), vec3(0.3, 0.85, 0.95), clamp(r * 1.1, 0.0, 1.0));
  col = mix(col, vec3(1.0, 0.86, 0.62), clamp(core * 1.4, 0.0, 1.0));
  o = vec4(col, ink);
}`;

GLSL.mandala = `
// uP0 grow, rot, pulse, hue | uP1 bright, -, -, -
void add(inout float ink, inout vec3 col, float v, vec3 c) {
  if (v > 0.001) { col = mix(col, c, clamp(v / (ink + v), 0.0, 1.0)); ink = max(ink, v); }
}
float ring(float r, float R, float w) { float d = (r - R) / w; return exp(-d * d); }
float line(float d, float w) { float q = d / w; return exp(-q * q); }
void main() {
  vec2 p = P();
  float grow = max(uP0.x, 0.001), rt = uP0.y, pulse = uP0.z, hue = uP0.w;
  float sc = grow * (1.0 + 0.06 * pulse);
  p /= sc;
  float r = length(p), a = atan(p.y, p.x);
  float W = 0.016 / sc;
  float ink = 0.0; vec3 col = vec3(0.0);
  add(ink, col, smoothstep(0.075, 0.055, r), hsv(hue + 0.12, 0.25, 1.0));
  add(ink, col, ring(r, 0.11, W), hsv(hue + 0.1, 0.5, 1.0));
  {
    float N = 8.0, sec = TAU / N; float aa = mod(a + rt * 0.8, sec) - 0.5 * sec;
    vec2 q = vec2(cos(aa), sin(aa)) * r;
    vec2 e = (q - vec2(0.23, 0.0)) / vec2(0.1, 0.046);
    float d = (length(e) - 1.0) * 0.046;
    add(ink, col, line(d, W) + smoothstep(0.0, -0.03, d) * 0.3, hsv(hue + 0.93, 0.62, 1.0));
  }
  {
    float N = 16.0, sec = TAU / N; float aa = mod(a - rt * 1.3, sec) - 0.5 * sec;
    vec2 q = vec2(cos(aa), sin(aa)) * r;
    float d = length(q - vec2(0.39, 0.0)) - 0.03;
    add(ink, col, smoothstep(W, -W, d), hsv(hue + 0.5, 0.6, 1.0));
  }
  {
    float N = 12.0, sec = TAU / N; float aa = mod(a + rt * 0.35, sec) - 0.5 * sec;
    vec2 q = vec2(cos(aa), sin(aa)) * r;
    vec2 e = (q - vec2(0.62, 0.0)) / vec2(0.2, 0.08);
    float d = (length(e) - 1.0) * 0.08;
    add(ink, col, line(d, W * 1.1), hsv(hue + 0.78, 0.6, 1.0));
    vec2 e2 = (q - vec2(0.62, 0.0)) / vec2(0.1, 0.035);
    float d2 = (length(e2) - 1.0) * 0.035;
    add(ink, col, smoothstep(0.0, -0.02, d2) * 0.55, hsv(hue + 0.02, 0.5, 1.0));
  }
  {
    float N = 24.0, sec = TAU / N; float aa = mod(a - rt * 0.2, sec) - 0.5 * sec;
    float d = abs(aa) * r;
    float m = smoothstep(0.83, 0.86, r) * smoothstep(1.0, 0.97, r);
    add(ink, col, line(d, W) * m, hsv(hue + 0.15, 0.55, 1.0));
  }
  add(ink, col, ring(r, 0.8, W), hsv(hue + 0.56, 0.5, 1.0));
  float dash = step(0.45, fract(a / TAU * 48.0 + rt * 0.5));
  add(ink, col, ring(r, 1.04, W) * dash, hsv(hue + 0.35, 0.55, 1.0));
  ink *= (1.0 + 0.3 * pulse) * uP1.x;
  o = vec4(col, clamp(ink, 0.0, 1.0));
}`;

GLSL.meta = `
// uP0 time, merge, pulse, hue | uP1 bigX, bigY, smallX, smallY | uP2 bright
void main() {
  vec2 p = P();
  float t = uP0.x, mg = uP0.y;
  float f = 0.0; vec3 cacc = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * (0.37 + 0.05 * fi) + fi * 1.7) * 1.15, cos(t * (0.29 + 0.041 * fi) + fi * 2.3) * 0.62);
    vec2 tg = i < 8 ? uP1.xy : uP1.zw;
    float spread = i < 8 ? 0.1 : 0.05;
    tg += spread * vec2(sin(fi * 2.1 + t * 1.3), cos(fi * 1.7 + t * 1.1));
    c = mix(c, tg, mg);
    float r = (0.1 + 0.05 * h11(fi)) * (1.0 + 0.25 * uP0.z);
    float k = r * r / (dot(p - c, p - c) + 1e-4);
    f += k;
    cacc += hsv(fract(fi * 0.13 + uP0.w), 0.65, 1.0) * k;
  }
  vec3 col = cacc / max(f, 1e-4);
  float lf = log2(f) * 2.2;
  float g = fract(lf);
  float lineInk = 1.0 - smoothstep(0.0, 1.3, min(g, 1.0 - g) / max(fwidth(lf), 1e-4));
  lineInk *= smoothstep(0.08, 0.25, f) * step(f, 1.0);
  float inside = smoothstep(0.95, 1.05, f) * (0.5 + 0.45 * smoothstep(1.0, 4.0, f));
  float ink = max(lineInk * 0.95, inside);
  col = mix(col, vec3(1.0), 0.25 * smoothstep(2.0, 6.0, f));
  o = vec4(col, clamp(ink * uP2.x, 0.0, 1.0));
}`;

GLSL.sky = `
// uP0 moonX, moonY, moonR, lightX | uP1 clouds, -, -, glow
void main() {
  vec2 p = P();
  vec2 mc = uP0.xy; float R = uP0.z;
  vec2 d = p - mc;
  float r = length(d);
  float ink = 0.0; vec3 col = vec3(0.0);
  if (r < R) {
    vec3 n = vec3(d / R, sqrt(max(0.0, 1.0 - dot(d, d) / (R * R))));
    vec3 L = normalize(vec3(uP0.w, 0.3, -0.22));
    float lit = smoothstep(-0.02, 0.2, dot(n, L));
    float cr = fbm(d / R * 2.6 + 3.0);
    float tex = 0.78 + 0.45 * (cr - 0.5);
    ink = max(lit * tex, 0.16);
    col = lit > 0.05 ? mix(vec3(1.0, 0.7, 0.42), vec3(1.0, 0.95, 0.82), lit * tex) : vec3(0.4, 0.44, 0.66);
  } else {
    float halo = exp(-(r - R) / (R * 0.45)) * 0.3 * uP1.w;
    float grain = step(0.55, h21(floor(gl_FragCoord.xy * 0.5)));
    ink = halo * grain;
    col = vec3(1.0, 0.82, 0.55);
  }
  float cl = fbm(vec2(p.x * 1.1 + uT * 0.025, p.y * 3.2 + 7.0));
  float band = smoothstep(-0.05, 0.25, p.y) * smoothstep(0.95, 0.5, p.y);
  float cloud = smoothstep(0.6, 0.82, cl) * band * uP1.x;
  if (cloud > 0.0) {
    float c = cloud * 0.34;
    if (c > ink * 0.8) { col = mix(col, vec3(0.5, 0.55, 0.78), 0.8); }
    ink = max(ink * (1.0 - cloud * 0.6), c);
  }
  o = vec4(col, clamp(ink, 0.0, 1.0));
}`;

function compileAll() { for (const k in GLSL) E.addScene(k, GLSL[k]); }

/* ═════════════════════ helpers ═════════════════════ */
function resetF(F) {
  F.A = null; F.B = null; F.mix = 0; F.mixMode = 0; F.pA = null; F.pB = null; F.qA = null; F.qB = null; F.lA = 0; F.lB = 0;
  F.mode = E.MODE.SHAPE; F.modeB = undefined; F.contrast = 1.6; F.ink = 1; F.thresh = 0.08; F.ramp = null;
  F.dissolve = 0; F.dissolveC = null; F.scramble = 0; F.reveal = 9; F.revealSoft = 0.3; F.revealDir = [1, 0];
  F.tint = [1, 1, 1]; F.tintAmt = 0;
  F.flash = 0; F.gain = 1; F.chroma = 0; F.glitch = 0; F.glitchSeed = 0; F.scan = 0; F.shake = null;
}
const plot = (x, y, ch, c, a) => E.plot(x, y, G[ch] || 0, c[0], c[1], c[2], a === undefined ? 255 : a);
const u2px = (x) => E.SW / 2 + x * E.SH / 2;
const v2px = (y) => E.SH / 2 - y * E.SH / 2;
const px = () => 2 / E.SH;  // one sample, in scene units
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function stars(T, n, fade, yMin, seed, prio, drift) {
  if (fade <= 0.01) return;
  const A = E.A;
  for (let i = 0; i < n; i++) {
    let x = (hash(i * 3.17 + seed) * 2 - 1) * A;
    const y = lerp(yMin, 1, hash(i * 7.71 + seed));
    if (drift) x = ((x + A + drift * (0.3 + hash(i * 1.9) * 0.7)) % (2 * A) + 2 * A) % (2 * A) - A;
    const tw = 0.55 + 0.45 * Math.sin(T * (1.3 + hash(i + seed) * 3.1) + i * 1.7);
    const b = (0.3 + 0.7 * Math.pow(hash(i * 1.31 + seed), 2)) * tw * fade;
    const ch = b > 0.8 ? '✦' : b > 0.6 ? '+' : b > 0.38 ? '·' : '.';
    plot(x, y, ch, mulc(C.star, Math.min(1, b + 0.15)), prio);
  }
}

/* ═════════════════════ idle (before start) ═════════════════════ */
function idle(tw, F, st) {
  resetF(F);
  E.clearOverlay();
  E.resetLayer();
  const g = E.beginLayer();
  const k = E.fit;
  const R = 0.5 * k, N = 24;
  const lit = st.ready ? N : Math.floor(st.progress * N + 1e-6);
  const fadeIn = sat(tw / 0.8);
  for (let i = 0; i < N; i++) {
    const a = Math.PI / 2 - (i / N) * TAU + tw * 0.12;
    const x = Math.cos(a) * R, y = Math.sin(a) * R;
    const wave = 0.5 + 0.5 * Math.sin(tw * 2.4 - i * 0.45);
    if (i < lit) plot(x, y, '●', mulc(mixc(C.gold, C.pearl, wave), (0.55 + 0.45 * wave) * fadeIn));
    else plot(x, y, i === lit ? '•' : '·', mulc(C.dim, (i === lit ? 2.2 : 1) * fadeIn));
  }
  if (st.ready) {
    const s = 0.14 * k * (1 + 0.035 * Math.sin(tw * 2.6));
    const b = st.hover ? 1 : 0.72 + 0.28 * Math.sin(tw * 2.6);
    g.fillStyle = rgba(mixc(C.rose, C.pearl, 0.5), b * fadeIn);
    g.beginPath(); g.moveTo(-s * 0.62, s); g.lineTo(-s * 0.62, -s); g.lineTo(s * 1.0, 0); g.closePath(); g.fill();
  }
  // headphones
  const hy = -R - 0.2 * k, hs = 0.075 * k;
  g.strokeStyle = rgba(C.dim, 0.95 * fadeIn); g.fillStyle = rgba(C.dim, 0.95 * fadeIn);
  g.lineWidth = 3.2 * px();
  g.beginPath(); g.arc(0, hy, hs, 0.15, Math.PI - 0.15); g.stroke();
  for (const sx of [-1, 1]) {
    g.beginPath();
    g.ellipse(sx * hs * 0.98, hy - hs * 0.2, hs * 0.26, hs * 0.42, 0, 0, TAU);
    g.fill();
  }
}

/* ═════════════════════ 0:00 — title card ═════════════════════ */
let titleCache = null;
function drawTitle(g, alpha, shine) {
  const k = E.fit;
  const size = (titleIsCJK ? 0.6 : 0.34) * k;
  const y = 0.2 * k;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  g.font = `800 ${Math.round(size * E.SH / 2)}px ${TITLE_FONT}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const w = 1.25 * k;
  const grad = g.createLinearGradient(u2px(-w), 0, u2px(w), 0);
  const base = rgba(C.pearl, alpha), glint = rgba([255, 150, 175], alpha);
  const s0 = clamp(shine, -1, 2);
  grad.addColorStop(0, base);
  if (s0 > 0.02 && s0 < 0.98) {
    grad.addColorStop(Math.max(0.001, s0 - 0.12), base);
    grad.addColorStop(s0, glint);
    grad.addColorStop(Math.min(0.999, s0 + 0.12), base);
  }
  grad.addColorStop(1, base);
  g.fillStyle = grad;
  g.fillText(titleIsCJK ? TITLE : 'beautiful thread', u2px(0), v2px(y));
  g.restore();
}
function titleCells() {
  if (titleCache && titleCache.cols === E.cols && titleCache.rows === E.rows) return titleCache.cells;
  const cv = document.createElement('canvas');
  cv.width = E.SW; cv.height = E.SH;
  const g = cv.getContext('2d', { willReadFrequently: true });
  drawTitle(g, 1, -1);
  const d = g.getImageData(0, 0, E.SW, E.SH).data;
  const cells = [];
  for (let r = 0; r < E.rows; r++) for (let c = 0; c < E.cols; c++) {
    let s = 0;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 2; i++) s += d[((r * 4 + j) * E.SW + c * 2 + i) * 4 + 3];
    if (s / (8 * 255) > 0.3) cells.push([c, r]);
  }
  titleCache = { cols: E.cols, rows: E.rows, cells };
  return cells;
}
const cellX = (c) => ((c + 0.5) / E.cols * 2 - 1) * E.A;
const cellY = (r) => 1 - (r + 0.5) / E.rows * 2;

function sceneTitle(T, F) {
  const k = E.fit;
  // the loading ring collapses into a point
  if (T < 1.0) {
    const R = 0.5 * k * (1 - easeIn(T / 0.92));
    for (let i = 0; i < 24; i++) {
      const a = Math.PI / 2 - (i / 24) * TAU + T * T * 9;
      plot(Math.cos(a) * R, Math.sin(a) * R, T < 0.8 ? '●' : '•', mulc(mixc(C.gold, C.pearl, T), 1));
    }
  }
  if (T > 0.86 && T < 1.4) {
    const q = (T - 0.86) / 0.54;
    plot(0, 0, q < 0.3 ? '✦' : q < 0.6 ? '*' : '·', mulc(C.pearl, 1 - q * 0.6));
    F.flash = 0.15 * (1 - q);
  }
  const cT0 = 4.22, cT1 = TB(3);
  // the title itself (drawn to the layer, becomes glyphs via shape matching)
  if (T >= 0.95 && T < 4.75) {
    const shine = (T - 2.1) / 1.6;
    const g = E.beginLayer();
    drawTitle(g, 1, shine);
    F.reveal = (T - 0.95) / 0.8;
    F.revealDir = [1, 0];
    F.revealSoft = 0.35;
    F.contrast = 1.35;
    if (T > cT0) F.dissolve = smooth(cT0, cT0 + 0.45, T);
    // a red thread beneath the title, drawn out from the centre
    const ly = -0.2 * k;
    const grow = easeOut((T - 1.5) / 1.1) * (1 - easeIn((T - cT0) / 0.5));
    if (grow > 0.001) {
      const half = 0.95 * k * grow;
      g.strokeStyle = rgba(C.red, 1);
      g.lineWidth = 0.7 * px();
      g.beginPath();
      for (let i = 0; i <= 60; i++) {
        const x = lerp(-half, half, i / 60);
        const y = ly + 0.012 * Math.sin(x * 7 + T * 2.2) * grow;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
  }
  // subtitle, decoded letter by letter
  const sub = Array.from(SUBTITLE);
  const srow = E.rowOf(-0.36 * k);
  const scol = Math.floor(E.cols / 2 - sub.length / 2);
  if (T >= 1.4 && T < cT0 + 0.05) {
    sub.forEach((c, i) => {
      if (c === ' ') return;
      const tr = 1.55 + i * 0.03;
      if (T < tr - 0.14) return;
      let ch = c, col = mulc(C.rose, 0.95);
      if (T < tr) { ch = String.fromCharCode(33 + Math.floor(hash(i * 7 + Math.floor(T * 24)) * 90)); col = [150, 255, 200]; }
      E.put(scol + i, srow, G[ch], col[0], col[1], col[2], 255);
    });
  }
  // collapse: everything streams into the centre and becomes one bead
  if (T >= cT0 && T < cT1 + 0.05) {
    const cells = titleCells();
    const span = cT1 - cT0;
    const parts = cells.map(([c, r]) => [cellX(c), cellY(r)]);
    sub.forEach((c, i) => { if (c !== ' ') parts.push([cellX(scol + i), cellY(srow)]); });
    const rub = ['·', ':', '*', '+', '•', '·', '.', 'o'];
    for (let i = 0; i < parts.length; i++) {
      const h = hash(i * 1.618 + 0.5);
      const q = sat((T - cT0 - h * 0.3) / (span - 0.32));
      if (q <= 0) continue;
      const e = easeIn(q);
      const [x0, y0] = parts[i];
      const sw = e * (1.6 + h * 1.4);
      const cs = Math.cos(sw), sn = Math.sin(sw);
      const x = (x0 * cs - y0 * sn) * (1 - e), y = (x0 * sn + y0 * cs) * (1 - e);
      if (q >= 1) continue;
      plot(x, y, q > 0.85 ? '·' : rub[(i * 7) % rub.length], mixc(C.pearl, C.gold, e), 255);
    }
  }
  if (T >= cT1 - 0.12) {
    const q = sat((T - (cT1 - 0.12)) / 0.12);
    plot(0, 0, q < 1 ? '•' : '●', mulc(C.pearl, 0.6 + 0.4 * q));
  }
}

/* ═════════════════════ 0:05 — the thread ═════════════════════ */
const STR_GAP = 0.238;
function stringEnds(T) {
  const A = E.A;
  const e = easeOut((T - TB(3)) / 0.7);
  return [-A * 0.97 * e, A * 0.97 * e];
}
function stringY(x, T, n, xl, xr) {
  const s = (x - xl) / Math.max(1e-4, xr - xl);
  const env = Math.sin(Math.PI * clamp(s, 0, 1));
  let y = n * STR_GAP;
  y += (0.022 * Math.sin(T * 0.9 + x * 1.3 + n * 0.8) + 0.01 * Math.sin(T * 1.7 - x * 2.1 + n)) * env;
  const att = Math.pow(0.6, Math.abs(n));
  for (let j = 0; j < introPlucks.length; j++) {
    const P = introPlucks[j];
    const dt = T - P.t;
    if (dt < 0 || dt > 3.2) continue;
    const amp = 0.16 * Math.exp(-dt / 0.8) * att;
    for (let kk = 1; kk <= 4; kk++) {
      y += amp * Math.sin(kk * Math.PI * P.s) / (kk * kk) * Math.sin(kk * Math.PI * s) * Math.cos(TAU * kk * 1.9 * dt);
    }
  }
  return y;
}
function vibAmount(T) {
  let v = 0;
  for (const P of introPlucks) { const dt = T - P.t; if (dt >= 0 && dt < 3.2) v += Math.exp(-dt / 0.8); }
  return Math.min(1, v * 1.4);
}
function stringColor(n) {
  return n === 0 ? C.red : mixc(C.violet, C.teal, (Math.abs(n) - 1) / 3);
}
function strokeString(g, T, n, xl, xr, sc, width, style) {
  g.strokeStyle = style; g.lineWidth = width;
  g.beginPath();
  for (let i = 0; i <= 150; i++) {
    const x = lerp(xl, xr, i / 150);
    const y = stringY(x, T, n, xl, xr) * sc;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}
function drawStrings(T, alpha) {
  const [xl, xr] = stringEnds(T);
  if (xr - xl < 0.01 || alpha <= 0.01) return;
  const g = E.beginLayer();
  const k = E.fit;
  const nMax = 4;
  const P = px();
  for (let n = -nMax; n <= nMax; n++) {
    let a = 1;
    const tn = TB(6) + (Math.abs(n) - 1) * BEAT * 1.6;
    if (n !== 0) a = smooth(tn, tn + 0.45, T);
    a *= alpha;
    if (a <= 0.01) continue;
    const col = stringColor(n);
    const sc = n === 0 ? 1 : k;
    // a vibrating string blurs into a spindle: draw its recent past, fading
    const vib = vibAmount(T) * Math.pow(0.6, Math.abs(n));
    if (vib > 0.05) for (let q = 5; q >= 1; q--) strokeString(g, T - q * 0.018, n, xl, xr, sc, 0.5 * P, rgba(col, a * vib * 0.18 * (6 - q) / 5));
    strokeString(g, T, n, xl, xr, sc, (n === 0 ? 0.75 : 0.55) * P, rgba(col, a));
  }
  // each bead lights the thread around it
  for (const Pk of introPlucks) {
    const dt = T - Pk.t;
    if (dt < 0) continue;
    const x0 = lerp(xl, xr, Pk.s);
    const glow = 0.55 + 0.45 * Math.exp(-dt / 0.5);
    const w = 0.045 + 0.05 * Math.exp(-dt / 0.4);
    g.strokeStyle = rgba(mixc(C.rose, [255, 245, 235], 0.5 * glow), glow * alpha);
    g.lineWidth = 0.75 * P;
    g.beginPath();
    for (let i = 0; i <= 8; i++) {
      const x = x0 - w + (2 * w * i) / 8;
      const y = stringY(x, T, 0, xl, xr);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  // weft threads, woven over / under, from bar 7
  if (T > TB(7)) {
    const A = E.A;
    const mMax = Math.ceil(A / STR_GAP);
    for (let m = -mMax; m < mMax; m++) {
      const x = cellX(E.colOf((m + 0.5) * STR_GAP));
      const t0 = TB(7) + Math.abs(x) / A * 1.2;
      const a = smooth(t0, t0 + 0.35, T) * alpha;
      if (a <= 0.01) continue;
      g.strokeStyle = rgba(mulc(C.teal, 0.9), a);
      g.lineWidth = 0.55 * P;
      g.beginPath(); g.moveTo(x, -1.1); g.lineTo(x, 1.1); g.stroke();
      // where the warp passes over, redraw it on top
      const iv = Math.floor(-x / STR_GAP - 0.5 + 1e-3);
      for (let n = -nMax; n <= nMax; n++) {
        if (((n + iv) & 1) !== 0) continue;
        const y = stringY(x, T, n, xl, xr) * (n === 0 ? 1 : k);
        g.clearRect(x - 0.012, y - 0.03, 0.024, 0.06);
        g.strokeStyle = rgba(stringColor(n), a);
        g.lineWidth = (n === 0 ? 0.75 : 0.55) * P;
        g.beginPath(); g.moveTo(x - STR_GAP * 0.45, y); g.lineTo(x + STR_GAP * 0.45, y); g.stroke();
      }
    }
  }
}
function sceneThread(T, F, alpha) {
  alpha = alpha === undefined ? 1 : alpha;
  const [xl, xr] = stringEnds(T);
  drawStrings(T, alpha);
  F.contrast = 1.5;
  F.flat = 0.05;
  // anchor beads at both ends
  const b0 = 0.8 + 0.2 * Math.sin(T * 3);
  plot(xl, stringY(xl, T, 0, xl, xr), '◉', mulc(C.pearl, b0 * alpha));
  plot(xr, stringY(xr, T, 0, xl, xr), '◉', mulc(C.pearl, b0 * alpha));
  // heartbeat
  const hb = S ? pulseOf(S.heart.map((e) => e[0]), T, 0.14) : 0;
  // beads, one per plucked note, each with a ripple and a burst of sparks
  const P = px();
  for (const Pk of introPlucks) {
    const dt = T - Pk.t;
    if (dt < 0) continue;
    const x = lerp(xl, xr, Pk.s);
    const y = stringY(x, T, 0, xl, xr);
    const pop = Math.exp(-dt / 0.35);
    const bright = Math.min(1, 0.75 + 0.25 * pop + 0.35 * hb);
    plot(x, y, dt < 0.12 ? '✦' : pop > 0.5 ? '◉' : '●', mulc(mixc([255, 250, 240], C.gold, pop), bright * alpha));
    if (dt < 1.4 && alpha > 0.5) {
      const q = dt / 1.4;
      const g = E.beginLayer();
      g.strokeStyle = rgba(mixc(C.gold, C.rose, q), (1 - q) * 0.9 * alpha);
      g.lineWidth = 0.55 * P;
      g.beginPath(); g.ellipse(x, y, 0.06 + easeOut(q) * 0.5, 0.03 + easeOut(q) * 0.26, 0, 0, TAU); g.stroke();
    }
    if (dt < 0.7) {
      for (let sp = 0; sp < 8; sp++) {
        const a = (sp / 8) * TAU + Pk.j;
        const r = 0.2 * easeOut(dt / 0.7) * (0.6 + 0.6 * hash(sp + Pk.j * 9));
        plot(x + Math.cos(a) * r * 1.5, y + Math.sin(a) * r, dt < 0.3 ? '*' : '·', mulc(C.gold, (1 - dt / 0.7) * alpha));
      }
    }
  }
  stars(T, 150, sat((T - TB(3)) / 1.6) * alpha, -1, 11, 110);
}

/* ═════════════════════ 0:15 — weave → tunnel ═════════════════════ */
const SPEED = [[TB(8), 0.03], [TB(10), 0.06], [TB(12), 0.35], [TB(14), 1.6], [TB(15, 12), 7.2], [TB(16), 8.0], [TB(24), 8.0]];
function weaveParams(T) {
  const b = T / BAR;
  const look = b < 10 ? lerp(1, 0.86, smooth(8.5, 10, b)) : b < 12 ? lerp(0.86, 0.5, smooth(10, 12, b)) : lerp(0.5, 0, smooth(12, 14, b));
  const roll = lerp(Math.PI / 2, 0, smooth(9, 14, b));
  const m = b < 10 ? 0 : b < 12 ? 0.35 * smooth(10, 12, b) : lerp(0.35, 1, smooth(12, 14, b));
  let pn = 2;
  if (b >= 20) pn = 2 + 6 * smooth(20, 20.4, b) * (1 - smooth(21.8, 22.2, b));
  const travel = integ(SPEED, T);
  const ripple = smooth(8, 9, b) * (1 - smooth(11.5, 13, b));
  let twist = 0.12 * smooth(14, 16, b);
  if (b >= 22) twist += 0.22 * smooth(22, 23.5, b);
  const rings = b < 12 ? 0 : b < 16 ? 0.2 + 0.4 * smooth(12, 16, b) : 1;
  const drop = b >= 16;
  const e = ENV || NOENV;
  const pulse = drop ? e.kick : b >= 12 ? e.kick * 0.5 : 0;
  const hue = (b < 20 ? 0 : 0.28 * smooth(20, 21, b)) + (drop ? 0.04 * Math.sin(T * 0.7) : 0);
  const fade = b >= 15.75 && b < 16 ? smooth(15.75, 15.8, b) : 0;
  const sp = lerp(0.14, 0.27, smooth(12, 15, b));
  const satu = drop ? 1.25 : 1;
  const bright = (b < 8.5 ? smooth(8, 8.5, b) : 1) * 0.86;
  const redB = drop ? 0.15 + 0.7 * e.lead : 0.1 * e.pluck;
  return [[roll, look, m, pn], [travel, fade, pulse, hue], [twist, ripple, sp, redB], [rings, satu, bright, 0]];
}
function tunnelBeads(T, fade) {
  if (fade <= 0.01) return;
  const t0 = TB(16);
  const kNow = Math.floor((T - t0) / (STEP / 2));
  const tr = integ(SPEED, T);
  for (let kk = Math.max(0, kNow - 90); kk <= kNow; kk++) {
    const ts = t0 + kk * STEP / 2;
    const z = 22 - (tr - integ(SPEED, ts));
    if (z < 0.35 || z > 22) continue;
    const th = hash(kk * 1.37) * TAU;
    const rr = 0.55 + 0.4 * hash(kk * 2.11);
    const f = 1.7 / z;
    const x = Math.cos(th) * rr * f, y = Math.sin(th) * rr * f;
    if (Math.abs(x) > E.A || Math.abs(y) > 1) continue;
    const near = sat(1.2 / z);
    const ch = near > 0.6 ? '●' : near > 0.3 ? 'o' : near > 0.12 ? '•' : '·';
    const hue = hash(kk * 3.3);
    const c = hue < 0.5 ? mixc(C.pearl, C.gold, hue * 2) : mixc(C.teal, C.rose, hue * 2 - 1);
    plot(x, y, ch, mulc(c, (0.35 + 0.65 * near) * fade));
  }
}
function sceneWeave(T, F) {
  const b = T / BAR;
  const e = ENV || NOENV;
  F.A = 'weave';
  F.pA = weaveParams(T);
  F.contrast = 1.45;
  F.flat = 1;
  F.ramp = RAMP_SOFT;
  // hand-over from the canvas strings
  if (T < TB(8) + 0.7) {
    const q = smooth(TB(8) - 0.05, TB(8) + 0.65, T);
    sceneThread(T, F, 1 - q);
  }
  // build: flashes on claps / snare roll
  if (b >= 12 && b < 16) {
    F.chroma = 1.5 * pulseOf(S ? S.clap : null, T, 0.1);
    if (b >= 14 && b < 15.75) F.flash = 0.12 * smooth(14, 15.75, b) * pulseOf(S ? S.snare.map((x) => x[0]) : null, T, 0.05);
  }
  // the drop
  if (b >= 16 && b < 24.3) {
    const dt = T - TB(16);
    F.flash = 0.55 * Math.exp(-dt / 0.28) + 0.25 * pulseOf(S ? S.crash : null, T, 0.25) * (b > 17 ? 1 : 0);
    F.chroma = 2.2 * pulseOf(S ? S.clap : null, T, 0.09) + 3 * Math.exp(-dt / 0.3);
    F.shake = dt < 0.6 ? [(hash(Math.floor(T * 40)) - 0.5) * 1.6 * Math.exp(-dt / 0.2), (hash(Math.floor(T * 40) + 3) - 0.5) * 0.8 * Math.exp(-dt / 0.2)] : null;
    if (b >= 23.5) {
      F.glitch = 0.25 * pulseOf(S ? S.snare.map((x) => x[0]) : null, T, 0.07);
      F.glitchSeed = Math.floor(T * 30);
    }
    tunnelBeads(T, sat((24.2 - b) * 3));
  }
  // exit the tunnel: the knot appears in the light at its end
  if (T > TB(23, 12)) {
    F.B = 'knot';
    knotParams(T, F, 'B');
    F.mixMode = 2;
    F.mix = easeIn((T - TB(23, 12)) / (TB(24) + 0.35 - TB(23, 12))) * 2.4;
    F.modeB = E.MODE.SHAPE;
  }
}

/* ═════════════════════ 0:45 — the knot ═════════════════════ */
const KNOT_SPIN = [[TB(23), 0.35], [TB(28), 0.42], [TB(31), 1.3], [TB(31, 12), 3.4], [TB(32), 5.0]];
function knotPos(phi, R, r) {
  const a = 2 * phi, b = 3 * phi;
  return [(R + r * Math.cos(b)) * Math.cos(a), r * Math.sin(b), (R + r * Math.cos(b)) * Math.sin(a)];
}
const knotQ = new Float32Array(64);
function knotParams(T, F, which, style) {
  const b = T / BAR;
  const e = ENV || NOENV;
  const x = smooth(28, 31.75, b);
  const rx = 0.55 + 0.25 * Math.sin(T * 0.31);
  const ry = integ(KNOT_SPIN, T);
  const rz = 0.25 * Math.sin(T * 0.23 + 1);
  let scale = 0.92 * (1 + 0.05 * e.kick * x);
  const col = sat((T - (TB(32) - 0.62)) / 0.58);
  scale *= 1 - 0.97 * easeIn(col);
  const heat = 0.8 * x + 0.2 * col;
  const zoom = lerp(1.7, 1.0, easeOut((T - TB(23, 12)) / 2.2));
  const R = 1.0, r = 0.42;
  const phase = T * 0.23;
  for (let i = 0; i < 8; i++) {
    const p = knotPos(phase + (i * TAU) / 8 + 0.2 * Math.sin(T * 0.5 + i), R, r);
    let glow = 0;
    for (let j = i; j < bellsBD.length; j += 8) {
      const dt = T - bellsBD[j][0];
      if (dt >= 0 && dt < 3) glow = Math.max(glow, Math.exp(-dt / 0.5));
    }
    knotQ[i * 4] = p[0]; knotQ[i * 4 + 1] = p[1]; knotQ[i * 4 + 2] = p[2]; knotQ[i * 4 + 3] = glow;
  }
  const P = [[rx, ry, rz, scale], [heat, e.kick * x, R, r], [0.16, zoom, 0.21, 0.55 + 0.12 * Math.sin(T * 0.2)], [0, 0, 0, 0]];
  if (style === 'montage') { P[0][1] = T * 2.5; P[0][3] = 0.8 * (1 + 0.1 * e.kick); P[1][0] = 0.3 + 0.4 * e.kick; P[2][1] = 1; }
  if (which === 'B') { F.pB = P; F.qB = knotQ; } else { F.pA = P; F.qA = knotQ; }
}
function sceneKnot(T, F) {
  const b = T / BAR;
  F.A = 'knot';
  knotParams(T, F, 'A');
  F.contrast = 1.7;
  F.flash = 0.3 * pulseOf(S ? S.crash : null, T, 0.3) * (b < 24.5 ? 1 : 0);
  stars(T, 170, sat((T - 44.8) / 1.5), -1, 23, 120, T * 0.02);
  if (b >= 31) {
    F.chroma = 1.6 * pulseOf(S ? S.snare.map((x) => x[0]) : null, T, 0.06) * smooth(31, 31.75, b);
  }
  if (T > TB(32) - 0.1) F.flash = sat((T - (TB(32) - 0.1)) / 0.1) * 0.6;
}

/* ═════════════════════ 1:00 — bloom ═════════════════════ */
function galaxy(T, t0, fade, prio) {
  if (fade <= 0.01) return;
  const tau = T - t0;
  const e = ENV || NOENV;
  const n = Math.min(2800, Math.floor(E.cols * E.rows / 3.5));
  const k = E.fit;
  const spin = 0.25 * Math.sin(T * 0.13);
  const cs = Math.cos(spin), sn = Math.sin(spin);
  for (let i = 0; i < n; i++) {
    const h1 = hash(i * 1.13), h2 = hash(i * 2.71 + 1), h3 = hash(i * 3.97 + 2), h4 = hash(i * 5.31 + 3), h5 = hash(i * 7.07 + 4);
    let rOrb, th0, kind;
    if (h5 < 0.22) { kind = 0; rOrb = 0.03 + 0.2 * Math.pow(h1, 1.6); th0 = h2 * TAU; }
    else if (h5 < 0.85) {
      kind = 1; rOrb = 0.1 + 0.95 * Math.pow(h1, 0.85);
      const spread = (h2 + h3 - 1) * 0.55;
      th0 = (i & 1) * Math.PI + 2.4 * Math.log(rOrb / 0.1) + spread;
    } else { kind = 2; rOrb = 0.15 + 1.0 * h1; th0 = h2 * TAU; }
    const burst = rOrb * (1 + 1.6 * Math.exp(-tau / 0.45)) * (1 - Math.exp(-tau / 0.06));
    const omega = 0.9 / (rOrb + 0.25);
    const th = th0 + omega * tau + (h3 - 0.5) * 3.5 * Math.exp(-tau / 0.35);
    const r = burst * (1 + 0.1 * e.kick) * k;
    const x = Math.cos(th) * r * 1.4, y = Math.sin(th) * r * 0.6;
    const xr = x * cs - y * sn, yr = x * sn + y * cs;
    const tw = 0.7 + 0.3 * Math.sin(T * (2 + h4 * 5) + i);
    let ch, c, bright;
    if (kind === 0) { ch = h4 > 0.6 ? '●' : h4 > 0.3 ? '@' : 'O'; c = mixc(C.pearl, C.gold, h2); bright = 1; }
    else if (kind === 1) {
      const rr = sat((rOrb - 0.1) / 0.9);
      ch = rr < 0.3 ? (h4 > 0.5 ? 'o' : '*') : h4 > 0.66 ? '•' : h4 > 0.33 ? '+' : '·';
      c = mixc(mixc(C.rose, C.violet, h3), C.teal, rr); bright = 0.95 - 0.35 * rr;
    } else { ch = h4 > 0.5 ? '·' : '.'; c = mixc(C.violet, C.star, h3); bright = 0.55; }
    plot(xr, yr, ch, mulc(c, Math.min(1.1, bright * tw * fade * (tau < 0.35 ? 1.3 : 1))), prio);
  }
}
function nebulaParams(T, t0, fade) {
  const tau = T - t0;
  const burst = (1 + 1.6 * Math.exp(-tau / 0.45)) * (1 - Math.exp(-tau / 0.06));
  return [[tau, 0.25 * Math.sin(T * 0.13), fade, (ENV || NOENV).kick], [0.6, 1.4, burst, 0]];
}
function mandalaParams(T, t0, style) {
  const e = ENV || NOENV;
  const grow = style === 'montage' ? 1 : easeOut((T - t0) / BAR) * 1.0;
  return [[grow * 0.95, T * 0.35, e.kick, 0.02 * T + (style === 'montage' ? 0.3 : 0)], [1, 0, 0, 0]];
}
function metaParams(T, merge) {
  const e = ENV || NOENV;
  // the two blobs settle where the two figures of the last scene will sit
  const H = HOME;
  return [[T * 0.9, merge, e.kick, T * 0.03], [H.girl * H.S, H.ridge + 0.42 * H.S, H.cat * H.S, H.ridge + 0.17 * H.S], [1, 0, 0, 0]];
}
function tunnelMontage(T) {
  const P = weaveParams(TB(20, 8));
  P[1][0] = integ(SPEED, TB(24)) + (T - TB(38)) * 9;
  P[1][2] = (ENV || NOENV).kick;
  P[1][3] = 0.5 + 0.05 * Math.sin(T);
  P[2][0] = 0.3;
  P[0][3] = 2;
  return P;
}
function sceneBloom(T, F) {
  const b = T / BAR;
  const t0 = TB(32);
  const tau = T - t0;
  const e = ENV || NOENV;
  F.contrast = 1.6;
  F.flash = 0.7 * Math.exp(-tau / 0.3) + 0.25 * pulseOf(S ? S.crash : null, T, 0.25) * (b > 33 ? 1 : 0);
  F.chroma = 2.4 * pulseOf(S ? S.clap : null, T, 0.09) + 3.5 * Math.exp(-tau / 0.35);
  if (tau < 0.7) F.shake = [(hash(Math.floor(T * 40)) - 0.5) * 2 * Math.exp(-tau / 0.25), (hash(Math.floor(T * 40) + 5) - 0.5) * Math.exp(-tau / 0.25)];
  // shockwave ring
  if (tau < 1.2) {
    const q = tau / 1.2;
    const g = E.beginLayer();
    g.strokeStyle = rgba(mixc(C.pearl, C.rose, q), 1 - q);
    g.lineWidth = (6 * (1 - q) + 1.5) * px();
    g.beginPath(); g.ellipse(0, 0, easeOut(q) * 2.4, easeOut(q) * 1.4, 0, 0, TAU); g.stroke();
  }
  if (b < 34) {
    F.A = 'nebula';
    F.pA = nebulaParams(T, t0, sat(tau / 0.4) * (1 - smooth(33.6, 34.1, b) * 0.6));
    galaxy(T, t0, 1, 255);
  } else if (b < 36) {
    F.A = 'mandala';
    F.pA = mandalaParams(T, TB(34));
    galaxy(T, t0, 0.55 * (1 - smooth(35.5, 36, b)), 100);
  } else if (b < 38) {
    F.A = 'meta';
    F.pA = metaParams(T, 0.35 * smooth(36.5, 38, b));
    if (b < 36.25) {
      F.B = 'mandala'; F.pB = mandalaParams(T, TB(34)); F.mixMode = 1; F.mix = 1 - (b - 36) / 0.25;
    }
  } else {
    // montage: a cut on every beat, then every half beat
    const beatIdx = Math.floor((T - TB(38)) / BEAT);
    const half = T >= TB(39, 8);
    const idx = half ? Math.floor((T - TB(39, 8)) / (BEAT / 2)) + 100 : beatIdx;
    const cutT = half ? TB(39, 8) + (idx - 100) * BEAT / 2 : TB(38) + beatIdx * BEAT;
    const list = ['weave', 'knot', 'mandala', 'meta'];
    let which = list[idx % 4];
    if (T > TB(39, 14)) which = 'meta';
    F.A = which;
    if (which === 'weave') F.pA = tunnelMontage(T);
    else if (which === 'knot') knotParams(T, F, 'A', 'montage');
    else if (which === 'mandala') F.pA = mandalaParams(T, 0, 'montage');
    else F.pA = metaParams(T, T > TB(39, 12) ? smooth(TB(39, 12), TB(40) - 0.1, T) : 0.2);
    const dc = T - cutT;
    F.glitch = 0.3 * Math.exp(-dc / 0.07);
    F.glitchSeed = idx * 13.1;
    F.chroma = Math.max(F.chroma, 3 * Math.exp(-dc / 0.1));
    F.scramble = half ? 0.35 * smooth(TB(39, 8), TB(39, 14), T) * (1 - smooth(TB(39, 14), TB(40) - 0.05, T)) : 0;
  }
}

/* ═════════════════════ 1:15 — home ═════════════════════ */
function heartPt(th, hx, hb, s) {
  const sn = Math.sin(th);
  return [hx + 16 * sn * sn * sn * s, hb + (13 * Math.cos(th) - 5 * Math.cos(2 * th) - 2 * Math.cos(3 * th) - Math.cos(4 * th) + 17) * s];
}
const HOME = { ridge: -0.56, S: 1.22, girl: -0.54, cat: 0.17, hx: -0.19, hb: 0.03, hs: 0.0118 };
function homeGeom() {
  const k = E.fit, H = HOME;
  const toScreen = (x, y) => [x * H.S * k, (H.ridge + y * H.S) * k];
  return { k, toScreen, notch: toScreen(H.hx, H.hb + 22 * H.hs), moon: [0.95 * k, 0.55 * k] };
}
function drawHome(g, T) {
  const { k, notch, moon } = homeGeom();
  const H = HOME;
  const A = E.A / k;
  const P = px() / k;
  g.save();
  g.scale(k, k);
  // the roof
  g.fillStyle = 'rgba(40,44,82,0.1)';
  g.fillRect(-A - 0.2, -1.3, 2 * A + 0.4, H.ridge + 1.3);
  g.strokeStyle = 'rgba(96,104,168,0.42)';
  g.lineWidth = 0.5 * P;
  for (let i = 1, y = H.ridge - 0.1; y > -1.3; y -= 0.1, i++) {
    g.beginPath(); g.moveTo(-A - 0.2, y); g.lineTo(A + 0.2, y); g.stroke();
    for (let x = -A - 0.2 + (i & 1) * 0.09; x < A + 0.2; x += 0.18) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 0.1); g.stroke(); }
  }
  g.strokeStyle = 'rgba(170,180,240,1)'; g.lineWidth = 0.9 * P;
  g.beginPath(); g.moveTo(-A - 0.2, H.ridge); g.lineTo(A + 0.2, H.ridge); g.stroke();

  // the two of them, anchored on the ridge
  g.translate(0, H.ridge);
  g.scale(H.S, H.S);
  const Q = P / H.S;
  const FILL = 'rgba(78,78,142,0.55)', HAIR = 'rgba(102,76,152,0.62)', RIM = 'rgba(182,182,246,1)';
  g.lineJoin = 'round';
  // ── her ──
  const cx = H.girl;
  g.fillStyle = FILL; g.strokeStyle = RIM; g.lineWidth = 0.7 * Q;
  g.beginPath();
  g.moveTo(cx - 0.22, 0);
  g.bezierCurveTo(cx - 0.25, 0.12, cx - 0.14, 0.2, cx - 0.145, 0.3);
  g.bezierCurveTo(cx - 0.15, 0.4, cx - 0.19, 0.45, cx - 0.18, 0.51);
  g.bezierCurveTo(cx - 0.17, 0.57, cx - 0.1, 0.585, cx - 0.045, 0.6);
  g.lineTo(cx - 0.04, 0.66); g.lineTo(cx + 0.04, 0.66); g.lineTo(cx + 0.045, 0.6);
  g.bezierCurveTo(cx + 0.1, 0.585, cx + 0.17, 0.57, cx + 0.18, 0.51);
  g.bezierCurveTo(cx + 0.19, 0.45, cx + 0.15, 0.4, cx + 0.145, 0.3);
  g.bezierCurveTo(cx + 0.14, 0.2, cx + 0.25, 0.12, cx + 0.22, 0);
  g.closePath(); g.fill(); g.stroke();
  g.lineCap = 'round';
  for (const sx of [-1, 1]) {
    g.strokeStyle = FILL; g.lineWidth = 0.05;
    g.beginPath(); g.moveTo(cx + sx * 0.17, 0.52); g.quadraticCurveTo(cx + sx * 0.25, 0.3, cx + sx * 0.25, 0.03); g.stroke();
    g.strokeStyle = RIM; g.lineWidth = 0.7 * Q;
    g.beginPath(); g.moveTo(cx + sx * 0.205, 0.5); g.quadraticCurveTo(cx + sx * 0.28, 0.3, cx + sx * 0.277, 0.03); g.stroke();
  }
  const hcx = cx + 0.01, hcy = 0.765, hr = 0.12;
  const sway = Math.sin(T * 1.1) * 0.012;
  g.fillStyle = HAIR; g.strokeStyle = RIM; g.lineWidth = 0.7 * Q;
  g.beginPath();
  g.moveTo(hcx - hr * 0.95, hcy);
  g.bezierCurveTo(hcx - hr * 1.3, hcy - 0.1, hcx - 0.16, 0.52, hcx - 0.15 + sway, 0.36);
  for (let i = 1; i <= 6; i++) {
    const x = lerp(hcx - 0.15, hcx + 0.15, i / 6) + sway * (1 + 0.5 * Math.sin(i * 1.7 + T * 1.6));
    g.lineTo(x, 0.36 + (i & 1 ? 0.035 : 0) + 0.01 * Math.sin(T * 1.9 + i));
  }
  g.bezierCurveTo(hcx + 0.16, 0.52, hcx + hr * 1.3, hcy - 0.1, hcx + hr * 0.95, hcy);
  g.closePath(); g.fill(); g.stroke();
  g.beginPath(); g.arc(hcx, hcy, hr, 0, TAU); g.fill(); g.stroke();
  const twitchG = 0.006 * Math.max(0, Math.sin(T * 0.9) - 0.9) * 10;
  for (const sx of [-1, 1]) {
    const a0 = Math.PI / 2 + sx * 0.22, a1 = Math.PI / 2 + sx * 1.02, am = Math.PI / 2 + sx * 0.58;
    g.beginPath();
    g.moveTo(hcx + Math.cos(a0) * hr * 0.92, hcy + Math.sin(a0) * hr * 0.92);
    g.lineTo(hcx + Math.cos(am) * hr * 2.1, hcy + Math.sin(am) * hr * 2.1 + (sx > 0 ? twitchG : 0));
    g.lineTo(hcx + Math.cos(a1) * hr * 0.92, hcy + Math.sin(a1) * hr * 0.92);
    g.closePath(); g.fill(); g.stroke();
  }
  g.fillStyle = rgba(C.red, 1);
  const rbx = hcx + 0.03, rby = hcy - 0.055;
  g.beginPath(); g.ellipse(rbx - 0.026, rby, 0.026, 0.014, -0.45, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(rbx + 0.026, rby, 0.026, 0.014, 0.45, 0, TAU); g.fill();

  // ── the little one ──
  const kx = H.cat;
  g.fillStyle = FILL; g.strokeStyle = RIM; g.lineWidth = 0.7 * Q;
  g.beginPath();
  g.moveTo(kx - 0.135, 0);
  g.bezierCurveTo(kx - 0.16, 0.1, kx - 0.1, 0.2, kx - 0.06, 0.26);
  g.lineTo(kx + 0.06, 0.26);
  g.bezierCurveTo(kx + 0.1, 0.2, kx + 0.16, 0.1, kx + 0.135, 0);
  g.closePath(); g.fill(); g.stroke();
  const ky = 0.31;
  const twitch = pulseOf(S ? S.pluck.map((x) => x[0]) : null, T, 0.12) * 0.014;
  for (const sx of [-1, 1]) {
    g.beginPath();
    g.moveTo(kx + sx * 0.02, ky + 0.06);
    g.lineTo(kx + sx * 0.075, ky + 0.125 + (sx > 0 ? twitch : 0));
    g.lineTo(kx + sx * 0.085, ky + 0.02);
    g.closePath(); g.fill(); g.stroke();
  }
  g.beginPath(); g.ellipse(kx, ky, 0.085, 0.07, 0, 0, TAU); g.fill(); g.stroke();

  // ── their tails make a heart ──
  const hx = H.hx, hb = H.hb, hs = H.hs;
  const TAIL = 'rgba(242,172,224,1)';
  const wob = 0.004 * Math.sin(T * 1.4);
  const half = (from, to, sx0, sy0, width) => {
    g.strokeStyle = TAIL; g.lineWidth = width;
    g.beginPath();
    g.moveTo(sx0, sy0);
    const [bx, by] = heartPt(Math.PI, hx, hb, hs);
    g.quadraticCurveTo(lerp(sx0, bx, 0.5), by - 0.03, bx, by);
    for (let i = 1; i <= 40; i++) {
      const [x, y] = heartPt(lerp(from, to, i / 40), hx, hb, hs);
      g.lineTo(x + wob * Math.sin(i * 0.3), y);
    }
    g.stroke();
  };
  half(Math.PI, TAU, cx + 0.03, 0.08, 0.026);
  half(Math.PI, 0, kx - 0.01, 0.05, 0.021);
  // ── tied together with the red thread ──
  const [nx, ny] = heartPt(0, hx, hb, hs);
  g.strokeStyle = rgba(C.red, 1); g.fillStyle = rgba(C.red, 1);
  g.lineWidth = 0.9 * Q;
  g.beginPath(); g.moveTo(nx - 0.045, ny + 0.035); g.quadraticCurveTo(nx, ny - 0.01, nx + 0.045, ny + 0.035); g.stroke();
  g.beginPath(); g.arc(nx, ny + 0.012, 0.016, 0, TAU); g.fill();
  g.restore();

  // the loose end drifts up toward the moon, fading
  const segs = 80;
  let prev = null;
  g.lineWidth = 0.7 * px();
  for (let i = 0; i <= segs; i++) {
    const q = i / segs;
    const x = lerp(notch[0] + 0.012 * k, moon[0] - 0.3 * k, q);
    const y = lerp(notch[1] + 0.025 * k, moon[1] - 0.05 * k, q) + Math.sin(q * Math.PI) * 0.14 * k + 0.03 * k * Math.sin(q * 10 - T * 2.2) * q;
    if (prev) {
      g.strokeStyle = rgba(C.red, Math.pow(1 - q, 1.3));
      g.beginPath(); g.moveTo(prev[0], prev[1]); g.lineTo(x, y); g.stroke();
    }
    prev = [x, y];
  }
}
function sceneHome(T, F) {
  const b = T / BAR;
  const { k, notch, moon } = homeGeom();
  F.A = 'sky';
  F.pA = [[moon[0] / k, moon[1] / k, 0.2, 0.9], [0.55, 0, 0, 1]];
  F.flat = 0.07;
  F.contrast = 1.5;
  drawHome(E.beginLayer(), T);
  const tIn = T - TB(40);
  F.flash = 0.6 * Math.exp(-tIn / 0.35);
  F.reveal = tIn / 1.3;
  F.revealDir = [0, 1];
  F.revealSoft = 0.25;
  // the ending: the world dissolves from the edges in, toward the knot in the thread
  const dis = smooth(TB(46), TB(47) + 0.15, T);
  F.dissolve = dis;
  F.dissolveC = [(notch[0] / E.A + 1) / 2, (notch[1] + 1) / 2, 0.85];
  const skyFade = 1 - dis;
  stars(T, 190, sat(tIn / 2) * skyFade, -0.25, 41, 110);
  // fireflies
  for (let i = 0; i < 9; i++) {
    const x = (hash(i * 9.1 + 4) * 2 - 1) * E.A * 0.95;
    const y = (HOME.ridge - 0.02) * k + (((T * 0.045 + hash(i * 2.3)) % 1) * 0.9);
    const tw = 0.5 + 0.5 * Math.sin(T * (2 + hash(i) * 2) + i);
    plot(x + 0.03 * Math.sin(T + i), y, tw > 0.6 ? '•' : '·', mulc(C.gold, (0.35 + 0.65 * tw) * skyFade * sat(tIn / 3)), 200);
  }
  // shooting star
  const ts = T - TB(43, 8);
  if (ts > 0 && ts < 1.1) {
    const q = ts / 0.8;
    for (let j = 0; j < 12; j++) {
      const qq = q - j * 0.035;
      if (qq < 0 || qq > 1) continue;
      const x = lerp(1.3, -0.25, qq) * k, y = lerp(0.98, 0.58, qq) * k;
      const ch = j === 0 ? '✦' : j < 3 ? '*' : j < 6 ? '+' : j < 9 ? '·' : '.';
      plot(x, y, ch, mulc(C.pearl, (1 - j / 12) * (1 - sat((ts - 0.8) / 0.3))), 255);
    }
  }
  // the last bead
  if (T > TB(46)) {
    const hb = S ? pulseOf(S.heart.map((x) => x[0]), T, 0.18) : 0;
    const out = 1 - smooth(TB(47, 10), DURATION - 0.15, T);
    const c = mixc(C.red, C.gold, 0.25 + 0.5 * hb);
    const bx = notch[0], by = notch[1] + 0.012 * k;
    plot(bx, by, '●', mulc(c, (0.75 + 0.35 * hb) * out * sat((T - TB(46)) / 1.2)), 255);
    // once it is alone, it breathes with the heartbeat
    const halo = (0.3 + 0.7 * hb) * out * smooth(TB(46, 14), TB(47, 2), T);
    if (halo > 0.03) {
      const cc = E.colOf(bx), rr = E.rowOf(by);
      const hc = mulc(mixc(C.red, C.rose, 0.5), halo * 0.8);
      for (const [dc, dr, ch] of [[-1, 0, '·'], [1, 0, '·'], [0, -1, '.'], [0, 1, '˙'], [-2, 0, '.'], [2, 0, '.']]) {
        E.put(cc + dc, rr + dr, G[ch], hc[0] * (Math.abs(dc) > 1 ? 0.6 : 1), hc[1] * (Math.abs(dc) > 1 ? 0.6 : 1), hc[2] * (Math.abs(dc) > 1 ? 0.6 : 1), 255);
      }
    }
  }
}
const DURATION = 90;

/* ═════════════════════ timeline ═════════════════════ */
function frame(T, F) {
  resetF(F);
  E.clearOverlay();
  E.resetLayer();
  if (T < TB(3)) sceneTitle(T, F);
  else if (T < TB(8)) sceneThread(T, F);
  else if (T < TB(24) + 0.4) sceneWeave(T, F);
  else if (T < TB(32)) sceneKnot(T, F);
  else if (T < TB(40)) sceneBloom(T, F);
  else if (T < DURATION) sceneHome(T, F);
  else F.gain = 0;
}

function setTitleFont(family, isCJK) { TITLE_FONT = family; titleIsCJK = isCJK; titleCache = null; }
function setEnv(e) { ENV = e; }

return { compileAll, frame, idle, setMusic, setEnv, setTitleFont, TITLE, TB, BEAT, BAR };
})();
