import { useDatadogAppInput } from '@datadog/apps-frontend/inputs/react';
import { datadogDashboard } from '@datadog/apps-frontend/inputs/schema';
import { useDatadogAppParameters } from '@datadog/apps-frontend/parameters/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent,
    type RefObject,
} from 'react';
import { createBarRenderer } from './bars/barRenderer';
import type { BarPointer, BarRect, BarRenderer, BarScene } from './bars/types';
import { queryMetricGrid, type MetricGrid } from './metrics.backend';
import { appParameters } from './parameters';
import { Guide } from './Guide';
import {
    supportsHtmlInCanvas,
    type HtmlInCanvasContext,
    type HtmlInCanvasElement,
} from './htmlInCanvas';
import { BackgroundPicker } from './BackgroundPicker';
import { hexToRgb, TRANSPARENT } from './colors';
import { QueryBuilder } from './QueryBuilder';
import { TimeFrameSelector } from './TimeFrameSelector';
import { createSound, type Sound } from './sound';
import {
    frameFromDashboard,
    frameKey,
    parseTimeFrame,
    fixedFrame,
    requestFor,
    slidingFrame,
    windowOf,
    type TimeFrame,
} from './timeFrame';

const BUCKETS = 30;
const ROW_LIMITS = [5, 10, 25, 50];
const DEFAULT_LIMIT = 10;
const LIVE_INTERVAL_MS = 15_000;
const DEFAULT_QUERY = 'avg:system.cpu.user{*} by {host}';
const DEFAULT_FRAME_TEXT = '1h';
const MAX_CONSECUTIVE_PAINT_FAILURES = 20;

// Geometry of the table that becomes the ground of the 3D chart.
const NAME_WIDTH = 190;
const DENSE_ROWS = 25;
const DENSE_CELL_HEIGHT = 36;
const CELL_SIZE = 56;
const HEAD_HEIGHT = 36;

const ROW_COLORS = [
    '#4f8cff',
    '#ff7a45',
    '#2fbf8f',
    '#a66bff',
    '#f2b705',
    '#ff5c8a',
    '#27b5d1',
    '#8fcf3c',
    '#e0605a',
    '#6c7bd9',
    '#d98ad8',
    '#5bb0a0',
];

const compact = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumSignificantDigits: 3,
});

const toRgb = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
];

// Two decimals at most: 0.7777777 does not fit a cell, and 0.78 says enough.
function round2(value: number) {
    return Math.round(value * 100) / 100;
}

function formatCell(value: number | null) {
    return value === null || !Number.isFinite(value) ? '–' : compact.format(round2(value));
}

function formatFull(value: number | null, unit: string) {
    if (value === null || !Number.isFinite(value)) {
        return 'no data';
    }
    const shown = Math.abs(value) < 1000 ? round2(value) : Number(value.toPrecision(4));
    return `${shown.toLocaleString('en')}${unit ? ` ${unit}` : ''}`;
}

// Column headings: the time of day (with seconds when the buckets are shorter than a minute: a
// 5 minute range is cut into 20 second buckets). Where the day changes, the heading is the date
// alone (M/D) instead; buckets a day long or more are all dates.
function formatTime(ms: number, previousMs: number | undefined, bucketSeconds: number) {
    const date = new Date(ms);
    const day = `${date.getMonth() + 1}/${date.getDate()}`;
    if (
        bucketSeconds >= 24 * 3600 ||
        (previousMs !== undefined && new Date(previousMs).getDate() !== date.getDate())
    ) {
        return day;
    }
    return date.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        ...(bucketSeconds < 60 ? { second: '2-digit' as const } : {}),
    });
}

// The time frame typed in the URL, or the default one if it is missing or unreadable.
function frameOrDefault(text: string, now: number): TimeFrame {
    for (const candidate of [text, DEFAULT_FRAME_TEXT]) {
        const result = parseTimeFrame(candidate, now);
        if ('frame' in result) {
            return result.frame;
        }
    }
    throw new Error('The default time frame is invalid.');
}

// How the rows are ordered: by value (the strongest first, or last) or by one of the tags the
// series are grouped by ("tag:<key>:a" A to Z, "tag:<key>:d" Z to A). The N strongest are still the
// ones that are drawn; this only orders them.
const DEFAULT_ORDER = 'vd';

function sortSeries(grid: MetricGrid, order: string): MetricGrid {
    if (order === DEFAULT_ORDER) {
        return grid;
    }
    const rows = [...grid.series];
    if (order === 'va') {
        rows.reverse(); // the grid comes strongest first
    } else if (order.startsWith('tag:')) {
        const split = order.lastIndexOf(':');
        const key = order.slice(4, split);
        const sign = order.slice(split + 1) === 'd' ? -1 : 1;
        rows.sort((a, b) => {
            const x = a.tags[key];
            const y = b.tags[key];
            if (x === undefined || y === undefined) {
                return x === y ? 0 : x === undefined ? 1 : -1; // a missing tag goes last
            }
            return sign * x.localeCompare(y, 'en', { numeric: true, sensitivity: 'base' });
        });
    }
    return { ...grid, series: rows };
}

// The sort order as the widget settings spell it: "value", "value:asc", "host", "host:desc".
function parseSortSetting(text: string): string {
    const clean = text.trim();
    const desc = clean.endsWith(':desc');
    const asc = clean.endsWith(':asc');
    const name = clean.replace(/:(asc|desc)$/, '');
    if (name === '' || name.toLowerCase() === 'value') {
        return asc ? 'va' : DEFAULT_ORDER;
    }
    return `tag:${name}:${desc ? 'd' : 'a'}`;
}

// What the viewer last chose for themselves (not part of the shared link): Sound, and the view
// (angle and zoom) the board was last left in. It is kept in the browser; where the browser refuses storage the button simply starts off.
const PREFS_KEY = 'timeseries-alternative:prefs';

// base: the "Starting view" setting that was in force when this view was saved. A viewer's own
// view is kept until the setting is changed, and then the new setting wins.
type SavedView = { yaw: number; pitch: number; zoom: number; base?: string };

// "turn,tilt,zoom" (degrees, degrees, distance) as the widget settings spell it.
function parseViewSetting(text: string): SavedView | null {
    const parts = text.split(',').map((part) => Number(part.trim()));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
        return null;
    }
    return { yaw: (parts[0] * Math.PI) / 180, pitch: (parts[1] * Math.PI) / 180, zoom: parts[2] };
}

function viewToText(view: SavedView): string {
    const deg = (rad: number) => Math.round((rad * 180) / Math.PI);
    return `${deg(view.yaw)},${deg(view.pitch)},${view.zoom.toFixed(2)}`;
}
type Prefs = { sound: boolean; view: SavedView | null };

function readPrefs(): Prefs {
    try {
        const saved = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}');
        const v = saved?.view;
        const view =
            v && [v.yaw, v.pitch, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n))
                ? {
                      yaw: v.yaw,
                      pitch: v.pitch,
                      zoom: v.zoom,
                      base: typeof v.base === 'string' ? v.base : '',
                  }
                : null;
        return { sound: saved?.sound === true, view };
    } catch {
        return { sound: false, view: null };
    }
}

// Changes only the parts given: Sound and the view are saved at different moments.
function writePrefs(change: Partial<Prefs>) {
    try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...change }));
    } catch {
        // no storage: nothing to remember
    }
}

// The shareable bits of the state live in the URL: ?q=<query>&t=<time frame>&s=1
function readUrlState() {
    const params = new URLSearchParams(window.location.search);
    const limit = Number(params.get('n'));
    return {
        order: params.get('o') || DEFAULT_ORDER,
        query: params.get('q') || DEFAULT_QUERY,
        frame: frameOrDefault(params.get('t') ?? '', Date.now()),
        stacked: params.get('s') === '1',
        limit: ROW_LIMITS.includes(limit) ? limit : DEFAULT_LIMIT,
    };
}

type UrlState = {
    query: string;
    frameText: string;
    stacked: boolean;
    limit: number;
    order: string;
};

function writeUrlState({ query, frameText, stacked, limit, order }: UrlState) {
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('q', query);
        if (frameText) {
            url.searchParams.set('t', frameText);
        }
        url.searchParams.delete('r');
        url.searchParams.set('n', String(limit));
        if (order === DEFAULT_ORDER) {
            url.searchParams.delete('o');
        } else {
            url.searchParams.set('o', order);
        }
        if (stacked) {
            url.searchParams.set('s', '1');
        } else {
            url.searchParams.delete('s');
        }
        window.history.replaceState(window.history.state, '', url);
    } catch {
        // No History API access: the state still works for this visit.
    }
}

// x, y: where the bar's roof is on screen; px, py: where the pointer is
type Hover = { row: number; col: number; x: number; y: number; px: number; py: number };

type MetricTableProps = {
    grid: MetricGrid | undefined;
    tableRef: RefObject<HTMLTableElement | null>;
    /** Stacked towers stand on one row of totals; the series are in the legend instead. */
    stacked: boolean;
};

// The page that becomes the ground (and the roofs) of the chart: an ordinary HTML table.
function MetricTable({ grid, tableRef, stacked }: MetricTableProps) {
    const times = grid?.times ?? [];
    const series = grid?.series ?? [];
    const bucketSeconds = times.length > 1 ? (times[1] - times[0]) / 1000 : 60;
    const totals = times.map((_, column) => {
        let sum = 0;
        let any = false;
        for (const row of series) {
            const value = row.values[column];
            if (value !== null) {
                sum += value;
                any = true;
            }
        }
        return any ? sum : null;
    });
    const rowHeight = series.length > DENSE_ROWS ? DENSE_CELL_HEIGHT : CELL_SIZE;

    return (
        <table
            className="sheet"
            ref={tableRef}
            style={{ width: NAME_WIDTH + Math.max(times.length, 1) * CELL_SIZE }}
        >
            {/* Column widths live here: with the heading row last, the first row is a body row. */}
            <colgroup>
                <col style={{ width: NAME_WIDTH }} />
                {times.map((time) => (
                    <col key={time} style={{ width: CELL_SIZE }} />
                ))}
            </colgroup>
            <tbody>
                {stacked && series.length > 0 && (
                    <tr style={{ height: CELL_SIZE }}>
                        <th className="name" style={{ borderLeftColor: '#6c7bd9' }}>
                            <span>Total</span>
                        </th>
                        {totals.map((total, colIndex) => (
                            <td key={times[colIndex]} style={{ backgroundColor: '#6c7bd930' }}>
                                {formatCell(total)}
                            </td>
                        ))}
                    </tr>
                )}
                {(stacked ? [] : series).map((row, rowIndex) => {
                    const color = ROW_COLORS[rowIndex % ROW_COLORS.length];
                    return (
                        <tr key={`${rowIndex}:${row.name}`} style={{ height: rowHeight }}>
                            <th className="name" style={{ borderLeftColor: color }}>
                                <span>{row.name}</span>
                            </th>
                            {row.values.map((value, colIndex) => (
                                <td key={times[colIndex]} style={{ backgroundColor: `${color}30` }}>
                                    {formatCell(value)}
                                </td>
                            ))}
                        </tr>
                    );
                })}
            </tbody>
            <tfoot>
                <tr style={{ height: HEAD_HEIGHT }}>
                    <th className="corner" style={{ width: NAME_WIDTH }}>
                        {grid?.unit ? `Series (${grid.unit})` : 'Series'}
                    </th>
                    {times.map((time, index) => (
                        <th key={time} style={{ width: CELL_SIZE }}>
                            {formatTime(time, times[index - 1], bucketSeconds)}
                        </th>
                    ))}
                </tr>
            </tfoot>
        </table>
    );
}

function TimeseriesAlternative() {
    const [initial] = useState(readUrlState);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const articleRef = useRef<HTMLElement>(null);
    const tableRef = useRef<HTMLTableElement>(null);
    const rendererRef = useRef<BarRenderer | null>(null);
    const sceneRef = useRef<BarScene | null>(null);
    const sceneVersionRef = useRef(0);
    const soundRef = useRef<Sound | null>(null);
    const movedByUserRef = useRef(false);
    // The next scene is a rearrangement the viewer asked for: the bars scramble into place.
    const scrambleRef = useRef(0); // when it was asked for (ms); it expires, in case nothing moves
    // Set when Top N was changed: the clatter goes by the number of series, not by the heights.
    const limitRisingRef = useRef<boolean | null>(null);
    const [prefs] = useState(readPrefs);
    const soundOnRef = useRef(prefs.sound);
    const pointerRef = useRef<BarPointer>({
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        down: false,
        inside: false,
    });
    const lastMoveRef = useRef({ time: 0, x: 0, y: 0 });
    const gridRef = useRef<MetricGrid | undefined>(undefined);

    const [native, setNative] = useState(supportsHtmlInCanvas);
    const paintRetriesRef = useRef(0);
    const [ready, setReady] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [query, setQuery] = useState(initial.query);
    const [frame, setFrame] = useState<TimeFrame>(initial.frame);
    const [stacked, setStacked] = useState(initial.stacked);
    // On a widget the settings give the starting point; pressing the button overrides it for as
    // long as the page is open (it is not saved).
    const [stackTouched, setStackTouched] = useState(false);
    // The table colour, on a widget only: the setting is the starting point, and a pick made
    // here is not saved.
    const [pickedBackground, setPickedBackground] = useState<string | null>(null);
    const [orderTouched, setOrderTouched] = useState(false);
    const [queryTouched, setQueryTouched] = useState(false);
    const [queryOpen, setQueryOpen] = useState(false);
    const [optionsOpen, setOptionsOpen] = useState(false);
    const [pointerOver, setPointerOver] = useState(false);
    const [viewText, setViewText] = useState('');
    const [limit, setLimit] = useState(initial.limit);
    const [order, setOrder] = useState(initial.order);
    const [live, setLive] = useState(true);
    const [pausedEnd, setPausedEnd] = useState<number | null>(null);
    const [alertDraft, setAlertDraft] = useState('');
    const [spin, setSpin] = useState<boolean | null>(null);
    const [sound, setSound] = useState(prefs.sound);
    const [hover, setHover] = useState<Hover | null>(null);
    const [snapshot, setSnapshot] = useState<HTMLCanvasElement | null>(null);
    const [guideOpen, setGuideOpen] = useState(false);
    const captureRequestedRef = useRef(false);

    // On a dashboard the dashboard owns the time: follow its time selector and hide ours.
    const dashboardInput = useDatadogAppInput(datadogDashboard);
    const dashboardFrame =
        dashboardInput.status === 'ready'
            ? frameFromDashboard(dashboardInput.fields.dashboard.timeframe)
            : null;
    const embedded = dashboardFrame !== null;
    const activeFrame = dashboardFrame ?? frame;
    const isLive = activeFrame.kind !== 'fixed' && (embedded || live);

    // The settings saved with this widget (the form Datadog shows when it is added to a
    // dashboard). They win over anything chosen in the page itself, which is not saved.
    const parameters = useDatadogAppParameters(appParameters);
    const savedQuery = parameters.status === 'ready' ? parameters.values.query.trim() : '';
    const savedStacked = parameters.status === 'ready' && parameters.values.stacked;
    const savedAlert = parameters.status === 'ready' ? parameters.values.alertAt : 0;
    // On a widget the query is the one in its settings, until the viewer opens the Query panel and
    // builds another there (to try it, or to copy it into the settings: it is not saved).
    const activeQuery = embedded && !queryTouched ? savedQuery || query : query;
    const stackedNow = embedded ? (stackTouched ? stacked : savedStacked) : stacked;
    // Spin as set in the widget's settings, until the viewer presses the button.
    const savedSpin = parameters.status === 'ready' && parameters.values.spin;
    const spinNow = spin ?? savedSpin;
    // On a dashboard the widget's setting decides; elsewhere the box in the toolbar does.
    const savedLimit =
        parameters.status === 'ready' ? Number(parameters.values.limit) : DEFAULT_LIMIT;
    const limitNow = embedded && ROW_LIMITS.includes(savedLimit) ? savedLimit : limit;

    // Do not fetch until the host has said what it has (saved settings, dashboard time), or the
    // first request would be for the wrong query and time. Give up waiting after a moment: a
    // page opened outside Datadog never hears back.
    const [gaveUpWaiting, setGaveUpWaiting] = useState(false);
    useEffect(() => {
        const timer = window.setTimeout(() => setGaveUpWaiting(true), 3000);
        return () => window.clearTimeout(timer);
    }, []);
    const settled =
        gaveUpWaiting || (parameters.status !== 'pending' && dashboardInput.status !== 'pending');

    // What the chart shows changed without the viewer pressing anything here (the dashboard's time
    // selector, the widget's settings): the bars rearrange all the same.
    const motionKey = `${activeQuery}|${frameKey(activeFrame)}|${limitNow}`;
    const lastMotionKeyRef = useRef(motionKey);
    useEffect(() => {
        if (lastMotionKeyRef.current !== motionKey) {
            lastMotionKeyRef.current = motionKey;
            movedByUserRef.current = true;
            scrambleRef.current = Date.now();
        }
    }, [motionKey]);

    // As a widget the query comes from the widget's settings (saved with the widget, so every
    // device sees the same chart); there is no query bar, and a widget without one says so.
    const needsSetup =
        embedded && parameters.status === 'ready' && savedQuery === '' && !queryTouched;

    // On a widget the menus are out of the way until the pointer comes over it (or while one of
    // them is in use, or there is nothing to see yet).
    useEffect(() => {
        if (!embedded) {
            return;
        }
        const root = document.documentElement;
        const over = () => setPointerOver(true);
        const out = () => setPointerOver(false);
        root.addEventListener('pointerenter', over);
        root.addEventListener('pointermove', over);
        root.addEventListener('pointerdown', over);
        root.addEventListener('pointerleave', out);
        return () => {
            root.removeEventListener('pointerenter', over);
            root.removeEventListener('pointermove', over);
            root.removeEventListener('pointerdown', over);
            root.removeEventListener('pointerleave', out);
        };
    }, [embedded]);
    const quiet =
        embedded && !pointerOver && !queryOpen && !optionsOpen && !guideOpen && !needsSetup;

    const gridQuery = useQuery({
        queryKey: [
            'grid',
            activeQuery,
            frameKey(activeFrame),
            isLive ? 'live' : pausedEnd,
            limitNow,
        ],
        enabled: settled && !needsSetup,
        // Wrapped: React Query hands its callback an AbortSignal, which the app bridge cannot clone.
        queryFn: () => {
            const request = requestFor(activeFrame, isLive, pausedEnd, Date.now());
            return queryMetricGrid(
                activeQuery,
                request.rangeSeconds,
                BUCKETS,
                request.endMs,
                limitNow,
            );
        },
        refetchInterval: isLive ? LIVE_INTERVAL_MS : false,
        placeholderData: keepPreviousData,
        retry: false,
    });
    const rawGrid = gridQuery.data && !gridQuery.data.error ? gridQuery.data : undefined;
    // On a widget the order comes from its settings; on its own, from the Sort box.
    const savedSort = parameters.status === 'ready' ? parameters.values.sort : 'value';
    const orderNow = embedded && !orderTouched ? parseSortSetting(savedSort) : order;
    const grid = useMemo(
        () => (rawGrid ? sortSeries(rawGrid, orderNow) : undefined),
        [rawGrid, orderNow],
    );
    // the tags the series are grouped by, to sort on
    const tagKeys = useMemo(() => {
        const keys: string[] = [];
        for (const row of rawGrid?.series ?? []) {
            for (const key of Object.keys(row.tags)) {
                if (!keys.includes(key)) {
                    keys.push(key);
                }
            }
        }
        return keys;
    }, [rawGrid]);
    const orderOptions = [
        { value: 'vd', label: 'Sort: Value ↓' },
        { value: 'va', label: 'Sort: Value ↑' },
        ...tagKeys.flatMap((key) => [
            { value: `tag:${key}:a`, label: `Sort: ${key} A→Z` },
            { value: `tag:${key}:d`, label: `Sort: ${key} Z→A` },
        ]),
    ];
    const shownOrder = orderOptions.some((option) => option.value === orderNow)
        ? orderNow
        : DEFAULT_ORDER;
    const errorText =
        gridQuery.data?.error ??
        (gridQuery.error instanceof Error ? gridQuery.error.message : null);

    const drafted =
        alertDraft.trim() !== '' && Number.isFinite(Number(alertDraft))
            ? Number(alertDraft)
            : Infinity;
    const alertAt = savedAlert > 0 ? savedAlert : drafted;

    useEffect(() => {
        gridRef.current = grid;
    }, [grid]);

    // A notice is a passing remark: it goes away by itself (or with its x).
    useEffect(() => {
        if (!notice) {
            return;
        }
        const timer = window.setTimeout(() => setNotice(null), 6000);
        return () => window.clearTimeout(timer);
    }, [notice]);

    // ---- toolbar actions ------------------------------------------------------------------

    const changeQuery = (next: string) => {
        movedByUserRef.current = true;
        scrambleRef.current = Date.now();
        setQuery(next);
        setQueryTouched(true);
        writeUrlState({ query: next, frameText: frame.text, stacked, limit, order });
    };

    const changeFrame = (next: TimeFrame) => {
        movedByUserRef.current = true;
        scrambleRef.current = Date.now();
        setFrame(next);
        writeUrlState({ query, frameText: next.text, stacked, limit, order });
    };

    const changeLimit = (next: number) => {
        // the board grows or shrinks by rows: the clatter comes with the new data, when it moves
        if (next !== limit) {
            movedByUserRef.current = true;
            scrambleRef.current = Date.now();
            limitRisingRef.current = next < limit;
        }
        setLimit(next);
        writeUrlState({ query, frameText: frame.text, stacked, limit: next, order });
    };

    const lastSortRef = useRef(orderNow);
    const changeOrder = (next: string) => {
        scrambleRef.current = Date.now();
        // the rows swap places at once (there is no new data to wait for): the same clatter
        if (soundOnRef.current && next !== shownOrder) {
            soundRef.current?.clatter(next === 'va' || next.endsWith(':d'));
        }
        lastSortRef.current = next; // this change has its sound already
        setOrder(next);
        setOrderTouched(true);
        writeUrlState({ query, frameText: frame.text, stacked, limit, order: next });
    };

    // The widget's sort setting was changed: the rows swap places at once, as with the Sort box.
    // (a layout effect, so it is ready before the scene is measured for the new order)
    useLayoutEffect(() => {
        if (lastSortRef.current === orderNow) {
            return;
        }
        lastSortRef.current = orderNow;
        if (embedded) {
            scrambleRef.current = Date.now();
            if (soundOnRef.current) {
                soundRef.current?.clatter(orderNow === 'va' || orderNow.endsWith(':d'));
            }
        }
    }, [orderNow, embedded]);

    const toggleStacked = () => {
        scrambleRef.current = Date.now();
        const next = !stackedNow;
        // blocks piling up, or scattering
        if (soundOnRef.current) {
            soundRef.current?.clatter(next);
        }
        setStacked(next);
        setStackTouched(true);
        writeUrlState({ query, frameText: frame.text, stacked: next, limit, order });
    };

    // The live tail again, over a window of the same length.
    const goLive = (seconds: number) => {
        movedByUserRef.current = true;
        scrambleRef.current = Date.now();
        const next = slidingFrame(seconds);
        setFrame(next);
        setLive(true);
        setPausedEnd(null);
        writeUrlState({ query, frameText: next.text, stacked, limit, order });
    };

    const toggleLive = () => {
        if (activeFrame.kind === 'fixed') {
            goLive(Math.round((activeFrame.toMs - activeFrame.fromMs) / 1000));
        } else if (live) {
            setPausedEnd(grid?.toMs ?? Date.now());
            setLive(false);
        } else {
            setLive(true);
        }
    };

    // Back / forward by one whole window. Back leaves the live tail for a fixed window; forward
    // that would pass "now" returns to the live tail instead.
    const stepWindow = (direction: -1 | 1) => {
        const now = Date.now();
        const current = windowOf(activeFrame, isLive, pausedEnd, now);
        const length = current.toMs - current.fromMs;
        const toMs = current.toMs + direction * length;
        if (direction > 0 && toMs >= now) {
            goLive(Math.round(length / 1000));
            return;
        }
        const next = fixedFrame(toMs - length, toMs);
        movedByUserRef.current = true;
        scrambleRef.current = Date.now();
        setFrame(next);
        setLive(false);
        setPausedEnd(null);
        writeUrlState({ query, frameText: next.text, stacked, limit, order });
    };

    // A browser only lets a page make sound after the viewer has done something on it: when Sound
    // was left on last time, it wakes up with the first click or key.
    useEffect(() => {
        if (!sound) {
            return;
        }
        const wake = () => {
            if (soundOnRef.current) {
                soundRef.current ??= createSound();
                soundRef.current.resume();
            }
        };
        window.addEventListener('pointerdown', wake, { once: true });
        window.addEventListener('keydown', wake, { once: true });
        return () => {
            window.removeEventListener('pointerdown', wake);
            window.removeEventListener('keydown', wake);
        };
    }, [sound]);

    const toggleSound = () => {
        const next = !sound;
        setSound(next);
        soundOnRef.current = next;
        writePrefs({ sound: next });
        if (next) {
            soundRef.current ??= createSound();
            soundRef.current.resume();
            soundRef.current.tick(0.5);
        }
    };

    // ---- the page -> the renderer's scene -----------------------------------------------------

    // Measure where every table cell is, so the renderer can stand a building on each one.
    useLayoutEffect(() => {
        const article = articleRef.current;
        const table = tableRef.current;
        if (!native || !article || !table || !grid || grid.series.length === 0) {
            sceneRef.current = null;
            sceneVersionRef.current += 1;
            return;
        }

        const measure = () => {
            const origin = article.getBoundingClientRect();
            const rows = grid.series.length;
            const cols = grid.times.length;
            const cells: BarRect[] = [];
            const values: number[] = [];
            let max = 0;
            for (let r = 0; r < rows; r += 1) {
                // The time headings are a <tfoot>, so they come last in table.rows. Stacked, the
                // only body row is the totals, and every segment of a tower shares its cell.
                const tableRow = table.rows[stackedNow ? 0 : r];
                for (let c = 0; c < cols; c += 1) {
                    const rect = tableRow?.cells[c + 1]?.getBoundingClientRect();
                    cells.push(
                        rect
                            ? {
                                  x: rect.left - origin.left,
                                  y: rect.top - origin.top,
                                  w: rect.width,
                                  h: rect.height,
                              }
                            : { x: 0, y: 0, w: 0, h: 0 },
                    );
                    const value = grid.series[r].values[c];
                    values.push(value === null ? NaN : value);
                    if (value !== null && value > max) {
                        max = value;
                    }
                }
            }
            sceneRef.current = {
                pageWidth: article.offsetWidth,
                pageHeight: article.offsetHeight,
                cols,
                rows,
                cells,
                values,
                max: max > 0 ? max : 1,
                rowColors: grid.series.map((_, index) =>
                    toRgb(ROW_COLORS[index % ROW_COLORS.length]),
                ),
                alertAt,
                partialColumns: grid.partial,
                stacked: stackedNow,
                playful: Date.now() - scrambleRef.current < 10000,
            };
            sceneVersionRef.current += 1;
        };

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(article);
        return () => observer.disconnect();
    }, [native, grid, stackedNow, alertAt]);

    // Sound for the chart moving. When the user changes something that reshapes the chart (the
    // query, the aggregation, the time frame), the new data lands as a clatter, rising or falling
    // with the tallest bar. Any other new data (the live tail) is a quiet chime. Data that is the
    // same as before is not "new" (the query client hands back the same object for it), and
    // sorting does not fetch anything, so it makes no sound here.
    const previousGridRef = useRef<MetricGrid | undefined>(undefined);
    useEffect(() => {
        if (!rawGrid) {
            return;
        }
        const previous = previousGridRef.current;
        previousGridRef.current = rawGrid;
        const rows = (g: MetricGrid) => g.series.flatMap((row) => row.values.map((v) => v ?? 0));
        const top = Math.max(...rows(rawGrid), 1);
        if (movedByUserRef.current) {
            movedByUserRef.current = false;
            const rising =
                limitRisingRef.current ?? (previous ? top >= Math.max(...rows(previous), 1) : true);
            limitRisingRef.current = null;
            if (soundOnRef.current && previous && previous !== rawGrid) {
                soundRef.current?.clatter(rising);
            }
            return;
        }
        if (!previous || !soundOnRef.current) {
            return;
        }
        const last = rawGrid.series.map((row) => row.values[row.values.length - 1] ?? 0);
        soundRef.current?.chime(Math.max(...last) / top);
    }, [rawGrid]);

    // ---- pointer ----------------------------------------------------------------------------

    const trackPointer = useCallback(
        (kind: 'down' | 'move' | 'up' | 'leave', event: PointerEvent<HTMLDivElement>) => {
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
        },
        [],
    );

    // ---- WebGL + the HTML-in-Canvas paint loop ----------------------------------------------

    useEffect(() => {
        if (!native) {
            return;
        }

        const canvas = canvasRef.current as HtmlInCanvasElement | null;
        const article = articleRef.current;
        if (!canvas || !article) {
            return;
        }

        const fallBack = (message: string) =>
            window.setTimeout(() => {
                setNotice(message);
                setNative(false);
            }, 0);

        // Opt in before the first paint: the canvas lays out its children, and the table
        // becomes an independently drawable element.
        canvas.setAttribute('content', 'drawable');
        article.setAttribute('drawable', '');

        const gl = canvas.getContext('webgl2', { alpha: true }) as HtmlInCanvasContext | null;
        const pageTexture = gl?.createTexture();
        if (!gl || !pageTexture) {
            fallBack('WebGL 2 is not available, so the table is shown flat.');
            return;
        }

        let renderer: BarRenderer;
        try {
            renderer = createBarRenderer(gl);
        } catch (error) {
            console.error(error);
            const reason = error instanceof Error ? error.message : String(error);
            fallBack(
                `The 3D chart could not start (${reason.slice(0, 120)}), so the table is shown flat.`,
            );
            return;
        }
        rendererRef.current = renderer;

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
        let appliedVersion = -1;
        let size = { width: 1, height: 1, dpr: 1 };
        let lastTime = performance.now();
        let lastHover: Hover | null = null;

        // A picture of the chart. It must be taken inside the paint, right after the draw, while
        // the WebGL back buffer still holds the frame.
        const snapshotChart = () => {
            try {
                const copy = document.createElement('canvas');
                copy.width = canvas.width;
                copy.height = canvas.height;
                const context = copy.getContext('2d');
                if (!context) {
                    throw new Error('No 2D context.');
                }
                context.drawImage(canvas, 0, 0);
                // The clipboard is closed to a page inside Datadog's frame, so there is no pretending:
                // the picture is shown, and the browser's own right-click menu saves it.
                setSnapshot(copy);
            } catch (error) {
                console.warn('Could not capture the chart', error);
                setNotice('The chart could not be captured.');
            }
        };

        // The canvas fills the window; the table inside it keeps its own size.
        const syncCanvasSize = () => {
            const width = canvas.clientWidth;
            const height = canvas.clientHeight;
            const scale = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            gl.viewport(0, 0, canvas.width, canvas.height);
            size = { width, height, dpr: scale };
            renderer.resize(width, height, scale);
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

                if (sceneVersionRef.current !== appliedVersion) {
                    appliedVersion = sceneVersionRef.current;
                    if (sceneRef.current) {
                        renderer.setScene(sceneRef.current);
                        // the rearrangement has reached the renderer: it is not asked for twice
                        if (sceneRef.current.playful) {
                            scrambleRef.current = 0;
                        }
                    }
                }

                const pointer = pointerRef.current;
                if (now - lastMoveRef.current.time > 60) {
                    pointer.vx *= 0.85;
                    pointer.vy *= 0.85;
                }

                if (sceneRef.current) {
                    const pick = renderer.render({
                        time: now * 0.001,
                        dt,
                        width: size.width,
                        height: size.height,
                        dpr: size.dpr,
                        pageTexture,
                        pointer,
                    });
                    const next = pick
                        ? {
                              row: pick.row,
                              col: pick.col,
                              x: pick.screenX,
                              y: pick.screenY,
                              px: pointer.x,
                              py: pointer.y,
                          }
                        : null;
                    const changed =
                        (next === null) !== (lastHover === null) ||
                        (next !== null &&
                            lastHover !== null &&
                            (next.row !== lastHover.row ||
                                next.col !== lastHover.col ||
                                Math.abs(next.x - lastHover.x) > 2 ||
                                Math.abs(next.y - lastHover.y) > 2 ||
                                Math.abs(next.px - lastHover.px) > 4 ||
                                Math.abs(next.py - lastHover.py) > 4));
                    if (changed) {
                        const entered =
                            next !== null &&
                            (lastHover === null ||
                                next.row !== lastHover.row ||
                                next.col !== lastHover.col);
                        lastHover = next;
                        setHover(next);
                        const current = gridRef.current;
                        if (entered && next && current && soundOnRef.current) {
                            const value = current.series[next.row]?.values[next.col];
                            const top = Math.max(sceneRef.current.max, 1e-9);
                            soundRef.current?.tick(Math.max(0, (value ?? 0) / top));
                        }
                    }
                }

                if (captureRequestedRef.current) {
                    captureRequestedRef.current = false;
                    snapshotChart();
                }

                failures = 0;
                setReady(true);
            } catch (error) {
                // The element may not have a cached paint record yet; retry a few times.
                failures = visible && !document.hidden ? failures + 1 : 0;
                if (failures >= MAX_CONSECUTIVE_PAINT_FAILURES) {
                    console.error('The 3D chart failed to paint', error);
                    const reason = error instanceof Error ? `${error.name}: ${error.message}` : '';
                    // A widget can be painted late (the dashboard lays it out after the page has
                    // loaded): try the 3D chart again a couple of times before giving up on it.
                    if (paintRetriesRef.current < 3) {
                        paintRetriesRef.current += 1;
                        disposed = true;
                        window.setTimeout(() => {
                            setNative(false);
                            window.setTimeout(() => setNative(true), 400);
                        }, 0);
                        return;
                    }
                    fallBack(
                        `The 3D chart stopped painting, so the table is shown flat.${reason ? ` (${reason})` : ''}`,
                    );
                    return;
                }
            }

            // Keep animating: schedule the next paint even when the DOM is unchanged.
            canvas.requestPaint();
        };

        // Scrolled out of sight (or in a hidden tab) the browser stops painting the page: that is
        // not a failure, and the chart paints again when it comes back.
        let visible = true;
        const visibility = new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            if (visible) {
                failures = 0;
                canvas.requestPaint();
            }
        });
        visibility.observe(canvas);

        const resizeObserver = new ResizeObserver(syncCanvasSize);
        resizeObserver.observe(canvas);
        canvas.addEventListener('paint', onPaint);
        syncCanvasSize();

        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            renderer.zoomBy(Math.exp(event.deltaY * 0.0012));
        };
        const stage = canvas.parentElement;
        stage?.addEventListener('wheel', onWheel, { passive: false });

        return () => {
            disposed = true;
            stage?.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('paint', onPaint);
            resizeObserver.disconnect();
            visibility.disconnect();
            rendererRef.current = null;
            renderer.dispose();
            gl.deleteTexture(pageTexture);
        };
    }, [native]);

    useEffect(() => {
        rendererRef.current?.setAutoRotate(spinNow);
    }, [spinNow, ready]);

    // The view the board starts at (where the opening shot ends): the one the viewer left it in,
    // or, once the widget's "Starting view" setting is changed (or if they never turned it), the
    // setting. It is saved again as it changes.
    // (Outside a widget the host may never say what the settings are: after a moment there are
    // none, and the view the viewer left is used.)
    const viewSetting =
        parameters.status === 'ready' ? parameters.values.view.trim() : settled ? '' : null;
    useEffect(() => {
        if (viewSetting === null) {
            return;
        }
        const own = prefs.view && (prefs.view.base ?? '') === viewSetting ? prefs.view : null;
        const view = own ?? parseViewSetting(viewSetting) ?? prefs.view;
        if (view) {
            rendererRef.current?.setHomeView(view);
        }
    }, [prefs, viewSetting, ready]);

    const savedBackground =
        parameters.status === 'ready' ? parameters.values.background.trim() : '';
    const backgroundNow = embedded ? (pickedBackground ?? savedBackground) : '';
    const clear = backgroundNow === TRANSPARENT;
    useEffect(() => {
        rendererRef.current?.setBackground(clear ? TRANSPARENT : hexToRgb(backgroundNow));
        document.documentElement.toggleAttribute('data-clear', clear);
    }, [backgroundNow, clear, ready]);

    // Reset view goes to the widget's starting view, if it has one.
    useEffect(() => {
        rendererRef.current?.setResetView(viewSetting ? parseViewSetting(viewSetting) : null);
    }, [viewSetting, ready]);

    // While the query panel is open on a widget, show the view as the setting spells it.
    useEffect(() => {
        if (!embedded || !queryOpen) {
            return;
        }
        const read = () => {
            const view = rendererRef.current?.getView();
            setViewText(view ? viewToText(view) : '');
        };
        read();
        const timer = window.setInterval(read, 500);
        return () => window.clearInterval(timer);
    }, [embedded, queryOpen]);

    // As a dashboard widget the chart is simply there: no opening shot.
    useEffect(() => {
        rendererRef.current?.setIntro(!embedded);
    }, [embedded, ready]);

    useEffect(() => {
        let saved = prefs.view;
        const save = () => {
            if (viewSetting === null) {
                return;
            }
            const view = rendererRef.current?.getView();
            if (
                view &&
                (!saved ||
                    Math.abs(view.yaw - saved.yaw) > 0.005 ||
                    Math.abs(view.pitch - saved.pitch) > 0.005 ||
                    Math.abs(view.zoom - saved.zoom) > 0.005)
            ) {
                saved = view;
                writePrefs({ view: { ...view, base: viewSetting ?? '' } });
            }
        };
        const timer = window.setInterval(save, 1500);
        window.addEventListener('pagehide', save);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('pagehide', save);
        };
    }, [prefs, viewSetting]);

    useEffect(
        () => () => {
            soundRef.current?.dispose();
            soundRef.current = null;
        },
        [],
    );

    // ---- render -----------------------------------------------------------------------------

    const hoveredSeries = hover && grid ? grid.series[hover.row] : undefined;
    const hoveredValue = hoveredSeries && hover ? hoveredSeries.values[hover.col] : null;
    // The line at the bottom is for what needs attention only: a failed query, no data, loading.
    let status: string | null = null;
    if (errorText) {
        status = errorText;
    } else if (!grid) {
        status = 'Loading...';
    } else if (grid.series.length === 0) {
        status = 'No data for that query and time frame.';
    }

    const stageClassName = ['stage', native ? 'native' : 'flat'].join(' ');

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
                    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                }

                html[data-clear],
                html[data-clear] body,
                html[data-clear] .chart {
                    background: transparent;
                }

                .stage {
                    position: fixed;
                    inset: 0;
                    touch-action: none;
                }

                .stage.native {
                    cursor: grab;
                    -webkit-user-select: none;
                    user-select: none;
                }

                .stage.flat {
                    overflow: auto;
                    padding: 120px 24px 24px;
                }

                .chart {
                    display: block;
                    width: 100vw;
                    height: 100vh;
                    background: #0d1030;
                }

                .page {
                    width: max-content;
                    color: #1b2333;
                    background: #f3f0ea;
                }

                .stage.native .page {
                    position: absolute;
                    top: 0;
                    left: 0;
                }

                .sheet {
                    table-layout: fixed;
                    border-collapse: collapse;
                    font: 600 15px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
                }

                .sheet th,
                .sheet td {
                    overflow: hidden;
                    border: 1px solid #d8d2c4;
                    padding: 0 4px;
                    text-align: center;
                    white-space: nowrap;
                }

                .sheet tfoot th {
                    padding: 0 1px;
                    letter-spacing: -0.02em;
                    color: #5a6275;
                    background: #e7e2d6;
                    font-size: 11px;
                    font-weight: 600;
                }

                .sheet .corner,
                .sheet .name {
                    text-align: left;
                    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .sheet .name {
                    border-left: 6px solid transparent;
                    padding-left: 10px;
                    color: #1b2333;
                    background: #ece7dc;
                    font-size: 12px;
                    font-weight: 600;
                }

                .sheet .name span {
                    display: block;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .bar {
                    position: fixed;
                    z-index: 6;
                    top: 10px;
                    right: 12px;
                    left: 12px;
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 8px;
                    /* The bar spans the window: only its groups take the pointer. */
                    pointer-events: none;
                }

                .bar .group {
                    pointer-events: auto;
                }

                .bar .query-group {
                    flex: 0 1 auto;
                    min-width: 0;
                }

                .bar .time-group {
                    flex: none;
                }

                .bar.tools {
                    top: auto;
                    bottom: 12px;
                    left: auto;
                    justify-content: flex-end;
                }

                .bar.tools .group {
                    flex-wrap: wrap;
                    justify-content: flex-end;
                    max-width: 100%;
                }

                .bar .group {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 5px;
                    border: 1px solid rgba(190, 180, 255, 0.3);
                    /* Not a full pill: the square-ish fields inside must not poke out of the corners. */
                    border-radius: 14px;
                    background: rgba(10, 14, 38, 0.72);
                }

                .bar input,
                .bar select,
                .bar button {
                    height: 30px;
                    border: 0;
                    border-radius: 999px;
                    padding: 0 12px;
                    color: #ffffff;
                    background: transparent;
                    font: 600 13px Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .bar input {
                    background: rgba(255, 255, 255, 0.08);
                }

                .bar input.query {
                    width: min(520px, 46vw);
                    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                    font-size: 12px;
                }

                .tf {
                    position: relative;
                }

                .bar .tf-button {
                    white-space: nowrap;
                }

                .tf-row {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }

                .bar .tf-button {
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    border-radius: 6px;
                    padding: 0 12px 0 6px;
                    color: #1b2333;
                    background: #ffffff;
                }

                .tf-badge {
                    border-radius: 4px;
                    padding: 3px 7px;
                    color: #5a6275;
                    background: #e4e8f2;
                    font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace;
                }

                .tf-steps {
                    display: inline-flex;
                    gap: 2px;
                }

                .bar .tf-steps button {
                    display: grid;
                    place-items: center;
                    width: 34px;
                    padding: 0;
                    border-radius: 6px;
                    color: #1b2333;
                    background: #ffffff;
                }

                .bar .tf-steps button.on {
                    color: #ffffff;
                    background: #2b6df6;
                }

                .bar .tf-steps button:disabled {
                    opacity: 0.45;
                }

                .tf-panel {
                    position: absolute;
                    z-index: 20;
                    top: calc(100% + 6px);
                    right: 0;
                    width: 300px;
                    padding: 8px;
                    border-radius: 10px;
                    color: #1b2333;
                    background: #ffffff;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
                }

                .bar .tf-panel input {
                    width: 100%;
                    height: 32px;
                    border: 1px solid #c9d0e4;
                    border-radius: 6px;
                    color: #1b2333;
                    background: #ffffff;
                    font: 500 13px ui-monospace, SFMono-Regular, Menlo, monospace;
                    outline: 0;
                }

                .bar .tf-panel input:focus {
                    border-color: #5b44c9;
                }

                .tf-error {
                    margin: 6px 2px 0;
                    color: #c0362c;
                    font: 12px Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .tf-panel ul {
                    margin: 6px 0 0;
                    padding: 0;
                    list-style: none;
                    font: 500 13px Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .tf-panel li {
                    padding: 6px 8px;
                    border-radius: 5px;
                    cursor: pointer;
                }

                .tf-panel li.active {
                    background: #e6ecff;
                }

                .tf-panel li.note {
                    color: #8a90a2;
                    cursor: default;
                }





                .qb {
                    position: relative;
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 4px;
                    min-width: 0;
                    max-width: 100%;
                    padding: 0 2px;
                }

                .qb-field {
                    position: relative;
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 3px;
                    min-height: 30px;
                    border-radius: 6px;
                    padding: 2px 6px;
                    color: #1b2333;
                }

                .qb-metric {
                    flex: 0 1 auto;
                    min-width: 120px;
                    background: #fdf6b2;
                }

                .qb-filter {
                    background: #ffffff;
                }

                .qb-group {
                    background: #fbdcf0;
                }

                .qb .qb-metric input {
                    flex: 0 1 280px;
                    width: 280px;
                    min-width: 0;
                    text-overflow: ellipsis;
                }

                .qb .qb-field input {
                    height: 24px;
                    min-width: 40px;
                    border-radius: 0;
                    padding: 0 2px;
                    color: #1b2333;
                    background: transparent;
                    font: 500 13px ui-monospace, SFMono-Regular, Menlo, monospace;
                    outline: 0;
                }

                .qb .qb-field input::placeholder {
                    color: #8a90a2;
                }

                .qb-word {
                    padding: 0 4px;
                    color: #b9c2ff;
                    font-size: 12px;
                    font-weight: 600;
                }

                .qb .qb-agg {
                    height: 30px;
                    border-radius: 6px;
                    padding: 0 6px;
                    color: #1b2333;
                    background: #e8ecf8;
                    font: 600 13px Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .qb-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 2px;
                    border-radius: 4px;
                    padding: 0 2px 0 6px;
                    color: #1b2333;
                    background: rgba(27, 35, 51, 0.1);
                    font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace;
                }

                .qb .qb-chip button {
                    width: 18px;
                    height: 18px;
                    border-radius: 3px;
                    padding: 0;
                    color: #1b2333;
                    font-size: 14px;
                    line-height: 1;
                }

                .qb .qb-toggle {
                    flex: none;
                    height: 24px;
                    border: 1px solid rgba(190, 180, 255, 0.35);
                    padding: 0 8px;
                    font-size: 11px;
                }

                .qb .qb-toggle svg {
                    display: block;
                }

                .qb-fixed {
                    max-width: min(520px, 46vw);
                    overflow: hidden;
                    padding: 0 10px;
                    color: #d6dafc;
                    font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .qb .qb-raw.invalid {
                    outline: 1px solid #ff8a8a;
                }

                .bar button.qb-fixed {
                    height: 30px;
                    border: 0;
                    background: transparent;
                    cursor: pointer;
                    text-align: left;
                }

                .bar button.qb-fixed:hover {
                    background: rgba(255, 255, 255, 0.08);
                }

                .qb-close {
                    flex: none;
                    width: 28px;
                    padding: 0;
                    font-size: 16px;
                }

                .qb-problem {
                    flex: 1 1 100%;
                    max-width: 420px;
                    color: #ffb3b3;
                    font: 600 12px Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .qb .qb-raw {
                    flex: 1 1 200px;
                    width: auto;
                    min-width: 0;
                    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                    font-size: 12px;
                    background: rgba(255, 255, 255, 0.08);
                }

                .qb-options {
                    position: absolute;
                    z-index: 20;
                    top: calc(100% + 4px);
                    left: 0;
                    min-width: 220px;
                    max-width: 480px;
                    max-height: 260px;
                    margin: 0;
                    padding: 4px;
                    overflow: auto;
                    border-radius: 8px;
                    color: #1b2333;
                    background: #ffffff;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
                    list-style: none;
                    font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace;
                }

                .qb-options li {
                    padding: 5px 8px;
                    border-radius: 5px;
                    cursor: pointer;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .qb-options li.active {
                    background: #e6ecff;
                }

                .qb-options li.note {
                    color: #8a90a2;
                    cursor: default;
                }

                .bar input.alert {
                    width: 78px;
                }

                .bar button {
                    cursor: pointer;
                }

                .bar button.on {
                    background: linear-gradient(180deg, #5b44c9 0%, #4330a0 100%);
                }

                .bar button:disabled {
                    cursor: default;
                    opacity: 0.5;
                }

                .bar select option {
                    color: #111111;
                }

                .status {
                    position: fixed;
                    z-index: 6;
                    bottom: 12px;
                    left: 12px;
                    max-width: min(70vw, 760px);
                    padding: 6px 12px;
                    border: 1px solid rgba(190, 180, 255, 0.3);
                    border-radius: 999px;
                    color: #d6dafc;
                    background: rgba(10, 14, 38, 0.72);
                    font: 600 12px Inter, ui-sans-serif, system-ui, sans-serif;
                    pointer-events: none;
                }

                .status.error {
                    color: #ffb3b3;
                    border-color: rgba(255, 140, 140, 0.5);
                }

                .bar {
                    transition: opacity 0.25s ease;
                }

                .bar.quiet {
                    opacity: 0;
                }

                .bar.quiet .group {
                    pointer-events: none;
                }

                .bar.stack {
                    flex-direction: column;
                    align-items: flex-start;
                    justify-content: flex-start;
                    gap: 6px;
                }

                /* the button stays where it is, whatever the builder beside it does */
                .bar.stack .query-group {
                    align-items: flex-start;
                }

                .query-notes {
                    pointer-events: auto;
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: 6px;
                    max-width: min(60vw, 520px);
                }

                .query-note {
                    margin: 0;
                    padding: 6px 10px;
                    border-radius: 8px;
                    color: #d6dafc;
                    background: rgba(10, 14, 38, 0.8);
                    font: 12px/1.4 Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .view-note {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .view-code {
                    height: 24px;
                    border: 1px solid rgba(190, 180, 255, 0.4);
                    border-radius: 6px;
                    padding: 0 8px;
                    color: #ffffff;
                    background: rgba(255, 255, 255, 0.1);
                    font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace;
                    text-align: center;
                }

                /* The text is above the brush (which is above the cards' backgrounds). */
                .guide-body h3,
                .guide-body li {
                    position: relative;
                    z-index: 1;
                }

                .brush-filter {
                    position: absolute;
                }

                .brush-layer {
                    position: absolute;
                    z-index: 0;
                    top: 0;
                    left: 0;
                }

                /* A stroke of a wide, dry brush: Datadog purple, with streaks and ragged ends. */
                .brush {
                    position: absolute;
                    border-radius: 2px;
                    background:
                        repeating-linear-gradient(
                            0deg,
                            rgba(255, 255, 255, 0.16) 0 1px,
                            rgba(30, 10, 70, 0.18) 1px 3px
                        ),
                        linear-gradient(180deg, #7c4dc8, #632ca6);
                    filter: url(#guide-brush);
                }

                .guide.ghost {
                    user-select: text;
                }

                .guide.settled ::selection {
                    color: #ffffff;
                    background: transparent;
                }

                /* the selected text, in the cloth's copy of the guide */
                ::highlight(guide-sel) {
                    color: #ffffff;
                }

                .guide section.hot {
                    margin: 12px 0 4px;
                    padding: 2px 14px 10px;
                    border: 1px solid #cfc8ff;
                    border-radius: 10px;
                    background: #f3f1ff;
                }

                .guide section.hot h3 {
                    margin-top: 10px;
                    font-size: 13px;
                }

                .guide .badge {
                    display: inline-block;
                    margin-right: 8px;
                    padding: 1px 8px;
                    border-radius: 999px;
                    color: #ffffff;
                    background: #5b44c9;
                    font-size: 10px;
                    letter-spacing: 0.06em;
                }

                .picker {
                    position: fixed;
                    z-index: 7;
                    right: 12px;
                    bottom: 64px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 10px;
                    padding: 12px;
                    border: 1px solid rgba(190, 180, 255, 0.3);
                    border-radius: 14px;
                    color: #d6dafc;
                    background: rgba(10, 14, 38, 0.92);
                    font: 12px Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .options {
                    align-items: stretch;
                    min-width: 230px;
                }

                /* the Options panel: a label and its control side by side where the label says
                   something the control does not; a button that says it all is the whole row */
                .option-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                }

                .options .option-row select {
                    border: 1px solid rgba(190, 180, 255, 0.3);
                    border-radius: 8px;
                }

                .options > select,
                .options > button,
                .options > .picker-button {
                    width: 100%;
                    text-align: left;
                }

                .options > select {
                    border: 1px solid rgba(190, 180, 255, 0.3);
                    border-radius: 8px;
                }

                .options .picker {
                    flex: 1 1 100%;
                    position: static;
                    padding: 8px 0 0;
                    border: 0;
                    background: transparent;
                }

                .picker-swatches {
                    display: grid;
                    grid-template-columns: repeat(5, 28px);
                    gap: 6px;
                }

                .bar .swatch-button,
                .swatch-button {
                    width: 28px;
                    height: 28px;
                    border: 2px solid rgba(255, 255, 255, 0.35);
                    border-radius: 8px;
                    padding: 0;
                    cursor: pointer;
                }

                .swatch-button.on {
                    border-color: #ffffff;
                    box-shadow: 0 0 0 2px #7c4dc8;
                }

                .picker-wheel {
                    width: 150px;
                    height: 150px;
                    border-radius: 50%;
                    cursor: crosshair;
                    touch-action: none;
                }

                .picker-brightness {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .picker-code {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 4px;
                }

                .picker-code input {
                    height: 24px;
                    border: 1px solid rgba(190, 180, 255, 0.4);
                    border-radius: 6px;
                    padding: 0 8px;
                    color: #ffffff;
                    background: rgba(255, 255, 255, 0.1);
                    font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace;
                    text-align: center;
                }

                .setup-note {
                    position: fixed;
                    z-index: 6;
                    top: 50%;
                    left: 50%;
                    max-width: min(80vw, 420px);
                    margin: 0;
                    padding: 12px 18px;
                    border-radius: 12px;
                    color: #d6dafc;
                    background: rgba(10, 14, 38, 0.8);
                    font: 13px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
                    text-align: center;
                    transform: translate(-50%, -50%);
                }

                .notice {
                    display: flex;
                    align-items: flex-start;
                    gap: 8px;
                    position: fixed;
                    z-index: 6;
                    right: 12px;
                    bottom: 64px;
                    max-width: min(46vw, 460px);
                    margin: 0;
                    padding: 8px 14px;
                    border-radius: 10px;
                    color: #ffe9b0;
                    background: rgba(60, 40, 10, 0.88);
                    font: 12px Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .notice button {
                    flex: none;
                    border: 0;
                    padding: 0 2px;
                    color: inherit;
                    background: transparent;
                    font-size: 16px;
                    line-height: 1;
                    cursor: pointer;
                }

                .snapshot {
                    position: fixed;
                    z-index: 30;
                    top: 50%;
                    left: 50%;
                    display: grid;
                    gap: 8px;
                    width: min(900px, 92vw);
                    max-height: 90vh;
                    padding: 14px;
                    border-radius: 12px;
                    color: #1b2333;
                    background: #ffffff;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
                    transform: translate(-50%, -50%);
                }

                .snapshot p {
                    margin: 0;
                    font: 600 13px Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .snapshot-image {
                    overflow: auto;
                    border-radius: 6px;
                    background: #0d1030;
                }

                .snapshot-image canvas {
                    display: block;
                    width: 100%;
                    height: auto;
                }

                .snapshot button {
                    justify-self: end;
                    height: 30px;
                    border: 0;
                    border-radius: 999px;
                    padding: 0 16px;
                    color: #ffffff;
                    background: #5b44c9;
                    font: 600 13px Inter, ui-sans-serif, system-ui, sans-serif;
                    cursor: pointer;
                }

                .legend {
                    position: fixed;
                    z-index: 5;
                    bottom: 56px;
                    left: 12px;
                    max-width: 280px;
                    max-height: 40vh;
                    margin: 0;
                    padding: 8px 12px;
                    overflow: auto;
                    border: 1px solid rgba(190, 180, 255, 0.3);
                    border-radius: 10px;
                    color: #d6dafc;
                    background: rgba(10, 14, 38, 0.72);
                    list-style: none;
                    font: 600 12px Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .legend li {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 2px 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .legend .swatch {
                    flex: none;
                    width: 10px;
                    height: 10px;
                    border-radius: 2px;
                }

                .bar .info {
                    width: 30px;
                    padding: 0;
                    border: 1.5px solid rgba(214, 218, 252, 0.7);
                    border-radius: 50%;
                    font: italic 700 15px Georgia, 'Times New Roman', serif;
                }

                .guide-backdrop {
                    position: fixed;
                    z-index: 40;
                    inset: 0;
                    background: rgba(5, 7, 22, 0.55);
                    animation: guide-dim 0.35s ease both;
                }

                .guide-backdrop.closing {
                    animation: guide-undim 0.55s ease forwards;
                }

                @keyframes guide-dim {
                    from {
                        background: rgba(5, 7, 22, 0);
                    }
                }

                @keyframes guide-undim {
                    to {
                        background: rgba(5, 7, 22, 0);
                    }
                }

                /* The cloth the guide is drawn on while it is pulled in or out. */
                .curtain {
                    position: fixed;
                    inset: 0;
                    width: 100vw;
                    height: 100vh;
                    pointer-events: none;
                }

                /* The same place, with and without the cloth: no transform, so the canvas and
                   the page agree on where the sheet is. */
                .guide {
                    position: absolute;
                    top: 7vh;
                    right: 0;
                    left: 0;
                    margin: 0 auto;
                    display: grid;
                    grid-template-rows: auto 1fr auto;
                    width: min(560px, 92vw);
                    max-height: 86vh;
                    border-radius: 14px;
                    color: #1b2333;
                    background: #ffffff;
                    font: 13px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
                }

                .guide.ghost {
                    opacity: 0;
                }

                .guide.settled {
                    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
                    animation: guide-shadow 0.3s ease both;
                }

                @keyframes guide-shadow {
                    from {
                        box-shadow: 0 24px 70px rgba(0, 0, 0, 0);
                    }
                }

                .guide-head {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 14px 18px 8px;
                }

                .guide h2 {
                    margin: 0;
                    font-size: 17px;
                }

                .guide-head button {
                    width: 30px;
                    height: 30px;
                    border: 0;
                    border-radius: 50%;
                    color: #1b2333;
                    background: #eef0f6;
                    font-size: 18px;
                    cursor: pointer;
                }

                .guide-body {
                    position: relative;
                    padding: 0 18px;
                    overflow: auto;
                }

                .guide h3 {
                    margin: 14px 0 4px;
                    font-size: 12px;
                    letter-spacing: 0.04em;
                    text-transform: uppercase;
                    color: #5b44c9;
                }

                .guide ul {
                    margin: 0;
                    padding-left: 18px;
                }

                .guide li {
                    margin: 2px 0;
                }

                .guide-foot {
                    display: flex;
                    gap: 16px;
                    padding: 12px 18px 16px;
                    border-top: 1px solid #e6e9f2;
                }

                .guide-foot a {
                    color: #3b46d6;
                    font-weight: 600;
                }

                .guide-author {
                    margin-left: auto;
                    color: #5a6275;
                }

                .tip {
                    position: fixed;
                    z-index: 7;
                    padding: 7px 10px;
                    border-radius: 8px;
                    color: #ffffff;
                    background: rgba(10, 14, 38, 0.92);
                    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
                    font: 12px/1.4 Inter, ui-sans-serif, system-ui, sans-serif;
                    pointer-events: none;
                    transform: translate(-50%, -100%);
                    white-space: nowrap;
                }

                .tip b {
                    display: block;
                    font-size: 13px;
                }

                .empty {
                    position: fixed;
                    inset: 0;
                    display: grid;
                    place-items: center;
                    color: #b9c2ff;
                    font: 600 14px Inter, ui-sans-serif, system-ui, sans-serif;
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
                    <canvas className="chart" ref={canvasRef}>
                        <article className="page" ref={articleRef}>
                            <MetricTable grid={grid} tableRef={tableRef} stacked={stackedNow} />
                        </article>
                    </canvas>
                ) : (
                    <article className="page" ref={articleRef}>
                        <MetricTable grid={grid} tableRef={tableRef} stacked={stackedNow} />
                    </article>
                )}
            </div>

            {/* Top: the query on the left, which grows with what is in it and wraps only when it
                would run into the time selector, and the time selector on its own on the right. */}
            <div className={`bar${embedded ? ' stack' : ''}${quiet ? ' quiet' : ''}`}>
                <div className="group query-group">
                    {embedded ? (
                        <>
                            <button
                                type="button"
                                className={queryOpen ? 'on' : ''}
                                title="Show the query: try another one, or copy this one into Edit Graph"
                                onClick={() => setQueryOpen(!queryOpen)}
                            >
                                Query
                            </button>
                            {queryOpen && (
                                <QueryBuilder value={activeQuery} onChange={changeQuery} />
                            )}
                        </>
                    ) : savedQuery ? (
                        <span className="qb-fixed" title="Change it in Edit Graph">
                            {savedQuery}
                        </span>
                    ) : (
                        <QueryBuilder value={activeQuery} onChange={changeQuery} />
                    )}
                </div>
                {!embedded && (
                    <div className="group time-group">
                        <TimeFrameSelector
                            frame={activeFrame}
                            live={isLive}
                            onApply={changeFrame}
                            onStep={stepWindow}
                            onToggleLive={toggleLive}
                        />
                    </div>
                )}
                {embedded && queryOpen && (
                    <div className="query-notes">
                        <p className="query-note">
                            Not saved. Press the {'</>'} button, select the text and copy it into
                            Edit Graph to keep it.
                        </p>
                        {viewText && (
                            <p className="query-note view-note">
                                Starting view
                                <input
                                    className="view-code"
                                    readOnly
                                    aria-label="Starting view, to copy into Edit Graph"
                                    value={viewText}
                                    size={viewText.length}
                                    onClick={(event) => event.currentTarget.select()}
                                    onFocus={(event) => event.currentTarget.select()}
                                />
                                click it, copy it into &quot;Starting view&quot; in Edit Graph
                            </p>
                        )}
                    </div>
                )}
            </div>
            {needsSetup && (
                <p className="setup-note">
                    Set the metrics query in Edit Graph, so every device shows the same chart. Press
                    &quot;Query&quot; at the top left to build one.
                </p>
            )}

            {/* Bottom right. On its own the whole menu is there; on a widget, which is small,
                what is used all the time stays and the rest is in the Options panel. */}
            <div className={`bar tools${quiet ? ' quiet' : ''}`}>
                <div className="group">
                    <button
                        type="button"
                        className={stackedNow ? 'on' : ''}
                        title={embedded ? 'Edit Graph gives the starting point' : undefined}
                        onClick={toggleStacked}
                    >
                        Stack
                    </button>
                    {!embedded && (
                        <>
                            <select
                                aria-label="Sort order"
                                value={shownOrder}
                                onChange={(event) => changeOrder(event.target.value)}
                            >
                                {orderOptions.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                            <select
                                aria-label="Number of series"
                                value={limit}
                                onChange={(event) => changeLimit(Number(event.target.value))}
                            >
                                {ROW_LIMITS.map((count) => (
                                    <option key={count} value={count}>
                                        Top {count}
                                    </option>
                                ))}
                            </select>
                            <input
                                className="alert"
                                aria-label="Alert at or above"
                                placeholder="Alert ≥"
                                inputMode="decimal"
                                value={alertDraft}
                                onChange={(event) => setAlertDraft(event.target.value)}
                            />
                        </>
                    )}
                    <button type="button" className={sound ? 'on' : ''} onClick={toggleSound}>
                        Sound
                    </button>
                    {!embedded && (
                        <button
                            type="button"
                            className={spinNow ? 'on' : ''}
                            onClick={() => setSpin(!spinNow)}
                        >
                            Spin
                        </button>
                    )}
                    <button type="button" onClick={() => rendererRef.current?.resetView()}>
                        Reset view
                    </button>
                    {!embedded && native && (
                        <button
                            type="button"
                            disabled={!ready}
                            title="Show the chart as an image to save"
                            onClick={() => {
                                captureRequestedRef.current = true;
                            }}
                        >
                            Image
                        </button>
                    )}
                    {embedded && (
                        <button
                            type="button"
                            className={optionsOpen ? 'on' : ''}
                            aria-label="Options"
                            title="Options: sort, spin, colour, image"
                            onClick={() => setOptionsOpen(!optionsOpen)}
                        >
                            Options
                        </button>
                    )}
                    <button
                        type="button"
                        className="info"
                        aria-label="How to use"
                        title="How to use"
                        onClick={() => setGuideOpen(true)}
                    >
                        i
                    </button>
                    {embedded && optionsOpen && (
                        <div className="picker options" role="dialog" aria-label="Options">
                            <label className="option-row">
                                Sort
                                <select
                                    aria-label="Sort order"
                                    value={shownOrder}
                                    onChange={(event) => changeOrder(event.target.value)}
                                >
                                    {orderOptions.map((option) => (
                                        <option key={option.value} value={option.value}>
                                            {option.label.replace('Sort: ', '')}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <div className="option-row">
                                Spin
                                <button
                                    type="button"
                                    className={spinNow ? 'on' : ''}
                                    onClick={() => setSpin(!spinNow)}
                                >
                                    {spinNow ? 'On' : 'Off'}
                                </button>
                            </div>
                            <BackgroundPicker value={backgroundNow} onPick={setPickedBackground} />
                            {native && (
                                <button
                                    type="button"
                                    disabled={!ready}
                                    title="Show the chart as an image to save"
                                    onClick={() => {
                                        captureRequestedRef.current = true;
                                    }}
                                >
                                    Save as image
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {native && !ready && !errorText && (
                <div className="empty">Waiting for the first paint...</div>
            )}
            {stackedNow && grid && grid.series.length > 0 && (
                <ul className="legend" aria-label="Series">
                    {grid.series
                        .map((row, index) => ({ row, index }))
                        // Listed as they are stacked: the last series is on top.
                        .reverse()
                        .map(({ row, index }) => (
                            <li key={`${index}:${row.name}`} title={row.name}>
                                <span
                                    className="swatch"
                                    style={{
                                        backgroundColor: ROW_COLORS[index % ROW_COLORS.length],
                                    }}
                                />
                                {row.name}
                            </li>
                        ))}
                </ul>
            )}
            {hover && hoveredSeries && (
                // Above the bar's roof, but never off the widget. A bar can be taller than the
                // widget (its roof is out of sight): then it is shown at the pointer. Near the
                // top edge it goes below, and near the sides it is kept inside.
                <div
                    className="tip"
                    style={(() => {
                        const roofInSight =
                            hover.x >= 0 &&
                            hover.x <= window.innerWidth &&
                            hover.y >= 0 &&
                            hover.y <= window.innerHeight;
                        const anchor = roofInSight
                            ? { x: hover.x, y: hover.y }
                            : { x: hover.px, y: hover.py };
                        const below = anchor.y < 90;
                        return {
                            left: Math.min(
                                Math.max(anchor.x, 90),
                                Math.max(90, window.innerWidth - 90),
                            ),
                            top: below ? anchor.y + 24 : anchor.y - 10,
                            transform: below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
                        };
                    })()}
                >
                    <b>{formatFull(hoveredValue, grid?.unit ?? '')}</b>
                    {hoveredSeries.name}
                    <br />
                    {grid ? new Date(grid.times[hover.col]).toLocaleString('en-GB') : ''}
                    {grid && hover.col >= grid.times.length - grid.partial && (
                        <>
                            <br />
                            <i>Still collecting data: the value may grow</i>
                        </>
                    )}
                </div>
            )}
            {status && (
                <div className={`status${errorText ? ' error' : ''}`} role="status">
                    {status}
                </div>
            )}
            {guideOpen && <Guide onClose={() => setGuideOpen(false)} />}
            {snapshot && (
                <div className="snapshot" role="dialog" aria-label="Chart image">
                    <p>Right-click the image to save it.</p>
                    <div
                        className="snapshot-image"
                        ref={(node) => {
                            node?.replaceChildren(snapshot);
                        }}
                    />
                    <button type="button" onClick={() => setSnapshot(null)}>
                        Close
                    </button>
                </div>
            )}
            {notice && (
                <div className="notice" role="alert">
                    <span>{notice}</span>
                    <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
                        {'\u00d7'}
                    </button>
                </div>
            )}
        </>
    );
}

export default TimeseriesAlternative;
