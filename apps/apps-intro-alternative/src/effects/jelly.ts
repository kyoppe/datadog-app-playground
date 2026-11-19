// Jelly: the live page set in a slab of jelly in the page's own violet on a glass plate. A port of the "Jelly Wobble"
// demo: a height-field mesh shaded in one pass (refraction, absorption, scattering, fruit, candy
// letters taken from the page), a spring-and-wave wobble simulation, and press-and-pull.
import { createProgram, type Program } from './glUtils';
import type { Effect, EffectFrame, PointerEventKind, PointerState } from './types';

// ------------------------------------------------------------------ GLSL
const GLSL_COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;
const vec2 DOM = vec2(1.75, 1.19);   // half size of the simulated area
const vec2 GRID = vec2(72., 49.);
const float H0 = 0.56;                  // jelly height
const vec2 PH = vec2(1.24, 0.775);     // half size of the page inside the jelly
const float ZT = 0.47, ZB = 0.40;
const float BASE = 0.03;                // the mould is trimmed this far up, for a clean foot
const vec2 PC = vec2(0.04, -0.03);      // platter centre
const vec2 PS = vec2(2.02, 1.52);       // platter half size
const float PR = 0.95;
uniform sampler2D uH;      // height, d/dx, d/dy, signed distance to the footprint
uniform sampler2D uU;      // wobble field
uniform sampler2D uPage;   // the page as candy ink: premultiplied colour, alpha = ink
uniform vec3 uEye, uRt, uUp, uFw;
uniform vec2 uTan;
uniform float uM;          // 0 = melted flat page, 1 = set jelly
uniform float uScene;      // how much of the kitchen scene shows
uniform float uLift;
uniform vec3 uSig;         // absorption per unit length
uniform vec3 uScat;
uniform vec3 uGlow;
uniform vec3 uTable;
uniform vec3 uRing;
uniform vec3 uPaper;       // sRGB
uniform vec3 uL;
uniform vec2 uPageTex;     // page texture size
uniform vec2 uFit;         // how much bigger than the slab the page is (keeps the page's aspect)
const int NF = 16;
uniform vec4 uFruit[NF];   // fruit set in the jelly: x, y, height of centre, radius
uniform vec3 uFruitA, uFruitB;
uniform float uFr;         // fruit size, 0 when melted
uniform vec2 uLag;         // how far the fruit trails the jelly around it
uniform float uSq;         // squash of the whole slab, for the belly it pushes out
`;

const GLSL_SHADE = `
vec2 huv(vec2 p){ return (p + DOM) / (2. * DOM); }
vec4 hgt(vec2 p){ return texture(uH, huv(p)); }
vec2 pageUV(vec2 q){ return vec2(q.x / PH.x * .5, -q.y / PH.y * .5) * uFit + .5; }
vec4 pageTex(vec2 q, float lod){
  vec2 uv = pageUV(q);
  vec4 c = textureLod(uPage, uv, lod);
  vec2 e = smoothstep(vec2(0.), vec2(.004), uv) * smoothstep(vec2(0.), vec2(.004), 1. - uv);
  return c * e.x * e.y;
}
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
float boxMask(vec2 p, vec2 b, float soft){ vec2 d = smoothstep(b + soft, b - soft, abs(p)); return d.x * d.y; }

// A made-up kitchen, seen only in reflections: a six-pane window, a ceiling light, a lamp, a pale wall behind the camera.
vec3 env(vec3 r, float crisp){
  vec3 c = mix(vec3(.62, .61, .58), vec3(.26, .28, .32), smoothstep(-.25, .12, r.z));
  c = mix(c, vec3(.58, .62, .68), smoothstep(.1, 1., r.z));
  if (r.z > .03) {
    vec2 p = r.xy / r.z * 6.;
    c += vec3(5.5, 5.3, 5.0) * boxMask(p - vec2(-1.2, 10.6), vec2(4.6, 2.3), .9);
    vec2 w = p - vec2(-1.22, 6.72);
    w = vec2(w.x * .993 + w.y * .12, -w.x * .12 + w.y * .993);
    vec2 a = (w + vec2(.42, .24)) / vec2(.84, .48);
    if (crisp > 0. && a.x > 0. && a.x < 1. && a.y > 0. && a.y < 1.) {
      vec2 g = abs(fract(a * vec2(3., 1.)) - .5) * 2.;   // three tall panes
      c += vec3(8.0, 7.8, 7.4) * (.55 + .45 * a.y) * smoothstep(.95, .78, g.x) * smoothstep(.98, .80, g.y);
    }
    c += vec3(5.0, 5.3, 5.8) * boxMask(p - vec2(5.6, 1.0), vec2(.55, 3.4), .35);
  }
  if (r.y < -.05) {
    float el = r.z / (-r.y), az = r.x / (-r.y);
    c += vec3(1.0, 1.05, 1.15) * smoothstep(.02, .3, el) * smoothstep(1.2, .5, el) * smoothstep(2.4, 1.2, abs(az));
  }
  return c;
}

// Light from the key lamp that reaches a point on the platter, coloured by any jelly in the way.
vec3 lightAt(vec2 q, out float under){
  vec2 Lh = uL.xy / uL.z;
  float zmax = uM * H0 * 1.12;
  under = 0.;
  // nothing but open air above most of the table
  vec2 far = abs(q + Lh * (zmax * .5 + uLift * .45)) - DOM - abs(Lh) * zmax * .5 - .25 * uLift;
  if (max(far.x, far.y) > 0. || uM < .002) return vec3(1.);
  vec3 U = texture(uU, huv(q + Lh * (zmax * .5 + uLift))).xyz;
  float len = 0.;
  float lifted = clamp(uLift * 2.5, 0., 1.);
  float jit = 0.;
  const int N = 8;
  for (int k = 0; k < N; k++) {
    float zl = (float(k) + .5 + jit) / float(N) * zmax;
    float s = zl / (uM * H0 + 1e-4);
    vec2 pr = q + Lh * (zl + uLift * .45) - uM * s * U.xy;
    float hb = textureLod(uH, huv(pr), 3.9 + lifted * 1.8).x * boxMask(pr, DOM - .10, .10);   // blurred heights: the lamp is not a point
    float hh = uM * (hb - BASE + s * U.z);
    len += smoothstep(-.07, .07, hh - zl);
  }
  len *= zmax / float(N) / uL.z;
  under = len;
  vec3 T = exp(-uSig * len * (1.35 - .6 * lifted)) * exp(-len * (.8 - .4 * lifted));
  T = max(T, uScat * .07);
  // light that crosses only a thin edge of jelly comes out bright and coloured: the lit rim of the shadow
  T *= 1. + 1.5 * smoothstep(0., .07, len) * exp(-len * 8.) * (1. - lifted);
  // shadows of the letters, carried down through the jelly
  vec2 pq = q + Lh * (uM * (ZT + ZB) * .5 + uLift) - uM * .66 * U.xy;
  float a = mix(pageTex(pq, 2.8).a, pageTex(pq, 4.8).a, .55);
  T *= 1. - .34 * a * smoothstep(0., .05, len);
  if (len > .001) {
    // the rounded, fluted shoulder is a lens: ridges gather the light into bright bands on the plate
    vec2 pe = q + Lh * (uM * hgt(q + Lh * zmax * .8).x + uLift) - uM * U.xy;
    float dd = .03;
    float lapH = (hgt(pe + vec2(dd, 0.)).y - hgt(pe - vec2(dd, 0.)).y + hgt(pe + vec2(0., dd)).z - hgt(pe - vec2(0., dd)).z) / (2. * dd);
    T *= mix(1., clamp(1. / max(1. + .026 * lapH, .28), .6, 1.3), uM);
    float fs = 1.;
    for (int i = 0; i < NF; i++) {
      vec4 f = uFruit[i];
      fs *= 1. - .5 * smoothstep(f.w * 1.4, f.w * .4, length(q + Lh * (uM * f.z + uLift) - f.xy - uLag * (f.z / H0))) * uFr;
    }
    T *= fs;
    // ripples on top focus and spread the light
    float d = .09;
    vec2 c = q + Lh * zmax;
    float lap = texture(uU, huv(c + vec2(d, 0.))).z + texture(uU, huv(c - vec2(d, 0.))).z
              + texture(uU, huv(c + vec2(0., d))).z + texture(uU, huv(c - vec2(0., d))).z - 4. * texture(uU, huv(c)).z;
    T *= clamp(1. - lap * 26. * uM, .45, 2.4);
  }
  return T;
}

float plateProfile(float e){
  return e < .07 ? .09 * sin(e / .07 * 1.5708) : .09 * (1. - smoothstep(.07, .52, e));
}

vec3 clothAt(vec2 q){
  float fold = sin(q.x * 1.1 + sin(q.y * .7) * 1.3) * .5 + sin(q.y * 1.7 + q.x * .6 + 1.) * .5;
  vec2 ck = q / .26 + vec2(.25, .1) + fold * .03;
  vec2 fw = max(fwidth(ck), vec2(1e-4));
  vec2 st = smoothstep(.25 - fw, .25 + fw, abs(fract(ck) - .5));
  vec3 cloth = mix(vec3(.93, .92, .89), uTable, .10 + .45 * (st.x + st.y));
  float thread = sin(q.x * 230.) * sin(q.y * 230.);
  cloth *= 1. + (.06 * thread + .03 * sin(q.x * 37. + q.y * 5.) * sin(q.y * 41.)) * (1. - smoothstep(.0, .04, fw.x));
  // the cloth was folded in a drawer: two pressed creases cross it
  vec2 cr = vec2(q.x * .97 + q.y * .24 - 2.35, -q.x * .24 + q.y * .97 + 1.62);
  float crease = cr.x * exp(-cr.x * cr.x * 90.) * 2.2 + cr.y * exp(-cr.y * cr.y * 90.) * 2.2;
  return cloth * (1. + .13 * fold + crease);
}
// Daylight from the window falls across the table in a soft-edged pool, with the shadows of two glazing bars.
float gobo(vec2 q){
  vec2 p = vec2(q.x * .94 + q.y * .34, -q.x * .34 + q.y * .94) - vec2(-.1, .12);
  float pool = boxMask(p, vec2(3.25, 1.95), .5);
  float bar = smoothstep(.17, .05, abs(p.y - 1.5)) + smoothstep(.13, .04, abs(p.x + 2.5));
  return mix(.50, 1., pool * (1. - .5 * min(bar, 1.)));
}

vec3 ground(vec2 q, vec3 V){
  vec2 Lh = uL.xy / uL.z;
  float under;
  vec3 T = lightAt(q, under);
  vec4 hq = hgt(q);
  float sdJ = hq.w, hLoc = uM * hq.x;
  float lifted = clamp(uLift * 2.5, 0., 1.);
  float ao = 1. - (.42 * exp(-max(sdJ, 0.) * 8.) + .30 * exp(-max(sdJ, 0.) * 38.) + .25 * smoothstep(.02, -.1, sdJ)) * uM * (1. - lifted);
  vec3 amb = vec3(.40, .43, .48) * ao;
  amb *= mix(vec3(1.), exp(-uSig * max(hLoc * .9 * (1. - lifted), under * 1.3)), .85);
  float gb = gobo(q);
  vec3 key = vec3(2.3, 2.16, 1.98) * T * gb;

  // the plate is clear glass: a flat well, a raised rim, a rolled lip
  float dpl = sdBox(q - PC, PS, PR), e = -dpl;
  float inside = smoothstep(.012, -.012, dpl);
  vec2 gp = normalize(vec2(sdBox(q - PC + vec2(.004, 0.), PS, PR) - sdBox(q - PC - vec2(.004, 0.), PS, PR),
                           sdBox(q - PC + vec2(0., .004), PS, PR) - sdBox(q - PC - vec2(0., .004), PS, PR)) + 1e-6);
  float dh = (plateProfile(e + .004) - plateProfile(e - .004)) / .008;
  vec3 n = normalize(vec3(dh * gp, 1.));
  float steep = clamp(abs(dh) * 4., 0., 1.);
  // the cloth, bent where the glass slopes
  vec3 cloth = clothAt(q - n.xy * .30 * inside);
  float sh = 1. - smoothstep(-.05, .13, sdBox(q + Lh * .13 - PC, PS, PR));
  float falloff = 1. - .34 * smoothstep(1.0, 4.4, length((q - vec2(-.5, .6)) * vec2(.7, 1.)));
  vec3 col = cloth * falloff * (key * uL.z * (1. - .30 * sh * (1. - inside)) + amb * (1. - .25 * exp(-max(dpl, 0.) * 10.) * (1. - inside)));
  col *= mix(vec3(1.), vec3(.80, .90, .87), inside * (.25 + .75 * steep));
  // the rim gathers light into a bright line on the cloth, on the side away from the window
  float awayP = clamp(dot(gp, -normalize(Lh)), 0., 1.);
  col += cloth * key * .25 * smoothstep(.07, 0., abs(dpl - .05)) * awayP * (1. - inside);
  // coloured light that has come through the jelly spills out around it, mostly on the side away from the window
  float sdB = textureLod(uH, huv(q), 3.6).w;
  float away = clamp(dot(normalize(q + 1e-4), -normalize(Lh)), 0., 1.);
  float spill = smoothstep(-.06, .08, sdB) * exp(-max(sdB, 0.) * 3.6) * (.20 + .80 * away) * uM * (1. - lifted);
  col += cloth * uScat * .35 * spill * gb;
  // glass shows itself by what it reflects
  vec3 r = reflect(V, n);
  float fr = .045 + .955 * pow(1. - max(dot(-V, n), 0.), 5.);
  col += (fr * env(r, 0.) * 1.9 * ao + T * gb * pow(max(dot(r, uL), 0.), 300.) * 5.) * inside;
  // the thick lip: a green-tinted edge, lit hard on the window side
  float lip = smoothstep(.0, .012, e) * smoothstep(.062, .034, e);
  float toward = clamp(dot(gp, normalize(Lh)), 0., 1.);
  col = mix(col, col * vec3(.78, .92, .87), lip * .35 * inside);
  col += vec3(.90, .97, .94) * gb * lip * inside * (.30 + 2.2 * pow(toward, 6.) + .8 * pow(1. - toward, 8.));
  return col;
}

const float FA = 1.26, FB = 0.76, FRC = 0.36, FFL = 0.075, FN = 8.;
float baseEdge(vec2 p){   // above zero inside the scalloped outline of the mould
  vec2 a = abs(p), d = a - vec2(FA, FB);
  float sd = length(max(d, 0.)) + min(max(d.x, d.y), 0.) - FRC;
  float s = (d.x > 0. && d.y > 0.) ? FA + FRC * atan(d.x, d.y) : (d.y > d.x ? min(a.x, FA) : FA + FRC * 1.5708 + (FB - min(a.y, FB)));
  return -sd - FFL * (.5 + .5 * cos(6.2832 * FN * s / (FA + FRC * 1.5708 + FB)));
}
vec3 tonemap(vec3 x){
  x *= .82;
  x = (x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14);
  return pow(clamp(x, 0., 1.), vec3(1. / 2.2));
}
`;

const VS_QUAD = `${GLSL_COMMON}
layout(location=0) in vec2 aP;
out vec2 vN;
void main(){ vN = aP; gl_Position = vec4(aP, .9999, 1.); }`;

const FS_GROUND = `${GLSL_COMMON}
in vec2 vN; out vec4 o;${GLSL_SHADE}
void main(){
  vec3 V = normalize(uFw + uRt * vN.x * uTan.x + uUp * vN.y * uTan.y);
  float t = -uEye.z / V.z;
  vec2 q = uEye.xy + V.xy * t;
  o = vec4(mix(uPaper, tonemap(ground(q, V)), uScene), 1.);
}`;

const VS_JELLY = `${GLSL_COMMON}
layout(location=0) in vec2 aXY;
out vec2 vXY; out vec3 vU, vUx, vUy, vW;
void bs(float f, out vec4 w, out vec4 d){
  float f2 = f * f, f3 = f2 * f, g = 1. - f;
  w = vec4(g * g * g, 3. * f3 - 6. * f2 + 4., -3. * f3 + 3. * f2 + 3. * f + 1., f3) / 6.;
  d = vec4(-.5 * g * g, 1.5 * f2 - 2. * f, -1.5 * f2 + f + .5, .5 * f2);
}
void main(){
  vec2 g = (aXY + DOM) / (2. * DOM) * GRID - .5;
  vec2 i = floor(g), f = g - i;
  vec4 wx, dx, wy, dy; bs(f.x, wx, dx); bs(f.y, wy, dy);
  vec3 U = vec3(0.), Ux = vec3(0.), Uy = vec3(0.);
  for (int b = 0; b < 4; b++) for (int a = 0; a < 4; a++) {
    ivec2 c = clamp(ivec2(i) + ivec2(a - 1, b - 1), ivec2(0), ivec2(GRID) - 1);
    vec3 t = texelFetch(uU, c, 0).xyz;
    U += t * wx[a] * wy[b]; Ux += t * dx[a] * wy[b]; Uy += t * wx[a] * dy[b];
  }
  vec2 sc = GRID / (2. * DOM);
  Ux *= sc.x; Uy *= sc.y;
  vec4 h = textureLod(uH, (aXY + DOM) / (2. * DOM), 0.);
  float s = h.x / H0;
  vec3 P = vec3(aXY, uLift) + uM * (vec3(0., 0., max(h.x - BASE, 0.)) + vec3(pow(s, 1.6) * U.xy, s * U.z) * smoothstep(0., BASE * 2., h.x));   // it bends: the top leans further than the waist
  P.xy += aXY * max(uSq, uSq * .25) * .6 * sin(3.14159 * min(s, 1.)) * uM;   // squashed jelly bellies out at the waist
  vXY = aXY; vU = U; vUx = Ux; vUy = Uy; vW = P;
  vec3 v = P - uEye;
  float z = dot(v, uFw);
  gl_Position = vec4(dot(v, uRt) / uTan.x, dot(v, uUp) / uTan.y, (z * 32. - 120.) / 28., z);
}`;

const FS_JELLY = `${GLSL_COMMON}
in vec2 vXY; in vec3 vU, vUx, vUy, vW; out vec4 o;${GLSL_SHADE}
// ink on the page becomes cream candy once the page is set in jelly
vec3 candy(vec4 c){
  vec3 s = c.rgb / max(c.a, 1e-3);
  float dark = 1. - max(s.r, max(s.g, s.b));
  vec3 lin = pow(s, vec3(2.2));
  return mix(lin, vec3(1., .93, .80), smoothstep(.5, .8, dark));
}
void main(){
  vec4 h4 = hgt(vXY);
  float Hf = h4.x;
  float be = baseEdge(vXY) - .016;
  float cover = clamp(be / max(fwidth(be), 1e-5) + .5, 0., 1.);
  if (cover <= 0. || Hf <= 0.) discard;
  float s = Hf / H0;
  vec2 sg = h4.yz / H0;
  float sp = pow(s, 1.6), spd = 1.6 * pow(max(s, 1e-4), .6);
  vec3 tx = vec3(1., 0., 0.) + uM * vec3(spd * sg.x * vU.xy + sp * vUx.xy, h4.y + sg.x * vU.z + s * vUx.z);
  vec3 ty = vec3(0., 1., 0.) + uM * vec3(spd * sg.y * vU.xy + sp * vUy.xy, h4.z + sg.y * vU.z + s * vUy.z);
  vec3 N = normalize(cross(tx, ty));
  vec3 V = normalize(vW - uEye);
  if (dot(N, V) > -.02) N = normalize(N - V * (dot(N, V) + .02));
  vec3 R = refract(V, N, 1. / 1.34);
  vec3 Rf = reflect(V, N);
  float F = .03 + .97 * pow(1. - max(dot(-V, N), 0.), 5.);
  float h = uM * max(Hf - BASE, .004);
  float rz = min(R.z, -.08);
  vec2 p0 = vXY;
  float zt = uM * ZT, zb = uM * ZB;

  // mip level for the page texture
  vec2 uv0 = pageUV(p0) * uPageTex;
  vec2 ddx = dFdx(uv0), ddy = dFdy(uv0);
  float lod = clamp(.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))), 0., 5.);

  // what is behind the jelly: the platter, seen through it
  float tG = (h + uLift) / (-rz);
  float Lin = h / (-rz);
  vec2 qG = p0 + R.xy * tG;
  float sdq = hgt(p0 + R.xy * Lin).w;
  float wallHit = 0.;
  if (sdq > 0.) { Lin *= clamp(-h4.w / (sdq - h4.w), 0., 1.); wallHit = smoothstep(0., .08, sdq); }
  Lin = mix(Lin, max(Lin, .22), (1. - smoothstep(.55, .98, s)) * .8);   // a ray through a wall crosses a fair bit of jelly
  vec3 trans = exp(-uSig * Lin);
  // the slab is a fat lens: what lies under it looks a little larger
  vec2 swim = vec2(sin(p0.x * 4.7 + p0.y * 2.1) + .6 * sin(p0.y * 7.3 - p0.x * 3.1), cos(p0.y * 5.3 - p0.x * 1.7) + .6 * sin(p0.x * 8.1 + p0.y * 2.9)) * .028 * uM;
  vec3 col = ground(mix(qG, qG * .86, uM * smoothstep(0., .2, -h4.w)) + swim, R) * trans;
  float lit = .45 + .55 * max(dot(N, uL), 0.);
  col += uScat * .34 * (1. - exp(-2.6 * Lin)) * lit;
  // light leaking in through thin edges
  col += uScat * .35 * exp(-s * 5.) * (1. - exp(-Lin * 3.));
  // walls: lit flanks take the lamp, flanks facing away glow with the light that has crossed the jelly
  float wallness = 1. - smoothstep(.55, .98, s);
  float nh = length(N.xy);
  float back = max(dot(N.xy / max(nh, 1e-4), -normalize(uL.xy)), 0.) * nh;
  col *= 1. + wallness * (2.1 * back * back + .6 * max(dot(N, uL), 0.) + .30);
  col += uGlow * wallness * .16 * back * back;
  // the inside of the far wall glows with the light coming through it
  col = mix(col, uScat * (1.25 + .5 * lit) + vec3(.10, .08, .06), smoothstep(0., .25, sdq) * .32);
  // and the whole rim is a little brighter than the deep middle
  float rim = exp(h4.w * 3.2);
  col = col * (.70 + .58 * rim) + uScat * .26 * rim;

  // fruit set in the jelly, under the letters: each is a ball the bent ray may hit
  {
    vec3 ro = vec3(p0, h), rd = normalize(vec3(R.xy, rz));
    float best = 1e9, cov = 0.; int hit = -1;
    for (int i = 0; i < NF; i++) {
      vec4 f = uFruit[i];
      float r = f.w * uFr;
      vec3 oc = ro - vec3(f.xy + uLag * (f.z / H0), f.z * uM);
      float b = dot(oc, rd), d2 = dot(oc, oc) - b * b;
      if (d2 < r * r && b < 0.) {
        float t = -b - sqrt(r * r - d2);
        if (t > 0. && t < best) { best = t; hit = i; cov = smoothstep(r, r * .92, sqrt(d2)); }
      }
    }
    if (hit >= 0) {
      vec4 f = uFruit[hit];
      vec3 pos = ro + rd * best, n = normalize(pos - vec3(f.xy + uLag * (f.z / H0), f.z * uM));
      vec3 alb = (hit % 2 == 0) ? uFruitA : uFruitB;
      float lightIn = max(h - pos.z, 0.) / uL.z;
      vec3 lamp = vec3(2.3, 2.16, 1.98) * exp(-uSig * lightIn * .7);
      vec3 fc = alb * (lamp * (max(dot(n, uL), 0.) * .85 + .12) + vec3(.40, .43, .48) * exp(-uSig * lightIn * .5) * (.5 + .5 * n.z));
      fc *= .55 + .45 * smoothstep(-.2, .7, n.z);
      fc += lamp * pow(max(dot(reflect(rd, n), uL), 0.), 70.) * .9;
      fc = fc * exp(-uSig * best * 1.5) + uScat * .55 * (1. - exp(-3.2 * best)) * lit;   // deeper fruit is dimmer and takes the jelly's colour
      col = mix(col, fc, cov);
    }
  }
  // the letters: the page is a slab of candy letters hanging inside the jelly
  vec4 flatC = vec4(0.);
  if (h >= zt) {
    float tA = (h - zt) / (-rz);
    float tB = (h - zb) / (-rz);
    float lightIn = (h - zt) / uL.z;
    vec2 pl = p0 - uLag * .5;   // the letters trail the jelly a little, like the fruit
    // side walls of the letters
    const int K = 7;
    float tPrev = tA, tHit = -1.;
    for (int k = 1; k <= K; k++) {
      float t = mix(tA, tB, float(k) / float(K));
      if (pageTex(pl + R.xy * t, lod + .5).a > .5) { tHit = t; break; }
      tPrev = t;
    }
    if (tHit > 0.) {
      float a = tPrev, b = tHit;
      for (int k = 0; k < 3; k++) { float m = .5 * (a + b); if (pageTex(pl + R.xy * m, lod + .5).a > .5) b = m; else a = m; }
      vec4 c = pageTex(pl + R.xy * (b + .004), lod + 1.);
      float depth = clamp((b - tA) / max(tB - tA, 1e-4), 0., 1.);
      vec3 side = candy(c) * mix(.52, .22, depth);
      side *= exp(-uSig * (b + lightIn + depth * (zt - zb)) * .8) * (2.3 * uL.z * .7 + .4);
      col = side;
    }
    // top faces
    vec4 c = pageTex(pl + R.xy * tA, lod);
    flatC = c;
    vec3 lf = exp(-uSig * (tA + lightIn) * .5) * (2.3 * uL.z + .46);
    col = mix(col, candy(c) * lf, c.a);
  }
  // gloss
  // the top is never optically flat: a faint swell bends what it mirrors
  vec3 Ng = normalize(N + vec3(sin(p0.x * 7. + p0.y * 3.) + .5 * sin(p0.y * 13. - p0.x * 5.), cos(p0.y * 6. - p0.x * 2.) + .5 * sin(p0.x * 11. + p0.y * 4.), 0.) * .010);
  vec3 Rg = reflect(V, Ng);
  vec3 spec = env(Rg, 1.) + vec3(60.) * pow(max(dot(Rg, uL), 0.), 900.);
  col = mix(col, spec, F);
  // a wet bright line where the jelly meets the glass
  col += vec3(.9, .9, .88) * (.08 + .34 * max(dot(N.xy, normalize(uL.xy)), 0.)) * smoothstep(.010, .002, be) * cover;
  // a clean foot: blend into the plate here, so no jagged edge
  if (cover < 1.) {
    float tg = -uEye.z / V.z;
    col = mix(ground(uEye.xy + V.xy * tg, V), col, cover);
  }
  vec3 plain = mix(uPaper, flatC.rgb / max(flatC.a, 1e-3), flatC.a);
  o = vec4(mix(plain, tonemap(col), uScene), 1.);
}`;

// Full-screen passes of the port: turn the host's opaque page into "candy ink", and put the
// finished scene on the canvas.
const VS_FULL = `#version 300 es
layout(location=0) in vec2 aP;
out vec2 vUv;
void main(){ vUv = aP * .5 + .5; gl_Position = vec4(aP, 0., 1.); }`;

// The demo's page was dark text on a transparent card. The host's page is opaque, so the ink is
// whatever is bright on it; the output is premultiplied, like the demo's page texture.
const FS_INK = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv; out vec4 o;
void main(){
  vec3 c = texture(uSrc, vUv).rgb;
  float a = smoothstep(.34, .6, max(c.r, max(c.g, c.b)));
  o = vec4(c * a, a);
}`;

const FS_BLIT = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv; out vec4 o;
void main(){ o = vec4(texture(uSrc, vUv).rgb, 1.); }`;

// ------------------------------------------------------------------ shape
const DX = 1.75;
const DY = 1.19;
const GX = 72;
const GY = 49;
const H0 = 0.56;
const A = 1.26;
const B = 0.76;
const RC = 0.36;
const WALL = 0.34;
const FL = 0.075;
const NFL = 8;
const LQ = A + (RC * Math.PI) / 2 + B;
const PHX = 1.24;
const PHY = 0.775;
const BASE = 0.03;

function footSD(x: number, y: number) {
    const qx = Math.abs(x) - A;
    const qy = Math.abs(y) - B;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RC;
}

function perim(x: number, y: number) {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const dx = ax - A;
    const dy = ay - B;
    if (dx > 0 && dy > 0) {
        return A + RC * Math.atan2(dx, dy);
    }
    if (dy > dx) {
        return Math.min(ax, A);
    }
    return A + (RC * Math.PI) / 2 + (B - Math.min(ay, B));
}

// Height of the set jelly over the plate: a fluted mould with a rounded shoulder.
function heightAt(x: number, y: number) {
    const e = -footSD(x, y);
    if (e <= 0) {
        return 0;
    }
    const fl = 0.5 + 0.5 * Math.cos((2 * Math.PI * NFL * perim(x, y)) / LQ);
    let t = (e - FL * fl) / WALL;
    if (t <= 0) {
        return 0;
    }
    if (t > 1) {
        t = 1;
    }
    const prof = 1 - Math.pow(1 - t, 3.2);
    const u = x / (A + RC);
    const v = y / (B + RC);
    return H0 * prof * (0.965 + 0.05 * (1 - u * u) * (1 - v * v));
}

// ------------------------------------------------------------------ look (the page's own violet)
const srgb = (hex: string) =>
    [1, 3, 5].map((i) => Math.pow(parseInt(hex.slice(i, i + 2), 16) / 255, 2.2));
const LOOK_C = [0.3, 0.05, 0.82];
const LOOK_FA = [0.08, 0.04, 0.3];
const LOOK_FB = [0.45, 0.7, 1.0];
const LOOK_SCAT = [0.42, 0.22, 0.98];
const LOOK_GLOW = [0.38, 0.26, 1.0];
const LOOK_TABLE = srgb('#3b2f9a');
const LOOK_RING = srgb('#8c7bff');
const PAPER = [0x10 / 255, 0x15 / 255, 0x35 / 255];
const FRUIT = new Float32Array([
    -1.08, 0.56, 0.2, 0.125, -0.8, 0.68, 0.15, 0.1, -1.14, 0.24, 0.16, 0.1, 1.04, 0.58, 0.19, 0.12,
    0.76, 0.68, 0.15, 0.095, -1.12, -0.2, 0.17, 0.11, -0.4, 0.7, 0.14, 0.09, 1.06, -0.42, 0.19,
    0.12, 0.84, -0.06, 0.15, 0.1, 1.14, 0.1, 0.15, 0.09, -0.36, -0.17, 0.15, 0.105, 0.16, -0.21,
    0.14, 0.095, 0.56, -0.2, 0.16, 0.11, -0.8, -0.09, 0.13, 0.085, 0.02, 0.69, 0.14, 0.09, 0.42,
    0.66, 0.13, 0.085,
]);
const LIGHT = (() => {
    const l = [-0.5, 0.62, 0.66];
    const n = Math.hypot(l[0], l[1], l[2]);
    return l.map((v) => v / n);
})();
const SLAB_ASPECT = PHX / PHY;

// ------------------------------------------------------------------ wobble constants
const CS = (2 * DX) / GX;
const PI = Math.PI;
const NX = 1 / 1.62;
const NY = 1 / 1.12;
const NB = 11;
const B_FREQ = [1, 1.08, 1.3, 1.55, 1.7, 1.9, 2.3, 2.6, 3.1, 1.75, 1.95];
const B_LIMIT = [0.62, 0.62, 0.22, 0.14, 0.18, 0.34, 0.1, 0.1, 0.09, 0.18, 0.18];
const BULGE = 0.32;

// The demo's "cold and firm" setting (6 degrees), which is where it comes to rest after its intro.
const FIRM = (() => {
    const f = Math.min(Math.max((6 - 2) / 28, 0), 1);
    const w0 = 6.283 * (3.1 - 1.7 * f);
    const wl = w0 * 1.7;
    return { w0, zeta: 0.038 + 0.03 * f, k: wl * wl, c2: 11 - 5 * f, damp: 0.09 * wl };
})();

type Grab = {
    x: number;
    y: number;
    z: number;
    s: number;
    tx: number;
    ty: number;
    tz: number;
    sigma: number;
    pull: number;
};

type Camera = {
    eye: number[];
    fw: number[];
    up: number[];
    rt: number[];
    tx: number;
    ty: number;
};

type Hit = { hit: boolean; x: number; y: number; s: number; wx: number; wy: number; wz: number };

export function createJelly(gl: WebGL2RenderingContext): Effect {
    const created: {
        programs: Program[];
        buffers: WebGLBuffer[];
        vaos: WebGLVertexArrayObject[];
        textures: WebGLTexture[];
        framebuffers: WebGLFramebuffer[];
        renderbuffers: WebGLRenderbuffer[];
    } = { programs: [], buffers: [], vaos: [], textures: [], framebuffers: [], renderbuffers: [] };

    const track = <T>(list: T[], item: T | null, what: string): T => {
        if (!item) {
            throw new Error(`Unable to create WebGL ${what}.`);
        }
        list.push(item);
        return item;
    };
    const forget = <T>(list: T[], item: T | null) => {
        if (item) {
            const at = list.indexOf(item);
            if (at >= 0) {
                list.splice(at, 1);
            }
        }
    };

    const progGround = createProgram(gl, VS_QUAD, FS_GROUND);
    created.programs.push(progGround);
    const progJelly = createProgram(gl, VS_JELLY, FS_JELLY);
    created.programs.push(progJelly);
    const progInk = createProgram(gl, VS_FULL, FS_INK);
    created.programs.push(progInk);
    const progBlit = createProgram(gl, VS_FULL, FS_BLIT);
    created.programs.push(progBlit);

    // full-screen triangle
    const quadVAO = track(created.vaos, gl.createVertexArray(), 'vertex array');
    gl.bindVertexArray(quadVAO);
    const quadBuffer = track(created.buffers, gl.createBuffer(), 'buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // height-field mesh
    const MX = 440;
    const MY = 300;
    const MESH_COUNT = MX * MY * 6;
    const meshVAO = track(created.vaos, gl.createVertexArray(), 'vertex array');
    gl.bindVertexArray(meshVAO);
    {
        const verts = new Float32Array((MX + 1) * (MY + 1) * 2);
        let k = 0;
        for (let j = 0; j <= MY; j += 1) {
            for (let i = 0; i <= MX; i += 1) {
                verts[k] = -DX + (2 * DX * i) / MX;
                verts[k + 1] = -DY + (2 * DY * j) / MY;
                k += 2;
            }
        }
        const idx = new Uint32Array(MESH_COUNT);
        k = 0;
        for (let j = 0; j < MY; j += 1) {
            for (let i = 0; i < MX; i += 1) {
                const a = j * (MX + 1) + i;
                const b = a + 1;
                const c = a + MX + 1;
                const d = c + 1;
                idx[k] = a;
                idx[k + 1] = b;
                idx[k + 2] = c;
                idx[k + 3] = b;
                idx[k + 4] = d;
                idx[k + 5] = c;
                k += 6;
            }
        }
        const vbo = track(created.buffers, gl.createBuffer(), 'buffer');
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        const ebo = track(created.buffers, gl.createBuffer(), 'buffer');
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // height texture: height, d/dx, d/dy, signed distance, with hand-made mip levels
    const HW = 1024;
    const HH = 696;
    const texH = track(created.textures, gl.createTexture(), 'texture');
    {
        const d = new Float32Array(HW * HH * 4);
        const e = 0.003;
        for (let j = 0; j < HH; j += 1) {
            for (let i = 0; i < HW; i += 1) {
                const x = -DX + (2 * DX * (i + 0.5)) / HW;
                const y = -DY + (2 * DY * (j + 0.5)) / HH;
                const k = (j * HW + i) * 4;
                d[k] = heightAt(x, y);
                d[k + 1] = (heightAt(x + e, y) - heightAt(x - e, y)) / (2 * e);
                d[k + 2] = (heightAt(x, y + e) - heightAt(x, y - e)) / (2 * e);
                d[k + 3] = footSD(x, y);
            }
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texH);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, HW, HH, 0, gl.RGBA, gl.FLOAT, d);
        let src = d;
        let w = HW;
        let h = HH;
        let level = 0;
        while (w > 1 || h > 1) {
            const nw = Math.max(1, w >> 1);
            const nh = Math.max(1, h >> 1);
            const dst = new Float32Array(nw * nh * 4);
            for (let j = 0; j < nh; j += 1) {
                for (let i = 0; i < nw; i += 1) {
                    const i0 = Math.min(w - 1, i * 2);
                    const i1 = Math.min(w - 1, i * 2 + 1);
                    const j0 = Math.min(h - 1, j * 2);
                    const j1 = Math.min(h - 1, j * 2 + 1);
                    for (let c = 0; c < 4; c += 1) {
                        dst[(j * nw + i) * 4 + c] =
                            0.25 *
                            (src[(j0 * w + i0) * 4 + c] +
                                src[(j0 * w + i1) * 4 + c] +
                                src[(j1 * w + i0) * 4 + c] +
                                src[(j1 * w + i1) * 4 + c]);
                    }
                }
            }
            level += 1;
            gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA16F, nw, nh, 0, gl.RGBA, gl.FLOAT, dst);
            src = dst;
            w = nw;
            h = nh;
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // wobble field: ripples plus whole-body sway
    const U = new Float32Array(GX * GY * 4);
    const UL = new Float32Array(GX * GY * 4);
    const Vel = new Float32Array(GX * GY * 3);
    const cellH = new Float32Array(GX * GY);
    const cellX = new Float32Array(GX);
    const cellY = new Float32Array(GY);
    for (let i = 0; i < GX; i += 1) {
        cellX[i] = -DX + (2 * DX * (i + 0.5)) / GX;
    }
    for (let j = 0; j < GY; j += 1) {
        cellY[j] = -DY + (2 * DY * (j + 0.5)) / GY;
    }
    let maskSum = 0;
    for (let j = 0; j < GY; j += 1) {
        for (let i = 0; i < GX; i += 1) {
            const m = Math.min(heightAt(cellX[i], cellY[j]) / H0, 1);
            cellH[j * GX + i] = m;
            maskSum += m;
        }
    }
    const texU = track(created.textures, gl.createTexture(), 'texture');
    gl.bindTexture(gl.TEXTURE_2D, texU);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, GX, GY, 0, gl.RGBA, gl.FLOAT, U);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // ------------------------------------------------------------------ state
    const S = {
        m: 1, // set jelly
        lift: 0,
        liftV: 0,
        dropPhase: 0,
        dropT: 0,
        shake: 0,
        shakeT: 0,
        grab: null as Grab | null,
        px: -1,
        py: -1,
        lookX: 0,
        lookY: 0,
        lookTX: 0,
        lookTY: 0,
        held: false,
        w: 1,
        h: 1,
    };
    let cam: Camera = {
        eye: [0, 0, 9],
        fw: [0, 0, -1],
        up: [0, 1, 0],
        rt: [1, 0, 0],
        tx: 1,
        ty: 1,
    };
    let acc = 0;
    let kicked = false;
    let lastMove: [number, number] | null = null;
    let lastTime = 0;
    let slowFrames = 0;
    let framesSeen = 0;
    let quality = 1;
    let dprNow = 1;
    const fit = [1, 1];

    const BD = {
        u: new Float32Array(NB),
        v: new Float32Array(NB),
        target: null as number[] | null,
        lag: [0, 0],
    };

    function camera() {
        const aspect = S.w / S.h;
        const D = 9;
        const wv = Math.max(4.75, 2.9 * aspect);
        const e = S.m * S.m * (3 - 2 * S.m);
        const el = ((90 - 41 * e) * Math.PI) / 180;
        const sh = S.shake * Math.sin(S.shakeT * 46);
        const target = [0, -0.13 * e, 0.17 * e + sh];
        // the view leans a little toward the pointer, which shows the letters are inside the jelly
        const el2 = el + S.lookY * 0.03 * e;
        const yaw = S.lookX * 0.045 * e;
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        const fw = [sy * Math.cos(el2), cy * Math.cos(el2), -Math.sin(el2)];
        const rt = [cy, -sy, 0];
        const up = [
            rt[1] * fw[2] - rt[2] * fw[1],
            rt[2] * fw[0] - rt[0] * fw[2],
            rt[0] * fw[1] - rt[1] * fw[0],
        ];
        const eye = [target[0] - fw[0] * D, target[1] - fw[1] * D, target[2] - fw[2] * D];
        const tx = wv / (2 * D);
        cam = { eye, fw, up, rt, tx, ty: tx / aspect };
    }

    // ------------------------------------------------------------------ field sampling (matches the vertex shader)
    const sm = new Float32Array(9);
    const wX = new Float32Array(4);
    const dXw = new Float32Array(4);
    const wY = new Float32Array(4);
    const dYw = new Float32Array(4);
    function bs(f: number, w: Float32Array, d: Float32Array) {
        const f2 = f * f;
        const f3 = f2 * f;
        const g = 1 - f;
        w[0] = (g * g * g) / 6;
        w[1] = (3 * f3 - 6 * f2 + 4) / 6;
        w[2] = (-3 * f3 + 3 * f2 + 3 * f + 1) / 6;
        w[3] = f3 / 6;
        d[0] = -0.5 * g * g;
        d[1] = 1.5 * f2 - 2 * f;
        d[2] = -1.5 * f2 + f + 0.5;
        d[3] = 0.5 * f2;
    }
    function sampleU(x: number, y: number) {
        const gx = ((x + DX) / (2 * DX)) * GX - 0.5;
        const gy = ((y + DY) / (2 * DY)) * GY - 0.5;
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        bs(gx - ix, wX, dXw);
        bs(gy - iy, wY, dYw);
        sm.fill(0);
        for (let b = 0; b < 4; b += 1) {
            const cy = Math.min(GY - 1, Math.max(0, iy + b - 1));
            for (let a = 0; a < 4; a += 1) {
                const cx = Math.min(GX - 1, Math.max(0, ix + a - 1));
                const k = (cy * GX + cx) * 4;
                const w = wX[a] * wY[b];
                const wx = (dXw[a] * wY[b] * GX) / (2 * DX);
                const wy = (wX[a] * dYw[b] * GY) / (2 * DY);
                for (let c = 0; c < 3; c += 1) {
                    const t = U[k + c];
                    sm[c] += t * w;
                    sm[3 + c] += t * wx;
                    sm[6 + c] += t * wy;
                }
            }
        }
        return sm;
    }

    // ------------------------------------------------------------------ pointer ray -> jelly
    function ray(px: number, py: number) {
        const nx = (px / S.w) * 2 - 1;
        const ny = 1 - (py / S.h) * 2;
        const c = cam;
        const d = [
            c.fw[0] + c.rt[0] * nx * c.tx + c.up[0] * ny * c.ty,
            c.fw[1] + c.rt[1] * nx * c.tx + c.up[1] * ny * c.ty,
            c.fw[2] + c.rt[2] * nx * c.tx + c.up[2] * ny * c.ty,
        ];
        const n = Math.hypot(d[0], d[1], d[2]);
        return [d[0] / n, d[1] / n, d[2] / n];
    }

    const rest = [0, 0];
    // rest position of the bit of jelly now at world (x, y), and how high its surface is there
    function surfaceUnder(x: number, y: number) {
        let rx = x;
        let ry = y;
        for (let i = 0; i < 3; i += 1) {
            const s = Math.pow(heightAt(rx, ry) / H0, 1.6);
            const u = sampleU(rx, ry);
            rx = x - S.m * s * u[0];
            ry = y - S.m * s * u[1];
        }
        const hf = heightAt(rx, ry);
        const u = sampleU(rx, ry);
        rest[0] = rx;
        rest[1] = ry;
        return S.lift + S.m * (hf - BASE + (hf / H0) * u[2]);
    }

    // Where a screen point lands: on the jelly or not, and where on the slab.
    function mapPoint(px: number, py: number): Hit {
        const d = ray(px, py);
        const o = cam.eye;
        const zTop = S.lift + S.m * H0 * 1.5 + 0.02;
        const t0 = (zTop - o[2]) / d[2];
        const t1 = -o[2] / d[2];
        let hit = false;
        let ta = t0;
        let tb = t1;
        const N = 44;
        let prev = t0;
        for (let i = 1; i <= N; i += 1) {
            const t = t0 + ((t1 - t0) * i) / N;
            const z = o[2] + d[2] * t;
            const zs = surfaceUnder(o[0] + d[0] * t, o[1] + d[1] * t);
            if (heightAt(rest[0], rest[1]) > BASE && z < zs) {
                hit = true;
                ta = prev;
                tb = t;
                break;
            }
            prev = t;
        }
        if (hit) {
            for (let i = 0; i < 9; i += 1) {
                const t = 0.5 * (ta + tb);
                const z = o[2] + d[2] * t;
                const zs = surfaceUnder(o[0] + d[0] * t, o[1] + d[1] * t);
                if (heightAt(rest[0], rest[1]) > BASE && z < zs) {
                    tb = t;
                } else {
                    ta = t;
                }
            }
        }
        if (!hit) {
            const x = o[0] + d[0] * t1;
            const y = o[1] + d[1] * t1;
            return { hit: false, x, y, s: 0, wx: x, wy: y, wz: 0 };
        }
        const wx = o[0] + d[0] * tb;
        const wy = o[1] + d[1] * tb;
        const wz = o[2] + d[2] * tb;
        surfaceUnder(wx, wy);
        const hf = heightAt(rest[0], rest[1]);
        return { hit: true, x: rest[0], y: rest[1], s: hf / H0, wx, wy, wz };
    }

    const lagOut = [0, 0];
    function lagNow() {
        // the same lag the shader is given
        lagOut[0] = Math.max(-0.12, Math.min(0.12, (BD.lag[0] - BD.u[0]) * 1.5)) * S.m;
        lagOut[1] = Math.max(-0.12, Math.min(0.12, (BD.lag[1] - BD.u[1]) * 1.5)) * S.m;
        return lagOut;
    }

    // ------------------------------------------------------------------ wobble physics
    function impulse(x: number, y: number, sigma: number, vx: number, vy: number, vz: number) {
        const r2 = sigma * sigma;
        for (let j = 0; j < GY; j += 1) {
            for (let i = 0; i < GX; i += 1) {
                const dx = cellX[i] - x;
                const dy = cellY[j] - y;
                const w = Math.exp(-(dx * dx + dy * dy) / r2);
                if (w < 0.01) {
                    continue;
                }
                const k = (j * GX + i) * 3;
                Vel[k] += vx * w * 2.2;
                Vel[k + 1] += vy * w * 2.2;
                Vel[k + 2] += vz * w * 2.2;
            }
        }
        const a = Math.min(1, sigma * sigma * 3.2);
        BD.v[0] += vx * a * 3.2;
        BD.v[1] += vy * a * 3.2;
        BD.v[2] += (x * vy - y * vx) * a * 1.2;
        BD.v[3] += vz * x * a * 0.9;
        BD.v[4] += vz * y * a * 1.2;
        BD.v[5] += -vz * a * 0.6;
        const X = x * NX;
        const Y = y * NY;
        BD.v[6] += vz * Math.cos(PI * X) * a * 0.8;
        BD.v[7] += vz * Math.cos(PI * Y) * a * 0.8;
        BD.v[8] += vz * Math.sin(PI * X) * Math.cos(PI * Y * 0.5) * a * 0.8;
        BD.v[9] += vx * a * (1 - 2 * Y * Y) * 1.6;
        BD.v[10] += vy * a * (1 - 2 * X * X) * 1.6;
    }

    // Whole-body wobble: the slab sways (0, 1), twists (2), rocks (3, 4) and squashes (5) as six
    // ringing springs. Modes 6 to 8 are swells across the top; 9 and 10 let the middle lag the edges.
    function stepBody(dt: number) {
        const w0 = FIRM.w0;
        const z = FIRM.zeta;
        let a0 = 0;
        let a1 = 0;
        for (let i = 0; i < NB; i += 1) {
            const w = w0 * B_FREQ[i];
            let a = -w * w * BD.u[i] - 2 * z * (i > 5 ? 1.5 : 1) * w * BD.v[i];
            if (BD.target && i < 2) {
                a += 260 * (BD.target[i] - BD.u[i]) - 22 * BD.v[i]; // held by the pointer
            }
            if (i === 0) {
                a0 = a;
            } else if (i === 1) {
                a1 = a;
            } else if (i === 9) {
                // when the slab lurches, its middle is slow to follow and its top tips
                a -= 0.3 * a0;
            } else if (i === 10) {
                a -= 0.3 * a1;
            } else if (i === 3) {
                a += 0.035 * a0;
            } else if (i === 4) {
                a += 0.05 * a1;
            }
            BD.v[i] += a * dt;
            BD.u[i] += BD.v[i] * dt;
            const lim = B_LIMIT[i];
            if (BD.u[i] > lim) {
                BD.u[i] = lim;
                BD.v[i] *= -0.3;
            } else if (BD.u[i] < -lim) {
                BD.u[i] = -lim;
                BD.v[i] *= -0.3;
            }
        }
        const k = 1 - Math.exp(-dt / 0.085);
        BD.lag[0] += (BD.u[0] - BD.lag[0]) * k;
        BD.lag[1] += (BD.u[1] - BD.lag[1]) * k;
    }

    function bodyAt(x: number, y: number, out: number[]) {
        const u = BD.u;
        const X = x * NX;
        const Y = y * NY;
        const bq = BULGE * (u[5] > 0 ? u[5] : u[5] * 0.3); // it spreads when squashed, but hardly narrows when it springs up
        out[0] = u[0] - u[2] * y + bq * x + u[9] * (1 - 2 * Y * Y);
        out[1] = u[1] + u[2] * x + bq * y + u[10] * (1 - 2 * X * X);
        out[2] =
            -H0 * u[5] +
            u[3] * x +
            u[4] * y +
            u[6] * Math.cos(PI * X) +
            u[7] * Math.cos(PI * Y) +
            u[8] * Math.sin(PI * X) * Math.cos(PI * Y * 0.5);
    }

    const bo = [0, 0, 0];
    function compose() {
        for (let j = 0; j < GY; j += 1) {
            for (let i = 0; i < GX; i += 1) {
                const k = (j * GX + i) * 4;
                bodyAt(cellX[i], cellY[j], bo);
                U[k] = UL[k] + bo[0];
                U[k + 1] = UL[k + 1] + bo[1];
                U[k + 2] = UL[k + 2] + bo[2];
            }
        }
    }

    function stepField(dt: number) {
        const k = FIRM.k;
        const c2 = FIRM.c2 / (CS * CS);
        const c2raw = FIRM.c2;
        const damp = FIRM.damp;
        let mean = 0;
        for (let n = 0; n < GX * GY; n += 1) {
            mean += UL[n * 4 + 2] * cellH[n];
        }
        mean /= maskSum;
        const g = S.grab;
        let gx = 0;
        let gy = 0;
        let gz = 0;
        let gr2 = 1;
        if (g) {
            gx = g.tx;
            gy = g.ty;
            gz = g.tz;
            gr2 = g.sigma * g.sigma;
        }
        for (let j = 0; j < GY; j += 1) {
            const jm = j > 0 ? j - 1 : 0;
            const jp = j < GY - 1 ? j + 1 : j;
            for (let i = 0; i < GX; i += 1) {
                const im = i > 0 ? i - 1 : 0;
                const ip = i < GX - 1 ? i + 1 : i;
                const n = j * GX + i;
                const k4 = n * 4;
                const k3 = n * 3;
                const l = j * GX + im;
                const r = j * GX + ip;
                const d = jm * GX + i;
                const u = jp * GX + i;
                // squeezing down pushes the sides out; stretching sideways pulls the top down
                const dzdx = (UL[r * 4 + 2] - UL[l * 4 + 2]) / (2 * CS);
                const dzdy = (UL[u * 4 + 2] - UL[d * 4 + 2]) / (2 * CS);
                const div =
                    (UL[r * 4] - UL[l * 4]) / (2 * CS) + (UL[u * 4 + 1] - UL[d * 4 + 1]) / (2 * CS);
                for (let c = 0; c < 3; c += 1) {
                    const lap =
                        UL[l * 4 + c] +
                        UL[r * 4 + c] +
                        UL[d * 4 + c] +
                        UL[u * 4 + c] -
                        4 * UL[k4 + c];
                    const lapV =
                        Vel[l * 3 + c] +
                        Vel[r * 3 + c] +
                        Vel[d * 3 + c] +
                        Vel[u * 3 + c] -
                        4 * Vel[k3 + c];
                    let a =
                        -(c === 2 ? 2.2 * k : k) * UL[k4 + c] +
                        c2 * lap -
                        damp * Vel[k3 + c] +
                        30 * lapV;
                    if (c === 0) {
                        a += 0.9 * c2raw * dzdx;
                    } else if (c === 1) {
                        a += 0.9 * c2raw * dzdy;
                    } else {
                        a += -0.5 * c2raw * div - 1.2 * k * mean;
                    }
                    Vel[k3 + c] += a * dt;
                }
                if (g) {
                    const ddx = cellX[i] - g.x;
                    const ddy = cellY[j] - g.y;
                    const w = Math.exp(-(ddx * ddx + ddy * ddy) / gr2);
                    if (w > 0.005) {
                        const kg = 2600 * w;
                        const dg = 60 * w;
                        Vel[k3] += (kg * (gx - UL[k4]) - dg * Vel[k3]) * dt;
                        Vel[k3 + 1] += (kg * (gy - UL[k4 + 1]) - dg * Vel[k3 + 1]) * dt;
                        Vel[k3 + 2] += (kg * (gz - UL[k4 + 2]) - dg * Vel[k3 + 2]) * dt;
                    }
                }
            }
        }
        for (let n = 0; n < GX * GY; n += 1) {
            const k4 = n * 4;
            const k3 = n * 3;
            for (let c = 0; c < 3; c += 1) {
                let v = UL[k4 + c] + Vel[k3 + c] * dt;
                const lim = c === 2 ? 0.34 : 0.62;
                if (v > lim) {
                    v = lim;
                    Vel[k3 + c] *= 0.5;
                } else if (v < -lim) {
                    v = -lim;
                    Vel[k3 + c] *= 0.5;
                }
                UL[k4 + c] = v;
            }
        }
    }

    function updateGrab() {
        const g = S.grab;
        if (!g) {
            return;
        }
        // pull the grabbed bit of jelly toward where the pointer is, on a level plane through the grab height
        const d = ray(S.px, S.py);
        const o = cam.eye;
        const t = (g.z - o[2]) / d[2];
        let ux = (o[0] + d[0] * t - g.x) / Math.max(S.m * g.s, 0.2);
        let uy = (o[1] + d[1] * t - g.y) / Math.max(S.m * g.s, 0.2);
        const len = Math.hypot(ux, uy);
        const max = 0.58;
        if (len > max) {
            const f = (max * (1 + 0.25 * Math.tanh((len - max) / max))) / len;
            ux *= f;
            uy *= f;
        }
        BD.target = [ux * 0.55, uy * 0.55];
        bodyAt(g.x, g.y, bo);
        g.tx = ux - bo[0];
        g.ty = uy - bo[1];
        g.tz = -0.13 - 0.06 * Math.min(len / max, 1) - bo[2];
        g.pull = Math.min(1, len / max);
    }

    // ------------------------------------------------------------------ drop
    function drop() {
        if (S.dropPhase || S.m < 0.6) {
            return;
        }
        S.dropPhase = 1;
        S.dropT = 0;
    }
    function stepDrop(dt: number) {
        if (!S.dropPhase) {
            return;
        }
        S.dropT += dt;
        if (S.dropPhase === 1) {
            // lift
            const T = 0.42;
            const u = Math.min(S.dropT / T, 1);
            const e = 1 - Math.pow(1 - u, 3);
            const z = 0.8 * e;
            S.liftV = (z - S.lift) / dt;
            S.lift = z;
            if (S.dropT <= dt * 1.5) {
                // it stretches as it is picked up
                BD.v[5] -= 3.2;
                BD.v[3] += 0.5;
            }
            if (u >= 1) {
                S.dropPhase = 2;
                S.liftV = 0;
                S.dropT = 0;
            }
        } else if (S.dropPhase === 2) {
            // fall
            S.liftV -= 17 * dt;
            S.lift += S.liftV * dt;
            if (S.lift <= 0) {
                const v = -S.liftV;
                S.lift = 0;
                S.liftV = 0;
                S.dropPhase = 0;
                // a fat squash, a sideways lurch, and ripples running out from the middle
                BD.v[5] += v * 2.1;
                BD.v[0] += (Math.random() < 0.5 ? -1 : 1) * (2.4 + Math.random());
                BD.v[1] += 1.4;
                BD.v[4] += (Math.random() - 0.5) * 1.0;
                BD.v[3] += (Math.random() - 0.5) * 0.9;
                BD.v[2] += (Math.random() - 0.5) * 0.6;
                BD.v[6] += (Math.random() < 0.5 ? -1 : 1) * 4.2;
                BD.v[7] += 3.6;
                BD.v[8] += (Math.random() < 0.5 ? -1 : 1) * 3.5;
                for (let jj = 0; jj < GY; jj += 1) {
                    for (let ii = 0; ii < GX; ii += 1) {
                        const n = jj * GX + ii;
                        const m = cellH[n];
                        if (m <= 0) {
                            continue;
                        }
                        const x = cellX[ii];
                        const y = cellY[jj];
                        Vel[n * 3 + 2] -= v * 0.35 * m * (1.0 - 0.6 * ((x * x) / 2.6 + y * y));
                    }
                }
                S.shake = 0.035;
                S.shakeT = 0;
            }
        }
    }

    function advance(dt: number) {
        if (!kicked) {
            // the little settle the demo gives once it has cooled
            kicked = true;
            BD.v[0] += 3.2;
            BD.v[1] += 1.2;
            BD.v[5] += 3.5;
            BD.v[4] += 0.7;
            impulse(-0.5, -0.1, 0.7, 0, 0, -1.2);
        }
        if (!S.held) {
            const a = 1 - Math.exp(-dt / 0.35);
            S.lookX += (S.lookTX - S.lookX) * a;
            S.lookY += (S.lookTY - S.lookY) * a;
        }
        stepDrop(dt);
        if (S.shake > 0.0005) {
            S.shakeT += dt;
            S.shake *= Math.exp(-dt * 9);
        } else {
            S.shake = 0;
        }
        camera();
        if (S.grab) {
            updateGrab();
        }
        acc += dt;
        const h = 1 / 240;
        let n = 0;
        while (acc >= h && n < 14) {
            stepBody(h);
            stepField(h);
            acc -= h;
            n += 1;
        }
        compose();
        if (n === 14) {
            acc = 0;
        }
    }

    // ------------------------------------------------------------------ render targets
    let inkTex: WebGLTexture | null = null;
    let inkFbo: WebGLFramebuffer | null = null;
    let inkW = 0;
    let inkH = 0;

    function allocInk(width: number, height: number) {
        const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
        const w = Math.max(1, Math.min(Math.round(width), max));
        const h = Math.max(1, Math.min(Math.round(height), max));
        if (inkTex && w === inkW && h === inkH) {
            return;
        }
        if (inkFbo) {
            gl.deleteFramebuffer(inkFbo);
            forget(created.framebuffers, inkFbo);
        }
        if (inkTex) {
            gl.deleteTexture(inkTex);
            forget(created.textures, inkTex);
        }
        inkW = w;
        inkH = h;
        inkTex = track(created.textures, gl.createTexture(), 'texture');
        const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
        gl.bindTexture(gl.TEXTURE_2D, inkTex);
        gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
        if (aniso) {
            gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
        }
        gl.bindTexture(gl.TEXTURE_2D, null);
        inkFbo = track(created.framebuffers, gl.createFramebuffer(), 'framebuffer');
        gl.bindFramebuffer(gl.FRAMEBUFFER, inkFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, inkTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    let msFbo: WebGLFramebuffer | null = null;
    let msColor: WebGLRenderbuffer | null = null;
    let msDepth: WebGLRenderbuffer | null = null;
    let resolveFbo: WebGLFramebuffer | null = null;
    let resolveTex: WebGLTexture | null = null;
    let sceneW = 0;
    let sceneH = 0;

    function freeScene() {
        if (msFbo) {
            gl.deleteFramebuffer(msFbo);
            forget(created.framebuffers, msFbo);
        }
        if (resolveFbo) {
            gl.deleteFramebuffer(resolveFbo);
            forget(created.framebuffers, resolveFbo);
        }
        if (msColor) {
            gl.deleteRenderbuffer(msColor);
            forget(created.renderbuffers, msColor);
        }
        if (msDepth) {
            gl.deleteRenderbuffer(msDepth);
            forget(created.renderbuffers, msDepth);
        }
        if (resolveTex) {
            gl.deleteTexture(resolveTex);
            forget(created.textures, resolveTex);
        }
        msFbo = null;
        resolveFbo = null;
        msColor = null;
        msDepth = null;
        resolveTex = null;
    }

    function allocScene(w: number, h: number) {
        if (w === sceneW && h === sceneH && msFbo) {
            return;
        }
        freeScene();
        sceneW = w;
        sceneH = h;
        const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
        msColor = track(created.renderbuffers, gl.createRenderbuffer(), 'renderbuffer');
        gl.bindRenderbuffer(gl.RENDERBUFFER, msColor);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
        msDepth = track(created.renderbuffers, gl.createRenderbuffer(), 'renderbuffer');
        gl.bindRenderbuffer(gl.RENDERBUFFER, msDepth);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        msFbo = track(created.framebuffers, gl.createFramebuffer(), 'framebuffer');
        gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msColor);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msDepth);
        const msOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        resolveTex = track(created.textures, gl.createTexture(), 'texture');
        gl.bindTexture(gl.TEXTURE_2D, resolveTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        resolveFbo = track(created.framebuffers, gl.createFramebuffer(), 'framebuffer');
        gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resolveTex, 0);
        const resolveOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!msOk || !resolveOk) {
            throw new Error('Jelly: the offscreen render target is not supported.');
        }
    }

    function layout() {
        // the demo draws at most about 3.4 megapixels, and fewer when frames are slow
        let ratio = Math.min(dprNow, 2) * quality;
        const maxPx = 3.4e6;
        if (S.w * S.h * ratio * ratio > maxPx) {
            ratio = Math.sqrt(maxPx / (S.w * S.h));
        }
        allocScene(Math.max(1, Math.round(S.w * ratio)), Math.max(1, Math.round(S.h * ratio)));
        // the page keeps its own proportions inside the slab (the demo's page was exactly 1.6:1)
        const aspect = S.w / S.h;
        if (aspect > SLAB_ASPECT) {
            fit[0] = 1;
            fit[1] = aspect / SLAB_ASPECT;
        } else {
            fit[0] = SLAB_ASPECT / aspect;
            fit[1] = 1;
        }
    }

    // ------------------------------------------------------------------ drawing
    function setCommon(pr: Program) {
        const u = pr.uniforms;
        const c = cam;
        gl.useProgram(pr.program);
        gl.uniform1i(u.uH, 0);
        gl.uniform1i(u.uU, 1);
        gl.uniform1i(u.uPage, 2);
        gl.uniform3fv(u.uEye, c.eye);
        gl.uniform3fv(u.uRt, c.rt);
        gl.uniform3fv(u.uUp, c.up);
        gl.uniform3fv(u.uFw, c.fw);
        gl.uniform2f(u.uTan, c.tx, c.ty);
        gl.uniform1f(u.uM, S.m);
        gl.uniform1f(u.uScene, 1);
        gl.uniform1f(u.uLift, S.lift);
        gl.uniform3f(
            u.uSig,
            -Math.log(LOOK_C[0]) / 0.5,
            -Math.log(LOOK_C[1]) / 0.5,
            -Math.log(LOOK_C[2]) / 0.5,
        );
        gl.uniform3fv(u.uScat, LOOK_SCAT);
        gl.uniform3fv(u.uGlow, LOOK_GLOW);
        gl.uniform3fv(u.uTable, LOOK_TABLE);
        gl.uniform3fv(u.uRing, LOOK_RING);
        gl.uniform3fv(u.uPaper, PAPER);
        gl.uniform3fv(u.uL, LIGHT);
        gl.uniform2f(u.uPageTex, inkW, inkH);
        gl.uniform2f(u.uFit, fit[0], fit[1]);
        gl.uniform4fv(u.uFruit, FRUIT);
        gl.uniform3fv(u.uFruitA, LOOK_FA);
        gl.uniform3fv(u.uFruitB, LOOK_FB);
        const fr = Math.min(Math.max((S.m - 0.15) / 0.6, 0), 1);
        gl.uniform1f(u.uFr, fr * fr * (3 - 2 * fr));
        const lg = lagNow();
        gl.uniform2f(u.uLag, lg[0], lg[1]);
        gl.uniform1f(u.uSq, BD.u[5]);
    }

    function trackPointer(pointer: PointerState) {
        S.px = pointer.x;
        S.py = pointer.y;
    }

    function release() {
        S.held = false;
        if (S.grab) {
            S.grab = null;
            BD.target = null;
        }
    }

    function resize(width: number, height: number, dpr: number) {
        S.w = Math.max(1, width);
        S.h = Math.max(1, height);
        dprNow = dpr > 0 ? dpr : 1;
        layout();
        camera();
    }

    // The Reset button: let go of the jelly and pick the whole slab up and drop it again.
    function reset() {
        release();
        drop();
    }

    function pointerEvent(kind: PointerEventKind, pointer: PointerState) {
        trackPointer(pointer);
        if (kind === 'down') {
            S.held = true;
            camera();
            const p = mapPoint(S.px, S.py);
            if (!p.hit) {
                // pressing beside the jelly picks the whole slab up and drops it
                drop();
                return;
            }
            S.grab = {
                x: p.x,
                y: p.y,
                z: p.wz,
                s: Math.max(p.s, 0.25),
                tx: 0,
                ty: 0,
                tz: -0.07,
                sigma: 0.34,
                pull: 0,
            };
            updateGrab();
        } else if (kind === 'move') {
            if (!S.held) {
                S.lookTX = Math.max(-1, Math.min(1, (S.px / S.w) * 2 - 1));
                S.lookTY = Math.max(-1, Math.min(1, (S.py / S.h) * 2 - 1));
            }
            if (S.grab) {
                updateGrab();
            } else if (!S.held && lastMove) {
                // brushing past the jelly with the pointer sets it trembling
                const dx = pointer.x - lastMove[0];
                const dy = pointer.y - lastMove[1];
                const sp = Math.hypot(dx, dy);
                if (sp > 6) {
                    const p = mapPoint(S.px, S.py);
                    if (p.hit) {
                        const g = Math.min(sp, 50) * 0.0016;
                        impulse(p.x, p.y, 0.4, (dx / sp) * g * 1.6, (-dy / sp) * g * 1.6, -g * 0.5);
                    }
                }
            }
            lastMove = [pointer.x, pointer.y];
        } else if (kind === 'up') {
            release();
        } else if (!pointer.down) {
            release();
            lastMove = null;
        }
    }

    function render(frame: EffectFrame) {
        S.w = Math.max(1, frame.width);
        S.h = Math.max(1, frame.height);
        if (frame.dpr !== dprNow) {
            dprNow = frame.dpr > 0 ? frame.dpr : 1;
        }
        if (frame.pointer.inside || S.grab) {
            trackPointer(frame.pointer);
        }
        if (S.grab && !frame.pointer.down) {
            release();
        }

        // if frames are slow, draw fewer pixels
        const gap = frame.time - lastTime;
        if (lastTime > 0 && gap > 0 && gap < 0.2) {
            framesSeen += 1;
            if (gap > 0.024) {
                slowFrames += 1;
            }
            if (framesSeen >= 40) {
                if (slowFrames > 26 && quality > 0.5) {
                    quality *= 0.82;
                }
                framesSeen = 0;
                slowFrames = 0;
            }
        }
        lastTime = frame.time;

        advance(Math.min(Math.max(frame.dt, 0), 0.05));
        layout();
        allocInk(frame.pageSize.width, frame.pageSize.height);

        gl.disable(gl.BLEND);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.DEPTH_TEST);

        // the wobble field
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, texU);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GX, GY, gl.RGBA, gl.FLOAT, U);

        // the host's page, as mip-mapped premultiplied candy ink
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, frame.pageTexture);
        gl.bindFramebuffer(gl.FRAMEBUFFER, inkFbo);
        gl.viewport(0, 0, inkW, inkH);
        gl.useProgram(progInk.program);
        gl.uniform1i(progInk.uniforms.uSrc, 0);
        gl.bindVertexArray(quadVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, inkTex);
        gl.generateMipmap(gl.TEXTURE_2D);

        // the scene: platter first, then the jelly mesh with depth
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texH);
        gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
        gl.viewport(0, 0, sceneW, sceneH);
        gl.depthMask(true);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        setCommon(progGround);
        gl.bindVertexArray(quadVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        setCommon(progJelly);
        gl.bindVertexArray(meshVAO);
        gl.drawElements(gl.TRIANGLES, MESH_COUNT, gl.UNSIGNED_INT, 0);
        gl.disable(gl.DEPTH_TEST);

        // resolve the multisampled scene and put it on the canvas
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msFbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolveFbo);
        gl.blitFramebuffer(
            0,
            0,
            sceneW,
            sceneH,
            0,
            0,
            sceneW,
            sceneH,
            gl.COLOR_BUFFER_BIT,
            gl.NEAREST,
        );
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, resolveTex);
        gl.useProgram(progBlit.program);
        gl.uniform1i(progBlit.uniforms.uSrc, 0);
        gl.bindVertexArray(quadVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        // leave the contract's state behind
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    function dispose() {
        freeScene();
        if (inkFbo) {
            gl.deleteFramebuffer(inkFbo);
            forget(created.framebuffers, inkFbo);
            inkFbo = null;
        }
        if (inkTex) {
            gl.deleteTexture(inkTex);
            forget(created.textures, inkTex);
            inkTex = null;
        }
        created.framebuffers.forEach((item) => gl.deleteFramebuffer(item));
        created.renderbuffers.forEach((item) => gl.deleteRenderbuffer(item));
        created.textures.forEach((item) => gl.deleteTexture(item));
        created.vaos.forEach((item) => gl.deleteVertexArray(item));
        created.buffers.forEach((item) => gl.deleteBuffer(item));
        created.programs.forEach((item) => gl.deleteProgram(item.program));
        created.framebuffers.length = 0;
        created.renderbuffers.length = 0;
        created.textures.length = 0;
        created.vaos.length = 0;
        created.buffers.length = 0;
        created.programs.length = 0;
    }

    return {
        name: 'jelly',
        resize,
        pointerEvent,
        // The page is set inside the jelly, nowhere near where it was laid out.
        pageInteractive: () => false,
        // The jelly settles by itself; what the button does is pick it up and drop it again.
        resetLabel: 'Drop it',
        reset,
        render,
        dispose,
    };
}
