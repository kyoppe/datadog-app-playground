// Bar renderer: the live page (a table of metric values) is the ground of a small board and one
// box stands on every cell, as tall as the cell's value (a 3D bar chart).
//
// World units: Y is up. The board is centred on the origin, its width (x) is 1 and its depth (z) is
// pageHeight / pageWidth, so page px map to world with one scale: x = (px - pw / 2) / pw, z likewise.
// The page TOP is z = -depth / 2 (the back); the default camera stands at +z looking towards -z, so
// the headers sit at the back and the series names on the left.
//
// Rendering: background gradient + slab + page quad + shadows (from a depth map) + instanced boxes into a
// multisampled framebuffer of our own (the default framebuffer has no depth), resolved into a
// texture and drawn to the default framebuffer with a full-screen pass.
import { createProgram, type Program } from './glUtils';
import type { BarFrame, BarPick, BarRenderer, BarScene } from './types';

// ------------------------------------------------------------------ constants
const DEG = Math.PI / 180;
const DEF_YAW = 35 * DEG;
const DEF_PITCH = 48 * DEG;
// The opening shot, as a path: a close-up at the front corner, a low flight along the board
// just above the bars, then out and up to the usual view. Per key: seconds, yaw (degrees from the
// usual one), pitch (degrees), zoom (distance, small = close) and where the camera looks along the
// board (a share of its half width).
const INTRO_KEYS: [number, number, number, number, number][] = [
    [0, -58, 17, 0.28, -0.62],
    [1.0, -50, 15, 0.27, -0.5],
    [3.0, -4, 21, 0.3, 0.55],
    [4.0, 18, 32, 0.5, 0.35],
    [6.0, 0, 48, 1, 0],
];
// How far the view can tip, as in Sheet City: never quite flat (about 11 degrees above the table)
// and never straight down (about 70 degrees), so it never goes under the board or over the top.
// Turning round the table is not limited.
const PITCH_MIN = 0.2;
const PITCH_MAX = 1.22;
const FOV = 30 * DEG;
const ZOOM_MIN = 0.14;
const ZOOM_MAX = 2.5;
const FLOATS = 16; // per instance
const SLAB_T = 0.008; // slab thickness
const SLAB_M = 0.018; // slab margin around the page
const SLAB_TOP = -0.002;
const SETTLE_TAU = 0.1; // exponential smoothing time constant, about 0.3 s to settle
const LIGHT = normalize3([-0.45, 0.8, 0.5]);
// Shadows fall behind the bars and a little to the right, so that every one shows on the board
// beyond its bar.
const SHADOW_DIR = normalize2([0.6, -1]);
// How far a shadow falls from a bar, per unit of its height (the light is low).
const SHADOW_REACH = 1.3;

// The light that casts the shadows, as a direction towards it.
const SHADOW_LIGHT = normalize3([-SHADOW_DIR[0] * SHADOW_REACH, 1, -SHADOW_DIR[1] * SHADOW_REACH]);
const SHADOW_MAP_SIZE = 2048;

// The table the board stands on: a big plain top that fades into the dark room.
const DESK_SIZE = 9;
const DESK_Y = -SLAB_T - 0.0005;

// ------------------------------------------------------------------ GLSL
const FULLSCREEN_VS = `#version 300 es
precision highp float;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const BG_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
out vec4 o;
void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    float t = 1.0 - uv.y;
    vec3 c0 = vec3(8.0, 10.0, 32.0) / 255.0;
    vec3 c1 = vec3(19.0, 15.0, 50.0) / 255.0;
    vec3 c = mix(c0, c1, smoothstep(0.0, 1.0, t));
    float r = length((uv - vec2(0.5, 0.48)) * vec2(uRes.x / uRes.y, 1.0));
    c += vec3(0.03, 0.025, 0.07) * (1.0 - smoothstep(0.0, 0.75, r));
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    c += (n - 0.5) / 255.0;
    o = vec4(c, 1.0);
}
`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
out vec4 o;
void main() {
    o = vec4(texelFetch(uTex, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
}
`;

const PAGE_TEX = `
uniform sampler2D uPage;
vec3 pageTex(vec2 uv) {
    vec2 dx = dFdx(uv) * 0.35;
    vec2 dy = dFdy(uv) * 0.35;
    vec3 c = texture(uPage, uv + dx + dy).rgb;
    c += texture(uPage, uv + dx - dy).rgb;
    c += texture(uPage, uv - dx + dy).rgb;
    c += texture(uPage, uv - dx - dy).rgb;
    return c * 0.25;
}
`;

// Shadows come from one depth map drawn from the light (the board, its bars and the slab), so a
// bar shades the table, the board and its neighbours alike, and every shadow has the same tone.
const SHADOW_LIB = `
uniform highp sampler2DShadow uShadowMap;
uniform mat4 uLightVP;
uniform float uTexel;
// How much of the light reaches a point: 1 = lit, 0 = in shadow (a little soft at the edge).
float lit(vec3 world, vec3 n) {
    vec4 c = uLightVP * vec4(world + n * 0.0035, 1.0);
    vec3 s = c.xyz * 0.5 + 0.5;
    if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) return 1.0;
    float sum = 0.0;
    for (int i = -1; i <= 1; i++) {
        for (int j = -1; j <= 1; j++) {
            sum += texture(uShadowMap, vec3(s.xy + vec2(float(i), float(j)) * uTexel, s.z - 0.0012));
        }
    }
    return sum / 9.0;
}
`;

const GROUND_VS = `#version 300 es
precision highp float;
uniform mat4 uVP;
uniform vec2 uHalf;
out vec2 vUV;
out vec3 vWorld;
void main() {
    vec2 cn = vec2(float(gl_VertexID & 1) * 2.0 - 1.0, float(gl_VertexID >> 1) * 2.0 - 1.0);
    vUV = cn * 0.5 + 0.5;
    vWorld = vec3(cn.x * uHalf.x, 0.0, cn.y * uHalf.y);
    gl_Position = uVP * vec4(vWorld, 1.0);
}
`;

const GROUND_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vWorld;
out vec4 o;
${PAGE_TEX}
${SHADOW_LIB}
void main() {
    vec3 c = pageTex(vUV) * 0.97;
    // on the board the shadows are lighter, so the numbers stay easy to read
    c = mix(c, vec3(0.02, 0.015, 0.07), 0.36 * (1.0 - lit(vWorld, vec3(0.0, 1.0, 0.0))));
    o = vec4(c, 1.0);
}
`;

const DESK_VS = `#version 300 es
precision highp float;
uniform mat4 uVP;
uniform float uSize;
uniform float uY;
out vec2 vXZ;
void main() {
    vec2 cn = vec2(float(gl_VertexID & 1) * 2.0 - 1.0, float(gl_VertexID >> 1) * 2.0 - 1.0);
    vXZ = cn * uSize;
    gl_Position = uVP * vec4(vXZ.x, uY, vXZ.y, 1.0);
}
`;

// A plain, matte table top, like a meeting room's: one even colour, a soft pool of light under
// the board, and a fade into the dark room at the far edge. No pattern.
const DESK_FS = `#version 300 es
precision highp float;
in vec2 vXZ;
uniform float uY;
out vec4 o;
${SHADOW_LIB}
void main() {
    float r = length(vXZ);
    vec3 c = vec3(0.50, 0.485, 0.47);
    c *= 0.70 + 0.44 * (1.0 - smoothstep(0.3, 3.5, r));
    c = mix(c, vec3(0.02, 0.015, 0.07), 0.5 * (1.0 - lit(vec3(vXZ.x, uY, vXZ.y), vec3(0.0, 1.0, 0.0))));
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    c += (n - 0.5) / 255.0;
    o = vec4(c, 1.0 - smoothstep(3.0, 7.0, r));
}
`;

const BUILDING_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNor;
layout(location = 2) in vec4 aRect;   // cx, cz, half x, half z
layout(location = 3) in vec4 aA;      // base, height, flags, shadow top
layout(location = 4) in vec4 aCol;    // rgb
layout(location = 5) in vec4 aUV;     // roof uv rect u0 v0 u1 v1
uniform mat4 uVP;
out vec3 vWorld;
out vec3 vN;
flat out vec4 vRect;
flat out vec4 vA;     // base, top, flags, unused
flat out vec3 vCol;
flat out vec4 vUV;
flat out int vInst;
void main() {
    vec3 p = vec3(
        aRect.x + aPos.x * aRect.z,
        aA.x + aPos.y * aA.y,
        aRect.y + aPos.z * aRect.w
    );
    vWorld = p;
    vN = aNor;
    vRect = aRect;
    vA = vec4(aA.x, aA.x + aA.y, aA.z, 0.0);
    vCol = aCol.rgb;
    vUV = aUV;
    vInst = gl_InstanceID;
    gl_Position = aA.y < 0.0015 ? vec4(2.0, 2.0, 2.0, 1.0) : uVP * vec4(p, 1.0);
}
`;

const BUILDING_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vN;
flat in vec4 vRect;
flat in vec4 vA;
flat in vec3 vCol;
flat in vec4 vUV;
flat in int vInst;
uniform vec3 uL;
uniform float uTime;
uniform float uHoverAmt;
uniform int uHover;
uniform vec3 uLd;      // towards the shadow light
out vec4 o;
${PAGE_TEX}
${SHADOW_LIB}
float hash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}
vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }

void main() {
    vec3 n = normalize(vN);
    float base = vA.x;
    float top = vA.y;
    float alert = step(0.5, mod(vA.z, 2.0));
    float stk = step(1.5, mod(vA.z, 4.0));
    float slab = step(3.5, vA.z);
    float hv = (vInst == uHover) ? uHoverAmt : 0.0;
    vec2 e2 = vec2(vRect.z - abs(vWorld.x - vRect.x), vRect.w - abs(vWorld.z - vRect.y));
    float edge = min(e2.x, e2.y);
    float pulse = 0.5 + 0.5 * sin(uTime * 3.0);
    vec3 red = vec3(1.0, 0.2, 0.18);

    // roof uv (computed outside any branch: it feeds derivatives)
    vec2 f = vec2(
        (vWorld.x - (vRect.x - vRect.z)) / max(2.0 * vRect.z, 1e-4),
        (vWorld.z - (vRect.y - vRect.w)) / max(2.0 * vRect.w, 1e-4)
    );
    vec2 uv = clamp(mix(vUV.xy, vUV.zw, f), vUV.xy, vUV.zw);
    vec3 paper = pageTex(uv);

    float sh = lit(vWorld, n);
    vec3 c;
    if (n.y > 0.5) {
        if (slab > 0.5) {
            c = vCol * 1.15;
        } else {
            vec3 tint = mix(vec3(1.0), clamp(vCol * 1.3 + 0.15, 0.0, 1.0), 0.16);
            c = paper * tint * 0.98;
            c = mix(c, c * vec3(1.0, 0.55, 0.5), alert * 0.7);
            c += red * alert * (0.16 + 0.12 * pulse);
            float rim = 1.0 - smoothstep(0.0018, 0.003, edge);
            vec3 rimCol = mix(c * 0.72, red, alert * 0.8);
            c = mix(c, rimCol, rim * 0.55);
            float ho = 1.0 - smoothstep(0.003, 0.006, edge);
            c = mix(c, vec3(1.0, 0.95, 0.7), ho * hv);
            c += 0.05 * hv;
        }
        c = mix(c, vec3(0.02, 0.015, 0.07), 0.36 * (1.0 - sh));
    } else if (n.y < -0.5) {
        c = vCol * 0.4;
    } else {
        float y = vWorld.y;
        float s = abs(n.x) > 0.5 ? vWorld.z : vWorld.x;
        // a wall that faces the shadow light is darkened by whatever stands in front of it
        float wallSh = dot(n, uLd) > 0.0 ? sh : 1.0;
        float l = 0.4 + 0.14 * (n.y * 0.5 + 0.5) + 0.62 * max(dot(n, uL), 0.0);
        l *= mix(0.62, 1.0, wallSh);
        float ao = mix(0.55, 1.0, smoothstep(0.0, 0.07, y));
        vec3 res = toSrgb(toLin(vCol) * l * ao);
        float seam = stk * step(0.001, base) * (1.0 - smoothstep(0.0015, 0.003, y - base));
        res *= 1.0 - 0.55 * seam;
        res *= 1.0 + 0.12 * (1.0 - smoothstep(0.0, 0.006, top - y));
        res += red * alert * 0.35 * (1.0 - smoothstep(0.0, 0.05, top - y)) * (0.6 + 0.4 * pulse);
        res = res * (1.0 + 0.22 * hv) + 0.05 * hv;
        c = res;
    }
    o = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

const DEPTH_FS = `#version 300 es
precision highp float;
void main() {}
`;

// ------------------------------------------------------------------ math helpers
function normalize3(v: number[]): [number, number, number] {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}

function normalize2(v: number[]): [number, number] {
    const l = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / l, v[1] / l];
}

function wrapPi(a: number) {
    return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

function mul4(a: Float32Array, b: Float32Array, out: Float32Array) {
    for (let c = 0; c < 4; c += 1) {
        for (let r = 0; r < 4; r += 1) {
            let s = 0;
            for (let k = 0; k < 4; k += 1) {
                s += a[k * 4 + r] * b[c * 4 + k];
            }
            out[c * 4 + r] = s;
        }
    }
}

type Vec3 = [number, number, number];

/** Rows of the rotation Rx(pitch) * Ry(yaw): view = R * (p - target), then z -= dist. */
function rotationRows(yaw: number, pitch: number): [Vec3, Vec3, Vec3] {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    return [
        [c, 0, s],
        [sp * s, cp, -sp * c],
        [-cp * s, sp, cp * c],
    ];
}

type Camera = {
    vp: Float32Array;
    r0: Vec3;
    r1: Vec3;
    r2: Vec3;
    eye: Vec3;
    tanV: number;
    tanH: number;
};

function dot3(a: Vec3, b: Vec3) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function buildCamera(
    aspect: number,
    yaw: number,
    pitch: number,
    dist: number,
    target: Vec3,
    out: Camera,
) {
    const [r0, r1, r2] = rotationRows(yaw, pitch);
    const v = new Float32Array(16);
    v[0] = r0[0];
    v[1] = r1[0];
    v[2] = r2[0];
    v[4] = r0[1];
    v[5] = r1[1];
    v[6] = r2[1];
    v[8] = r0[2];
    v[9] = r1[2];
    v[10] = r2[2];
    v[12] = -dot3(r0, target);
    v[13] = -dot3(r1, target);
    v[14] = -dot3(r2, target) - dist;
    v[15] = 1;
    const near = Math.max(0.01, dist * 0.03);
    const far = dist + 14;
    const tanV = Math.tan(FOV / 2);
    const f = 1 / tanV;
    const p = new Float32Array(16);
    p[0] = f / aspect;
    p[5] = f;
    p[10] = (far + near) / (near - far);
    p[11] = -1;
    p[14] = (2 * far * near) / (near - far);
    mul4(p, v, out.vp);
    out.r0 = r0;
    out.r1 = r1;
    out.r2 = r2;
    out.eye = [target[0] + dist * r2[0], target[1] + dist * r2[1], target[2] + dist * r2[2]];
    out.tanV = tanV;
    out.tanH = tanV * aspect;
}

// ------------------------------------------------------------------ unit box
function buildBox() {
    // x, z in [-1, 1], y in [0, 1]; interleaved position + normal; 36 vertices.
    const faces: Array<{ n: Vec3; c: Vec3[] }> = [
        {
            n: [0, 1, 0],
            c: [
                [-1, 1, -1],
                [1, 1, -1],
                [1, 1, 1],
                [-1, 1, 1],
            ],
        },
        {
            n: [0, -1, 0],
            c: [
                [-1, 0, -1],
                [-1, 0, 1],
                [1, 0, 1],
                [1, 0, -1],
            ],
        },
        {
            n: [1, 0, 0],
            c: [
                [1, 0, -1],
                [1, 0, 1],
                [1, 1, 1],
                [1, 1, -1],
            ],
        },
        {
            n: [-1, 0, 0],
            c: [
                [-1, 0, -1],
                [-1, 1, -1],
                [-1, 1, 1],
                [-1, 0, 1],
            ],
        },
        {
            n: [0, 0, 1],
            c: [
                [-1, 0, 1],
                [1, 0, 1],
                [1, 1, 1],
                [-1, 1, 1],
            ],
        },
        {
            n: [0, 0, -1],
            c: [
                [-1, 0, -1],
                [-1, 1, -1],
                [1, 1, -1],
                [1, 0, -1],
            ],
        },
    ];
    const data: number[] = [];
    for (const face of faces) {
        for (const i of [0, 1, 2, 0, 2, 3]) {
            data.push(...face.c[i], ...face.n);
        }
    }
    return new Float32Array(data);
}

// ------------------------------------------------------------------ renderer
export function createBarRenderer(gl: WebGL2RenderingContext): BarRenderer {
    const bgProg = createProgram(gl, FULLSCREEN_VS, BG_FS);
    const compProg = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS);
    const groundProg = createProgram(gl, GROUND_VS, GROUND_FS);
    const depthProg = createProgram(gl, BUILDING_VS, DEPTH_FS);
    const bldProg = createProgram(gl, BUILDING_VS, BUILDING_FS);
    const deskProg = createProgram(gl, DESK_VS, DESK_FS);
    const programs: Program[] = [bgProg, compProg, groundProg, depthProg, bldProg, deskProg];

    // geometry
    const boxVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, boxVbo);
    gl.bufferData(gl.ARRAY_BUFFER, buildBox(), gl.STATIC_DRAW);
    const instBuf = gl.createBuffer();
    const slabBuf = gl.createBuffer();
    let instCapacity = 0;

    function setupInstanceAttribs(buffer: WebGLBuffer | null) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        for (let k = 0; k < 4; k += 1) {
            gl.enableVertexAttribArray(2 + k);
            gl.vertexAttribPointer(2 + k, 4, gl.FLOAT, false, FLOATS * 4, k * 16);
            gl.vertexAttribDivisor(2 + k, 1);
        }
    }

    function makeBoxVao(buffer: WebGLBuffer | null) {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, boxVbo);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        setupInstanceAttribs(buffer);
        return vao;
    }

    const bldVao = makeBoxVao(instBuf);
    const slabVao = makeBoxVao(slabBuf);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // the depth map seen from the light (texture unit 2)
    const shadowTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.DEPTH_COMPONENT24,
        SHADOW_MAP_SIZE,
        SHADOW_MAP_SIZE,
        0,
        gl.DEPTH_COMPONENT,
        gl.UNSIGNED_INT,
        null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.activeTexture(gl.TEXTURE0);
    const shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const lightVP = new Float32Array(16);

    // render targets, (re)allocated lazily in render()
    let msFbo: WebGLFramebuffer | null = null;
    let msColor: WebGLRenderbuffer | null = null;
    let msDepth: WebGLRenderbuffer | null = null;
    let resFbo: WebGLFramebuffer | null = null;
    let resTex: WebGLTexture | null = null;
    let targetW = 0;
    let targetH = 0;

    function freeTargets() {
        gl.deleteFramebuffer(msFbo);
        gl.deleteRenderbuffer(msColor);
        gl.deleteRenderbuffer(msDepth);
        gl.deleteFramebuffer(resFbo);
        gl.deleteTexture(resTex);
        msFbo = msColor = msDepth = resFbo = resTex = null;
    }

    function ensureTargets(w: number, h: number) {
        if (w === targetW && h === targetH && msFbo) {
            return;
        }
        freeTargets();
        targetW = w;
        targetH = h;
        const formats = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES);
        let samples = 0;
        for (let i = 0; i < formats.length; i += 1) {
            if (formats[i] <= 4) {
                samples = formats[i];
                break;
            }
        }
        msColor = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, msColor);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
        msDepth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, msDepth);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        msFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msColor);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msDepth);
        const msOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

        gl.activeTexture(gl.TEXTURE1);
        resTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, resTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.activeTexture(gl.TEXTURE0);
        resFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, resFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resTex, 0);
        const resOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!msOk || !resOk) {
            throw new Error('Bar renderer: framebuffer is incomplete.');
        }
    }

    // ---------------------------------------------------------- scene state
    let scene: BarScene | null = null;
    let count = 0;
    // The playful rearranging: every bar that has to move waits a random moment, hops, and
    // settles with a few bounces (a spring that is not quite damped).
    let springing = false;
    let vel = new Float32Array(0);
    let delay = new Float32Array(0);
    let springK = new Float32Array(0);
    let springC = new Float32Array(0);
    let cur = new Float32Array(0); // per instance: cx, cz, hx, hz, base, height (animated)
    let tgt = new Float32Array(0);
    let inst = new Float32Array(0);
    let colTop = new Float32Array(0);
    let stackedMode = false;
    let cols = 1;
    let instDirty = true;

    // board
    let boardHx = 0.5;
    let boardHz = 0.333; // where the board should be
    let boardHzCur = 0.333; // where it is drawn right now: it glides there
    let boardPlaced = false;
    let firstScene = true;
    let maxH = 0.1;
    let boardKey = '';
    const slabData = new Float32Array(FLOATS);

    // The tallest bar: a share of the board's shorter side, but never under a few cells' worth, so
    // a table with only a handful of rows still gets bars with some presence.
    const HEIGHT_SHARE = 0.34;
    const MIN_HEIGHT_CELLS = 5;

    // The slab (the board's thick base and frame) is drawn from the depth shown right now.
    function writeSlab() {
        slabData.set([0, 0, boardHx + SLAB_M, boardHzCur + SLAB_M], 0);
        slabData.set([-SLAB_T, SLAB_T + SLAB_TOP, 4, 0], 4);
        // A light lavender grey: the board has to stand out from the dark indigo behind it.
        slabData.set([0.6, 0.58, 0.8, 0], 8);
        slabData.set([0, 0, 1, 1], 12);
        gl.bindBuffer(gl.ARRAY_BUFFER, slabBuf);
        gl.bufferData(gl.ARRAY_BUFFER, slabData, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    // When the table changes size (stacking collapses it to one row) the board shrinks or grows
    // to the new depth instead of jumping: a quick ease, and the camera follows it.
    function glideBoard(dt: number) {
        if (boardHzCur === boardHz) {
            return;
        }
        const next = boardHzCur + (boardHz - boardHzCur) * (1 - Math.exp(-dt / 0.11));
        boardHzCur = Math.abs(boardHz - next) < 1e-4 ? boardHz : next;
        writeSlab();
        fitKey = '';
    }

    function setBoard(pw: number, ph: number, cellH: number) {
        const key = `${pw}x${ph}x${cellH}`;
        if (key === boardKey) {
            return;
        }
        boardKey = key;
        boardHx = 0.5;
        boardHz = (0.5 * ph) / pw;
        maxH = Math.max(HEIGHT_SHARE * Math.min(1, ph / pw), (MIN_HEIGHT_CELLS * cellH) / pw);
        if (!boardPlaced) {
            boardPlaced = true;
            boardHzCur = boardHz;
        }
        writeSlab();
        fitKey = '';
    }

    function applyScene(s: BarScene) {
        scene = s;
        const rows = Math.max(1, s.rows);
        cols = Math.max(1, s.cols);
        const n = Math.max(0, Math.min(s.cells.length, s.values.length, rows * cols));
        const pw = Math.max(1, s.pageWidth);
        const ph = Math.max(1, s.pageHeight);
        // The cells' average height (page px) sets what "a cell's worth" of height means.
        let cellSum = 0;
        let cellCount = 0;
        for (let i = 0; i < n; i += 1) {
            if (s.cells[i].h > 0) {
                cellSum += s.cells[i].h;
                cellCount += 1;
            }
        }
        setBoard(pw, ph, cellCount > 0 ? Math.round(cellSum / cellCount) : 0);
        if (firstScene) {
            // The very first table is simply there; only later changes glide.
            firstScene = false;
            boardHzCur = boardHz;
            writeSlab();
            fitKey = '';
        }
        if (introPending && cellCount > 0 && s.max > 0) {
            introPending = false;
            introT = 0;
            resetting = false;
        }
        const sc = 1 / pw;
        const max = s.max > 0 ? s.max : 1;
        stackedMode = s.stacked;

        const nt = new Float32Array(n * 6);
        const ni = new Float32Array(n * FLOATS);

        // Stacked scale: the tallest TOWER must fit in maxH. A tower can be taller than a single
        // value / max (it is a sum), so scale by max(scene.max, largest column sum): a single
        // cell never exceeds maxH and a tower never does either.
        const colSum = new Float64Array(cols);
        const colX0 = new Float64Array(cols).fill(Infinity);
        const colX1 = new Float64Array(cols).fill(-Infinity);
        let avgH = 0;
        for (let i = 0; i < n; i += 1) {
            const c = i % cols;
            const v = s.values[i];
            if (Number.isFinite(v)) {
                colSum[c] += Math.max(0, v);
            }
            const cell = s.cells[i];
            colX0[c] = Math.min(colX0[c], cell.x);
            colX1[c] = Math.max(colX1[c], cell.x + cell.w);
            avgH += cell.h;
        }
        avgH = n > 0 ? avgH / n : 0;
        let maxSum = 0;
        for (let c = 0; c < cols; c += 1) {
            maxSum = Math.max(maxSum, colSum[c]);
        }
        const stackScale = maxH / Math.max(max, maxSum, 1e-9);
        const run = new Float64Array(cols); // running base per column

        for (let i = 0; i < n; i += 1) {
            const cell = s.cells[i];
            const row = Math.floor(i / cols);
            const c = i % cols;
            const v = s.values[i];
            const fin = Number.isFinite(v);
            const m = Math.min(cell.w, cell.h) * 0.1;
            const o = i * 6;
            if (stackedMode) {
                const w = colX1[c] - colX0[c];
                nt[o] = ((colX0[c] + colX1[c]) / 2 - pw / 2) * sc;
                nt[o + 1] = 0;
                nt[o + 2] = Math.max(0.002, (w / 2 - Math.min(w, avgH) * 0.1) * sc);
                nt[o + 3] = 0.6 * avgH * sc;
                const h = fin ? Math.max(0, v) * stackScale : 0;
                nt[o + 4] = run[c];
                nt[o + 5] = h;
                run[c] += h;
            } else {
                nt[o] = (cell.x + cell.w / 2 - pw / 2) * sc;
                nt[o + 1] = (cell.y + cell.h / 2 - ph / 2) * sc;
                nt[o + 2] = Math.max(0.002, (cell.w / 2 - m) * sc);
                nt[o + 3] = Math.max(0.002, (cell.h / 2 - m) * sc);
                nt[o + 4] = 0;
                nt[o + 5] = fin ? Math.min(1, Math.max(0, v) / max) * maxH : 0;
            }
            // statics
            const q = i * FLOATS;
            const rc = s.rowColors[row] ?? [0.6, 0.6, 0.7];
            ni[q + 6] = (fin && v >= s.alertAt ? 1 : 0) + (stackedMode ? 2 : 0);
            ni[q + 8] = rc[0];
            ni[q + 9] = rc[1];
            ni[q + 10] = rc[2];
            ni[q + 12] = (cell.x + m) / pw;
            ni[q + 13] = (cell.y + m) / ph;
            ni[q + 14] = (cell.x + cell.w - m) / pw;
            ni[q + 15] = (cell.y + cell.h - m) / ph;
        }

        // keep the animated state of the cells that already exist; new ones grow from zero
        const nc = new Float32Array(n * 6);
        const keep = Math.min(count, n);
        nc.set(cur.subarray(0, keep * 6));
        for (let i = keep; i < n; i += 1) {
            const o = i * 6;
            nc[o] = nt[o];
            nc[o + 1] = nt[o + 1];
            nc[o + 2] = nt[o + 2];
            nc[o + 3] = nt[o + 3];
            nc[o + 4] = nt[o + 4];
            nc[o + 5] = 0;
        }
        // the bars that have to move scramble: a random wait, a hop, a few bounces
        if (s.playful) {
            vel = new Float32Array(n * 6);
            delay = new Float32Array(n);
            springK = new Float32Array(n);
            springC = new Float32Array(n);
            for (let i = 0; i < n; i += 1) {
                const o = i * 6;
                let moves = false;
                for (let j = 0; j < 6; j += 1) {
                    if (Math.abs(nt[o + j] - nc[o + j]) > 1e-4) {
                        moves = true;
                    }
                }
                delay[i] = moves ? Math.random() * 0.45 : 0;
                springK[i] = 120 + Math.random() * 110;
                springC[i] = 2 * (0.17 + Math.random() * 0.15) * Math.sqrt(springK[i]);
                // a hop as it starts, so the bars jump about before they settle
                vel[o + 5] = moves ? (1.2 + Math.random() * 2.8) * maxH : 0;
            }
            springing = true;
        }
        if (!s.playful && vel.length !== n * 6) {
            springing = false; // the bars it was for are gone
        }
        cur = nc;
        tgt = nt;
        inst = ni;
        count = n;
        colTop = new Float32Array(cols);
        instDirty = true;
        if (n > instCapacity) {
            instCapacity = Math.max(n, 64);
            gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
            gl.bufferData(gl.ARRAY_BUFFER, instCapacity * FLOATS * 4, gl.DYNAMIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }
    }

    // ---------------------------------------------------------- camera state
    let yaw = DEF_YAW;
    let pitch = DEF_PITCH;
    let yawV = 0;
    let pitchV = 0;
    let zoom = 1;
    let zoomT = 1;
    let resetting = false;
    // The opening shot: a close-up from the side that swings out to the usual view, slowly.
    let introPending = true;
    let introT = -1; // seconds into the opening shot, -1 when it is not playing
    let introTx = 0; // where along the board the camera looks (a share of the half width)
    let yawT = DEF_YAW;
    let pitchT = DEF_PITCH;
    let autoRotate = false;
    // Dragging pauses the turntable; it picks up again a few seconds after the user lets go.
    let autoRotateResumeAt = 0;
    let leanYaw = 0;
    let leanPitch = 0;
    let prevDown = false;
    let downX = 0;
    let downY = 0;
    let lastX = 0;
    let lastY = 0;
    let moved = false;
    let fitDist = 2;
    let fitKey = '';
    let lastAspect = 1.5;
    let canvasW = 0;
    let canvasH = 0;
    const camera: Camera = {
        vp: new Float32Array(16),
        r0: [1, 0, 0],
        r1: [0, 1, 0],
        r2: [0, 0, 1],
        eye: [0, 0, 1],
        tanV: Math.tan(FOV / 2),
        tanH: Math.tan(FOV / 2),
    };
    let hoverIdx = -1;
    let hoverAmt = 0;

    // The closest the camera may come, as a zoom: about the height of the tallest bars, so that it
    // is above their roofs when looking down at a fair angle. It does not depend on the angle: tipping
    // the board must not move the camera in and out.
    function minZoom() {
        return Math.max(ZOOM_MIN, (maxH * 1.05) / Math.max(fitDist, 0.1));
    }

    function camTarget(): Vec3 {
        return [introTx * boardHx, maxH * 0.3, 0];
    }

    /** Distance at which the whole board plus the tallest building fits at the default pose. */
    function fit(aspect: number) {
        const key = `${boardKey}|${aspect.toFixed(3)}`;
        if (key === fitKey) {
            return;
        }
        fitKey = key;
        const [r0, r1, r2] = rotationRows(DEF_YAW, DEF_PITCH);
        const t = camTarget();
        const tanV = Math.tan(FOV / 2);
        const tanH = tanV * aspect;
        const margin = 0.9;
        const pts: Vec3[] = [];
        const bx = boardHx + SLAB_M;
        const bz = boardHzCur + SLAB_M;
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                pts.push([sx * bx, -SLAB_T, sz * bz]);
                pts.push([sx * boardHx * 0.94, maxH, sz * boardHzCur * 0.94]);
            }
        }
        let d = 0.5;
        for (const p of pts) {
            const q: Vec3 = [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
            const x = dot3(r0, q);
            const y = dot3(r1, q);
            const z = dot3(r2, q);
            d = Math.max(
                d,
                z + Math.max(Math.abs(x) / (tanH * margin), Math.abs(y) / (tanV * margin)),
            );
        }
        fitDist = d;
    }

    // Catmull-Rom through the opening shot's keys: no stops at the keys, rest at both ends.
    function introShot(t: number): [number, number, number, number] {
        const last = INTRO_KEYS.length - 1;
        let i = 0;
        while (i < last - 1 && t >= INTRO_KEYS[i + 1][0]) {
            i += 1;
        }
        const k1 = INTRO_KEYS[i];
        const k2 = INTRO_KEYS[Math.min(i + 1, last)];
        const k0 = INTRO_KEYS[Math.max(i - 1, 0)];
        const k3 = INTRO_KEYS[Math.min(i + 2, last)];
        const u = Math.min(1, Math.max(0, (t - k1[0]) / Math.max(1e-6, k2[0] - k1[0])));
        const u2 = u * u;
        const u3 = u2 * u;
        const at = (n: number) => {
            const v0 = k0[n];
            const v1 = k1[n];
            const v2 = k2[n];
            const v3 = k3[n];
            return (
                0.5 *
                (2 * v1 +
                    (-v0 + v2) * u +
                    (2 * v0 - 5 * v1 + 4 * v2 - v3) * u2 +
                    (-v0 + 3 * v1 - 3 * v2 + v3) * u3)
            );
        };
        return [at(1), at(2), Math.max(0.2, at(3)), at(4)];
    }

    function updateCamera(frame: BarFrame) {
        const dt = frame.dt;
        const p = frame.pointer;
        let dragging = false;
        if (p.down) {
            if (!prevDown) {
                downX = p.x;
                downY = p.y;
                lastX = p.x;
                lastY = p.y;
                moved = false;
            }
            if (!moved && Math.hypot(p.x - downX, p.y - downY) > 3) {
                moved = true;
            }
            if (moved) {
                dragging = true;
                const k = 0.0085;
                const sign = Math.cos(pitch) >= 0 ? 1 : -1;
                const dYaw = (p.x - lastX) * k * sign;
                const dPitch = (p.y - lastY) * k;
                yaw += dYaw;
                pitch += dPitch;
                if (dt > 0) {
                    yawV += (dYaw / dt - yawV) * 0.5;
                    pitchV += (dPitch / dt - pitchV) * 0.5;
                    yawV = Math.max(-12, Math.min(12, yawV));
                    pitchV = Math.max(-12, Math.min(12, pitchV));
                }
                autoRotateResumeAt = frame.time + 3;
                resetting = false;
            }
            lastX = p.x;
            lastY = p.y;
        } else {
            if (prevDown && !moved) {
                yawV = 0;
                pitchV = 0;
            }
            // inertia
            yaw += yawV * dt;
            pitch += pitchV * dt;
            const decay = Math.exp(-dt * 5.5);
            yawV *= decay;
            pitchV *= decay;
            if (Math.abs(yawV) < 1e-4) {
                yawV = 0;
            }
            if (Math.abs(pitchV) < 1e-4) {
                pitchV = 0;
            }
        }
        // Stop at the ends of the range, and drop the momentum that was pushing past them.
        if (pitch < PITCH_MIN) {
            pitch = PITCH_MIN;
            pitchV = Math.max(pitchV, 0);
        } else if (pitch > PITCH_MAX) {
            pitch = PITCH_MAX;
            pitchV = Math.min(pitchV, 0);
        }
        prevDown = p.down;
        if (p.down && moved) {
            dragging = true;
        }

        if (resetting) {
            const k = 1 - Math.exp(-dt * 5);
            yaw += (yawT - yaw) * k;
            pitch += (pitchT - pitch) * k;
            if (Math.abs(yawT - yaw) < 1e-3 && Math.abs(pitchT - pitch) < 1e-3) {
                yaw = DEF_YAW;
                pitch = DEF_PITCH;
                resetting = false;
            }
        } else if (autoRotate && !dragging && frame.time >= autoRotateResumeAt) {
            yaw += 6 * DEG * dt;
        }

        zoom += (zoomT - zoom) * (1 - Math.exp(-dt * 8));
        // The turning point stays where it is, and so does the closest the camera may come.
        zoom = Math.max(zoom, minZoom());
        // Close in, the board cannot be tipped so flat that the camera would sink into the bars:
        // the lowest angle rises as the camera comes closer, and tipping (or zooming) past it
        // lifts the view by itself.
        if (introT < 0) {
            const reach = (maxH * 0.78) / Math.max(fitDist * zoom, 0.05);
            const lowest = Math.min(PITCH_MAX, Math.max(PITCH_MIN, Math.asin(Math.min(1, reach))));
            if (pitch < lowest) {
                pitch += (lowest - pitch) * (1 - Math.exp(-dt * 6));
                pitchV = Math.max(pitchV, 0);
            }
        }
        if (introT >= 0) {
            if (p.down || resetting) {
                introT = -1; // the viewer takes over: stay where the shot is
                zoomT = zoom;
            } else {
                introT += dt;
                const shot = introShot(introT);
                yaw = DEF_YAW + shot[0] * DEG;
                pitch = shot[1] * DEG;
                zoom = zoomT = shot[2];
                introTx = shot[3];
                if (introT >= INTRO_KEYS[INTRO_KEYS.length - 1][0]) {
                    introT = -1;
                }
            }
        } else {
            introTx -= introTx * (1 - Math.exp(-dt * 4));
        }

        // slight lean towards the pointer, never while dragging
        const leanOn = p.inside && !p.down;
        const lyT = leanOn ? (p.x / Math.max(1, frame.width) - 0.5) * 2 * 3 * DEG : 0;
        const lpT = leanOn ? (p.y / Math.max(1, frame.height) - 0.5) * 2 * 3 * DEG : 0;
        const kl = 1 - Math.exp(-dt * (leanOn ? 4 : 10));
        leanYaw += (lyT - leanYaw) * kl;
        leanPitch += (lpT - leanPitch) * kl;
        return dragging;
    }

    function cameraFor(width: number, height: number) {
        const aspect = width / Math.max(1, height);
        lastAspect = aspect;
        fit(aspect);
        buildCamera(aspect, yaw + leanYaw, pitch + leanPitch, fitDist * zoom, camTarget(), camera);
    }

    // ---------------------------------------------------------- animation and picking
    function animate(dt: number) {
        const k = 1 - Math.exp(-dt / SETTLE_TAU);
        let changed = instDirty;
        if (springing) {
            let active = false;
            const steps = Math.max(1, Math.ceil(dt / 0.008));
            const h = dt / steps;
            for (let i = 0; i < count; i += 1) {
                if (delay[i] > 0) {
                    delay[i] -= dt;
                    active = true;
                    continue;
                }
                for (let j = 0; j < 6; j += 1) {
                    const idx = i * 6 + j;
                    for (let step = 0; step < steps; step += 1) {
                        // only the heights bounce; sideways (and the footprint) the bars glide in without overshoot
                        const damping = j >= 4 ? springC[i] : 2 * Math.sqrt(springK[i]);
                        const a = (tgt[idx] - cur[idx]) * springK[i] - vel[idx] * damping;
                        vel[idx] += a * h;
                        cur[idx] += vel[idx] * h;
                    }
                    if (j === 5 || j === 4) {
                        cur[idx] = Math.max(0, cur[idx]); // never through the table
                    } else if (j === 2 || j === 3) {
                        cur[idx] = Math.max(0.002, cur[idx]);
                    }
                    if (Math.abs(tgt[idx] - cur[idx]) > 1e-5 || Math.abs(vel[idx]) > 1e-4) {
                        active = true;
                    } else {
                        cur[idx] = tgt[idx];
                        vel[idx] = 0;
                    }
                }
            }
            springing = active;
            changed = true;
        }
        for (let i = 0; i < count * 6 && !springing; i += 1) {
            const d = tgt[i] - cur[i];
            if (d !== 0) {
                if (Math.abs(d) < 1e-6) {
                    cur[i] = tgt[i];
                } else {
                    cur[i] += d * k;
                }
                changed = true;
            }
        }
        if (!changed) {
            return false;
        }
        colTop.fill(0);
        if (stackedMode) {
            for (let i = 0; i < count; i += 1) {
                const c = i % cols;
                colTop[c] = Math.max(colTop[c], cur[i * 6 + 4] + cur[i * 6 + 5]);
            }
        }
        for (let i = 0; i < count; i += 1) {
            const o = i * 6;
            const q = i * FLOATS;
            inst[q] = cur[o];
            inst[q + 1] = cur[o + 1];
            inst[q + 2] = cur[o + 2];
            inst[q + 3] = cur[o + 3];
            inst[q + 4] = cur[o + 4];
            inst[q + 5] = cur[o + 5];
            inst[q + 7] = stackedMode ? colTop[i % cols] : cur[o + 4] + cur[o + 5];
        }
        instDirty = false;
        return true;
    }

    function project(x: number, y: number, z: number, width: number, height: number) {
        const m = camera.vp;
        const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (cw < 1e-4) {
            return null;
        }
        return {
            x: ((cx / cw) * 0.5 + 0.5) * width,
            y: (1 - ((cy / cw) * 0.5 + 0.5)) * height,
        };
    }

    function pick(frame: BarFrame, dragging: boolean): { index: number; pick: BarPick } | null {
        const p = frame.pointer;
        if (!scene || dragging || !p.inside || count === 0) {
            return null;
        }
        const nx = (p.x / frame.width) * 2 - 1;
        const ny = 1 - (p.y / frame.height) * 2;
        const { r0, r1, r2, eye, tanH, tanV } = camera;
        const d: Vec3 = [
            r0[0] * nx * tanH + r1[0] * ny * tanV - r2[0],
            r0[1] * nx * tanH + r1[1] * ny * tanV - r2[1],
            r0[2] * nx * tanH + r1[2] * ny * tanV - r2[2],
        ];
        let best = -1;
        let bestT = Infinity;
        for (let i = 0; i < count; i += 1) {
            const o = i * 6;
            const h = cur[o + 5];
            if (h < 0.002) {
                continue;
            }
            const lo: Vec3 = [cur[o] - cur[o + 2], cur[o + 4], cur[o + 1] - cur[o + 3]];
            const hi: Vec3 = [cur[o] + cur[o + 2], cur[o + 4] + h, cur[o + 1] + cur[o + 3]];
            let t0 = 0;
            let t1 = Infinity;
            let ok = true;
            for (let a = 0; a < 3; a += 1) {
                if (Math.abs(d[a]) < 1e-9) {
                    if (eye[a] < lo[a] || eye[a] > hi[a]) {
                        ok = false;
                        break;
                    }
                } else {
                    let ta = (lo[a] - eye[a]) / d[a];
                    let tb = (hi[a] - eye[a]) / d[a];
                    if (ta > tb) {
                        const tmp = ta;
                        ta = tb;
                        tb = tmp;
                    }
                    t0 = Math.max(t0, ta);
                    t1 = Math.min(t1, tb);
                    if (t0 > t1) {
                        ok = false;
                        break;
                    }
                }
            }
            if (ok && t0 < bestT) {
                bestT = t0;
                best = i;
            }
        }
        if (best < 0) {
            return null;
        }
        const o = best * 6;
        const s = project(cur[o], cur[o + 4] + cur[o + 5], cur[o + 1], frame.width, frame.height);
        return {
            index: best,
            pick: {
                row: Math.floor(best / cols),
                col: best % cols,
                screenX: s ? s.x : p.x,
                screenY: s ? s.y : p.y,
            },
        };
    }

    // ---------------------------------------------------------- drawing

    // The light's view: a box round the board and its tallest bars, seen along the light.
    function updateLight() {
        const zAxis = SHADOW_LIGHT;
        const xl = Math.hypot(zAxis[2], zAxis[0]) || 1;
        const xAxis: Vec3 = [zAxis[2] / xl, 0, -zAxis[0] / xl];
        const yAxis: Vec3 = [
            zAxis[1] * xAxis[2] - zAxis[2] * xAxis[1],
            zAxis[2] * xAxis[0] - zAxis[0] * xAxis[2],
            zAxis[0] * xAxis[1] - zAxis[1] * xAxis[0],
        ];
        const bx = boardHx + SLAB_M;
        const bz = Math.max(boardHz, boardHzCur) + SLAB_M;
        const lo: Vec3 = [Infinity, Infinity, Infinity];
        const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                for (const y of [-SLAB_T, maxH * 1.05 + 0.01]) {
                    const p: Vec3 = [sx * bx, y, sz * bz];
                    [xAxis, yAxis, zAxis].forEach((axis, k) => {
                        const d = dot3(axis, p);
                        lo[k] = Math.min(lo[k], d);
                        hi[k] = Math.max(hi[k], d);
                    });
                }
            }
        }
        lo[0] -= 0.03;
        hi[0] += 0.03;
        lo[1] -= 0.03;
        hi[1] += 0.03;
        lo[2] -= 1.5;
        hi[2] += 1.5;
        const wx = hi[0] - lo[0];
        const wy = hi[1] - lo[1];
        const wz = hi[2] - lo[2];
        lightVP.fill(0);
        for (let r = 0; r < 3; r += 1) {
            const axis = r === 0 ? xAxis : r === 1 ? yAxis : zAxis;
            const scale = r === 0 ? 2 / wx : r === 1 ? 2 / wy : -2 / wz;
            lightVP[0 * 4 + r] = axis[0] * scale;
            lightVP[1 * 4 + r] = axis[1] * scale;
            lightVP[2 * 4 + r] = axis[2] * scale;
        }
        lightVP[12] = (-2 * lo[0]) / wx - 1;
        lightVP[13] = (-2 * lo[1]) / wy - 1;
        lightVP[14] = (2 * hi[2]) / wz - 1;
        lightVP[15] = 1;
    }

    function renderShadowMap() {
        updateLight();
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
        gl.viewport(0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);
        gl.colorMask(false, false, false, false);
        gl.clearDepth(1);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(2, 4);
        gl.useProgram(depthProg.program);
        gl.uniformMatrix4fv(depthProg.uniforms.uVP, false, lightVP);
        gl.bindVertexArray(slabVao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, 1);
        if (count > 0) {
            gl.bindVertexArray(bldVao);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, count);
        }
        gl.bindVertexArray(null);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.colorMask(true, true, true, true);
    }

    // what every surface needs to look up the shadows
    function bindShadows(program: Program) {
        gl.uniform1i(program.uniforms.uShadowMap, 2);
        gl.uniformMatrix4fv(program.uniforms.uLightVP, false, lightVP);
        gl.uniform1f(program.uniforms.uTexel, 1.7 / SHADOW_MAP_SIZE);
    }

    function drawScene(frame: BarFrame, w: number, h: number) {
        renderShadowMap();
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, shadowTex);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
        gl.viewport(0, 0, w, h);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.clearDepth(1);
        gl.clear(gl.DEPTH_BUFFER_BIT);

        // background
        gl.useProgram(bgProg.program);
        gl.uniform2f(bgProg.uniforms.uRes, w, h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, frame.pageTexture);

        // slab (drawn with the building program: one flagged instance)
        const bu = bldProg.uniforms;
        gl.useProgram(bldProg.program);
        gl.uniformMatrix4fv(bu.uVP, false, camera.vp);
        gl.uniform1i(bu.uPage, 0);
        gl.uniform3f(bu.uL, LIGHT[0], LIGHT[1], LIGHT[2]);
        gl.uniform1f(bu.uTime, frame.time);
        gl.uniform1f(bu.uHoverAmt, 0);
        gl.uniform1i(bu.uHover, -1);
        gl.uniform3f(bu.uLd, SHADOW_LIGHT[0], SHADOW_LIGHT[1], SHADOW_LIGHT[2]);
        bindShadows(bldProg);
        gl.bindVertexArray(slabVao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, 1);

        // page
        const gu = groundProg.uniforms;
        gl.useProgram(groundProg.program);
        gl.uniformMatrix4fv(gu.uVP, false, camera.vp);
        gl.uniform2f(gu.uHalf, boardHx, boardHzCur);
        gl.uniform1i(gu.uPage, 0);
        bindShadows(groundProg);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // the table the board stands on (it fades out towards the far edge)
        const du = deskProg.uniforms;
        gl.useProgram(deskProg.program);
        gl.uniformMatrix4fv(du.uVP, false, camera.vp);
        gl.uniform1f(du.uSize, DESK_SIZE);
        gl.uniform1f(du.uY, DESK_Y);
        bindShadows(deskProg);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.disable(gl.BLEND);

        gl.useProgram(bldProg.program);
        if (count > 0) {
            // buildings
            gl.uniform1f(bu.uHoverAmt, hoverAmt);
            gl.uniform1i(bu.uHover, hoverAmt > 0 ? hoverIdx : -1);
            gl.bindVertexArray(bldVao);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, count);
        }

        gl.bindVertexArray(null);
        gl.disable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
    }

    function render(frame: BarFrame): BarPick | null {
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        canvasW = frame.width;
        canvasH = frame.height;
        ensureTargets(w, h);
        glideBoard(frame.dt);

        const dragging = updateCamera(frame);
        cameraFor(frame.width, frame.height);

        const upload = animate(frame.dt);
        if (upload && count > 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, count * FLOATS);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }

        // pick with the exact camera that is about to be drawn
        const hit = pick(frame, dragging);
        const kh = 1 - Math.exp(-frame.dt / 0.06);
        if (hit) {
            if (hit.index !== hoverIdx) {
                hoverIdx = hit.index;
                hoverAmt = Math.min(hoverAmt, 0.25);
            }
            hoverAmt += (1 - hoverAmt) * kh;
        } else {
            hoverAmt += (0 - hoverAmt) * kh;
            if (hoverAmt < 0.01) {
                hoverAmt = 0;
                hoverIdx = -1;
            }
        }

        drawScene(frame, w, h);

        // resolve the multisampled target, then draw it to the default framebuffer
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msFbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resFbo);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        gl.useProgram(compProg.program);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, resTex);
        gl.uniform1i(compProg.uniforms.uTex, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.activeTexture(gl.TEXTURE0);

        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.CULL_FACE);
        gl.depthMask(true);
        gl.bindVertexArray(null);
        return hit ? hit.pick : null;
    }

    // initial board so that render works before the first setScene
    setBoard(1.5, 1, 0);

    return {
        resize(width, height) {
            canvasW = width;
            canvasH = height;
            // render targets follow the drawing buffer lazily in render()
        },
        setScene(s) {
            applyScene(s);
        },
        resetView() {
            resetting = true;
            yawT = yaw - wrapPi(yaw - DEF_YAW);
            pitchT = DEF_PITCH;
            zoomT = 1;
            yawV = 0;
            pitchV = 0;
        },
        zoomBy(factor) {
            if (Number.isFinite(factor) && factor > 0) {
                introT = -1;
                zoomT = Math.min(ZOOM_MAX, Math.max(minZoom(), zoomT * factor));
            }
        },
        setIntro(on) {
            if (introT < 0) {
                introPending = on;
            }
        },
        setAutoRotate(on) {
            autoRotate = on;
            if (on) {
                resetting = false;
            }
        },
        render,
        dispose() {
            freeTargets();
            gl.deleteTexture(shadowTex);
            gl.deleteFramebuffer(shadowFbo);
            gl.deleteBuffer(boxVbo);
            gl.deleteBuffer(instBuf);
            gl.deleteBuffer(slabBuf);
            gl.deleteVertexArray(bldVao);
            gl.deleteVertexArray(slabVao);
            for (const p of programs) {
                gl.deleteProgram(p.program);
            }
            void canvasW;
            void canvasH;
            void lastAspect;
        },
    };
}
