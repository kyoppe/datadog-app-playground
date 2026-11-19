import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

const vertexShaderSource = `
    attribute vec2 position;
    varying vec2 uv;

    void main() {
        uv = position * 0.5 + 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
    }
`;

const fragmentShaderSource = `
    precision mediump float;

    varying vec2 uv;
    uniform sampler2D articleTexture;
    uniform vec2 pointer;
    uniform float time;
    uniform float interaction;

    void main() {
        vec2 delta = uv - pointer;
        float distanceToPointer = length(delta);
        float ring = sin(distanceToPointer * 72.0 - time * 4.8);
        float falloff = exp(-distanceToPointer * 8.0);
        float pointerWave = ring * falloff * 0.04 * interaction;
        float surfaceWave = sin(uv.y * 31.0 + time * 1.1)
            * cos(uv.x * 24.0 - time * 0.85)
            * 0.007;
        vec2 direction = normalize(delta + vec2(0.0001));
        vec2 distortion = direction * pointerWave;
        distortion += vec2(surfaceWave, surfaceWave * 0.7);

        // uv has its origin at the bottom-left; the element texture starts at the top-left.
        vec2 sampleUv = uv + distortion;
        vec4 color = texture2D(articleTexture, vec2(sampleUv.x, 1.0 - sampleUv.y));
        float caustic = 0.86 + 0.2 * sin((uv.x + uv.y) * 31.0 + time * 1.4);
        vec3 waterTint = mix(color.rgb, color.rgb * vec3(0.58, 0.86, 1.16), 0.24);
        gl_FragColor = vec4(waterTint * caustic, 1.0);
    }
`;

// HTML-in-Canvas is not part of lib.dom yet, so describe only the surface used here.
type HtmlInCanvasElement = HTMLCanvasElement & {
    requestPaint(): void;
    getElementImageDefaultSize(element: Element): { width: number; height: number };
    updateElementGeometry(element: Element, options: { canvasTransform?: DOMMatrix }): void;
};

type HtmlInCanvasContext = WebGLRenderingContext & {
    texElementSubImage2D(
        target: number,
        level: number,
        xoffset: number,
        yoffset: number,
        element: Element,
    ): void;
};

type PointerPosition = {
    x: number;
    y: number;
    interaction: number;
};

const MAX_CONSECUTIVE_PAINT_FAILURES = 5;

function supportsHtmlInCanvas() {
    if (typeof document === 'undefined' || typeof WebGLRenderingContext === 'undefined') {
        return false;
    }

    const probe = document.createElement('canvas');
    probe.setAttribute('content', 'drawable');

    return (
        (probe as { content?: string }).content === 'drawable' &&
        'requestPaint' in probe &&
        'texElementSubImage2D' in WebGLRenderingContext.prototype
    );
}

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
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

function createProgram(gl: WebGLRenderingContext) {
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    const program = gl.createProgram();

    if (!program) {
        throw new Error('Unable to create WebGL program.');
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) ?? 'Unknown program error.';
        gl.deleteProgram(program);
        throw new Error(log);
    }

    return program;
}

function ArticleContent() {
    return (
        <>
            <p className="article-kicker">A small rendering experiment</p>
            <h2>Ordinary HTML, moving like water</h2>
            <p className="article-lede">
                This article is ordinary HTML. The browser hands it to WebGL as a texture
                through the HTML-in-Canvas API, and a shader bends that texture around your
                pointer.
            </p>
            <div className="article-rule" />
            <h3>Why is this different from a screenshot?</h3>
            <p>
                The article is a real child of the canvas. The browser lays it out, keeps it in
                the accessibility tree, and routes clicks to its links, so no second copy of the
                page is needed.
            </p>
            <p>
                Move your pointer across the article. You can also visit the{' '}
                <a
                    href="https://docs.datadoghq.com/actions/datadog_apps/"
                    target="_blank"
                    rel="noreferrer"
                >
                    Datadog Apps documentation
                </a>
                .
            </p>
            <aside className="article-callout">
                <strong>Graceful fallback</strong>
                <span>
                    If the browser does not support HTML-in-Canvas, this same article is
                    rendered as a normal, readable HTML page.
                </span>
            </aside>
            <h3>What is happening here?</h3>
            <ol>
                <li>The canvas opts in with content="drawable" and the article is drawable.</li>
                <li>On every paint event the article is copied into a WebGL texture.</li>
                <li>A pointer-centered water ripple is applied in the fragment shader.</li>
            </ol>
            <p className="article-footnote">
                This is a local prototype. It does not upload data or call the Datadog API.
            </p>
        </>
    );
}

function HtmlCanvasArticle() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const articleRef = useRef<HTMLElement>(null);
    const pointerRef = useRef<PointerPosition>({ x: 0.5, y: 0.5, interaction: 0 });
    const [native, setNative] = useState(supportsHtmlInCanvas);
    const [ready, setReady] = useState(false);

    const updatePointer = useCallback((event: PointerEvent<HTMLDivElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        pointerRef.current = {
            x: (event.clientX - bounds.left) / bounds.width,
            y: 1 - (event.clientY - bounds.top) / bounds.height,
            interaction: 1,
        };
    }, []);

    const clearPointer = useCallback(() => {
        pointerRef.current.interaction = 0;
    }, []);

    useEffect(() => {
        if (!native) {
            return;
        }

        const canvas = canvasRef.current as HtmlInCanvasElement | null;
        const article = articleRef.current;
        if (!canvas || !article) {
            return;
        }

        const fallBack = () => window.setTimeout(() => setNative(false), 0);

        // Opt in before the first paint: the canvas lays out its children, and the
        // article becomes an independently drawable element.
        canvas.setAttribute('content', 'drawable');
        article.setAttribute('drawable', '');

        const gl = canvas.getContext('webgl', { alpha: false }) as HtmlInCanvasContext | null;
        if (!gl) {
            fallBack();
            return;
        }

        let program: WebGLProgram;
        try {
            program = createProgram(gl);
        } catch (error) {
            console.error(error);
            fallBack();
            return;
        }

        const positionBuffer = gl.createBuffer();
        const texture = gl.createTexture();
        const positionLocation = gl.getAttribLocation(program, 'position');
        const pointerLocation = gl.getUniformLocation(program, 'pointer');
        const timeLocation = gl.getUniformLocation(program, 'time');
        const interactionLocation = gl.getUniformLocation(program, 'interaction');

        if (!positionBuffer || !texture || positionLocation < 0) {
            fallBack();
            return;
        }

        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
            gl.STATIC_DRAW,
        );
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(gl.getUniformLocation(program, 'articleTexture'), 0);

        let disposed = false;
        let textureWidth = 0;
        let textureHeight = 0;
        let failures = 0;

        // The canvas has no intrinsic size: follow the article that lives inside it.
        const syncCanvasSize = () => {
            const bounds = article.getBoundingClientRect();
            const scale = Math.min(window.devicePixelRatio || 1, 2);
            canvas.style.height = `${bounds.height}px`;
            canvas.width = Math.max(1, Math.round(bounds.width * scale));
            canvas.height = Math.max(1, Math.round(bounds.height * scale));
            gl.viewport(0, 0, canvas.width, canvas.height);

            // WebGL cannot infer where the element is drawn, so tell the browser for
            // hit testing (links, selection) and the accessibility tree.
            try {
                canvas.updateElementGeometry(article, {
                    canvasTransform: new DOMMatrix().scale(scale),
                });
            } catch (error) {
                console.warn('updateElementGeometry failed', error);
            }

            canvas.requestPaint();
        };

        const onPaint = () => {
            if (disposed) {
                return;
            }

            try {
                const size = canvas.getElementImageDefaultSize(article);
                const width = Math.max(1, Math.ceil(size.width));
                const height = Math.max(1, Math.ceil(size.height));

                gl.useProgram(program);
                gl.bindTexture(gl.TEXTURE_2D, texture);
                if (width !== textureWidth || height !== textureHeight) {
                    gl.texImage2D(
                        gl.TEXTURE_2D,
                        0,
                        gl.RGBA,
                        width,
                        height,
                        0,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        null,
                    );
                    textureWidth = width;
                    textureHeight = height;
                }
                gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, article);

                gl.uniform1f(timeLocation, performance.now() * 0.001);
                gl.uniform2f(pointerLocation, pointerRef.current.x, pointerRef.current.y);
                gl.uniform1f(interactionLocation, pointerRef.current.interaction);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

                failures = 0;
                setReady(true);
            } catch (error) {
                // The element may not have a cached paint record yet; retry a few times.
                failures += 1;
                if (failures >= MAX_CONSECUTIVE_PAINT_FAILURES) {
                    console.error('HTML-in-Canvas paint failed', error);
                    fallBack();
                    return;
                }
            }

            // Keep animating: schedule the next paint even when the DOM is unchanged.
            canvas.requestPaint();
        };

        const resizeObserver = new ResizeObserver(syncCanvasSize);
        resizeObserver.observe(article);
        canvas.addEventListener('paint', onPaint);
        syncCanvasSize();

        return () => {
            disposed = true;
            canvas.removeEventListener('paint', onPaint);
            resizeObserver.disconnect();
            gl.deleteTexture(texture);
            gl.deleteBuffer(positionBuffer);
            gl.deleteProgram(program);
        };
    }, [native]);

    const stageClassName = ['article-stage', native ? 'native' : 'fallback']
        .filter(Boolean)
        .join(' ');

    let modeLabel = 'Fallback: HTML-in-Canvas is not supported here';
    if (native) {
        modeLabel = ready
            ? 'Native HTML-in-Canvas + WebGL active'
            : 'Waiting for the first paint event...';
    }

    return (
        <>
            <style>{`
                :root {
                    color-scheme: dark;
                }

                * {
                    box-sizing: border-box;
                }

                body {
                    margin: 0;
                    background: #111631;
                }

                .app-page {
                    min-height: 100vh;
                    padding: 48px 22px 72px;
                    color: #f5f7ff;
                    background:
                        radial-gradient(circle at 10% 0%, rgba(69, 89, 220, 0.4), transparent 36%),
                        linear-gradient(150deg, #111631 0%, #1a2254 54%, #0b1029 100%);
                    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                }

                .app-header,
                .article-stage {
                    width: min(820px, 100%);
                    margin: 0 auto;
                }

                .app-kicker {
                    margin: 0 0 12px;
                    color: #99aaff;
                    font-size: 12px;
                    font-weight: 700;
                    letter-spacing: 0.16em;
                    text-transform: uppercase;
                }

                .app-header h1 {
                    max-width: 730px;
                    margin: 0;
                    font-size: clamp(38px, 7vw, 76px);
                    line-height: 0.98;
                    letter-spacing: -0.065em;
                }

                .app-header p {
                    max-width: 650px;
                    margin: 22px 0 24px;
                    color: #c2c9e6;
                    font-size: 17px;
                    line-height: 1.6;
                }

                .mode {
                    display: inline-flex;
                    margin: 0 0 28px;
                    border: 1px solid rgba(173, 190, 255, 0.3);
                    border-radius: 999px;
                    padding: 7px 12px;
                    color: #d3dbff;
                    background: rgba(255, 255, 255, 0.08);
                    font-size: 13px;
                }

                .article-stage {
                    position: relative;
                    overflow: hidden;
                    border: 1px solid rgba(187, 207, 255, 0.35);
                    border-radius: 22px;
                    background: #ffffff;
                    box-shadow: 0 28px 90px rgba(0, 0, 0, 0.36);
                }

                .article-canvas {
                    display: block;
                    width: 100%;
                    min-height: 620px;
                    background: #073c82;
                }

                .article-body {
                    display: block;
                    min-height: 620px;
                    padding: clamp(30px, 7vw, 76px);
                    color: #152044;
                    background: #ffffff;
                    font-family: Georgia, "Times New Roman", serif;
                    font-size: 18px;
                    line-height: 1.75;
                }

                /* Water palette: only the drawn texture, since the shader tints it further. */
                .article-stage.native .article-body {
                    width: 100%;
                    color: #e7fbff;
                    background:
                        repeating-radial-gradient(
                            ellipse at 20% 20%,
                            rgba(184, 248, 255, 0.16) 0 2px,
                            transparent 3px 34px
                        ),
                        repeating-linear-gradient(
                            12deg,
                            rgba(156, 239, 255, 0.12) 0 3px,
                            transparent 4px 22px
                        ),
                        linear-gradient(145deg, #12a8d4 0%, #096eae 48%, #073c82 100%);
                }

                .article-stage.native .article-kicker,
                .article-stage.native .article-body h2,
                .article-stage.native .article-body h3 {
                    color: #f1feff;
                    text-shadow: 0 2px 0 rgba(0, 48, 100, 0.24);
                }

                .article-stage.native .article-body a {
                    color: #ffffff;
                }

                .article-stage.native .article-callout {
                    border-left-color: #f7e77a;
                    background: rgba(0, 48, 112, 0.3);
                }

                .article-stage.native .article-callout strong,
                .article-stage.native .article-callout span {
                    color: #f4ffff;
                }

                .article-stage.native .article-footnote {
                    color: #c8f4ff;
                }

                .article-kicker {
                    margin: 0 0 14px;
                    color: #3970c8;
                    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
                    font-size: 12px;
                    font-weight: 800;
                    letter-spacing: 0.12em;
                    text-transform: uppercase;
                }

                .article-body h2 {
                    max-width: 650px;
                    margin: 0 0 20px;
                    color: inherit;
                    font-size: clamp(38px, 7vw, 74px);
                    line-height: 0.98;
                    letter-spacing: -0.055em;
                }

                .article-body h3 {
                    margin: 36px 0 8px;
                    color: inherit;
                    font-size: 27px;
                    line-height: 1.15;
                }

                .article-body p {
                    max-width: 650px;
                    margin: 0 0 20px;
                }

                .article-lede {
                    color: inherit;
                    font-size: 21px;
                    line-height: 1.5;
                }

                .article-rule {
                    width: 100%;
                    height: 1px;
                    margin: 32px 0;
                    background: currentColor;
                    opacity: 0.18;
                }

                .article-body a {
                    color: #145bc0;
                    font-weight: 700;
                    text-decoration-thickness: 2px;
                    text-underline-offset: 3px;
                }

                .article-callout {
                    display: grid;
                    gap: 8px;
                    max-width: 650px;
                    margin: 30px 0;
                    border-left: 4px solid #4b83df;
                    padding: 18px 22px;
                    background: #edf4ff;
                    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
                    line-height: 1.5;
                }

                .article-callout strong {
                    color: #164b9d;
                    font-size: 14px;
                }

                .article-callout span {
                    color: #263d67;
                    font-size: 15px;
                }

                .article-body ol {
                    max-width: 650px;
                    padding-left: 28px;
                }

                .article-footnote {
                    margin-top: 44px !important;
                    color: #65708c;
                    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
                    font-size: 13px;
                }

                .explanation {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 12px;
                    width: min(820px, 100%);
                    margin: 18px auto 0;
                }

                .explanation div {
                    border: 1px solid rgba(174, 190, 255, 0.23);
                    border-radius: 14px;
                    padding: 16px;
                    color: #bfc8ed;
                    background: rgba(255, 255, 255, 0.06);
                    font-size: 13px;
                    line-height: 1.45;
                }

                .explanation strong {
                    display: block;
                    margin-bottom: 5px;
                    color: #f3f5ff;
                }

                @media (max-width: 680px) {
                    .app-page {
                        padding: 30px 14px 48px;
                    }

                    .article-body {
                        min-height: 700px;
                        padding: 30px 24px;
                    }

                    .explanation {
                        grid-template-columns: 1fr;
                    }
                }
            `}</style>
            <main className="app-page">
                <header className="app-header">
                    <p className="app-kicker">Datadog Apps Playground</p>
                    <h1>HTML-in-Canvas with a WebGL water shader</h1>
                    <p>
                        Move your pointer across the article. The browser draws the real HTML
                        into a WebGL texture, and the shader makes the pixels ripple.
                    </p>
                    <span className="mode" role="status">
                        {modeLabel}
                    </span>
                </header>

                <div
                    className={stageClassName}
                    onPointerMove={updatePointer}
                    onPointerLeave={clearPointer}
                >
                    {native ? (
                        <canvas className="article-canvas" ref={canvasRef}>
                            <article className="article-body" ref={articleRef}>
                                <ArticleContent />
                            </article>
                        </canvas>
                    ) : (
                        <article className="article-body">
                            <ArticleContent />
                        </article>
                    )}
                </div>

                <section className="explanation" aria-label="Implementation notes">
                    <div>
                        <strong>Drawable element</strong>
                        The canvas opts in with content="drawable" and its child article is
                        marked drawable.
                    </div>
                    <div>
                        <strong>WebGL texture</strong>
                        texElementSubImage2D copies the article into a texture on every paint
                        event.
                    </div>
                    <div>
                        <strong>HTML fallback</strong>
                        Without browser support, the article is rendered as plain HTML.
                    </div>
                </section>
            </main>
        </>
    );
}

export default HtmlCanvasArticle;
