import { useCallback, useEffect, useRef, useState, type Ref, type RefObject } from 'react';
import { createCurtain } from './curtain';
import {
    supportsHtmlInCanvas,
    type HtmlInCanvasContext,
    type HtmlInCanvasElement,
} from './htmlInCanvas';

// The short user guide behind the (i) button. The long one is GUIDE.md in the repository.
//
// It is drawn as a curtain: a sheet of cloth in a canvas (the guide's own HTML, drawn by the
// browser with HTML-in-Canvas) that is pulled in from the side and then keeps stirring in the
// wind. Over the cloth lies the same guide as ordinary, invisible HTML, which is what takes the
// clicks and the text selection. Closing draws the cloth away. Without HTML-in-Canvas the guide
// is plain HTML that simply appears.

const REPOSITORY_URL = 'https://github.com/kyoppe/datadog-app-playground';
const AUTHOR_URL = 'https://dd.enterprise.slack.com/team/U03C6HE5LUV';
const SWEEP_IN_SECONDS = 0.9;
const SWEEP_OUT_SECONDS = 0.55;
const MAX_CONSECUTIVE_PAINT_FAILURES = 3;

const SECTIONS: { title: string; lines: string[]; hot?: boolean }[] = [
    {
        title: 'Use it on a dashboard',
        hot: true,
        lines: [
            'Add the app to a dashboard as a widget. Open Edit Graph to set its query, Top N, Stacked, Sort order, Spin, Alert, Starting view and Background. They are saved with the widget, so every device shows the same chart, and two widgets can chart two metrics.',
            "The widget follows the dashboard's own time selector. Press Query at the top left to open the query builder: try a query (not saved), switch to </> and copy the text into Edit Graph. Stack, and Sort and Spin (in Options), stay for trying things out (not saved).",
            'Starting view: turn and zoom the board the way you want it to open, then press Query at the top left and copy the "Starting view" code shown there (for example 0,48,1) into Edit Graph. The widget then opens at that angle and zoom on every device, and Reset view returns to it.',
            'Background: the colour behind the chart. Open Options and pick Color: choose one from the list (Transparent lets the dashboard show through) or click the color wheel, then copy the code shown there (#rrggbb, or transparent) into Edit Graph.',
        ],
    },
    {
        title: 'The chart',
        lines: [
            'Rows are the series, strongest first. Columns are time, the oldest on the left.',
            "A bar's height is its value, from zero, relative to the tallest bar on screen.",
            'Point at a bar for its exact value, its series and its time.',
        ],
    },
    {
        title: 'The query (top left)',
        lines: [
            'metric, from (filters), an aggregation, by (groups): pick from the lists as you type.',
            '</> switches to plain query text, for example avg:system.cpu.user{env:prod} by {host}. Copy it into Edit Graph to use it on a dashboard.',
        ],
    },
    {
        title: 'The time frame (top right)',
        lines: [
            'Type what Datadog takes: 5m, 1 week, since Jan 1, Jan 1 - Jan 5, yesterday, last month.',
            'The buttons beside it step one window back, pause or resume the live tail, and step one window forward.',
        ],
    },
    {
        title: 'The tools (bottom right)',
        lines: [
            'Stack: one tower per time bucket, the series stacked inside it. (With Sound on, the chart clatters whenever it moves.)',
            'Sort: order the rows by value (highest or lowest first) or by one of the tags the series are grouped by (A to Z, Z to A).',
            'Top 5 / 10 / 25 / 50: how many series to draw (the strongest ones; Sort only orders them).',
            'Alert: roofs at or above the value glow red.',
            'Sound, Spin, Reset view, and Image (the chart as a picture to save with a right-click).',
            'On a widget the bar is shorter: Stack, Sound and Reset view, and an Options button with Sort, Spin, Color and Save as image.',
        ],
    },
    {
        title: 'The view',
        lines: ['Drag to turn the board. Scroll to zoom.'],
    },
];

type Brush = { x: number; y: number; w: number; h: number };
// A selected piece of text, found again in the cloth's copy of the guide by its path of child
// indexes from the guide's body.
type Mark = { path: number[]; start: number; end: number };

function pathFrom(root: Node, node: Node): number[] {
    const path: number[] = [];
    for (let at: Node | null = node; at && at !== root; at = at.parentNode) {
        const parent: Node | null = at.parentNode;
        if (!parent) {
            return [];
        }
        path.unshift(Array.prototype.indexOf.call(parent.childNodes, at));
    }
    return path;
}

function nodeAt(root: Node, path: number[]): Node | null {
    let node: Node | null = root;
    for (const index of path) {
        node = node?.childNodes[index] ?? null;
    }
    return node;
}

type SheetProps = {
    /** The marker strokes over the text the viewer has selected. */
    brushes: Brush[];
    onClose: () => void;
    /** cloth: drawn into the canvas; ghost: over the cloth, invisible but takes the clicks;
     *  plain: ordinary HTML (no HTML-in-Canvas). */
    look: 'cloth' | 'ghost' | 'plain';
    sheetRef?: Ref<HTMLDivElement>;
};

function Sheet({ onClose, look, sheetRef, brushes }: SheetProps) {
    return (
        <div
            className={`guide${look === 'cloth' ? '' : ` ${look === 'ghost' ? 'ghost' : 'settled'}`}`}
            role="dialog"
            aria-label="How to use"
            ref={sheetRef}
            onMouseDown={(event) => event.stopPropagation()}
        >
            <div className="guide-head">
                <h2>How to use</h2>
                <button type="button" aria-label="Close" onClick={onClose}>
                    {'×'}
                </button>
            </div>
            <div className="guide-body">
                {/* the selection, drawn as strokes of a wide brush behind the text */}
                <svg className="brush-filter" width="0" height="0" aria-hidden="true">
                    <filter id="guide-brush" x="-6%" y="-40%" width="112%" height="180%">
                        <feTurbulence
                            type="fractalNoise"
                            baseFrequency="0.012 0.9"
                            numOctaves="2"
                            seed="4"
                            result="noise"
                        />
                        <feDisplacementMap
                            in="SourceGraphic"
                            in2="noise"
                            scale="16"
                            xChannelSelector="R"
                            yChannelSelector="G"
                        />
                    </filter>
                </svg>
                <div className="brush-layer" aria-hidden="true">
                    {brushes.map((brush, index) => (
                        <span
                            key={index}
                            className="brush"
                            style={{
                                left: brush.x - 6,
                                top: brush.y - 1,
                                width: brush.w + 12,
                                height: brush.h + 2,
                            }}
                        />
                    ))}
                </div>
                {SECTIONS.map((section) => (
                    <section key={section.title} className={section.hot ? 'hot' : undefined}>
                        <h3>
                            {section.hot && <span className="badge">Dashboard</span>}
                            {section.title}
                        </h3>
                        <ul>
                            {section.lines.map((line) => (
                                <li key={line}>{line}</li>
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
            <div className="guide-foot">
                <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
                    Repository
                </a>
                <span className="guide-author">
                    <a href={AUTHOR_URL} target="_blank" rel="noreferrer">
                        Feedback here
                    </a>
                </span>
            </div>
        </div>
    );
}

type CurtainProps = {
    mode: 'in' | 'out';
    onDone: () => void;
    onClose: () => void;
    /** The plain-HTML twin over the cloth: kept exactly where the cloth is drawn. */
    twinRef?: RefObject<HTMLDivElement | null>;
    brushes: Brush[];
    marks: Mark[];
};

// The guide drawn on a sheet of cloth: a full-window canvas with the guide as its child.
function Curtain({ mode, onDone, onClose, twinRef, brushes, marks }: CurtainProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sheetRef = useRef<HTMLDivElement>(null);
    const doneRef = useRef(onDone);
    useEffect(() => {
        doneRef.current = onDone;
    }, [onDone]);

    // The selected text is white on the cloth: the same stretches of text in the cloth's copy of
    // the guide are given to the browser's highlight registry, which the stylesheet colours.
    useEffect(() => {
        const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
        const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
            .Highlight;
        const body = sheetRef.current?.querySelector('.guide-body');
        if (!registry || !Highlight || !body) {
            return;
        }
        const ranges: Range[] = [];
        for (const mark of marks) {
            const node = nodeAt(body, mark.path);
            if (!node) {
                continue;
            }
            try {
                const range = document.createRange();
                range.setStart(node, mark.start);
                range.setEnd(node, mark.end);
                ranges.push(range);
            } catch {
                // the text changed under it: leave it out
            }
        }
        if (ranges.length > 0) {
            registry.set('guide-sel', new Highlight(...ranges));
        }
        return () => {
            registry.delete('guide-sel');
        };
    }, [marks]);

    useEffect(() => {
        const canvas = canvasRef.current as HtmlInCanvasElement | null;
        const sheet = sheetRef.current;
        if (!canvas || !sheet) {
            return;
        }

        // Opt in before the first paint: the canvas lays out its child, and the guide becomes an
        // independently drawable element.
        canvas.setAttribute('content', 'drawable');
        sheet.setAttribute('drawable', '');

        const gl = canvas.getContext('webgl2', { alpha: true }) as HtmlInCanvasContext | null;
        const texture = gl?.createTexture();
        if (!gl || !texture) {
            doneRef.current();
            return;
        }

        let curtain;
        try {
            curtain = createCurtain(gl);
        } catch (error) {
            console.warn('The curtain could not start', error);
            doneRef.current();
            return;
        }

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        const scale = Math.min(window.devicePixelRatio || 1, 2);
        let progress = mode === 'in' ? 0 : 1;
        let last = performance.now();
        let textureWidth = 0;
        let textureHeight = 0;
        let failures = 0;
        let finished = false;
        let breeze = 0;
        let arrived = false;

        // Inside a canvas the page lays its child out in the corner and ignores where the CSS
        // puts it, so the sheet's place is not read from it: the cloth is drawn centred, as the
        // plain HTML is, and only the sheet's size (and its picture) are taken from it.
        const place = () => {
            sheet.style.width = `${Math.min(560, canvas.clientWidth * 0.92)}px`;
        };
        place();

        const onPaint = () => {
            if (finished) {
                return;
            }
            place();

            const now = performance.now();
            const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
            last = now;
            progress += mode === 'in' ? dt / SWEEP_IN_SECONDS : -dt / SWEEP_OUT_SECONDS;
            progress = Math.min(1, Math.max(0, progress));
            // once in place the cloth keeps stirring (it is let go of only when it is drawn away)
            breeze = mode === 'in' && progress >= 1 ? Math.min(1, breeze + dt * 0.5) : 0;

            try {
                const size = canvas.getElementImageDefaultSize(sheet);
                const width = Math.max(1, Math.ceil(size.width));
                const height = Math.max(1, Math.ceil(size.height));
                gl.activeTexture(gl.TEXTURE0);
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
                gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sheet);

                const bounds = sheet.getBoundingClientRect();
                const left = (canvas.clientWidth - bounds.width) / 2;
                const top = canvas.clientHeight * 0.07;
                const twin = twinRef?.current;
                if (twin) {
                    // the twin is what is scrolled: the cloth shows the same part of the guide
                    const mine = twin.querySelector('.guide-body');
                    const theirs = sheet.querySelector('.guide-body');
                    if (mine && theirs && theirs.scrollTop !== mine.scrollTop) {
                        theirs.scrollTop = mine.scrollTop;
                    }
                    // clicks must land where the cloth shows the links
                    twin.style.margin = '0';
                    twin.style.right = 'auto';
                    twin.style.left = `${left}px`;
                    twin.style.top = `${top}px`;
                    twin.style.width = `${bounds.width}px`;
                }
                curtain.render({
                    width: canvas.width,
                    height: canvas.height,
                    scale,
                    rect: {
                        x: left * scale,
                        y: top * scale,
                        w: bounds.width * scale,
                        h: bounds.height * scale,
                    },
                    texture,
                    progress,
                    direction: 1,
                    time: now / 1000,
                    breeze,
                });
                failures = 0;
            } catch (error) {
                failures += 1;
                if (failures >= MAX_CONSECUTIVE_PAINT_FAILURES) {
                    console.warn('The curtain could not be drawn', error);
                    finished = true;
                    doneRef.current();
                    return;
                }
            }

            if (mode === 'in' && progress >= 1 && !arrived) {
                arrived = true;
                doneRef.current();
            } else if (mode === 'out' && progress <= 0) {
                finished = true;
                doneRef.current();
                return;
            }
            canvas.requestPaint();
        };

        canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale));
        canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale));
        canvas.addEventListener('paint', onPaint);
        canvas.requestPaint();

        return () => {
            finished = true;
            canvas.removeEventListener('paint', onPaint);
            curtain.dispose();
            gl.deleteTexture(texture);
        };
    }, [mode, twinRef]);

    return (
        <canvas className="curtain" ref={canvasRef}>
            <Sheet onClose={onClose} look="cloth" sheetRef={sheetRef} brushes={brushes} />
        </canvas>
    );
}

type GuideProps = { onClose: () => void };

export function Guide({ onClose }: GuideProps) {
    const [animated] = useState(supportsHtmlInCanvas);
    const [phase, setPhase] = useState<'in' | 'open' | 'out'>(animated ? 'in' : 'open');

    // Closing: draw the curtain away first, then let go. (While it is still arriving, wait.)
    const requestClose = useCallback(() => {
        if (!animated) {
            onClose();
        } else if (phase === 'open') {
            setPhase('out');
        }
    }, [animated, onClose, phase]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                requestClose();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [requestClose]);

    const twinRef = useRef<HTMLDivElement>(null);

    // What the viewer has selected in the guide, as boxes in the text's own coordinates (so they
    // scroll with it). The selection itself is made on the plain HTML; the cloth shows it as
    // brush strokes.
    const [brushes, setBrushes] = useState<Brush[]>([]);
    const [marks, setMarks] = useState<Mark[]>([]);
    useEffect(() => {
        const clear = () => {
            setBrushes((now) => (now.length === 0 ? now : []));
            setMarks((now) => (now.length === 0 ? now : []));
        };
        const update = () => {
            const body = twinRef.current?.querySelector('.guide-body');
            const selection = document.getSelection();
            if (!body || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
                clear();
                return;
            }
            const range = selection.getRangeAt(0);
            if (!body.contains(range.commonAncestorContainer)) {
                clear();
                return;
            }
            const origin = body.getBoundingClientRect();
            // Only the text itself: the boxes of the elements around it (and the empty space
            // beside a short line) are not part of what is selected.
            const boxes: Brush[] = [];
            const found: Mark[] = [];
            const walker = document.createTreeWalker(
                range.commonAncestorContainer,
                NodeFilter.SHOW_TEXT,
            );
            for (let node = walker.currentNode; node; node = walker.nextNode() as Node) {
                if (node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(node)) {
                    continue;
                }
                const text = node.textContent ?? '';
                if (text.trim() === '') {
                    continue;
                }
                const part = document.createRange();
                part.setStart(node, node === range.startContainer ? range.startOffset : 0);
                part.setEnd(node, node === range.endContainer ? range.endOffset : text.length);
                found.push({
                    path: pathFrom(body, node),
                    start: part.startOffset,
                    end: part.endOffset,
                });
                for (const rect of Array.from(part.getClientRects())) {
                    if (rect.width > 1 && rect.height > 1) {
                        boxes.push({
                            x: rect.left - origin.left + body.scrollLeft,
                            y: rect.top - origin.top + body.scrollTop,
                            w: rect.width,
                            h: rect.height,
                        });
                    }
                }
            }
            setBrushes(boxes);
            setMarks(found);
        };
        document.addEventListener('selectionchange', update);
        return () => document.removeEventListener('selectionchange', update);
    }, []);
    const arrived = useCallback(() => setPhase('open'), []);

    return (
        <div
            className={`guide-backdrop${phase === 'out' ? ' closing' : ''}`}
            onMouseDown={requestClose}
        >
            {animated ? (
                <>
                    <Curtain
                        mode={phase === 'out' ? 'out' : 'in'}
                        onDone={phase === 'out' ? onClose : arrived}
                        onClose={requestClose}
                        twinRef={twinRef}
                        brushes={brushes}
                        marks={marks}
                    />
                    {phase === 'open' && (
                        <Sheet
                            onClose={requestClose}
                            look="ghost"
                            sheetRef={twinRef}
                            brushes={[]}
                        />
                    )}
                </>
            ) : (
                <Sheet onClose={requestClose} look="plain" sheetRef={twinRef} brushes={brushes} />
            )}
        </div>
    );
}
