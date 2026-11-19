import {
    listActiveTagsAndAggregations,
    listMetrics,
    listTagsByMetricName,
} from '@datadog/action-catalog/dd/metrics';

const MAX_SUGGESTIONS = 30;
const MAX_TAGS = 3000;
const METRIC_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const SEARCH_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const DEFAULT_AGGREGATIONS = ['avg', 'sum', 'min', 'max'];

export type MetricDetails = {
    /** Every tag the metric carries, as key:value. */
    tags: string[];
    /** Space aggregations that make sense for the metric. */
    aggregations: string[];
};

function names(results: unknown) {
    const found = (results as { metrics?: unknown } | undefined)?.metrics;
    return Array.isArray(found)
        ? found.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

// Metric names that contain the typed text (seen in the last 24 hours), for the completion list.
export async function searchMetricNames(text: string): Promise<string[]> {
    const typed = text.trim();
    if (!SEARCH_PATTERN.test(typed)) {
        return [];
    }

    // The search endpoint takes a `metrics:` prefix; fall back to the bare text in case the
    // action adds it itself.
    let found = names((await listMetrics({ inputs: { q: `metrics:${typed}` } })).results);
    if (found.length === 0) {
        found = names((await listMetrics({ inputs: { q: typed } })).results);
    }
    return found.slice(0, MAX_SUGGESTIONS);
}

// What can be filtered and grouped on for a metric, and which aggregations it supports.
export async function getMetricDetails(metric: string): Promise<MetricDetails> {
    if (!METRIC_NAME_PATTERN.test(metric)) {
        return { tags: [], aggregations: DEFAULT_AGGREGATIONS };
    }

    const [tagsResult, activeResult] = await Promise.allSettled([
        listTagsByMetricName({ inputs: { metricName: metric } }),
        listActiveTagsAndAggregations({ inputs: { metricName: metric } }),
    ]);

    const tags =
        tagsResult.status === 'fulfilled'
            ? tagsResult.value.tags.filter((tag) => typeof tag === 'string')
            : [];
    const active =
        activeResult.status === 'fulfilled'
            ? (activeResult.value.activeAggregations ?? []).map((entry) => entry.space)
            : [];
    const aggregations = DEFAULT_AGGREGATIONS.filter(
        (name) => active.length === 0 || active.includes(name as 'avg' | 'sum' | 'min' | 'max'),
    );

    return {
        tags: Array.from(new Set(tags)).slice(0, MAX_TAGS),
        aggregations: aggregations.length > 0 ? aggregations : DEFAULT_AGGREGATIONS,
    };
}
