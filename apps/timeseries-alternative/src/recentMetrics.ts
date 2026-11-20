// The metrics this browser queried lately, newest first, for the top of the metric name list.
// Kept in the browser only (not shared with other devices); where it refuses storage the list is
// simply empty.
const RECENT_KEY = 'timeseries-alternative:recent-metrics';
const MAX_RECENT = 15;

export function readRecentMetrics(): string[] {
    try {
        const saved = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
        return Array.isArray(saved)
            ? saved
                  .filter((entry): entry is string => typeof entry === 'string')
                  .slice(0, MAX_RECENT)
            : [];
    } catch {
        return [];
    }
}

export function rememberMetric(metric: string) {
    const name = metric.trim();
    if (name === '') {
        return;
    }
    try {
        const next = [name, ...readRecentMetrics().filter((entry) => entry !== name)];
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, MAX_RECENT)));
    } catch {
        // no storage: nothing to remember
    }
}
