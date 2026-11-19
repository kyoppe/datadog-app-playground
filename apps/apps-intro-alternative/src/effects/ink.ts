import { createProgram, requireFloatTargets } from './glUtils';
import type { Program } from './glUtils';
import type { Effect, EffectFrame, PointerEventKind, PointerState } from './types';

// "Ink": the page is a sheet floating on a thick fluid. Dragging stirs the fluid, the sheet is
// carried along with it (a displacement map advected by the velocity field), and the comb lays
// a ribbon of pigment onto the sheet. Left alone, the stir is run backwards and the page settles.

const DT = 1 / 60;
const SIM_H = 168;
const KEY_H = 160;
const KEY_MAX = 120;
const MESH_N = 36;
const JACOBI_ITERATIONS = 22;
/** Ink thickness slider of the original (default 76 of 100). */
const THICK = 0.76;
/** Seconds without any stirring before the page settles back by itself. */
const IDLE_SETTLE_SECONDS = 9;
/** Seconds after the last pointer movement for which a plain hover keeps stirring. */
const HOVER_HOLD_SECONDS = 0.12;

const damping = () => 0.55 + 3.4 * THICK * THICK; // per second
const brush = () => 0.04 + 0.04 * THICK; // in sheet heights

const FULLSCREEN_VS = `#version 300 es
out vec2 v;
uniform float uY;
void main() {
    vec2 a = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2. - 1.;
    v = a * .5 + .5;
    gl_Position = vec4(a.x, a.y * uY, 0., 1.);
}`;

const fragment = (body: string) => `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v;
out vec4 o;
${body}`;

// Lays pigment under the comb. A small mesh around the stroke is carried through the map onto the
// sheet, so the mark is stored where the sheet was at that moment.
const LAY_VS = `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec2 a;
out vec2 hs;
uniform sampler2D uMap;
uniform vec2 uA, uB;
uniform float uR, uAsp;
void main() {
    vec2 lo = min(uA, uB) - uR * 2.05, hi = max(uA, uB) + uR * 2.05;
    hs = mix(lo, hi, a);
    vec2 uv = hs / vec2(uAsp, 1.);
    vec2 q = uv + texture(uMap, uv).xy;
    gl_Position = vec4(q * 2. - 1., 0., 1.);
}`;

const LAY_FS = `#version 300 es
precision highp float;
in vec2 hs;
out vec4 o;
uniform vec2 uA, uB;
uniform float uR, uRings;
void main() {
    vec2 pa = hs - uA, ba = uB - uA;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0., 1.);
    float dd = length(pa - ba * h);
    float c = clamp(1. - dd / (2. * uR), 0., 1.);
    if (uRings > 0.) c = dd < uR * 1.9 ? .5 + .42 * cos(6.2832 * dd / (uR * .76)) * smoothstep(1.9, 1.6, dd / uR) : 0.;
    o = vec4(c, 0., 0., 1.);
}`;

const SEG = `float seg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0., 1.);
    return length(pa - ba * h);
}`;

const SPLAT_V = `uniform sampler2D uV; uniform vec2 uA, uB, uVel; uniform float uR, uGain, uAsp;
${SEG}
void main() {
    float w = exp(-pow(seg(v * vec2(uAsp, 1.), uA, uB) / uR, 2.));
    vec2 c = texture(uV, v).xy;
    o = vec4(mix(c, uVel, w * uGain), 0., 1.);
}`;

const ADV_V = `uniform sampler2D uV; uniform vec2 uTexel; uniform float uDt, uDamp, uAsp;
void main() {
    vec2 c = texture(uV, v).xy;
    vec2 q = v - c * uDt / vec2(uAsp, 1.);
    vec2 n = texture(uV, q).xy * uDamp;
    vec2 e = min(v, 1. - v) / uTexel;
    o = vec4(n * smoothstep(0., 2.5, min(e.x, e.y)), 0., 1.);
}`;

const DIV = `uniform sampler2D uV; uniform vec2 uTexel;
void main() {
    float l = texture(uV, v - vec2(uTexel.x, 0.)).x, r = texture(uV, v + vec2(uTexel.x, 0.)).x;
    float t = texture(uV, v - vec2(0., uTexel.y)).y, b = texture(uV, v + vec2(0., uTexel.y)).y;
    o = vec4(.5 * ((r - l) + (b - t)), 0., 0., 1.);
}`;

const JAC = `uniform sampler2D uP, uDiv; uniform vec2 uTexel;
void main() {
    float l = texture(uP, v - vec2(uTexel.x, 0.)).x, r = texture(uP, v + vec2(uTexel.x, 0.)).x;
    float t = texture(uP, v - vec2(0., uTexel.y)).x, b = texture(uP, v + vec2(0., uTexel.y)).x;
    o = vec4((l + r + t + b - texture(uDiv, v).x) * .25, 0., 0., 1.);
}`;

const GRAD = `uniform sampler2D uP, uV; uniform vec2 uTexel;
void main() {
    float l = texture(uP, v - vec2(uTexel.x, 0.)).x, r = texture(uP, v + vec2(uTexel.x, 0.)).x;
    float t = texture(uP, v - vec2(0., uTexel.y)).x, b = texture(uP, v + vec2(0., uTexel.y)).x;
    o = vec4(texture(uV, v).xy - .5 * vec2(r - l, b - t), 0., 1.);
}`;

const ADV_M = `uniform sampler2D uV, uM; uniform float uDt, uAsp;
void main() {
    vec2 s = texture(uV, v).xy * uDt / vec2(uAsp, 1.);
    o = vec4(texture(uM, v - s).xy - s, 0., 1.);
}`;

const MIX = `uniform sampler2D uA, uB; uniform float uT;
void main() { o = mix(texture(uA, v), texture(uB, v), uT); }`;

// Smooth (B-spline) enlargement of two small snapshots, blended.
const FILM = `uniform sampler2D uA, uB; uniform float uT;
vec4 bs(sampler2D s, vec2 uv) {
    vec2 n = vec2(textureSize(s, 0));
    vec2 x = uv * n - .5, i = floor(x), f = x - i;
    vec2 w0 = (1. - f) * (1. - f) * (1. - f) / 6., w1 = (4. - 6. * f * f + 3. * f * f * f) / 6.;
    vec2 w2 = (1. + 3. * f + 3. * f * f - 3. * f * f * f) / 6., w3 = f * f * f / 6.;
    vec2 g0 = w0 + w1, g1 = w2 + w3, h0 = (i - .5 + w1 / g0) / n, h1 = (i + 1.5 + w3 / g1) / n;
    return g0.y * (g0.x * texture(s, vec2(h0.x, h0.y)) + g1.x * texture(s, vec2(h1.x, h0.y)))
        + g1.y * (g0.x * texture(s, vec2(h0.x, h1.y)) + g1.x * texture(s, vec2(h1.x, h1.y)));
}
void main() { o = mix(bs(uA, v), bs(uB, v), uT); }`;

// Default pigment (Prussian blue): its absorbance of red, green and blue when laid as a ribbon.
// The paper is the original's paper colour; the page is read as absorbance relative to it.
const SHOW = `uniform sampler2D uPage, uMap, uSt;
uniform float uStain, uDpr;
uniform vec2 uCss, uMapTexel, uPageSize;
const vec3 PIG = vec3(2.0, 1.05, 0.34);
const vec3 uPaper = vec3(232. / 255., 236. / 255., 234. / 255.);
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3. - 2. * f);
    return mix(mix(h21(i), h21(i + vec2(1., 0.)), f.x), mix(h21(i + vec2(0., 1.)), h21(i + 1.), f.x), f.y);
}
vec3 absorb(vec3 c) { return max(-log(max(c, vec3(.004)) / uPaper), 0.); }
void main() {
    vec2 e = uMapTexel;
    vec2 d = texture(uMap, v).xy;
    vec2 du = (texture(uMap, v + vec2(e.x, 0.)).xy - texture(uMap, v - vec2(e.x, 0.)).xy) / (2. * e.x);
    vec2 dv = (texture(uMap, v + vec2(0., e.y)).xy - texture(uMap, v - vec2(0., e.y)).xy) / (2. * e.y);
    vec2 jx = vec2(1., 0.) + du, jy = vec2(0., 1.) + dv;   // columns of d(page)/d(screen), in sheet fractions
    // The same in pixels, and how far it stretches (s2 < 1) and squeezes (s1 > 1) the sheet here.
    float k = uCss.x / uCss.y;
    float a = jx.x, b = jy.x * k, c = jx.y / k, dd = jy.y;
    float fro = a * a + b * b + c * c + dd * dd, det = a * dd - b * c;
    float disc = sqrt(max(fro * fro - 4. * det * det, 0.));
    float s1 = sqrt(.5 * (fro + disc)), s2 = sqrt(max(.5 * (fro - disc), 1e-5));
    float pull = s1 / s2;                                   // 1 = untouched, large = drawn into a thread
    float bent = smoothstep(1.03, 1.5, pull);
    vec2 p = v + d;
    vec2 in2 = smoothstep(vec2(-.001), vec2(.002), p) * smoothstep(vec2(-.001), vec2(.002), 1. - p);
    float inside = in2.x * in2.y;
    vec2 px = v * uCss;
    vec2 pp = p * uCss;
    float far = smoothstep(3., 9., pull);
    // The sheet is read at the size the stir has made it here, so nothing breaks into stripes: fine print
    // drawn out too far gathers into a soft bleed with some body, and the edge of any solid shape is then
    // drawn again, hard, with pigment gathered in a narrow line just inside it.
    float lod = max(log2(s1) - .15, 0.);
    float st = exp2(lod);
    vec2 tx = st / uPageSize;
    vec3 a0 = absorb(textureLod(uPage, p, lod).rgb);
    vec3 a1 = absorb(textureLod(uPage, p + vec2(tx.x, 0.), lod).rgb), a2 = absorb(textureLod(uPage, p - vec2(tx.x, 0.), lod).rgb);
    vec3 a3 = absorb(textureLod(uPage, p + vec2(0., tx.y), lod).rgb), a4 = absorb(textureLod(uPage, p - vec2(0., tx.y), lod).rgb);
    vec3 lo = min(a0, min(min(a1, a2), min(a3, a4))), hi = max(a0, max(max(a1, a2), max(a3, a4)));
    float ramp = 2. * st / s2;
    float w = clamp(.6 / ramp, .03, .5);
    float span = (hi.r - lo.r) + (hi.g - lo.g) + (hi.b - lo.b);
    float t = ((a0.r - lo.r) + (a0.g - lo.g) + (a0.b - lo.b)) / max(span, 1e-3);
    float solid = smoothstep(.25, .9, span);
    float e0 = smoothstep(.5 - w, .5 + w, t);
    float rim = e0 * (1. - smoothstep(.58, .95, t)) * solid;
    vec3 sharp = absorb(textureGrad(uPage, p, jx / (uCss.x * uDpr), jy / (uCss.y * uDpr)).rgb);
    // How much ink there is round about: a letter of the headline has plenty, a line of small print very little.
    vec3 ab = absorb(textureLod(uPage, p, lod + 3.5).rgb);
    float fine = 1. - smoothstep(.3, .9, ab.r + ab.g + ab.b);
    // Small print pulled a long way lets go of the sheet and disperses, rather than tearing into scratches.
    vec3 bleed = a0 * (1. - fine * smoothstep(2.6, 6., pull));
    vec3 A = mix(sharp, bleed, smoothstep(1.6, 3.2, pull));
    A = mix(A, mix(lo, hi, e0), solid * bent * smoothstep(1., 1.5, ramp));
    A *= (1. + mix(.1, .2, bent) * rim) * inside;
    // Ink is a material. A fine grain lives in the sheet itself, so when the sheet is drawn out the grain is
    // drawn out with it, and opens into hairline rifts where the paper shows through.
    float f1 = clamp(5. / (s1 * 3.), 0., 1.), f2 = clamp(12. / (s1 * 3.), 0., 1.);
    float grain = mix(.5, vn(pp / 2.5), f1) * .5 + mix(.5, vn(pp / 6. + 31.), f2) * .5;
    float vein = smoothstep(.61, .7, grain) * smoothstep(.3, .62, vn(pp / 70. + 7.)) * (1. - fine);
    A *= (1. - .42 * far * vein) * mix(1., clamp(pow(max(pull / 2., 1.), -.16), .7, 1.), bent);
    // A ribbon of pigment laid by the comb. It lives on the sheet, so it is carried, folded and unstirred
    // with it. A ribbon pushes aside what it crosses and leaves a pale line round itself.
    if (uStain > 0.) {
        float cv = texture(uSt, p).r;
        float rag = (vn(pp / 14. + 17.) - .5) * .07 * f2;
        float along = .75 + .5 * vn(pp / 38. + 50.);
        float cs = cv + rag * step(.02, cv);
        float ww = max(fwidth(cs) * .75, .004);
        // A ribbon is laid by a comb, not a brush: a full band down the middle and finer threads either
        // side of it with paper between, all running with the stroke.
        float band = smoothstep(.5 - ww, .5 + ww, cs);
        float gap1 = smoothstep(.555 - ww, .555 + ww, cs) * (1. - smoothstep(.6 - ww, .6 + ww, cs));
        float gap2 = smoothstep(.665 - ww, .665 + ww, cs) * (1. - smoothstep(.725 - ww, .725 + ww, cs));
        // (the threads are a difference of tone, not of line: quieter where the ribbon is thin)
        float thread = 1. - (.34 * gap1 + .26 * gap2) * smoothstep(.62, .8, cv + .12 * smoothstep(1.5, 4., pull));
        float m = band * uStain * inside;
        float halo = smoothstep(.5 - ww - .085, .5 - ww - .03, cs) * uStain;
        A *= 1. - .7 * halo * (1. - m) * (1. - smoothstep(1., 2.3, A.r));
        vec3 body = PIG * .9 * along * thread * (1. - .5 * mix(.25, 1., far) * vein);
        float dark = smoothstep(1., 2.3, A.r);
        A = mix(A, body + .5 * dark * A, m);
    }

    float g = vn(px * .8) * .45 + vn(px * 2.3) * .3 + vn(vec2(px.x * .045, px.y * 1.6) + 7.) * .25;
    float fibre = smoothstep(.72, .9, vn(vec2(px.x * .035 + vn(px * .02) * 3., px.y * .9))) * .5
        + smoothstep(.75, .9, vn(vec2(px.x * .8, px.y * .03 + 40.))) * .5;
    vec3 paper = uPaper * (1. - .055 * (g - .5) - .022 * fibre);
    vec2 q = v - .5;
    paper *= 1. - .1 * dot(q, q);
    vec3 col = paper * exp(-A);
    col += (h21(px * uDpr + 3.) - .5) * .012;
    o = vec4(col, 1.);
}`;

type Target = { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number };
type Pair = { a: Target; b: Target };
type Pen = {
    on: boolean;
    x: number;
    y: number;
    px: number;
    py: number;
    fresh: boolean;
    gain: number;
    sw: number;
};
type Rewind = { n: number; t: number; dur: number; at: number };

export function createInk(gl: WebGL2RenderingContext): Effect {
    requireFloatTargets(gl);
    const floatLinear = !!gl.getExtension('OES_texture_float_linear');
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    const mapFormat = floatLinear ? gl.RG32F : gl.RG16F;

    const P = {
        splatV: createProgram(gl, FULLSCREEN_VS, fragment(SPLAT_V)),
        advV: createProgram(gl, FULLSCREEN_VS, fragment(ADV_V)),
        div: createProgram(gl, FULLSCREEN_VS, fragment(DIV)),
        jac: createProgram(gl, FULLSCREEN_VS, fragment(JAC)),
        grad: createProgram(gl, FULLSCREEN_VS, fragment(GRAD)),
        advM: createProgram(gl, FULLSCREEN_VS, fragment(ADV_M)),
        mix: createProgram(gl, FULLSCREEN_VS, fragment(MIX)),
        film: createProgram(gl, FULLSCREEN_VS, fragment(FILM)),
        show: createProgram(gl, FULLSCREEN_VS, fragment(SHOW)),
        lay: createProgram(gl, LAY_VS, LAY_FS),
    };

    const emptyVao = gl.createVertexArray();
    const meshVao = gl.createVertexArray();
    const meshBuffer = gl.createBuffer();
    {
        const pts: number[] = [];
        for (let y = 0; y < MESH_N; y += 1) {
            for (let x = 0; x < MESH_N; x += 1) {
                const x0 = x / MESH_N;
                const x1 = (x + 1) / MESH_N;
                const y0 = y / MESH_N;
                const y1 = (y + 1) / MESH_N;
                pts.push(x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1);
            }
        }
        gl.bindVertexArray(meshVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    // ---- GPU resources -----------------------------------------------------------------------

    function makeTarget(w: number, h: number, format: number, filter: number): Target {
        const tex = gl.createTexture();
        const fb = gl.createFramebuffer();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return { tex, fb, w, h };
    }

    function makePair(w: number, h: number, format: number, filter: number): Pair {
        return { a: makeTarget(w, h, format, filter), b: makeTarget(w, h, format, filter) };
    }

    function swap(pair: Pair) {
        const x = pair.a;
        pair.a = pair.b;
        pair.b = x;
    }

    function freeTarget(t: Target | null) {
        if (t) {
            gl.deleteTexture(t.tex);
            gl.deleteFramebuffer(t.fb);
        }
    }

    function freePair(p: Pair | null) {
        if (p) {
            freeTarget(p.a);
            freeTarget(p.b);
        }
    }

    function clearTarget(t: Target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // ---- state --------------------------------------------------------------------------------

    let W = 1;
    let H = 1;
    let DPR = 1;
    let ASP = 1;
    let ready = false;

    let vel: Pair | null = null;
    let prs: Pair | null = null;
    let dvg: Target | null = null;
    let map: Pair | null = null;
    let top: Target | null = null;
    let zero: Target | null = null;
    let stain: Target | null = null;
    let pageCopy: Target | null = null; // mipmapped copy of the host page texture
    let keys: Target[] = [];
    let pool: Target[] = [];
    let KW = 1;

    let stainOn = false;
    let atRest = true;
    let simTime = 0;
    let flowUntil = 0;
    let stepCount = 0;
    let acc = 0;
    let idleSince = 0;
    let rewind: Rewind | null = null;

    const real: Pen = { on: false, x: 0, y: 0, px: 0, py: 0, fresh: true, gain: 0, sw: 0 };
    let lastPx = -1;
    let lastPy = -1;
    let lastMoveAt = -1e9;
    let dragDist = 0;
    let pressed = false;
    let pendingDrop: { u: number; v: number } | null = null;

    // ---- program helpers ----------------------------------------------------------------------

    let cur: Program = P.mix;
    let unit = 0;
    function bindProgram(pr: Program) {
        cur = pr;
        unit = 0;
        gl.useProgram(pr.program);
    }
    function tex(name: string, t: WebGLTexture | Target) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, 'tex' in t ? t.tex : t);
        gl.uniform1i(cur.uniforms[name], unit);
        unit += 1;
    }
    const f1 = (name: string, x: number) => gl.uniform1f(cur.uniforms[name], x);
    const f2 = (name: string, x: number, y: number) => gl.uniform2f(cur.uniforms[name], x, y);

    function into(t: Target | null) {
        if (t) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
            gl.viewport(0, 0, t.w, t.h);
            f1('uY', 1);
        } else {
            // v = 0 is the top of the screen (like the page texture), so flip the final pass.
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            f1('uY', -1);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---- sizes --------------------------------------------------------------------------------

    function releaseSim() {
        freePair(vel);
        freePair(prs);
        freePair(map);
        freeTarget(dvg);
        freeTarget(top);
        freeTarget(zero);
        freeTarget(stain);
        keys.concat(pool).forEach(freeTarget);
        vel = null;
        prs = null;
        map = null;
        dvg = null;
        top = null;
        zero = null;
        stain = null;
        keys = [];
        pool = [];
    }

    function resize(width: number, height: number, dpr: number) {
        W = Math.max(width, 2);
        H = Math.max(height, 2);
        DPR = dpr || 1;
        ASP = W / H;

        gl.activeTexture(gl.TEXTURE0);
        releaseSim();
        const SW = Math.round(SIM_H * ASP);
        const MH = Math.max(260, Math.min(Math.round(H * 0.5), 540));
        const MW = Math.round(MH * ASP);
        KW = Math.round(KEY_H * ASP);
        vel = makePair(SW, SIM_H, gl.RG16F, gl.LINEAR);
        prs = makePair(SW, SIM_H, gl.R16F, gl.NEAREST);
        dvg = makeTarget(SW, SIM_H, gl.R16F, gl.NEAREST);
        map = makePair(MW, MH, mapFormat, gl.LINEAR);
        top = makeTarget(MW, MH, mapFormat, gl.LINEAR);
        zero = makeTarget(4, 4, gl.RGBA16F, gl.LINEAR);
        const stainScale = Math.min(DPR, 1.5);
        stain = makeTarget(
            Math.round(W * stainScale),
            Math.round(H * stainScale),
            gl.R16F,
            gl.LINEAR,
        );
        stainOn = false;
        rewind = null;
        atRest = true;
        flowUntil = 0;
        acc = 0;
        real.fresh = true;
        pendingDrop = null;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        ready = true;
    }

    function ensurePageCopy(w: number, h: number) {
        if (pageCopy && pageCopy.w === w && pageCopy.h === h) {
            return;
        }
        freeTarget(pageCopy);
        const t = gl.createTexture();
        const fb = gl.createFramebuffer();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (aniso) {
            const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
            gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, max));
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        pageCopy = { tex: t, fb, w, h };
    }

    // ---- pigment ------------------------------------------------------------------------------

    function lay(ax: number, ay: number, bx: number, by: number, rr: number, rings: boolean) {
        if (!map || !stain) {
            return;
        }
        bindProgram(P.lay);
        gl.bindVertexArray(meshVao);
        tex('uMap', map.a.tex);
        f2('uA', ax, ay);
        f2('uB', bx, by);
        f1('uR', rr);
        f1('uAsp', ASP);
        f1('uRings', rings ? 1 : 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, stain.fb);
        gl.viewport(0, 0, stain.w, stain.h);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.MAX);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArrays(gl.TRIANGLES, 0, MESH_N * MESH_N * 6);
        gl.disable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.bindVertexArray(emptyVao);
        stainOn = true;
        atRest = false;
    }

    // A press that does not turn into a drag leaves one round drop.
    function drop(u: number, v: number) {
        if (rewind) {
            stopRewind(false);
        }
        lay(u * ASP, v, u * ASP, v, 0.034, true);
        if (!keys.length) {
            pushKey(); // so that settling has something to take back
        }
    }

    // ---- simulation ---------------------------------------------------------------------------

    function splat(ptr: Pen) {
        if (!ptr.on) {
            ptr.fresh = true;
            ptr.sw = 0;
            return;
        }
        if (ptr.fresh || (rewind && ptr.gain < 0.5)) {
            ptr.px = ptr.x;
            ptr.py = ptr.y;
            ptr.fresh = false;
            return;
        }
        if (!vel) {
            return;
        }
        const ax = ptr.px * ASP;
        const ay = ptr.py;
        const bx = ptr.x * ASP;
        const by = ptr.y;
        const dx = bx - ax;
        const dy = by - ay;
        const dist = Math.hypot(dx, dy);
        ptr.px = ptr.x;
        ptr.py = ptr.y;
        if (dist < 1e-5) {
            return;
        }
        let vx = (0.62 * dx) / DT;
        let vy = (0.62 * dy) / DT;
        const cap = 4;
        const sp = Math.hypot(vx, vy);
        if (sp > cap) {
            vx *= cap / sp;
            vy *= cap / sp;
        }
        const spd = Math.min(sp, cap);
        bindProgram(P.splatV);
        tex('uV', vel.a);
        f2('uA', ax, ay);
        f2('uB', bx, by);
        f2('uVel', vx, vy);
        f1('uR', brush());
        f1('uGain', ptr.gain);
        f1('uAsp', ASP);
        into(vel.b);
        swap(vel);
        if (ptr.gain > 0.5) {
            // The comb lays more the faster it moves, so a stroke swells from a point and tails off.
            const want = Math.min(spd / 0.75, 1);
            ptr.sw += (want - ptr.sw) * 0.22;
            const rNow = 0.025 * ptr.sw * ptr.sw * (3 - 2 * ptr.sw);
            if (rNow > 0.0012) {
                lay(ax, ay, bx, by, rNow, false);
            }
        }
        flowUntil = simTime + 4.2 / damping() + 0.25;
        if (rewind) {
            stopRewind(false);
        }
        atRest = false;
    }

    function step() {
        if (!vel || !prs || !dvg || !map) {
            return;
        }
        simTime += DT;
        stepCount += 1;
        splat(real);
        if (simTime < flowUntil) {
            const tx = 1 / vel.a.w;
            const ty = 1 / vel.a.h;
            bindProgram(P.advV);
            tex('uV', vel.a);
            f2('uTexel', tx, ty);
            f1('uDt', DT);
            f1('uDamp', Math.exp(-damping() * DT));
            f1('uAsp', ASP);
            into(vel.b);
            swap(vel);
            bindProgram(P.div);
            tex('uV', vel.a);
            f2('uTexel', tx, ty);
            into(dvg);
            bindProgram(P.jac);
            f2('uTexel', tx, ty);
            for (let i = 0; i < JACOBI_ITERATIONS; i += 1) {
                unit = 0;
                tex('uP', prs.a);
                tex('uDiv', dvg);
                into(prs.b);
                swap(prs);
            }
            bindProgram(P.grad);
            tex('uP', prs.a);
            tex('uV', vel.a);
            f2('uTexel', tx, ty);
            into(vel.b);
            swap(vel);
            bindProgram(P.advM);
            tex('uV', vel.a);
            tex('uM', map.a);
            f1('uDt', DT);
            f1('uAsp', ASP);
            into(map.b);
            swap(map);
            if (stepCount % 4 === 0) {
                pushKey();
            }
        } else if (flowUntil) {
            clearTarget(vel.a);
            clearTarget(vel.b);
            clearTarget(prs.a);
            clearTarget(prs.b);
            flowUntil = 0;
        }
    }

    function copy(src: Target, dst: Target) {
        if (!zero) {
            return;
        }
        bindProgram(P.mix);
        tex('uA', src);
        tex('uB', zero);
        f1('uT', 0);
        into(dst);
    }

    // The stir is remembered as a film of small snapshots of the map, so it can be run backwards.
    function pushKey() {
        if (!map) {
            return;
        }
        if (keys.length >= KEY_MAX) {
            const kept: Target[] = [];
            keys.forEach((k, i) => ((keys.length - 1 - i) % 2 === 0 ? kept : pool).push(k));
            keys = kept;
        }
        const k = pool.pop() ?? makeTarget(KW, KEY_H, mapFormat, gl.LINEAR);
        copy(map.a, k);
        keys.push(k);
    }

    function startRewind() {
        if (rewind || !keys.length || !map || !top || !vel || !prs) {
            return false;
        }
        copy(map.a, top);
        clearTarget(vel.a);
        clearTarget(vel.b);
        clearTarget(prs.a);
        clearTarget(prs.b);
        flowUntil = 0;
        const n = keys.length + 1;
        rewind = { n, t: 0, dur: Math.max(1.1, Math.min(0.9 + 0.03 * n, 4.4)), at: n };
        return true;
    }

    function frameAt(i: number): Target {
        if (i <= 0) {
            return zero as Target;
        }
        return i <= keys.length ? keys[i - 1] : (top as Target);
    }

    function rewindStep(dt: number) {
        const r = rewind;
        if (!r || !map) {
            return;
        }
        r.t = Math.min(r.t + dt / r.dur, 1);
        const e = r.t < 0.5 ? 4 * r.t * r.t * r.t : 1 - Math.pow(-2 * r.t + 2, 3) / 2;
        r.at = r.n * (1 - e);
        const i = Math.min(Math.floor(r.at), r.n - 1);
        bindProgram(P.film);
        tex('uA', frameAt(i));
        tex('uB', frameAt(i + 1));
        f1('uT', r.at - i);
        into(map.b);
        swap(map);
        if (r.t >= 1) {
            stopRewind(true);
        }
    }

    function stopRewind(done: boolean) {
        if (!rewind) {
            return;
        }
        if (done) {
            pool.push(...keys);
            keys = [];
            if (map) {
                clearTarget(map.a);
            }
            if (stain) {
                clearTarget(stain);
            }
            stainOn = false;
            atRest = true;
        } else {
            const keep = Math.min(Math.floor(rewind.at), keys.length);
            pool.push(...keys.splice(keep));
        }
        rewind = null;
    }

    // ---- drawing ------------------------------------------------------------------------------

    function draw(frame: EffectFrame) {
        if (!map || !stain || !zero) {
            return;
        }
        // The host page has no mipmaps; the shader reads the sheet at the scale the stir gives it.
        const pw = Math.max(1, Math.round(frame.pageSize.width));
        const ph = Math.max(1, Math.round(frame.pageSize.height));
        ensurePageCopy(pw, ph);
        if (!pageCopy) {
            return;
        }
        bindProgram(P.mix);
        tex('uA', frame.pageTexture);
        tex('uB', zero);
        f1('uT', 0);
        into(pageCopy);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, pageCopy.tex);
        gl.generateMipmap(gl.TEXTURE_2D);

        bindProgram(P.show);
        tex('uPage', pageCopy);
        tex('uMap', map.a);
        tex('uSt', stain);
        let stainAmount = 0;
        if (stainOn) {
            stainAmount = rewind
                ? 1 - Math.pow(Math.min(1, Math.max(0, (rewind.t - 0.5) / 0.42)), 2)
                : 1;
        }
        f1('uStain', stainAmount);
        f1('uDpr', DPR);
        f2('uCss', W, H);
        f2('uMapTexel', 1 / map.a.w, 1 / map.a.h);
        f2('uPageSize', pw, ph);
        into(null);
    }

    // ---- input --------------------------------------------------------------------------------

    function pointerEvent(kind: PointerEventKind, pointer: PointerState) {
        if (kind === 'down') {
            dragDist = 0;
            pressed = true;
            real.fresh = true;
            lastPx = pointer.x;
            lastPy = pointer.y;
        } else if (kind === 'up') {
            if (pressed && dragDist < 4) {
                pendingDrop = { u: pointer.x / W, v: pointer.y / H };
            }
            pressed = false;
        } else if (kind === 'leave') {
            real.on = false;
            real.fresh = true;
        }
    }

    function render(frame: EffectFrame) {
        if (!ready || !map) {
            return;
        }
        const p = frame.pointer;
        const now = frame.time;

        if (p.x !== lastPx || p.y !== lastPy) {
            if ((p.down || pressed) && lastPx >= 0) {
                dragDist += Math.hypot(p.x - lastPx, p.y - lastPy);
            }
            lastPx = p.x;
            lastPy = p.y;
            lastMoveAt = now;
        }

        // Drag stirs hard and lays pigment; a hand merely passing over the water stirs lightly.
        if (p.down) {
            real.on = true;
            real.gain = 0.95;
        } else if (p.inside && now - lastMoveAt < HOVER_HOLD_SECONDS) {
            real.on = true;
            real.gain = 0.22;
        } else {
            real.on = false;
        }
        real.x = p.x / W;
        real.y = p.y / H;

        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.CULL_FACE);
        gl.bindVertexArray(emptyVao);

        if (pendingDrop) {
            drop(pendingDrop.u, pendingDrop.v);
            pendingDrop = null;
            idleSince = now;
        }

        const busy = real.on || simTime < flowUntil;
        if (busy || rewind) {
            acc = Math.min(acc + frame.dt, 2 * DT + 0.001);
            while (acc >= DT) {
                acc -= DT;
                if (rewind && !(real.on && real.gain > 0.5)) {
                    rewindStep(DT);
                } else {
                    step();
                }
            }
            idleSince = now;
        } else {
            acc = 0;
            // Left alone, the sheet finds its way back.
            if (!atRest && now - idleSince > IDLE_SETTLE_SECONDS) {
                startRewind();
                idleSince = now;
            }
        }

        draw(frame);

        gl.bindVertexArray(null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.disable(gl.BLEND);
        gl.activeTexture(gl.TEXTURE0);
    }

    // The Reset button: run the stir backwards right away instead of waiting for the idle timer.
    function reset() {
        startRewind();
    }

    function dispose() {
        releaseSim();
        freeTarget(pageCopy);
        pageCopy = null;
        Object.values(P).forEach((pr) => gl.deleteProgram(pr.program));
        gl.deleteVertexArray(emptyVao);
        gl.deleteVertexArray(meshVao);
        gl.deleteBuffer(meshBuffer);
        ready = false;
    }

    return {
        name: 'ink',
        resize,
        pointerEvent,
        pageInteractive: () => atRest,
        reset,
        render,
        dispose,
    };
}
