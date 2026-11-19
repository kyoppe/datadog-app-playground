export type Program = {
    program: WebGLProgram;
    /** Uniform locations by name, with any trailing "[0]" removed. */
    uniforms: Record<string, WebGLUniformLocation | null>;
};

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
    const shader = gl.createShader(type);
    if (!shader) {
        throw new Error('Unable to create WebGL shader.');
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) ?? 'Unknown shader error.';
        gl.deleteShader(shader);
        throw new Error(log);
    }

    return shader;
}

export function createProgram(
    gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
): Program {
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();

    if (!program) {
        throw new Error('Unable to create WebGL program.');
    }

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) ?? 'Unknown program error.';
        gl.deleteProgram(program);
        throw new Error(log);
    }

    const uniforms: Program['uniforms'] = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let index = 0; index < count; index += 1) {
        const info = gl.getActiveUniform(program, index);
        if (info) {
            const name = info.name.replace('[0]', '');
            uniforms[name] = gl.getUniformLocation(program, info.name);
        }
    }

    return { program, uniforms };
}

/** Float render targets (and linear filtering of them) are required by the simulations. */
export function requireFloatTargets(gl: WebGL2RenderingContext) {
    if (!gl.getExtension('EXT_color_buffer_float')) {
        throw new Error('EXT_color_buffer_float is not available.');
    }
    gl.getExtension('OES_texture_float_linear');
}
