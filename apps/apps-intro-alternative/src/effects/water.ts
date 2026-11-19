import { createProgram } from './glUtils';
import type { Effect, EffectFrame } from './types';

const vertexShaderSource = `#version 300 es
    out vec2 uv;

    void main() {
        vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        uv = corner;
        gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
    }
`;

const fragmentShaderSource = `#version 300 es
    precision highp float;

    in vec2 uv;
    out vec4 outColor;
    uniform sampler2D articleTexture;
    uniform vec2 pointer;
    uniform float time;
    uniform float interaction;
    uniform vec2 resolution;

    // uv has its origin at the bottom-left; the element texture starts at the top-left.
    vec3 sampleArticle(vec2 coord) {
        return texture(articleTexture, vec2(coord.x, 1.0 - coord.y)).rgb;
    }

    void main() {
        float aspect = resolution.x / resolution.y;
        vec2 p = vec2(uv.x * aspect, uv.y);
        vec2 m = vec2(pointer.x * aspect, pointer.y);

        // Slow, large swells that keep the whole surface drifting, domain-warped so
        // they never look like a clean sine grid.
        vec2 swell = vec2(
            sin(p.y * 8.0 + time * 0.8 + sin(p.x * 4.0 + time * 0.5) * 1.8),
            cos(p.x * 6.0 - time * 0.7 + sin(p.y * 5.0 - time * 0.4) * 1.8)
        ) * 0.0075;

        // Faster, smaller ripples on top.
        vec2 chop = vec2(
            sin(p.y * 24.0 - time * 1.7 + p.x * 6.0),
            cos(p.x * 21.0 + time * 1.4 - p.y * 5.0)
        ) * 0.0022;

        // Rings spreading from the pointer.
        vec2 delta = p - m;
        float dist = length(delta);
        float ring = sin(dist * 38.0 - time * 5.5);
        float falloff = exp(-dist * 3.2);
        vec2 ripple = (delta / (dist + 0.0001)) * ring * falloff * 0.02 * interaction;
        ripple.x /= aspect;

        vec2 distortion = swell + chop + ripple;

        // Split the channels slightly, like light refracting through water.
        vec3 color = vec3(
            sampleArticle(uv + distortion * 1.35).r,
            sampleArticle(uv + distortion).g,
            sampleArticle(uv + distortion * 0.65).b
        );

        float wave = sin(p.x * 13.0 + p.y * 9.0 + time * 1.1 + ring * falloff * interaction * 3.0);
        float caustic = 0.9 + 0.14 * sin((p.x - p.y) * 17.0 + time * 1.3 + swell.x * 90.0);
        float glint = pow(max(wave, 0.0), 14.0) * 0.16;

        vec3 waterTint = mix(color, color * vec3(0.62, 0.88, 1.15), 0.22);
        outColor = vec4(waterTint * caustic + vec3(glint), 1.0);
    }
`;

export function createWater(gl: WebGL2RenderingContext): Effect {
    const { program, uniforms } = createProgram(gl, vertexShaderSource, fragmentShaderSource);
    const vao = gl.createVertexArray();
    // Ease toward the pointer so ripples glide and fade instead of snapping.
    const smoothed = { x: 0.5, y: 0.5, interaction: 0 };
    const target = { x: 0.5, y: 0.5 };

    return {
        name: 'Water',
        resize() {},
        render(frame: EffectFrame) {
            if (frame.pointer.inside) {
                target.x = frame.pointer.x / frame.width;
                target.y = 1 - frame.pointer.y / frame.height;
            }
            smoothed.x += (target.x - smoothed.x) * 0.12;
            smoothed.y += (target.y - smoothed.y) * 0.12;
            smoothed.interaction += ((frame.pointer.inside ? 1 : 0) - smoothed.interaction) * 0.06;

            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.useProgram(program);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, frame.pageTexture);
            gl.uniform1i(uniforms.articleTexture, 0);
            gl.uniform1f(uniforms.time, frame.time);
            gl.uniform2f(uniforms.pointer, smoothed.x, smoothed.y);
            gl.uniform1f(uniforms.interaction, smoothed.interaction);
            gl.uniform2f(uniforms.resolution, frame.width, frame.height);

            gl.bindVertexArray(vao);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.bindVertexArray(null);
        },
        dispose() {
            gl.deleteVertexArray(vao);
            gl.deleteProgram(program);
        },
    };
}
