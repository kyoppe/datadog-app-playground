import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type PointerEvent,
    type RefObject,
} from 'react';
import { listOrgDashboards } from './dashboards.backend';
import { getDefaultDashboardId, setDefaultDashboardId } from './defaultDashboard.backend';
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

type EmbedMode = 'canvas' | 'overlay';

// Which dashboard opens first: ?dashboard=<id> in the URL, else the default saved in Datadog (the
// "Set as default" button), else this one, else the first in the list.
const DEFAULT_DASHBOARD_ID = '3nq-mnb-esv'; // landing-page-dashboard
const DASHBOARD_PARAM = 'dashboard';

function readUrlDashboardId() {
    try {
        return new URLSearchParams(window.location.search).get(DASHBOARD_PARAM) ?? '';
    } catch {
        return '';
    }
}

function rememberDashboardInUrl(id: string) {
    try {
        // Mirrored into the host page URL by the deep-links module, so it can be shared.
        const url = new URL(window.location.href);
        url.searchParams.set(DASHBOARD_PARAM, id);
        window.history.replaceState(window.history.state, '', url);
    } catch {
        // No History API access: the pick still works for this visit.
    }
}

type DashboardPageProps = {
    title: string;
    src: string | null;
    /** Reserve the space only: the real iframe is laid over the canvas instead. */
    overlay: boolean;
    slotRef: RefObject<HTMLDivElement | null>;
};

function DashboardPage({ title, src, overlay, slotRef }: DashboardPageProps) {
    let body = <p className="dash-empty">Pick a dashboard</p>;
    if (src && overlay) {
        body = <div className="dash-slot" ref={slotRef} />;
    } else if (src) {
        body = <iframe className="dash-frame" src={src} title={title} />;
    }

    return (
        <div className="dash-page">
            <div className="dash-bar">{title}</div>
            <div className="dash-body">{body}</div>
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
    const [embedMode, setEmbedMode] = useState<EmbedMode>('canvas');
    const [pickedId, setPickedId] = useState(readUrlDashboardId);
    const [slotRect, setSlotRect] = useState<CSSProperties | null>(null);
    const slotRef = useRef<HTMLDivElement>(null);
    const dashboardsQuery = useQuery({
        queryKey: ['dashboards'],
        // Wrapped: React Query hands its callback an AbortSignal, which the app bridge cannot clone.
        queryFn: () => listOrgDashboards(),
    });
    const [canReset, setCanReset] = useState(false);
    const queryClient = useQueryClient();
    const defaultQuery = useQuery({
        queryKey: ['default-dashboard'],
        queryFn: () => getDefaultDashboardId(),
        retry: false,
    });
    const saveDefault = useMutation({
        mutationFn: (id: string) => setDefaultDashboardId(id),
        onSuccess: (_result, id) => {
            queryClient.setQueryData(['default-dashboard'], { configured: true, id });
            setNotice(null);
        },
        onError: (error) => {
            setNotice(
                `Could not save the default: ${error instanceof Error ? error.message : 'unknown error'}`,
            );
        },
    });

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

    const dashboards = dashboardsQuery.data ?? [];
    const savedDefault = defaultQuery.data;
    // Wait for the saved default before choosing, so the iframe does not load twice.
    const settled = pickedId !== '' || !defaultQuery.isPending;
    const wantedId = pickedId || savedDefault?.id || DEFAULT_DASHBOARD_ID;
    const selected = settled
        ? (dashboards.find((entry) => entry.id === wantedId) ?? dashboards[0])
        : undefined;
    const isDefault = Boolean(selected && savedDefault?.id === selected.id);
    // Relative on purpose: it resolves against whatever origin serves this app.
    const dashboardSrc = selected ? selected.url : null;
    const overlay = native && embedMode === 'overlay';

    // In overlay mode the iframe sits above the canvas; keep it on the slot drawn inside it.
    useEffect(() => {
        const slot = slotRef.current;
        if (!overlay || !slot) {
            return;
        }

        const measure = () => {
            const rect = slot.getBoundingClientRect();
            setSlotRect({
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
            });
        };

        const observer = new ResizeObserver(measure);
        observer.observe(slot);
        window.addEventListener('resize', measure);
        const frame = requestAnimationFrame(measure);

        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [overlay, dashboardSrc]);

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

                .console {
                    display: block;
                    width: 100vw;
                    height: 100vh;
                    overflow: hidden;
                    color: #ffffff;
                    background: #0d1030;
                    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                }

                .dash-page {
                    display: flex;
                    flex-direction: column;
                    width: 100%;
                    height: 100%;
                }

                .dash-bar {
                    display: flex;
                    flex: none;
                    align-items: center;
                    justify-content: center;
                    height: 56px;
                    padding: 0 16px;
                    color: #d6dafc;
                    background: linear-gradient(160deg, #1b1546 0%, #101535 100%);
                    font-size: 14px;
                    font-weight: 600;
                }

                .dash-body {
                    position: relative;
                    flex: 1;
                    min-height: 0;
                }

                .dash-frame,
                .dash-slot {
                    display: block;
                    width: 100%;
                    height: 100%;
                    border: 0;
                    background: #ffffff;
                }

                .dash-empty {
                    margin: 24px;
                    color: #b9c2ff;
                }

                .dash-overlay {
                    position: fixed;
                    z-index: 3;
                    border: 0;
                    background: #ffffff;
                    filter: url(#water-dashboard);
                }

                .dash-controls {
                    position: fixed;
                    z-index: 6;
                    top: 8px;
                    left: 12px;
                    display: flex;
                    gap: 6px;
                    max-width: min(480px, 36vw);
                }

                .dash-select,
                .dash-default,
                .dash-embed {
                    height: 36px;
                    border: 1px solid rgba(190, 180, 255, 0.35);
                    border-radius: 999px;
                    padding: 0 14px;
                    color: #ffffff;
                    background: rgba(10, 14, 38, 0.7);
                    font: 600 13px Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .dash-select {
                    min-width: 0;
                    flex: 1;
                }

                .dash-default,
                .dash-embed {
                    cursor: pointer;
                    white-space: nowrap;
                }

                .dash-default:disabled {
                    cursor: default;
                    opacity: 0.6;
                }

                .dash-embed {
                    position: fixed;
                    z-index: 6;
                    top: 8px;
                    right: 12px;
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
                            <DashboardPage
                                title={selected?.title ?? 'Dashboards'}
                                src={dashboardSrc}
                                overlay={overlay}
                                slotRef={slotRef}
                            />
                        </article>
                    </canvas>
                ) : (
                    <article className="console">
                        <DashboardPage
                            title={selected?.title ?? 'Dashboards'}
                            src={dashboardSrc}
                            overlay={overlay}
                            slotRef={slotRef}
                        />
                    </article>
                )}
            </div>
            <div className="dash-controls">
                <select
                    className="dash-select"
                    aria-label="Dashboard"
                    value={selected?.id ?? ''}
                    disabled={dashboards.length === 0}
                    onChange={(event) => {
                        setPickedId(event.target.value);
                        rememberDashboardInUrl(event.target.value);
                    }}
                >
                    {(dashboardsQuery.isPending || !settled) && (
                        <option value="">Loading dashboards...</option>
                    )}
                    {dashboardsQuery.isError && <option value="">Could not load dashboards</option>}
                    {dashboards.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                            {entry.title}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    className="dash-default"
                    disabled={
                        !selected || !savedDefault?.configured || isDefault || saveDefault.isPending
                    }
                    title={
                        savedDefault?.configured
                            ? 'Open this dashboard first, for everyone who opens the app'
                            : 'Set DATASTORE_ID in defaultDashboard.backend.ts to save a default'
                    }
                    onClick={() => selected && saveDefault.mutate(selected.id)}
                >
                    {isDefault ? '\u2605 Default' : '\u2606 Set as default'}
                </button>
            </div>
            {native && (
                <button
                    type="button"
                    className="dash-embed"
                    onClick={() => setEmbedMode(embedMode === 'canvas' ? 'overlay' : 'canvas')}
                >
                    Embed: {embedMode === 'canvas' ? 'in canvas' : 'overlay'}
                </button>
            )}
            {overlay && dashboardSrc && slotRect && (
                <>
                    {/* A cross-origin iframe cannot be drawn into the canvas, but a CSS filter can
                        still warp it on screen. */}
                    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
                        <filter
                            id="water-dashboard"
                            x="0"
                            y="0"
                            width="100%"
                            height="100%"
                            colorInterpolationFilters="sRGB"
                        >
                            <feTurbulence
                                type="fractalNoise"
                                baseFrequency="0.006 0.01"
                                numOctaves="2"
                                seed="3"
                                result="noise"
                            >
                                <animate
                                    attributeName="baseFrequency"
                                    dur="14s"
                                    values="0.006 0.01;0.01 0.016;0.006 0.01"
                                    repeatCount="indefinite"
                                />
                            </feTurbulence>
                            <feDisplacementMap
                                in="SourceGraphic"
                                in2="noise"
                                scale="14"
                                xChannelSelector="R"
                                yChannelSelector="G"
                            />
                        </filter>
                    </svg>
                    <iframe
                        className="dash-overlay"
                        style={slotRect}
                        src={dashboardSrc}
                        title={selected?.title ?? 'Dashboard'}
                    />
                </>
            )}
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
