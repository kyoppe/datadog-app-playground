import { queryMetrics } from '@datadog/action-catalog/dd/metrics';
import { friendlyQueryError, queryProblem } from './queryCheck';

export type MetricGrid = {
    query: string;
    /** The window the buckets cover, ms since the epoch. */
    fromMs: number;
    toMs: number;
    /** Start time of every bucket, ms since the epoch. */
    times: number[];
    /** One row per series, strongest first. null = no data in that bucket. */
    series: { name: string; values: (number | null)[]; tags: Record<string, string> }[];
    /** How many weaker series were left out (only the strongest `limit` are shown). */
    hidden: number;
    /** Unit of the first series ("%", "B", ...), or an empty string. */
    unit: string;
    /** Set when the query could not be run; the other fields are then empty. */
    error: string | null;
};

// How many series can be asked for (Datadog's own Top N choices); more would be unreadable.
const ALLOWED_LIMITS = [5, 10, 25, 50];
const MAX_BUCKETS = 60;
const MIN_RANGE_SECONDS = 60;
const MAX_RANGE_SECONDS = 365 * 24 * 3600;
const MAX_QUERY_LENGTH = 2000;
const BUCKET_STEP_MS = 10_000;

// The spacing of Datadog's automatic rollup for this answer. The points themselves tell it
// (their smallest gap); the declared `interval` (seconds) is the fallback.
function rollupIntervalMs(series: { interval?: number; pointlist?: number[][] }[]): number {
    let smallest = Infinity;
    let declared = 0;
    for (const entry of series) {
        if (typeof entry.interval === 'number' && entry.interval > declared) {
            declared = entry.interval;
        }
        const times = (entry.pointlist ?? [])
            .map((point) => point[0])
            .filter((time): time is number => typeof time === 'number');
        for (let index = 1; index < times.length && index < 400; index += 1) {
            const gap = times[index] - times[index - 1];
            if (gap > 0 && gap < smallest) {
                smallest = gap;
            }
        }
    }
    if (Number.isFinite(smallest)) {
        return smallest;
    }
    return declared > 0 ? declared * 1000 : 0;
}

function failed(query: string, error: string): MetricGrid {
    return { query, fromMs: 0, toMs: 0, times: [], series: [], hidden: 0, unit: '', error };
}

// Runs a Datadog metrics query (filters and group-bys included, e.g.
// `avg:system.cpu.user{env:prod} by {host}`) over a window and averages the points into a fixed
// number of equal buckets, so the frontend gets a ready-made series x time grid.
// `endMs` null means "now" (live); a number pins the window's end (paused).
export async function queryMetricGrid(
    query: string,
    rangeSeconds: number,
    buckets: number,
    endMs: number | null,
    limit: number,
): Promise<MetricGrid> {
    const text = query.trim();
    if (text.length > MAX_QUERY_LENGTH) {
        return failed(text, 'That query is too long.');
    }
    if (!ALLOWED_LIMITS.includes(limit)) {
        return failed(text, `The number of series must be one of ${ALLOWED_LIMITS.join(', ')}.`);
    }
    const problem = queryProblem(text);
    if (problem) {
        return failed(text, problem);
    }
    if (
        !Number.isFinite(rangeSeconds) ||
        rangeSeconds < MIN_RANGE_SECONDS ||
        rangeSeconds > MAX_RANGE_SECONDS ||
        !Number.isInteger(buckets) ||
        buckets < 1 ||
        buckets > MAX_BUCKETS ||
        (endMs !== null && !Number.isFinite(endMs))
    ) {
        return failed(text, 'The time range is out of bounds.');
    }

    // The query is sent as is, so Datadog picks its automatic rollup for the range. The bucket
    // width follows that interval (and is only widened, in whole intervals, when there would be
    // more than `buckets` columns); it is known only once Datadog has answered. So ask for a
    // little more than the window and cut it to size afterwards.
    const now = Date.now();
    const rangeMs = rangeSeconds * 1000;
    const wantedMs = Math.max(BUCKET_STEP_MS, Math.ceil(rangeMs / buckets));
    const end = endMs ?? now;
    const askFromMs = end - rangeMs - (2 * wantedMs + 120_000);

    let response;
    try {
        response = await queryMetrics({
            inputs: {
                query: text,
                time: {
                    from: new Date(askFromMs).toISOString(),
                    to: new Date(Math.min(end, now)).toISOString(),
                },
            },
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return failed(text, friendlyQueryError(reason));
    }

    if (response.error || response.status === 'error') {
        return failed(
            text,
            friendlyQueryError(response.error ?? response.message ?? 'Query failed.'),
        );
    }

    const intervalMs = rollupIntervalMs(response.series ?? []);
    const bucketMs =
        intervalMs > 0
            ? Math.ceil(wantedMs / intervalMs) * intervalMs
            : Math.ceil(wantedMs / BUCKET_STEP_MS) * BUCKET_STEP_MS;
    const count = Math.max(1, Math.min(buckets, Math.ceil(rangeMs / bucketMs)));
    // Buckets sit on the interval's own grid, so a live tail slides one column at a time. A pinned
    // end (paused, or a fixed window) is kept exactly.
    const toMs = endMs ?? Math.ceil(now / bucketMs) * bucketMs;
    const fromMs = toMs - count * bucketMs;

    const times = Array.from({ length: count }, (_, index) => fromMs + index * bucketMs);
    const all = (response.series ?? []).map((series) => {
        const sums = new Array<number>(count).fill(0);
        const counts = new Array<number>(count).fill(0);
        for (const point of series.pointlist ?? []) {
            const [time, value] = point;
            if (typeof time !== 'number' || typeof value !== 'number' || !Number.isFinite(value)) {
                continue;
            }
            const index = Math.floor((time - fromMs) / bucketMs);
            if (index >= 0 && index < count) {
                sums[index] += value;
                counts[index] += 1;
            }
        }
        const values = sums.map((sum, index) => (counts[index] > 0 ? sum / counts[index] : null));
        // the value of each tag, without its key: "host:web-1" is shown as "web-1"
        const tagSet = series.tag_set ?? [];
        const tags = tagSet
            .map((tag) => (tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag))
            .join(', ');
        // by key, for sorting by a group tag
        const tagValues: Record<string, string> = {};
        for (const tag of tagSet) {
            const colon = tag.indexOf(':');
            if (colon > 0) {
                tagValues[tag.slice(0, colon)] = tag.slice(colon + 1);
            }
        }
        const scope = series.scope && series.scope !== '*' ? series.scope : '';
        return {
            name: tags || scope || series.display_name || series.metric || 'series',
            values,
            tagValues,
            strength: values.reduce<number>((best, value) => Math.max(best, value ?? 0), 0),
            unit: series.unit?.find((entry) => entry?.short_name)?.short_name ?? '',
        };
    });

    // A live tail's newest buckets are often still filling: series that were reporting a moment ago
    // have not reported in them yet. Leave such a bucket out rather than show gaps that are only
    // a matter of timing. "A moment ago" is the three buckets before it, so that a series that
    // stopped long ago does not keep hiding the newest data. At most two, so real gaps stay visible.
    if (endMs === null) {
        const reportingAt = (column: number) =>
            column < 0 ? 0 : all.filter((row) => row.values[column] !== null).length;
        for (let trimmed = 0; trimmed < 2 && times.length > 1; trimmed += 1) {
            const last = times.length - 1;
            const expected = Math.max(
                reportingAt(last - 1),
                reportingAt(last - 2),
                reportingAt(last - 3),
            );
            const reporting = reportingAt(last);
            if (reporting > 0 && reporting >= expected) {
                break;
            }
            times.pop();
            for (const row of all) {
                row.values.pop();
            }
        }
    }

    all.sort((a, b) => b.strength - a.strength);
    return {
        query: text,
        fromMs,
        toMs,
        times,
        series: all.slice(0, limit).map(({ name, values, tagValues }) => ({
            name,
            values,
            tags: tagValues,
        })),
        hidden: Math.max(0, all.length - limit),
        unit: all[0]?.unit ?? '',
        error: null,
    };
}
