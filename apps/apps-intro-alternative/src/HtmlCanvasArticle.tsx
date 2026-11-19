import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import TerminalDemo from './TerminalDemo';
import { createInk } from './effects/ink';
import { createJelly } from './effects/jelly';
import { createLiquidGlass } from './effects/liquidGlass';
import type { Effect, EffectFactory, PointerEventKind, PointerState } from './effects/types';
import { createWater } from './effects/water';

type EffectId = 'water' | 'glass' | 'ink' | 'jelly';

const EFFECTS: { id: EffectId; label: string; factory: EffectFactory }[] = [
    { id: 'water', label: 'Water', factory: createWater },
    { id: 'glass', label: 'Liquid Glass', factory: createLiquidGlass },
    { id: 'ink', label: 'Ink', factory: createInk },
    { id: 'jelly', label: 'Jelly', factory: createJelly },
];

// Which effect greets the visitor is random, picked once per page load.
const INITIAL_EFFECT = EFFECTS[Math.floor(Math.random() * EFFECTS.length)].id;

// HTML-in-Canvas is not part of lib.dom yet, so describe only the surface used here.
type HtmlInCanvasElement = HTMLCanvasElement & {
    requestPaint(): void;
    getElementImageDefaultSize(element: Element): {
        width: number;
        height: number;
    };
    updateElementGeometry(element: Element, options: { canvasTransform?: DOMMatrix }): void;
};

type HtmlInCanvasContext = WebGL2RenderingContext & {
    texElementSubImage2D(
        target: number,
        level: number,
        xoffset: number,
        yoffset: number,
        element: Element,
    ): void;
};

const MAX_CONSECUTIVE_PAINT_FAILURES = 5;

function supportsHtmlInCanvas() {
    if (typeof document === 'undefined' || typeof WebGL2RenderingContext === 'undefined') {
        return false;
    }

    const probe = document.createElement('canvas');
    probe.setAttribute('content', 'drawable');

    return (
        (probe as { content?: string }).content === 'drawable' &&
        'requestPaint' in probe &&
        'texElementSubImage2D' in WebGL2RenderingContext.prototype
    );
}

function OceanConsole() {
    return (
        <div className="landing">
            <p className="landing-kicker">Datadog Apps</p>
            <h1>
                Build custom apps,
                <br />
                <span className="gradient">with your Datadog data</span>.
            </h1>
            <p className="landing-sub">
                Use Claude, Cursor, or your preferred AI agent to bring your ideas to life.
            </p>
            <a
                className="cta"
                href="https://docs.datadoghq.com/actions/datadog_apps/"
                target="_blank"
                rel="noreferrer"
            >
                Get Started
            </a>

            <div className="window">
                <div className="window-bar">
                    <span className="light red" />
                    <span className="light yellow" />
                    <span className="light green" />
                    <span className="window-title">Datadog Apps ~ cli</span>
                </div>
                <TerminalDemo />
            </div>

            <a
                className="watch"
                href="https://www.youtube.com/watch?v=Ou5zyErFrY0"
                target="_blank"
                rel="noreferrer"
            >
                Watch the demo
                <span className="watch-icon" aria-hidden="true" />
            </a>

            <p className="landing-foot">
                You can also build an app with the{' '}
                <a href="/app-builder/apps/edit?newApp=true">classic App Builder</a>
            </p>
        </div>
    );
}

function HtmlCanvasArticle() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const articleRef = useRef<HTMLElement>(null);
    const pointerRef = useRef<PointerState>({
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        down: false,
        inside: false,
    });
    const lastMoveRef = useRef({ time: 0, x: 0, y: 0 });
    const effectEventRef = useRef<((kind: PointerEventKind) => void) | null>(null);
    const requestedEffectRef = useRef<EffectId>(INITIAL_EFFECT);
    const resetRef = useRef<(() => void) | null>(null);
    const [native, setNative] = useState(supportsHtmlInCanvas);
    const [ready, setReady] = useState(false);
    const [effectId, setEffectId] = useState<EffectId>(INITIAL_EFFECT);
    const [notice, setNotice] = useState<string | null>(null);
    const [canReset, setCanReset] = useState(false);

    const selectEffect = useCallback((id: EffectId) => {
        requestedEffectRef.current = id;
        setEffectId(id);
        setNotice(null);
    }, []);

    const trackPointer = useCallback(
        (kind: PointerEventKind, event: PointerEvent<HTMLDivElement>) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - bounds.left;
            const y = event.clientY - bounds.top;
            const pointer = pointerRef.current;
            const last = lastMoveRef.current;
            const now = performance.now();

            if (kind === 'move' && last.time > 0) {
                const seconds = Math.max((now - last.time) / 1000, 0.001);
                pointer.vx += ((x - last.x) / seconds - pointer.vx) * 0.35;
                pointer.vy += ((y - last.y) / seconds - pointer.vy) * 0.35;
            } else {
                pointer.vx = 0;
                pointer.vy = 0;
            }

            pointer.x = x;
            pointer.y = y;
            pointer.inside = kind !== 'leave';
            if (kind === 'down') {
                pointer.down = true;
            } else if (kind === 'up' || kind === 'leave') {
                pointer.down = false;
            }
            lastMoveRef.current = kind === 'leave' ? { time: 0, x, y } : { time: now, x, y };

            effectEventRef.current?.(kind);
        },
        [],
    );

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

        const gl = canvas.getContext('webgl2', {
            alpha: false,
        }) as HtmlInCanvasContext | null;
        const pageTexture = gl?.createTexture();
        if (!gl || !pageTexture) {
            fallBack();
            return;
        }

        gl.bindTexture(gl.TEXTURE_2D, pageTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        let disposed = false;
        let textureWidth = 0;
        let textureHeight = 0;
        let failures = 0;
        let effect: Effect | null = null;
        let activeId: EffectId | null = null;
        let size = { width: 1, height: 1, dpr: 1 };
        let lastTime = performance.now();

        // Swap the active effect. A broken effect (missing GPU feature, shader error) falls
        // back to Water instead of taking the whole page down.
        const activate = (id: EffectId) => {
            effect?.dispose();
            effect = null;
            activeId = null;

            const entry = EFFECTS.find((candidate) => candidate.id === id) ?? EFFECTS[0];
            try {
                const created = entry.factory(gl);
                created.resize(size.width, size.height, size.dpr);
                effect = created;
                activeId = entry.id;
                setCanReset(typeof created.reset === 'function');
            } catch (error) {
                console.error(`${entry.label} failed to start`, error);
                if (entry.id === 'water') {
                    fallBack();
                    return;
                }
                const reason = error instanceof Error ? error.message : String(error);
                setNotice(`${entry.label} is unavailable on this GPU: ${reason.slice(0, 120)}`);
                requestedEffectRef.current = 'water';
                setEffectId('water');
                activate('water');
            }
        };

        resetRef.current = () => effect?.reset?.();
        effectEventRef.current = (kind) => {
            effect?.pointerEvent?.(kind, pointerRef.current);
        };

        // WebGL cannot infer where the element is drawn, so tell the browser for hit testing
        // (links) and the accessibility tree. The page is drawn where it was laid out; the
        // transform is in CSS px.
        const applyGeometry = () => {
            try {
                canvas.updateElementGeometry(article, { canvasTransform: new DOMMatrix() });
            } catch (error) {
                console.warn('updateElementGeometry failed', error);
            }
        };

        // Links on a page that an effect has bent out of shape would sit in the wrong place.
        let interactive = true;
        const applyInteractive = () => {
            const next = effect?.pageInteractive?.() ?? true;
            if (next !== interactive) {
                interactive = next;
                article.style.pointerEvents = next ? '' : 'none';
            }
        };

        // The canvas has no intrinsic size: follow the article that lives inside it.
        const syncCanvasSize = () => {
            // Layout size, unaffected by the transform the effect or the CSS fallback applies.
            const width = article.offsetWidth;
            const height = article.offsetHeight;
            const scale = Math.min(window.devicePixelRatio || 1, 2);
            canvas.style.height = `${height}px`;
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            gl.viewport(0, 0, canvas.width, canvas.height);
            size = { width, height, dpr: scale };
            effect?.resize(size.width, size.height, size.dpr);

            applyGeometry();

            canvas.requestPaint();
        };

        const onPaint = () => {
            if (disposed) {
                return;
            }

            const now = performance.now();
            const dt = Math.min(Math.max((now - lastTime) / 1000, 0), 0.05);
            lastTime = now;

            try {
                const textureSize = canvas.getElementImageDefaultSize(article);
                const width = Math.max(1, Math.ceil(textureSize.width));
                const height = Math.max(1, Math.ceil(textureSize.height));

                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, pageTexture);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
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

                if (activeId !== requestedEffectRef.current || !effect) {
                    activate(requestedEffectRef.current);
                }

                // Let the pointer speed settle when the pointer stops moving.
                const pointer = pointerRef.current;
                if (now - lastMoveRef.current.time > 60) {
                    pointer.vx *= 0.85;
                    pointer.vy *= 0.85;
                }

                effect?.render({
                    time: now * 0.001,
                    dt,
                    width: size.width,
                    height: size.height,
                    dpr: size.dpr,
                    pageTexture,
                    pageSize: { width: textureWidth, height: textureHeight },
                    pointer,
                });

                applyInteractive();

                failures = 0;
                setReady(true);
            } catch (error) {
                // The element may not have a cached paint record yet; retry a few times.
                failures += 1;
                if (failures >= MAX_CONSECUTIVE_PAINT_FAILURES) {
                    console.error('HTML-in-Canvas paint failed', error);
                    if (activeId !== null && activeId !== 'water') {
                        // An effect that throws every frame is the likelier culprit.
                        failures = 0;
                        const label =
                            EFFECTS.find((entry) => entry.id === activeId)?.label ?? activeId;
                        setNotice(`${label} stopped rendering; switched back to Water.`);
                        requestedEffectRef.current = 'water';
                        setEffectId('water');
                    } else {
                        fallBack();
                        return;
                    }
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
            effectEventRef.current = null;
            resetRef.current = null;
            effect?.dispose();
            gl.deleteTexture(pageTexture);
        };
    }, [native]);

    const stageClassName = ['article-stage', native ? 'native' : 'fallback']
        .filter(Boolean)
        .join(' ');

    const effectLabel = EFFECTS.find((candidate) => candidate.id === effectId)?.label ?? '';
    let modeLabel = 'Fallback: HTML-in-Canvas is not supported here';
    if (native) {
        modeLabel = ready
            ? `Native HTML-in-Canvas + WebGL \u00b7 ${effectLabel}`
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

                html,
                body {
                    margin: 0;
                    overflow: hidden;
                    background: #0d1030;
                }

                .article-stage {
                    position: fixed;
                    inset: 0;
                }

                .article-canvas {
                    display: block;
                    width: 100vw;
                    height: 100vh;
                    background: #0d1030;
                }

                .console {
                    display: block;
                    width: 100vw;
                    height: 100vh;
                    overflow: hidden;
                    color: #ffffff;
                    background:
                        radial-gradient(ellipse at 18% 22%, rgba(102, 68, 210, 0.42), transparent 55%),
                        radial-gradient(ellipse at 85% 80%, rgba(40, 70, 190, 0.3), transparent 55%),
                        linear-gradient(160deg, #1b1546 0%, #101535 50%, #0a0e26 100%);
                    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                }

                .landing {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 0;
                    height: 100%;
                    padding: 24px;
                    text-align: center;
                }

                .landing-kicker {
                    margin: 0 0 14px;
                    color: #b9c2ff;
                    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                    font-size: 12px;
                    font-weight: 700;
                    letter-spacing: 0.22em;
                    text-transform: uppercase;
                }

                .landing h1 {
                    margin: 0;
                    font-size: clamp(32px, 5.2vw, 52px);
                    font-weight: 800;
                    line-height: 1.05;
                    letter-spacing: -0.035em;
                }

                .gradient {
                    background: linear-gradient(90deg, #4f9bff 0%, #8c7bff 100%);
                    -webkit-background-clip: text;
                    background-clip: text;
                    color: transparent;
                }

                .landing-sub {
                    margin: 18px 0 22px;
                    color: #e6e9ff;
                    font-size: 16px;
                }

                .cta {
                    display: inline-block;
                    border: 1px solid rgba(190, 180, 255, 0.45);
                    border-radius: 8px;
                    padding: 11px 22px;
                    color: #ffffff;
                    background: linear-gradient(180deg, #5b44c9 0%, #4330a0 100%);
                    font-size: 15px;
                    font-weight: 600;
                    text-decoration: none;
                }

                .window {
                    width: clamp(320px, calc((100vh - 460px) * 16 / 9), 880px);
                    margin-top: 32px;
                    overflow: hidden;
                    border: 1px solid rgba(150, 130, 255, 0.45);
                    border-radius: 12px;
                    background: #1c1c1e;
                    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
                }

                .window-bar {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    height: 31px;
                    padding: 0 12px;
                    background: #2a2a2e;
                }

                .light {
                    width: 12px;
                    height: 12px;
                    border-radius: 50%;
                }

                .red {
                    background: #ff5f57;
                }

                .yellow {
                    background: #febc2e;
                }

                .green {
                    background: #28c840;
                }

                .window-title {
                    margin-left: 6px;
                    color: #d9dbe6;
                    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                    font-size: 12px;
                }

                .term-body {
                    position: relative;
                    width: 100%;
                    aspect-ratio: 16 / 9;
                    overflow: hidden;
                    padding: 14px 16px 16px;
                    background: #1c1b1e;
                    font-family: "Roboto Mono", Menlo, Consolas, monospace;
                }

                .term-scroll {
                    position: absolute;
                    top: 14px;
                    right: 16px;
                    left: 16px;
                    text-align: left;
                    transition:
                        transform 0.5s cubic-bezier(0.4, 0, 0.2, 1),
                        opacity 0.48s ease;
                }

                .term-banner {
                    display: block;
                    width: 100%;
                    margin-bottom: 6px;
                    opacity: 0;
                    transition: opacity 0.6s ease;
                }

                .term-banner.show {
                    opacity: 1;
                }

                .term-line {
                    min-height: 1.62em;
                    color: #e4e8eb;
                    font-size: 12.5px;
                    line-height: 1.62;
                    white-space: pre-wrap;
                    word-break: break-word;
                }

                .t-white {
                    color: #fff;
                }

                .t-violet {
                    color: #ac9dff;
                }

                .term-cursor {
                    display: inline-block;
                    width: 7px;
                    height: 14px;
                    margin-left: 1px;
                    background: #46e0a0;
                    vertical-align: -2px;
                    animation: term-blink 1s steps(1) infinite;
                }

                @keyframes term-blink {
                    50% {
                        opacity: 0;
                    }
                }

                .mini-app {
                    position: absolute;
                    right: 16px;
                    bottom: 16px;
                    z-index: 5;
                    width: min(300px, 46%);
                    overflow: hidden;
                    border: 1px solid #e4e8ee;
                    border-radius: 10px;
                    color: #1c2b34;
                    background: #fff;
                    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
                    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
                    text-align: left;
                    opacity: 0;
                    transform: translateY(16px) scale(0.96);
                    transition:
                        opacity 0.5s ease,
                        transform 0.55s cubic-bezier(0.34, 1.25, 0.5, 1);
                }

                .mini-app.show {
                    opacity: 1;
                    transform: none;
                }

                .mini-browser {
                    display: flex;
                    align-items: center;
                    padding: 7px 10px;
                    border-bottom: 1px solid #e4e8eb;
                    background: #f1f3f5;
                }

                .mini-url {
                    flex: 1;
                    min-width: 0;
                    overflow: hidden;
                    padding: 4px 8px;
                    border: 1px solid #e4e8eb;
                    border-radius: 5px;
                    color: #5a6b78;
                    background: #fff;
                    font-size: 10px;
                    line-height: 1;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                }

                .mini-head {
                    display: flex;
                    align-items: center;
                    gap: 7px;
                    padding: 9px 12px;
                    border-bottom: 1px solid #eef0f2;
                }

                .mini-title {
                    font-size: 12px;
                    font-weight: 700;
                }

                .mini-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    margin-left: auto;
                    padding: 3px 7px;
                    border-radius: 5px;
                    color: #1f8a5b;
                    background: #e7f7ef;
                    font-size: 9px;
                    font-weight: 700;
                    letter-spacing: 0.05em;
                }

                .mini-live {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: #46e0a0;
                    animation: mini-pulse 1.6s infinite;
                }

                @keyframes mini-pulse {
                    0% {
                        box-shadow: 0 0 0 0 rgba(70, 224, 160, 0.55);
                    }
                    70% {
                        box-shadow: 0 0 0 6px rgba(70, 224, 160, 0);
                    }
                    100% {
                        box-shadow: 0 0 0 0 rgba(70, 224, 160, 0);
                    }
                }

                .mini-row {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 9px 12px;
                    border-bottom: 1px solid #f2f4f6;
                    opacity: 0;
                    transform: translateY(8px);
                }

                .mini-row:last-child {
                    border-bottom: 0;
                }

                .mini-app.show .mini-row {
                    animation: mini-in 0.45s ease forwards;
                }

                .mini-app.show .mini-row:nth-of-type(3) {
                    animation-delay: 0.18s;
                }

                .mini-app.show .mini-row:nth-of-type(4) {
                    animation-delay: 0.33s;
                }

                .mini-app.show .mini-row:nth-of-type(5) {
                    animation-delay: 0.48s;
                }

                @keyframes mini-in {
                    to {
                        opacity: 1;
                        transform: none;
                    }
                }

                .mini-name {
                    flex: 1;
                    min-width: 0;
                    overflow: hidden;
                    color: #2a3b47;
                    font-size: 11px;
                    font-weight: 600;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                }

                .mini-pill {
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 9px;
                    font-weight: 700;
                    white-space: nowrap;
                }

                .mini-pill.ok {
                    color: #1f8a5b;
                    background: #e7f7ef;
                }

                .mini-pill.wait {
                    color: #9a6a00;
                    background: #fdf3da;
                }

                .mini-dot {
                    flex: none;
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                }

                .mini-dot.ok {
                    background: #46e0a0;
                }

                .mini-dot.wait {
                    background: #f4bf4f;
                }

                .watch {
                    display: inline-flex;
                    align-items: center;
                    gap: 12px;
                    margin-top: 26px;
                    border: 1px solid rgba(190, 180, 255, 0.28);
                    border-radius: 999px;
                    padding: 6px 7px 6px 16px;
                    color: #ffffff;
                    background: rgba(8, 10, 28, 0.85);
                    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
                    font-size: 13px;
                    font-weight: 700;
                    text-decoration: none;
                }

                .watch-icon {
                    position: relative;
                    width: 26px;
                    height: 26px;
                    border-radius: 50%;
                    background: #6b6d78;
                }

                .watch-icon::after {
                    content: '';
                    position: absolute;
                    top: 8px;
                    left: 10px;
                    border-style: solid;
                    border-width: 5px 0 5px 8px;
                    border-color: transparent transparent transparent #ffffff;
                }

                .landing-foot {
                    margin: 28px 0 0;
                    color: #e6e9ff;
                    font-size: 14px;
                }

                .landing-foot a {
                    color: #ffffff;
                    text-underline-offset: 3px;
                }

                .article-stage {
                    touch-action: none;
                }

                .article-stage.native {
                    -webkit-user-select: none;
                    user-select: none;
                }

                .article-stage.native a {
                    -webkit-user-drag: none;
                }

                .switcher {
                    position: fixed;
                    z-index: 6;
                    top: 8px;
                    left: 50%;
                    display: flex;
                    gap: 4px;
                    padding: 4px;
                    border: 1px solid rgba(190, 180, 255, 0.35);
                    border-radius: 999px;
                    background: rgba(10, 14, 38, 0.7);
                    transform: translateX(-50%);
                }

                .switcher button {
                    border: 0;
                    border-radius: 999px;
                    padding: 7px 14px;
                    color: #d6dafc;
                    background: transparent;
                    font: 600 13px Inter, ui-sans-serif, system-ui, sans-serif;
                    cursor: pointer;
                }

                .switcher button.reset {
                    margin-left: 4px;
                    border: 1px solid rgba(190, 180, 255, 0.4);
                    color: #ffffff;
                }

                .switcher button.active {
                    color: #ffffff;
                    background: linear-gradient(180deg, #5b44c9 0%, #4330a0 100%);
                }

                .notice {
                    position: fixed;
                    z-index: 6;
                    top: 56px;
                    left: 50%;
                    max-width: min(560px, 90vw);
                    margin: 0;
                    padding: 8px 14px;
                    border-radius: 10px;
                    color: #ffe9b0;
                    background: rgba(60, 40, 10, 0.85);
                    font: 12px Inter, ui-sans-serif, system-ui, sans-serif;
                    transform: translateX(-50%);
                }

                .mode {
                    position: fixed;
                    z-index: 5;
                    right: 14px;
                    bottom: 14px;
                    border: 1px solid rgba(190, 180, 255, 0.4);
                    border-radius: 999px;
                    padding: 6px 12px;
                    color: #e6e9ff;
                    background: rgba(10, 14, 38, 0.65);
                    font: 12px Inter, ui-sans-serif, system-ui, sans-serif;
                    pointer-events: none;
                }
            `}</style>
            <div
                className={stageClassName}
                onPointerMove={(event) => trackPointer('move', event)}
                onPointerDown={(event) => trackPointer('down', event)}
                onPointerUp={(event) => trackPointer('up', event)}
                onPointerCancel={(event) => trackPointer('up', event)}
                onPointerLeave={(event) => trackPointer('leave', event)}
            >
                {native ? (
                    <canvas className="article-canvas" ref={canvasRef}>
                        <article className="console" ref={articleRef}>
                            <OceanConsole />
                        </article>
                    </canvas>
                ) : (
                    <article className="console">
                        <OceanConsole />
                    </article>
                )}
            </div>
            {native && (
                <div className="switcher" role="radiogroup" aria-label="Effect">
                    {EFFECTS.map((entry) => (
                        <button
                            key={entry.id}
                            type="button"
                            role="radio"
                            aria-checked={effectId === entry.id}
                            className={effectId === entry.id ? 'active' : ''}
                            onClick={() => selectEffect(entry.id)}
                        >
                            {entry.label}
                        </button>
                    ))}
                    {canReset && (
                        <button
                            type="button"
                            className="reset"
                            onClick={() => resetRef.current?.()}
                        >
                            Reset
                        </button>
                    )}
                </div>
            )}
            {notice && (
                <p className="notice" role="alert">
                    {notice}
                </p>
            )}
            <span className="mode" role="status">
                {modeLabel}
            </span>
        </>
    );
}

export default HtmlCanvasArticle;
