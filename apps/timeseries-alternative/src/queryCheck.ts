// Cheap checks on a metrics query before it is sent, with messages a person can act on.

const EXAMPLE = 'avg:system.cpu.user{env:prod} by {host}';

export function queryProblem(query: string): string | null {
    const text = query.trim();
    if (!text) {
        return 'Enter a metrics query.';
    }

    let braces = 0;
    let parens = 0;
    for (const char of text) {
        if (char === '{') braces += 1;
        else if (char === '}') braces -= 1;
        else if (char === '(') parens += 1;
        else if (char === ')') parens -= 1;
        if (braces < 0) return `There is a } without a matching {. For example: ${EXAMPLE}`;
        if (parens < 0) return 'There is a ) without a matching (.';
    }
    if (braces > 0) return `A { is not closed with }. For example: ${EXAMPLE}`;
    if (parens > 0) return 'A ( is not closed with ).';
    if (!text.includes(':')) {
        return `A query looks like ${EXAMPLE}: aggregation, a colon, then the metric name.`;
    }
    return null;
}

// Datadog's own error text names grammar rules; say what it means instead.
export function friendlyQueryError(message: string): string {
    const lower = message.toLowerCase();

    if (lower.includes('error parsing query')) {
        const near = /begins with '([^']*)'/.exec(message)?.[1];
        const column = /column (\d+)/.exec(message)?.[1];
        const where = near
            ? ` It stops making sense at "${near.trim()}"${column ? ` (character ${column})` : ''}.`
            : '';
        return `Datadog could not read this query.${where} Check the braces and commas. For example: ${EXAMPLE}`;
    }
    if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many')) {
        return 'Datadog is limiting how fast metrics can be queried. Wait a moment and try again.';
    }
    if (lower.includes('403') || lower.includes('forbidden') || lower.includes('permission')) {
        return 'You do not have permission to query metrics here.';
    }
    if (lower.includes('401') || lower.includes('unauthorized')) {
        return 'You are not signed in to Datadog for this app. Reload the page and sign in again.';
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
        return 'The query took too long. Try a shorter time frame or a narrower filter.';
    }
    return `Datadog could not run the query: ${message.replace(/^query failed: ?/i, '').slice(0, 200)}`;
}
