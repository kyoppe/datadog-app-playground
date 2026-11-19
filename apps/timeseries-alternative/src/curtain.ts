import { createProgram } from './bars/glUtils';

// A sheet of cloth that carries a piece of HTML (the guide) across the screen: it is drawn in
// from the side like a curtain pulled shut, stretching while it travels and snapping tight on
// arrival, with pleats running along it and the hem flapping in the wind. Played backwards it is
// drawn away again. At the end of the way (progress 1) the cloth lies perfectly flat on the
// rectangle the HTML sits in. After that it keeps stirring a little, as if in a light wind.

const COLUMNS = 56;
const ROWS = 40;

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aUV;
uniform vec2 uRes;     // drawing buffer, px
uniform vec4 uRect;    // where the sheet ends up: x, y (from the top), width, height, px
uniform float uT;      // 0 = off screen, 1 = in place
uniform float uDir;    // +1 arrives from the right, -1 from the left
uniform float uTime;   // seconds
uniform float uScale;  // device pixel ratio
uniform float uBreeze; // 0..1: once in place, the cloth keeps stirring in a light wind
out vec2 vUV;
out float vShade;

void main() {
    vec2 size = uRect.zw;

    // The edge that leads moves first and the far edge follows, so the cloth is stretched out
    // while it travels and snaps tight when it arrives.
    float lead = uDir > 0.0 ? aUV.x : 1.0 - aUV.x;
    float tc = clamp((uT - lead * 0.38) / 0.62, 0.0, 1.0);
    // no overshoot: scaled by the whole width of the screen it would fold the cloth over
    float away = pow(1.0 - tc, 3.0);
    float travel = (uDir > 0.0 ? uRes.x - uRect.x : uRect.x + size.x) + 24.0 * uScale;

    // everything below dies away as the cloth arrives: in place it is perfectly flat
    float live = 1.0 - smoothstep(0.5, 1.0, uT);
    float phase = aUV.x * size.x / (46.0 * uScale) - uT * 11.0;
    float pleat = sin(phase);
    float flap = sin(uTime * 3.0 + aUV.x * 9.0);

    vec2 pos = uRect.xy + aUV * size;
    pos.x += uDir * travel * away;
    pos.x += sin(uTime * 5.0 + aUV.x * 3.0 + aUV.y * 2.0) * 5.0 * uScale * live * aUV.y * aUV.y;
    pos.y += pleat * 12.0 * uScale * live * (0.35 + 0.65 * aUV.y);
    pos.y += aUV.y * aUV.y * aUV.y * 9.0 * uScale * flap * live;

    // Once in place the cloth flutters in the wind: waves run along it and the whole sheet swells.
    // (Its arrival is eased in with uBreeze, so nothing shivers as it lands.)
    float wave = sin(aUV.x * size.x / (90.0 * uScale) - uTime * 4.2);
    pos.y += wave * 12.0 * uScale * uBreeze * (0.35 + 0.65 * aUV.y);
    pos.y += sin(uTime * 6.0 + aUV.x * 7.0 + aUV.y * 2.0) * 5.0 * uScale * uBreeze * aUV.y;
    pos.y += sin(uTime * 1.6 + aUV.x * 2.0) * 14.0 * uScale * uBreeze * (0.3 + 0.7 * aUV.y);
    pos.x += sin(uTime * 1.3 + aUV.y * 3.0) * 8.0 * uScale * uBreeze * aUV.y;

    vShade = 1.0 + 0.16 * cos(phase) * live + 0.07 * wave * uBreeze;
    vUV = aUV;
    gl_Position = vec4(pos.x / uRes.x * 2.0 - 1.0, 1.0 - pos.y / uRes.y * 2.0, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUV;
in float vShade;
uniform sampler2D uTex;
out vec4 o;
void main() {
    vec4 c = texture(uTex, vUV);
    // premultiplied, for a canvas that is composited over the page
    o = vec4(c.rgb * vShade * c.a, c.a);
}
`;

export type CurtainFrame = {
    /** The drawing buffer, px. */
    width: number;
    height: number;
    /** Device pixel ratio. */
    scale: number;
    /** Where the sheet ends up, in drawing-buffer px (y from the top). */
    rect: { x: number; y: number; w: number; h: number };
    /** The HTML on the cloth (v = 0 is its top). */
    texture: WebGLTexture;
    /** 0 = off screen, 1 = in place. */
    progress: number;
    /** +1: from the right, -1: from the left. */
    direction: 1 | -1;
    time: number;
    /** 0..1: how much the cloth stirs once it is in place (0 = lies flat). */
    breeze: number;
};

export type Curtain = {
    render(frame: CurtainFrame): void;
    dispose(): void;
};

export function createCurtain(gl: WebGL2RenderingContext): Curtain {
    const { program, uniforms } = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);

    const uvs = new Float32Array((COLUMNS + 1) * (ROWS + 1) * 2);
    for (let row = 0; row <= ROWS; row += 1) {
        for (let column = 0; column <= COLUMNS; column += 1) {
            const index = (row * (COLUMNS + 1) + column) * 2;
            uvs[index] = column / COLUMNS;
            uvs[index + 1] = row / ROWS;
        }
    }
    const indices = new Uint16Array(COLUMNS * ROWS * 6);
    let cursor = 0;
    for (let row = 0; row < ROWS; row += 1) {
        for (let column = 0; column < COLUMNS; column += 1) {
            const a = row * (COLUMNS + 1) + column;
            const b = a + 1;
            const c = a + (COLUMNS + 1);
            const d = c + 1;
            indices.set([a, b, c, b, d, c], cursor);
            cursor += 6;
        }
    }

    const vao = gl.createVertexArray();
    const vertices = gl.createBuffer();
    const elements = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elements);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    return {
        render(frame) {
            gl.viewport(0, 0, frame.width, frame.height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);

            gl.useProgram(program);
            gl.uniform2f(uniforms.uRes, frame.width, frame.height);
            gl.uniform4f(uniforms.uRect, frame.rect.x, frame.rect.y, frame.rect.w, frame.rect.h);
            gl.uniform1f(uniforms.uT, Math.min(1, Math.max(0, frame.progress)));
            gl.uniform1f(uniforms.uDir, frame.direction);
            gl.uniform1f(uniforms.uTime, frame.time);
            gl.uniform1f(uniforms.uScale, frame.scale);
            gl.uniform1f(uniforms.uBreeze, frame.breeze);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, frame.texture);
            gl.uniform1i(uniforms.uTex, 0);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.bindVertexArray(vao);
            gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
            gl.bindVertexArray(null);
            gl.disable(gl.BLEND);
        },
        dispose() {
            gl.deleteVertexArray(vao);
            gl.deleteBuffer(vertices);
            gl.deleteBuffer(elements);
            gl.deleteProgram(program);
        },
    };
}
