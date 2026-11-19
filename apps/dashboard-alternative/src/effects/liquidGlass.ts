// "Liquid Glass": a damped wave-equation ripple sheet plus a metaball field of water beads that
// refract, disperse and light the page texture. Ported from the published Liquid Glass demo.
import { createProgram, requireFloatTargets } from './glUtils';
import type { Effect, EffectFrame, PointerEventKind, PointerState } from './types';

// Original default parameters (light paper theme, drizzle on, n = 1.33 water, 35% dispersion).
const IOR = 1.33;
const DISPERSION = 0.35;
const RAIN = 0.1;
// This page is dark, so use the original's dark-paper lighting.
const DARK = 1;
const LOUPE = true;
const MAX_DROPS = 1700;
const INTRO = 1.7;
const RIPPLE_SCALE = 2;
const RIPPLE_HZ = 240;

const VS_FULL = `#version 300 es
out vec2 vUv;
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv = p; gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;

// Shallow-water ripples: a damped wave equation on a small float texture.
const FS_RIPPLE = `#version 300 es
precision highp float;
uniform sampler2D uPrev; uniform vec2 uTexel; uniform vec2 uRes;
uniform vec4 uImp[8]; uniform int uN;
in vec2 vUv; out vec4 o;
void main(){
  vec4 c = texture(uPrev, vUv);
  float h = c.r, v = c.g;
  float a = texture(uPrev, vUv+vec2(uTexel.x,0.)).r + texture(uPrev, vUv-vec2(uTexel.x,0.)).r
          + texture(uPrev, vUv+vec2(0.,uTexel.y)).r + texture(uPrev, vUv-vec2(0.,uTexel.y)).r;
  float d = texture(uPrev, vUv+uTexel).r + texture(uPrev, vUv-uTexel).r
          + texture(uPrev, vUv+vec2(uTexel.x,-uTexel.y)).r + texture(uPrev, vUv+vec2(-uTexel.x,uTexel.y)).r;
  float lap = a*0.2 + d*0.05 - h;
  v += lap*1.45;
  v *= 0.9925;
  h += v;
  h *= 0.9992;
  vec2 p = vec2(vUv.x*uRes.x, (1.0-vUv.y)*uRes.y);
  for(int i=0;i<8;i++){ if(i>=uN) break;
    vec2 q = p - uImp[i].xy; float r = uImp[i].z;
    h -= uImp[i].w * exp(-dot(q,q)/(r*r));
  }
  if(!(abs(h)<40.0) || !(abs(v)<40.0)){ h = 0.; v = 0.; }
  o = vec4(h, v, 0., 1.);
}`;

// Droplets: every bead adds a smooth kernel to a metaball field (r), its radius (g) and the field gradient (b,a).
const VS_FIELD = `#version 300 es
layout(location=0) in vec2 aQ; layout(location=1) in vec3 aDrop; layout(location=2) in vec2 aStretch;
uniform vec2 uRes;
out vec2 vD; flat out float vR; flat out vec2 vS;
void main(){
  float ext = aDrop.z*1.5*(1.0+length(aStretch))+1.0;
  vD = aQ*ext; vR = aDrop.z; vS = aStretch;
  vec2 p = (aDrop.xy + vD)/uRes;
  gl_Position = vec4(p.x*2.0-1.0, 1.0-p.y*2.0, 0.0, 1.0);
}`;

const FS_FIELD = `#version 300 es
precision highp float;
in vec2 vD; flat in float vR; flat in vec2 vS; out vec4 o;
void main(){
  float a = length(vS); vec2 u = a>1e-4 ? vS/a : vec2(1.,0.); vec2 w = vec2(-u.y,u.x);
  float al = dot(vD,u), pe = dot(vD,w);
  float ka = 1.0/(1.0+a), kp = 1.0+a*0.45;
  float q2 = (al*al*ka*ka + pe*pe*kp*kp)/(vR*vR);
  float t = 1.0 - q2/2.25;
  if(t<=0.) discard;
  vec2 g = -(4.0/2.25)*t*(al*ka*ka*u + pe*kp*kp*w)/(vR*vR);
  o = vec4(t*t, t*t*vR, g);
}`;

// The glass: one pass that refracts the page texture through ripples and beads, then lights the water.
// The page texture has v = 0 at the top and p is measured from the top-left, so no flip is needed.
const FS_GLASS = `#version 300 es
precision highp float;
uniform sampler2D uUI; uniform sampler2D uField; uniform sampler2D uRip;
uniform vec2 uRes; uniform vec2 uRipTexel;
uniform float uDpr, uIor, uDisp, uDark, uRipPx;
uniform vec3 uHero;
out vec4 o;
const float T = 0.308642;
const vec2 L = vec2(-0.5547,-0.8321);

vec2 fuv(vec2 p){ return vec2(p.x/uRes.x, 1.0-p.y/uRes.y); }
vec3 ui(vec2 p){ return texture(uUI, p/uRes).rgb; }

float hash(vec2 v){ return fract(sin(dot(v, vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 v){ vec2 i = floor(v), u = fract(v); u = u*u*(3.0-2.0*u); return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x), mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x), u.y); }
vec3 env(vec3 r, float dark, float big, float small){
  vec2 q = r.xy/(1.0+max(r.z,-0.9));
  vec2 w = q - L*0.40;
  vec2 wb = abs(vec2(0.955*w.x-0.296*w.y, 0.296*w.x+0.955*w.y)) - vec2(0.10,0.14);
  float box = exp(-dot(w,w)/mix(0.0007,0.009,small))*mix(1.3,1.6,small) + (1.0-smoothstep(-0.05,0.05,max(wb.x,wb.y)))*0.16*big, mull = 1.0;
  float ql = length(q);
  float hor = smoothstep(mix(0.55,0.42,dark),1.25,ql);
  float az = dot(q/max(ql,1e-4), L);
  vec3 sky = mix(vec3(0.93,0.95,0.98),vec3(0.72,0.84,1.0)*1.5,dark)*hor*mix(0.90+0.10*smoothstep(-0.6,1.0,az), 0.32+0.68*smoothstep(-0.5,1.0,az), dark);
  vec2 w2 = q + L*0.62; float l2 = exp(-dot(w2,w2)/0.02);
  return vec3(1.0,0.99,0.97)*34.0*box*mull + sky + vec3(0.85,0.92,1.0)*mix(3.0,5.0,dark)*l2;
}

void main(){
  vec2 p = vec2(gl_FragCoord.x, uRes.y*uDpr - gl_FragCoord.y)/uDpr;
  vec2 uv = fuv(p);

  // ripples
  float hc = texture(uRip, uv).r;
  float hE = texture(uRip, uv+vec2(uRipTexel.x,0.)).r, hW = texture(uRip, uv-vec2(uRipTexel.x,0.)).r;
  float hN = texture(uRip, uv+vec2(0.,uRipTexel.y)).r, hS = texture(uRip, uv-vec2(0.,uRipTexel.y)).r;
  vec2 gr = vec2(hE-hW, hS-hN)/(2.0*uRipPx);
  float lap = (hE+hW+hN+hS-4.0*hc)/(uRipPx*uRipPx);

  // beads
  vec4 F = texture(uField, uv);
  float f = F.r; float R = F.g/max(f,1e-4);
  float wob = smoothstep(26.,90.,R)*0.34*(vnoise((p-uHero.xy)/max(uHero.z,1.0)*1.7+7.3)-0.5);
  f *= 1.0+wob; F.ba *= 1.0+wob;
  vec2 gf = F.ba; float gl = length(gf);
  float m = clamp((f-T)/max(gl,1e-5)*uDpr+0.5, 0., 1.);
  float sf = sqrt(clamp(f,1e-4,1.7));
  float cap2 = 1.0 - 2.25*(1.0-sf);
  float cap = sqrt(max(cap2,0.));
  float big = smoothstep(26.,90.,R);
  float c = mix(0.74,0.45,smoothstep(20.,70.,R));
  float ex = mix(0.76,0.56,big);
  float h = R*c*pow(max(cap2,0.),ex)*m;
  vec2 g = R*c*ex*pow(max(cap2,0.006),ex-1.0)*(1.125/sf)*gf*m;
  float rimz = 1.0-smoothstep(0.0,0.30,cap2);

  vec3 n = normalize(vec3(-(g+gr*2.0), 1.0));
  float depth = (h*1.35 + R*0.50*m)*(0.20+0.80*smoothstep(0.0,0.6,cap2))*big;
  vec2 dirO = -gf/max(gl,1e-5);
  vec2 beadOff = -dirO*sqrt(clamp(1.0-cap2,0.,1.))*R*mix(0.28,mix(2.2,4.0,smoothstep(9.,16.,R)),smoothstep(8.4,9.4,R))*(1.0-big)*m;
  float dE = uDisp*mix(1.0,0.5*(0.15+0.85*(1.0-smoothstep(0.0,0.5,cap2)))*smoothstep(0.0,0.14,cap2),big);
  vec2 offR = -gr*150.0;

  vec3 col;
  if(m>0.001 || dot(gr,gr)>1e-8){
    col = vec3(0.);
    for(int i=0;i<5;i++){
      float t = float(i)*0.25;
      float ior = max(1.0001, uIor*(1.0+(t-0.5)*dE*0.11));
      vec3 r = refract(vec3(0.,0.,-1.), n, 1.0/ior);
      vec2 off = r.xy/max(-r.z,0.3)*depth + beadOff*(1.0+(t-0.5)*dE*0.07) + offR*(1.0+(t-0.5)*uDisp*0.6);
      vec3 s = ui(p+off);
      vec3 w = i==0 ? vec3(1.,0.,0.) : i==1 ? vec3(.5,.5,0.) : i==2 ? vec3(0.,1.,0.) : i==3 ? vec3(0.,.5,.5) : vec3(0.,0.,1.);
      col += s*w;
    }
    col /= vec3(1.5,2.0,1.5);
  } else col = ui(p);

  // light focused and scattered by the ripples
  float face = dot(-gr, L);
  col *= 1.0 - clamp(-face*2.4, 0., 0.14) - clamp(lap*3.0, 0., 0.05);
  col += vec3(0.95,0.97,1.0)*pow(clamp(face*13.0,0.,1.),3.0)*mix(0.60,0.60,uDark)*(1.0-m);

  float sh = 0.0, cau = 0.0;
  if(f>0.0 && m<0.999){
    vec4 Fa = texture(uField, fuv(p+L*2.0));
    float Ra = Fa.g/max(Fa.r,1e-4);
    vec4 Fb = texture(uField, fuv(p+L*(2.0+0.06*min(Ra,30.0))));
    sh = smoothstep(T*mix(0.78,0.90,smoothstep(20.,90.,Ra)),T*1.0,Fb.r);
    vec4 Fc = texture(uField, fuv(p+L*0.55*min(Ra,34.0)));
    cau = smoothstep(T*1.3,T*2.1,Fc.r)*smoothstep(T*0.3,T*0.9,f)*(1.0-m);
    sh *= (1.0-0.85*cau)*(1.0-m);
  }
  col *= mix(vec3(1.0), mix(vec3(0.66,0.72,0.86),vec3(0.75),uDark), sh);
  col += cau*mix(vec3(0.05), vec3(0.10,0.15,0.26), uDark);
  float side = dot(n.xy, L);
  float sideN = dot(n.xy/max(length(n.xy),1e-4), L);
  col *= 1.0 - m*0.15*smoothstep(0.05,0.8,side)*(1.0-0.8*big);
  float ca = m*smoothstep(0.2,0.9,-side)*(1.0-big);
  col = mix(col, col*1.14+vec3(0.21), ca*uDark);
  col += m*uDark*(1.0-big)*vec3(0.020,0.026,0.036);
  col *= 1.0 - big*m*0.13*(1.0-smoothstep(0.0,0.05,cap2));
  col *= 1.0 - big*m*0.18*rimz*smoothstep(0.0,0.7,sideN)*(1.0-uDark);
  float rb = 1.0-smoothstep(0.0,0.40,cap2);
  col += m*uDark*(rb*(0.18+0.46*smoothstep(-0.2,1.0,sideN))*vec3(0.78,0.88,1.0) + smoothstep(0.1,1.0,-sideN)*(1.0-cap2)*0.20*vec3(0.85,0.92,1.0)*(1.0-big));
  col += big*m*rimz*smoothstep(0.1,0.8,-sideN)*vec3(0.07+0.06*uDark);
  col *= 1.0 - m*(1.0-smoothstep(0.0,0.22,cap))*0.18*smoothstep(0.0,0.8,side)*(1.0-uDark);
  col *= mix(vec3(1.0), vec3(0.74,0.79,0.90), m*(1.0-uDark)*(1.0-big)*(1.0-smoothstep(0.0,0.09,cap2)));
  col *= mix(vec3(1.0), vec3(0.965,0.975,0.985), m*(1.0-uDark));

  // reflection of the room, Fresnel weighted
  float wet = max(m, smoothstep(0.0,0.02,length(gr)));
  float fr = 0.02 + 0.98*pow(1.0-clamp(n.z,0.,1.), 5.0);
  col = mix(col, env(reflect(vec3(0.,0.,-1.), n), uDark, big, (1.0-big)*(1.0-smoothstep(8.,26.,R))), clamp(fr,0.,1.)*wet);

  if(!(col.r>=0.0) || !(col.g>=0.0) || !(col.b>=0.0)) col = ui(p);
  o = vec4(clamp(col,0.0,1.0), 1.0);
}`;

type Drop = {
    x: number;
    y: number;
    r: number;
    vx: number;
    vy: number;
    th: number;
    slip: number;
    slipT: number;
    trail: number;
    dying: boolean;
    lobes: number[] | null;
    wet?: boolean;
    hold?: number;
    age?: number;
    pool?: boolean;
    fly?: boolean;
};

type Target = { texture: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

export function createLiquidGlass(gl: WebGL2RenderingContext): Effect {
    requireFloatTargets(gl);

    const progRipple = createProgram(gl, VS_FULL, FS_RIPPLE);
    let progField;
    let progGlass;
    try {
        progField = createProgram(gl, VS_FIELD, FS_FIELD);
        progGlass = createProgram(gl, VS_FULL, FS_GLASS);
    } catch (error) {
        gl.deleteProgram(progRipple.program);
        if (progField) {
            gl.deleteProgram(progField.program);
        }
        throw error;
    }

    const vaoFull = gl.createVertexArray();
    const vaoField = gl.createVertexArray();
    const quadBuf = gl.createBuffer();
    const instBuf = gl.createBuffer();
    const inst = new Float32Array(MAX_DROPS * 5);

    gl.bindVertexArray(vaoField);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 20, 12);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const floatTarget = (w: number, h: number): Target => {
        const texture = gl.createTexture();
        const fbo = gl.createFramebuffer();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return { texture, fbo, w, h };
    };
    const deleteTarget = (target: Target | null) => {
        if (target) {
            gl.deleteTexture(target.texture);
            gl.deleteFramebuffer(target.fbo);
        }
    };

    // ------------------------------------------------------------------ simulation state
    let W = 1;
    let H = 1;
    let dpr = 1;
    let rip: [Target, Target] | null = null;
    let field: Target | null = null;
    let cur = 0;
    let simAcc = 0;

    let seed = 20261112;
    const rnd = () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    let drops: Drop[] = [];
    const hero = {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        tx: 0,
        ty: 0,
        R: 90,
        k: 0,
        w: 0,
        wv: 0,
        placed: false,
        moved: false,
    };
    let drag: { ox: number; oy: number } | null = null;
    const impulses: number[] = [];
    const impBuf = new Float32Array(32);
    let pending: Drop[] = [];
    let introT = -1;
    let front = 1e9;
    let rainAcc = 0;
    const grid = new Map<number, Drop[]>();

    // pointer tracking (CSS px)
    let px = 0;
    let py = 0;
    let havePrev = false;
    let trailAcc = 0;

    const impulse = (x: number, y: number, r: number, s: number) => {
        if (impulses.length < 64) {
            impulses.push(x, y, r, s);
        }
    };

    const addDrop = (x: number, y: number, r: number, vx = 0, vy = 0): Drop | null => {
        if (drops.length >= MAX_DROPS - 40) {
            return null;
        }
        const d: Drop = {
            x,
            y,
            r,
            vx,
            vy,
            th: 8.5 + rnd() * 3.5,
            slip: 1,
            slipT: rnd(),
            trail: r * 2,
            dying: false,
            lobes: null,
        };
        // water never sits in perfect circles: bigger beads get a few overlapping lobes
        if (r > 5.5) {
            d.lobes = [];
            for (let i = 1 + ((rnd() * 2.7) | 0); i > 0; i -= 1) {
                d.lobes.push(rnd() * 6.283, 0.32 + rnd() * 0.42, 0.5 + rnd() * 0.34);
            }
        }
        drops.push(d);
        return d;
    };

    const dropSize = () => {
        const u = rnd();
        return u < 0.8 ? 3.2 + rnd() * 2.6 : u < 0.95 ? 5.6 + rnd() * 4.5 : 10.5 + rnd() * 6.5;
    };

    // The page opens dry. Then one sheet of water runs down it and leaves the beads behind.
    const seedDrops = () => {
        drops.length = 0;
        pending = [];
        const clear = (x: number, y: number, r: number) =>
            Math.hypot(x - hero.x, y - hero.y) > hero.R + r + 6;
        const area = (W * H) / 1296000;
        const cl: number[][] = [];
        for (let i = 0; i < 11; i += 1) {
            cl.push([rnd() * W, rnd() * H, 50 + rnd() * 110]);
        }
        const place = (r: number, tries: number, loose: boolean) => {
            for (let t = 0; t < tries; t += 1) {
                let x: number;
                let y: number;
                if (rnd() < 0.8) {
                    const c = cl[(rnd() * cl.length) | 0];
                    const a = rnd() * 6.283;
                    const q = Math.sqrt(-2 * Math.log(1 - rnd() * 0.98)) * c[2];
                    x = c[0] + Math.cos(a) * q;
                    y = c[1] + Math.sin(a) * q;
                } else {
                    x = rnd() * W;
                    y = rnd() * H;
                }
                if (x < 4 || y < 4 || x > W - 4 || y > H - 4) {
                    continue;
                }
                if (clear(x, y, r) || (loose && rnd() < 0.12)) {
                    const d = addDrop(x, y, r);
                    if (d) {
                        d.th = Math.max(r * 1.3, r + 3);
                    }
                    return;
                }
            }
        };
        for (let i = 0; i < Math.round(5 * area) + 2; i += 1) {
            place(17 + rnd() * rnd() * 22, 60, false);
        }
        for (let i = 0; i < Math.round(15 * area); i += 1) {
            place(7.5 + rnd() * 8, 30, false);
        }
        for (let i = 0; i < Math.round(125 * area); i += 1) {
            place(2.9 + rnd() * rnd() * 3.6, 8, false);
        }
        if (introT < INTRO) {
            pending = drops.splice(0).sort((a, b) => b.y - a.y);
            front = -1e9;
        }
    };

    const placeHero = () => {
        hero.R = Math.max(56, Math.min(132, Math.min(W, H) * 0.142));
        hero.x = hero.tx = Math.min(W - hero.R * 0.8, W * 0.5);
        hero.y = hero.ty = H * 0.62;
        hero.placed = true;
        if (!hero.moved) {
            seedDrops();
        }
    };

    const shake = (x: number, y: number, power: number) => {
        for (const d of drops) {
            const dx = d.x - x;
            const dy = d.y - y;
            const q = dx * dx + dy * dy;
            if (q > 170 * 170) {
                continue;
            }
            const l = Math.sqrt(q) + 1e-3;
            const a = (1 - l / 170) * power;
            d.vx += (dx / l) * 90 * a;
            d.vy += (dy / l) * 90 * a;
            if (rnd() < a * 0.5) {
                d.th = Math.min(d.th, d.r - 0.2);
            }
        }
    };

    const overHero = (x: number, y: number) =>
        LOUPE && Math.hypot(x - hero.x, y - hero.y) < hero.R * hero.k * 0.94;

    const endDrag = () => {
        if (drag) {
            drag = null;
            hero.wv -= 1.5;
        }
    };

    const stepDrops = (dt: number) => {
        if (!hero.placed && W > 1) {
            placeHero();
        }
        if (introT < INTRO) {
            introT = Math.max(0, introT) + dt;
            const u = Math.max(0, Math.min(1, (introT - 0.25) / (INTRO - 0.25)));
            front = introT < 0.25 ? -1e9 : u * u * (3 - 2 * u) * (H + 160) - 80;
            while (pending.length && pending[pending.length - 1].y < front - 10) {
                drops.push(pending.pop() as Drop);
            }
            if (u > 0 && u < 1) {
                for (let i = 0; i < 6; i += 1) {
                    impulse(rnd() * W, front + (rnd() - 0.5) * 14, 12, 0.5);
                }
            }
            if (introT >= INTRO) {
                front = 1e9;
                while (pending.length) {
                    drops.push(pending.pop() as Drop);
                }
            }
        }
        if (RAIN > 0 && introT >= INTRO) {
            rainAcc += dt * (0.4 + 46 * RAIN * RAIN) * Math.min(2.2, (W * H) / 921600);
            while (rainAcc > 1) {
                rainAcc -= 1;
                const r = dropSize();
                const x = rnd() * W;
                const y = rnd() * H;
                if (addDrop(x, y, r)) {
                    impulse(x, y, 3 + r * 0.6, 0.1 + r * 0.035);
                }
            }
        }
        // the big drop
        const kt = LOUPE && front > hero.y ? 1 : 0;
        hero.k += (kt - hero.k) * Math.min(1, dt * 7);
        if (drag) {
            hero.vx += ((hero.tx - hero.x) * 260 - hero.vx * 24) * dt;
            hero.vy += ((hero.ty - hero.y) * 260 - hero.vy * 24) * dt;
        } else {
            const f = Math.exp(-dt * 5);
            hero.vx *= f;
            hero.vy *= f;
        }
        hero.x += hero.vx * dt;
        hero.y += hero.vy * dt;
        hero.wv += (-hero.w * 220 - hero.wv * 9) * dt;
        hero.w += hero.wv * dt;
        const hr = hero.R * hero.k * (1 + hero.w * 0.05);
        const hs = Math.hypot(hero.vx, hero.vy);
        if (hs > 30 && hero.k > 0.5 && rnd() < dt * 30) {
            impulse(hero.x, hero.y, hr * 0.5, Math.min(0.5, hs / 2400));
        }

        const fr = Math.exp(-dt * 4.2);
        const crowd = drops.length > MAX_DROPS * 0.7;
        grid.clear();
        for (let i = drops.length - 1; i >= 0; i -= 1) {
            const d = drops[i];
            if (d.dying) {
                d.r *= Math.exp(-dt * 9);
            } else if (d.r < 4.6) {
                d.r -=
                    dt * (crowd ? 0.5 : d.wet ? ((d.age ?? 0) < (d.hold ?? 0) ? 0.04 : 0.3) : 0.06);
            }
            d.age = (d.age || 0) + dt;
            if (d.r < (d.wet ? 1.7 : 2.6) || d.y - d.r > H + 30 || d.x < -40 || d.x > W + 40) {
                drops[i] = drops[drops.length - 1];
                drops.pop();
                continue;
            }
            if (d.pool) {
                d.r -= dt * 0.45;
            }
            if (d.r > d.th && !d.pool) {
                d.slipT -= dt;
                if (d.slipT < 0) {
                    d.slip = rnd() < 0.22 ? 0.03 : 0.3 + rnd() * 0.7;
                    d.slipT = 0.2 + rnd() * 1.4;
                }
                const e = d.r - d.th * 0.55;
                const vt = Math.min(560, e * e * 2.4 + 14) * d.slip;
                d.vy += (vt - d.vy) * Math.min(1, dt * 4);
                d.vx += ((rnd() - 0.5) * 70 - d.vx * 1.6) * dt * 3;
                d.trail -= Math.abs(d.vy) * dt;
                if (d.trail < 0 && d.r > 7.5) {
                    const tr = d.r * (0.17 + rnd() * 0.14);
                    const t = addDrop(
                        d.x + (rnd() - 0.5) * d.r * 0.5,
                        d.y - d.r * 0.85,
                        Math.max(2.3, tr),
                    );
                    if (t) {
                        t.th = 99;
                    }
                    d.r = Math.cbrt(Math.max(1, d.r * d.r * d.r - tr * tr * tr * 0.9));
                    d.trail = d.r * (1.3 + rnd() * 3.2);
                }
            } else {
                d.vx *= fr;
                d.vy *= fr;
            }
            d.fly = d.vx * d.vx + d.vy * d.vy > 2500;
            d.x += d.vx * dt;
            d.y += d.vy * dt;
            // water that reaches the bottom edge gathers there, then slowly dries
            if (d.y > H - d.r * 0.3) {
                d.y = H - d.r * 0.3;
                d.vy = 0;
                d.pool = true;
            }
            // swallowed by the big drop
            if (hero.k > 0.6) {
                const dx = d.x - hero.x;
                const dy = d.y - hero.y;
                if (dx * dx + dy * dy < hr * 0.93 * (hr * 0.93)) {
                    hero.wv += Math.min(3, d.r * 0.22);
                    drops[i] = drops[drops.length - 1];
                    drops.pop();
                    continue;
                }
            }
            const key = (d.x >> 6) + (d.y >> 6) * 4096;
            let cell = grid.get(key);
            if (!cell) {
                cell = [];
                grid.set(key, cell);
            }
            cell.push(d);
        }
        // beads that touch become one bead
        for (const d of drops) {
            if (d.r <= 0) {
                continue;
            }
            const cx = d.x >> 6;
            const cy = d.y >> 6;
            for (let oy = -1; oy <= 1; oy += 1) {
                for (let ox = -1; ox <= 1; ox += 1) {
                    const cell = grid.get(cx + ox + (cy + oy) * 4096);
                    if (!cell) {
                        continue;
                    }
                    for (const e of cell) {
                        if (
                            e === d ||
                            e.r <= 0 ||
                            e.r > d.r ||
                            (e.r === d.r && e.x <= d.x) ||
                            e.fly ||
                            d.fly
                        ) {
                            continue;
                        }
                        const dx = e.x - d.x;
                        const dy = e.y - d.y;
                        const rr = (d.r + e.r) * 0.82;
                        if (
                            d.wet &&
                            e.wet &&
                            ((d.age ?? 0) < (d.hold ?? 0) || (e.age ?? 0) < (e.hold ?? 0))
                        ) {
                            continue;
                        }
                        if (dx * dx + dy * dy < rr * rr) {
                            const a = d.r * d.r * d.r;
                            const b = e.r * e.r * e.r;
                            const s = a + b;
                            d.x = (d.x * a + e.x * b) / s;
                            d.y = (d.y * a + e.y * b) / s;
                            d.vx = (d.vx * a + e.vx * b) / s;
                            d.vy = (d.vy * a + e.vy * b) / s;
                            d.r = Math.cbrt(s);
                            d.dying = d.dying && e.dying;
                            e.r = 0;
                        }
                    }
                }
            }
        }
        drops = drops.filter((d) => d.r > 0);
    };

    const fillInstances = () => {
        let n = 0;
        const put = (x: number, y: number, r: number, sx: number, sy: number) => {
            if (n >= MAX_DROPS) {
                return;
            }
            const o = n * 5;
            inst[o] = x;
            inst[o + 1] = y;
            inst[o + 2] = r;
            inst[o + 3] = sx;
            inst[o + 4] = sy;
            n += 1;
        };
        const hr = hero.R * hero.k * (1 + hero.w * 0.05);
        if (hr > 2) {
            const s = Math.hypot(hero.vx, hero.vy);
            const a = Math.min(0.3, s / 2600) + Math.abs(hero.w) * 0.04;
            const sx = s > 1 ? (hero.vx / s) * a : a;
            const sy = s > 1 ? (hero.vy / s) * a : 0;
            put(hero.x, hero.y, hr, sx, sy);
        }
        for (const d of drops) {
            const s = Math.hypot(d.vx, d.vy);
            const a = Math.min(0.42, s / 620);
            const sx = s > 1 ? (d.vx / s) * a : 0;
            const sy = s > 1 ? (d.vy / s) * a : 0;
            put(d.x, d.y, d.lobes ? d.r * 0.9 : d.r, sx, sy);
            if (d.lobes) {
                for (let i = 0; i < d.lobes.length; i += 3) {
                    put(
                        d.x + Math.cos(d.lobes[i]) * d.lobes[i + 1] * d.r,
                        d.y + Math.sin(d.lobes[i]) * d.lobes[i + 1] * d.r,
                        d.lobes[i + 2] * d.r,
                        sx,
                        sy,
                    );
                }
            }
            if (s > 120 && d.r > 6) {
                put(
                    d.x - (d.vx / s) * d.r * 0.95,
                    d.y - (d.vy / s) * d.r * 0.95,
                    d.r * 0.62,
                    (d.vx / s) * a,
                    (d.vy / s) * a,
                );
            }
        }
        return n;
    };

    // ------------------------------------------------------------------ pointer input
    const handlePointerFrame = (pointer: PointerState) => {
        const x = pointer.x;
        const y = pointer.y;
        if (!pointer.inside && !drag) {
            havePrev = false;
            trailAcc = 0;
            return;
        }
        if (!havePrev) {
            px = x;
            py = y;
            havePrev = true;
        }
        const sp = Math.hypot(x - px, y - py);
        if (drag) {
            if (pointer.down) {
                hero.tx = x + drag.ox;
                hero.ty = y + drag.oy;
            } else {
                endDrag();
            }
        } else if (pointer.down) {
            if (sp > 3) {
                impulse(x, y, 7, Math.min(0.5, sp * 0.03));
            }
        } else if (sp > 2) {
            impulse(x, y, 6, Math.min(0.1, sp * 0.006));
            // the pointer is a wet fingertip: it leaves a line of small beads that gather and run
            if (introT >= INTRO && !overHero(x, y)) {
                const n = Math.min(24, Math.floor((trailAcc + sp) / 2.2));
                for (let i = 1; i <= n; i += 1) {
                    const u = (i * 2.2 - trailAcc) / sp;
                    const d = addDrop(
                        px + (x - px) * u + (rnd() - 0.5) * 1.2,
                        py + (y - py) * u + (rnd() - 0.5) * 1.2,
                        1.9 + rnd() * 1.0,
                    );
                    if (d) {
                        d.wet = true;
                        d.th = 6.4 + rnd() * 1.6;
                        d.hold = 0.9 + rnd() * 1.3;
                    }
                }
                trailAcc = n ? trailAcc + sp - n * 2.2 : trailAcc + sp;
            } else {
                trailAcc = 0;
            }
        }
        px = x;
        py = y;
    };

    // ------------------------------------------------------------------ Effect
    const resize = (width: number, height: number, ratio: number) => {
        const sizeChanged = Math.abs(width - W) > 0.5 || Math.abs(height - H) > 0.5;
        W = Math.max(1, width);
        H = Math.max(1, height);
        const bufW = Math.max(1, gl.drawingBufferWidth || Math.round(W * ratio));
        const bufH = Math.max(1, gl.drawingBufferHeight || Math.round(H * ratio));
        dpr = bufW / W;
        if (rip) {
            deleteTarget(rip[0]);
            deleteTarget(rip[1]);
        }
        deleteTarget(field);
        const rw = Math.max(16, Math.round(W / RIPPLE_SCALE));
        const rh = Math.max(16, Math.round(H / RIPPLE_SCALE));
        rip = [floatTarget(rw, rh), floatTarget(rw, rh)];
        field = floatTarget(bufW, bufH);
        cur = 0;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        if (sizeChanged && !hero.moved) {
            hero.placed = false;
        }
        for (const d of drops) {
            d.x = Math.min(d.x, W + 10);
        }
    };

    // The Reset button: wipe the glass dry and let the sheet of water run down again.
    const reset = () => {
        drag = null;
        drops = [];
        pending = [];
        impulses.length = 0;
        grid.clear();
        hero.placed = false;
        hero.moved = false;
        introT = -1;
        front = -1e9;
    };

    const pointerEvent = (kind: PointerEventKind, pointer: PointerState) => {
        if (kind === 'down') {
            hero.moved = true;
            if (introT < INTRO) {
                introT = INTRO;
                front = 1e9;
                while (pending.length) {
                    drops.push(pending.pop() as Drop);
                }
            }
            px = pointer.x;
            py = pointer.y;
            havePrev = true;
            impulse(px, py, 9, 3.2);
            shake(px, py, 0.55);
            if (overHero(px, py)) {
                drag = { ox: hero.x - px, oy: hero.y - py };
                hero.tx = hero.x;
                hero.ty = hero.y;
                hero.wv += 1.2;
            }
        } else if (kind === 'up') {
            endDrag();
        } else if (kind === 'leave') {
            endDrag();
            havePrev = false;
            trailAcc = 0;
        }
    };

    const render = (frame: EffectFrame) => {
        if (!rip || !field) {
            return;
        }
        const dt = Math.max(0.001, Math.min(0.05, frame.dt));
        handlePointerFrame(frame.pointer);
        stepDrops(dt);

        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.CULL_FACE);
        gl.bindVertexArray(vaoFull);

        // ripples, fixed 240 Hz steps (ping-pong between two float targets)
        gl.useProgram(progRipple.program);
        gl.viewport(0, 0, rip[0].w, rip[0].h);
        gl.uniform2f(progRipple.uniforms.uTexel, 1 / rip[0].w, 1 / rip[0].h);
        gl.uniform2f(progRipple.uniforms.uRes, W, H);
        gl.uniform1i(progRipple.uniforms.uPrev, 0);
        gl.activeTexture(gl.TEXTURE0);
        simAcc = Math.min(simAcc + dt * RIPPLE_HZ, 8);
        let first = true;
        while (simAcc >= 1) {
            simAcc -= 1;
            let n = 0;
            if (first) {
                n = Math.min(8, impulses.length / 4);
                impBuf.fill(0);
                for (let i = 0; i < n * 4; i += 1) {
                    impBuf[i] = impulses[i];
                }
                impulses.splice(0, n * 4);
                first = impulses.length > 0;
            }
            gl.uniform1i(progRipple.uniforms.uN, n);
            gl.uniform4fv(progRipple.uniforms.uImp, impBuf);
            gl.bindFramebuffer(gl.FRAMEBUFFER, rip[1 - cur].fbo);
            gl.bindTexture(gl.TEXTURE_2D, rip[cur].texture);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            cur = 1 - cur;
        }

        // bead field
        const count = fillInstances();
        gl.bindFramebuffer(gl.FRAMEBUFFER, field.fbo);
        gl.viewport(0, 0, field.w, field.h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (count) {
            gl.useProgram(progField.program);
            gl.uniform2f(progField.uniforms.uRes, W, H);
            gl.bindVertexArray(vaoField);
            gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst.subarray(0, count * 5));
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
            gl.disable(gl.BLEND);
        }

        // glass
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.useProgram(progGlass.program);
        gl.bindVertexArray(vaoFull);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, frame.pageTexture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, field.texture);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, rip[cur].texture);
        const u = progGlass.uniforms;
        gl.uniform1i(u.uUI, 0);
        gl.uniform1i(u.uField, 1);
        gl.uniform1i(u.uRip, 2);
        gl.uniform2f(u.uRes, W, H);
        gl.uniform2f(u.uRipTexel, 1 / rip[0].w, 1 / rip[0].h);
        gl.uniform3f(u.uHero, hero.x, hero.y, hero.R * hero.k * (1 + hero.w * 0.05));
        gl.uniform1f(u.uRipPx, W / rip[0].w);
        gl.uniform1f(u.uDpr, dpr);
        gl.uniform1f(u.uIor, IOR);
        gl.uniform1f(u.uDisp, DISPERSION);
        gl.uniform1f(u.uDark, DARK);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindVertexArray(null);
        gl.activeTexture(gl.TEXTURE0);
    };

    const dispose = () => {
        if (rip) {
            deleteTarget(rip[0]);
            deleteTarget(rip[1]);
            rip = null;
        }
        deleteTarget(field);
        field = null;
        gl.deleteProgram(progRipple.program);
        gl.deleteProgram(progField.program);
        gl.deleteProgram(progGlass.program);
        gl.deleteVertexArray(vaoFull);
        gl.deleteVertexArray(vaoField);
        gl.deleteBuffer(quadBuf);
        gl.deleteBuffer(instBuf);
    };

    return { name: 'Liquid Glass', resize, pointerEvent, reset, render, dispose };
}
