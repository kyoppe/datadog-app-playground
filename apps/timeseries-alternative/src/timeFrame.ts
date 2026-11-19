// Time frames typed the way Datadog's time selector takes them
// (https://docs.datadoghq.com/dashboards/guide/custom_time_frames/):
//
//   relative            5m  2d  1 week  3 mo  past 4 hours
//   growing             since Jan 1   from 5h   Jan 1 to now   10am - now
//   fixed               Jan 1 - Jan 2   6:00 am - 1:00 pm   1577883600 - 1578009540
//   calendar-aligned    today  yesterday  week to date  this month  last week  2 weeks ago
//
// Dates are read in the browser's time zone.

export type TimeFrame =
    /** The last `seconds`, sliding with the clock. */
    | { kind: 'sliding'; text: string; label: string; seconds: number }
    /** From a fixed start up to now. */
    | { kind: 'growing'; text: string; label: string; startMs: number }
    /** A fixed window. */
    | { kind: 'fixed'; text: string; label: string; fromMs: number; toMs: number };

export type TimeFrameResult = { frame: TimeFrame } | { error: string };

const MIN_SECONDS = 60;
const MAX_SECONDS = 365 * 24 * 3600;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

type Unit = 'minute' | 'hour' | 'day' | 'week' | 'month';
const UNIT_SECONDS: Record<Unit, number> = {
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 7 * 86400,
    month: 30 * 86400,
};

function unitOf(word: string): Unit | null {
    if (/^(m|min|mins|minute|minutes)$/.test(word)) return 'minute';
    if (/^(h|hr|hrs|hour|hours)$/.test(word)) return 'hour';
    if (/^(d|day|days)$/.test(word)) return 'day';
    if (/^(w|week|weeks)$/.test(word)) return 'week';
    if (/^(mo|mos|mon|mons|month|months)$/.test(word)) return 'month';
    return null;
}

function relative(text: string) {
    const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(text);
    const unit = match ? unitOf(match[2]) : null;
    if (!match || !unit) {
        return null;
    }
    const count = Number(match[1]);
    return {
        seconds: count * UNIT_SECONDS[unit],
        label: `${count} ${unit}${count === 1 ? '' : 's'}`,
    };
}

function localDate(year: number, month: number, day: number, hours = 0, minutes = 0) {
    return new Date(year, month, day, hours, minutes, 0, 0);
}

// One moment in time: relative shorthand (5h = five hours ago), a unix timestamp, or a date
// and/or a clock time.
function parsePoint(input: string, now: number): number | null {
    const text = input.trim().toLowerCase();
    if (/^\d{10}$/.test(text)) return Number(text) * 1000;
    if (/^\d{13}$/.test(text)) return Number(text);
    const ago = relative(text);
    if (ago) return now - ago.seconds * 1000;

    let rest = text.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    let hours: number | null = null;
    let minutes = 0;
    const meridiem = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(rest);
    const clock = /\b(\d{1,2}):(\d{2})\b/.exec(rest);
    if (meridiem) {
        hours = (Number(meridiem[1]) % 12) + (meridiem[3] === 'pm' ? 12 : 0);
        minutes = Number(meridiem[2] ?? 0);
        rest = rest.replace(meridiem[0], ' ').replace(/\s+/g, ' ').trim();
    } else if (clock) {
        hours = Number(clock[1]);
        minutes = Number(clock[2]);
        rest = rest.replace(clock[0], ' ').replace(/\s+/g, ' ').trim();
    }
    if ((hours !== null && hours > 23) || minutes > 59) {
        return null;
    }

    const today = new Date(now);
    let year = today.getFullYear();
    let month = today.getMonth();
    let day = today.getDate();
    let hasYear = false;
    let hasDate = false;

    const named = /^([a-z]{3,9})\.? (\d{1,2})(?: (\d{2,4}))?$/.exec(rest);
    const numeric = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(rest);
    if (named) {
        const index = MONTHS.indexOf(named[1].slice(0, 3));
        if (index < 0) return null;
        month = index;
        day = Number(named[2]);
        hasDate = true;
        if (named[3]) {
            year = Number(named[3]);
            hasYear = true;
        }
    } else if (numeric) {
        month = Number(numeric[1]) - 1;
        day = Number(numeric[2]);
        hasDate = true;
        if (numeric[3]) {
            year = Number(numeric[3]);
            hasYear = true;
        }
    } else if (rest !== '') {
        return null;
    }
    if (hasYear && year < 100) year += 2000;

    const date = localDate(year, month, day, hours ?? 0, minutes);
    if (date.getMonth() !== month || date.getDate() !== day) {
        return null;
    }
    // Without a year (or a date) the most recent matching moment is meant.
    if (date.getTime() > now && !hasYear) {
        if (hasDate) date.setFullYear(date.getFullYear() - 1);
        else date.setDate(date.getDate() - 1);
    }
    return date.getTime();
}

type CalendarUnit = 'day' | 'week' | 'month' | 'year';

function calendarUnit(word: string): CalendarUnit | null {
    if (/^days?$/.test(word)) return 'day';
    if (/^weeks?$/.test(word)) return 'week';
    if (/^months?$/.test(word)) return 'month';
    if (/^years?$/.test(word)) return 'year';
    return null;
}

// The calendar unit `back` periods ago (0 = the current one); weeks start on Monday.
function calendarRange(unit: CalendarUnit, back: number, now: number): [number, number] {
    const d = new Date(now);
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    if (unit === 'day') {
        return [localDate(y, m, day - back).getTime(), localDate(y, m, day - back + 1).getTime()];
    }
    if (unit === 'week') {
        const monday = day - ((d.getDay() + 6) % 7) - 7 * back;
        return [localDate(y, m, monday).getTime(), localDate(y, m, monday + 7).getTime()];
    }
    if (unit === 'month') {
        return [localDate(y, m - back, 1).getTime(), localDate(y, m - back + 1, 1).getTime()];
    }
    return [localDate(y - back, 0, 1).getTime(), localDate(y - back + 1, 0, 1).getTime()];
}

function capitalise(text: string) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function check(frame: TimeFrame, now: number): TimeFrameResult {
    let seconds: number;
    if (frame.kind === 'sliding') seconds = frame.seconds;
    else if (frame.kind === 'growing') seconds = (now - frame.startMs) / 1000;
    else seconds = (frame.toMs - frame.fromMs) / 1000;

    if (!Number.isFinite(seconds) || seconds < MIN_SECONDS) {
        return { error: 'The time frame must be at least 1 minute long.' };
    }
    if (seconds > MAX_SECONDS) {
        return { error: 'The time frame can be at most 1 year long.' };
    }
    return { frame };
}

export function parseTimeFrame(input: string, now: number): TimeFrameResult {
    const raw = input.trim();
    if (!raw) {
        return { error: 'Enter a time frame, for example 5m, 1w or yesterday.' };
    }
    const text = raw.toLowerCase().replace(/\s+/g, ' ');
    const bad: TimeFrameResult = {
        error: `Could not read "${raw}". Try 5m, 2 days, since Jan 1, Jan 1 - Jan 5 or last month.`,
    };

    const past = relative(text.replace(/^past /, ''));
    if (past) {
        return check(
            {
                kind: 'sliding',
                text: raw,
                label: `Past ${past.label}`,
                seconds: past.seconds,
            },
            now,
        );
    }

    // Calendar-aligned phrases.
    if (text === 'today') {
        return check(
            {
                kind: 'growing',
                text: raw,
                label: 'Today',
                startMs: calendarRange('day', 0, now)[0],
            },
            now,
        );
    }
    if (text === 'yesterday') {
        const [fromMs, toMs] = calendarRange('day', 1, now);
        return check({ kind: 'fixed', text: raw, label: 'Yesterday', fromMs, toMs }, now);
    }
    const toDate =
        /^(week|month|year) to date$/.exec(text) ?? /^this (week|month|year)$/.exec(text);
    if (toDate) {
        const unit = toDate[1] as CalendarUnit;
        return check(
            {
                kind: 'growing',
                text: raw,
                label: capitalise(text),
                startMs: calendarRange(unit, 0, now)[0],
            },
            now,
        );
    }
    const last = /^(?:last|previous) ([a-z]+)$/.exec(text);
    const lastUnit = last ? calendarUnit(last[1]) : null;
    if (lastUnit) {
        const [fromMs, toMs] = calendarRange(lastUnit, 1, now);
        return check({ kind: 'fixed', text: raw, label: capitalise(text), fromMs, toMs }, now);
    }
    const ago = /^(\d+) ([a-z]+) ago$/.exec(text);
    const agoUnit = ago ? calendarUnit(ago[2]) : null;
    if (ago && agoUnit) {
        const [fromMs, toMs] = calendarRange(agoUnit, Number(ago[1]), now);
        return check({ kind: 'fixed', text: raw, label: capitalise(text), fromMs, toMs }, now);
    }

    // Growing: a fixed start, up to now.
    const since = /^(?:since|from) (.+)$/.exec(text) ?? /^(.+?) (?:to|-) now$/.exec(text);
    if (since) {
        const startMs = parsePoint(since[1], now);
        return startMs === null
            ? bad
            : check({ kind: 'growing', text: raw, label: capitalise(raw), startMs }, now);
    }

    // Fixed: two moments, or one whole day.
    const parts = text.split(/ (?:to|-) /);
    if (parts.length === 2) {
        const fromMs = parsePoint(parts[0], now);
        const toMs = parsePoint(parts[1], now);
        if (fromMs === null || toMs === null) {
            return bad;
        }
        // the two unix timestamps a window we made ourselves puts in the URL: read as a range
        const stamps = /^\d{10,13}$/.test(parts[0]) && /^\d{10,13}$/.test(parts[1]);
        return check(
            {
                kind: 'fixed',
                text: raw,
                label: stamps ? rangeLabel(fromMs, toMs) : capitalise(raw),
                fromMs,
                toMs,
            },
            now,
        );
    }
    const only = parsePoint(text, now);
    if (only !== null && !/\d\s*(am|pm)|\d:\d/.test(text) && !/^\d{10,13}$/.test(text)) {
        const date = new Date(only);
        const fromMs = localDate(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const toMs = localDate(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
        return check({ kind: 'fixed', text: raw, label: capitalise(raw), fromMs, toMs }, now);
    }
    return bad;
}

// What to ask the backend for: how long, and where the window ends (null = now).
export function requestFor(
    frame: TimeFrame,
    live: boolean,
    pausedEnd: number | null,
    now: number,
): { rangeSeconds: number; endMs: number | null } {
    if (frame.kind === 'fixed') {
        return {
            rangeSeconds: Math.round((frame.toMs - frame.fromMs) / 1000),
            endMs: frame.toMs,
        };
    }
    const end = live ? now : (pausedEnd ?? now);
    const seconds =
        frame.kind === 'sliding'
            ? frame.seconds
            : Math.max(MIN_SECONDS, (end - frame.startMs) / 1000);
    return { rangeSeconds: Math.round(seconds), endMs: live ? null : end };
}

// A stable key for React Query: the same frame always gives the same string.
export function frameKey(frame: TimeFrame) {
    if (frame.kind === 'sliding') return `s:${frame.seconds}`;
    if (frame.kind === 'growing') return `g:${frame.startMs}`;
    return `f:${frame.fromMs}:${frame.toMs}`;
}

export const PRESETS = [
    { text: '5m', label: 'Past 5 minutes' },
    { text: '15m', label: 'Past 15 minutes' },
    { text: '1h', label: 'Past 1 hour' },
    { text: '4h', label: 'Past 4 hours' },
    { text: '1d', label: 'Past 1 day' },
    { text: '2d', label: 'Past 2 days' },
    { text: '1w', label: 'Past 1 week' },
    { text: '1mo', label: 'Past 1 month' },
    { text: '3mo', label: 'Past 3 months' },
] as const;

export type FrameSuggestion = { text: string; label: string };

const PHRASES = [
    'today',
    'yesterday',
    'week to date',
    'month to date',
    'year to date',
    'this week',
    'this month',
    'this year',
    'last week',
    'last month',
    'last year',
];
const SHORT_UNIT: Record<Unit, string> = {
    minute: 'm',
    hour: 'h',
    day: 'd',
    week: 'w',
    month: 'mo',
};
const SUGGESTED_UNITS: Unit[] = ['minute', 'hour', 'day', 'week', 'month'];

// The completion list under the time frame box: `5` offers minutes, hours, days...; `yes` offers
// yesterday; an empty box offers the usual presets.
export function suggestFrames(input: string): FrameSuggestion[] {
    const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!text) {
        return [
            ...PRESETS,
            { text: 'today', label: 'Today' },
            { text: 'yesterday', label: 'Yesterday' },
            { text: 'week to date', label: 'Week to date' },
        ];
    }

    const found: FrameSuggestion[] = [];
    const number = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(text);
    if (number) {
        const count = Number(number[1]);
        const typed = number[2];
        for (const unit of SUGGESTED_UNITS) {
            if (typed === '' || unit.startsWith(typed) || unitOf(typed) === unit) {
                found.push({
                    text: `${count}${SHORT_UNIT[unit]}`,
                    label: `Past ${count} ${unit}${count === 1 ? '' : 's'}`,
                });
            }
        }
    }
    for (const phrase of PHRASES) {
        if (phrase.includes(text)) {
            found.push({ text: phrase, label: capitalise(phrase) });
        }
    }
    return found.slice(0, 8);
}

// The dashboard's own time frame, as this app's frame: live means "the last N" sliding with the
// clock; otherwise a fixed window. The length is rounded to 10 s so a moving start/end does not
// look like a new frame every refresh.
export function frameFromDashboard(timeframe: {
    start: number;
    end: number;
    isLive: boolean;
}): TimeFrame {
    if (timeframe.isLive) {
        const seconds = Math.max(
            MIN_SECONDS,
            Math.round((timeframe.end - timeframe.start) / 10_000) * 10,
        );
        return { kind: 'sliding', text: '', label: 'Dashboard', seconds };
    }
    return {
        kind: 'fixed',
        text: '',
        label: 'Dashboard',
        fromMs: timeframe.start,
        toMs: timeframe.end,
    };
}

// The short form shown in the badge: 300 -> 5m, 3600 -> 1h, 86400 -> 1d, 604800 -> 1w.
export function shortOf(seconds: number) {
    const pick = (unitSeconds: number, suffix: string) =>
        seconds % unitSeconds === 0 ? `${seconds / unitSeconds}${suffix}` : null;
    return (
        pick(7 * 86400, 'w') ??
        pick(86400, 'd') ??
        pick(3600, 'h') ??
        pick(60, 'm') ??
        `${Math.max(1, Math.round(seconds / 60))}m`
    );
}

// "Nov 19, 7:00 PM - 8:00 PM", or with both dates when the window spans days.
function rangeLabel(fromMs: number, toMs: number) {
    const day = (ms: number) =>
        new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const clock = (ms: number) =>
        new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return day(fromMs) === day(toMs)
        ? `${day(fromMs)}, ${clock(fromMs)} – ${clock(toMs)}`
        : `${day(fromMs)} ${clock(fromMs)} – ${day(toMs)} ${clock(toMs)}`;
}

// A window that stays where it is. Its text is two unix timestamps, which the parser reads back,
// so the URL can carry it.
export function fixedFrame(fromMs: number, toMs: number): TimeFrame {
    return {
        kind: 'fixed',
        text: `${Math.round(fromMs / 1000)} - ${Math.round(toMs / 1000)}`,
        label: rangeLabel(fromMs, toMs),
        fromMs,
        toMs,
    };
}

// "The last N seconds", sliding with the clock again.
export function slidingFrame(seconds: number): TimeFrame {
    const short = shortOf(seconds);
    return {
        kind: 'sliding',
        text: short,
        label: `Past ${relative(short)?.label ?? short}`,
        seconds,
    };
}

// Where the window sits now and how long it is, for stepping it back or forward.
export function windowOf(
    frame: TimeFrame,
    live: boolean,
    pausedEnd: number | null,
    now: number,
): { fromMs: number; toMs: number } {
    const request = requestFor(frame, live, pausedEnd, now);
    const toMs = request.endMs ?? now;
    return { fromMs: toMs - request.rangeSeconds * 1000, toMs };
}
