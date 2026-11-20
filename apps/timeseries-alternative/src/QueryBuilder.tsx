import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getMetricDetails, searchMetricNames } from './metricSearch.backend';
import { queryProblem } from './queryCheck';
import { readRecentMetrics, rememberMetric } from './recentMetrics';

// The query builder of a Datadog Timeseries widget: `metric  from  [filters]  avg by  [groups]`,
// with completion for the metric name, the filter tags and the group-by keys. It reads and writes
// an ordinary metrics query string, so anything it cannot express falls back to a text box.

type Parts = { agg: string; metric: string; filters: string[]; groups: string[] };

const QUERY_PATTERN =
    /^\s*(avg|sum|min|max):([A-Za-z0-9_.:-]+)\{([^}]*)\}(?:\s*by\s*\{([^}]*)\})?\s*$/;
const DEFAULT_AGGREGATIONS = ['avg', 'sum', 'min', 'max'];
const MAX_OPTIONS = 12;
const METRIC_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function splitList(text: string | undefined) {
    return (text ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '' && entry !== '*');
}

function parseQuery(query: string): Parts | null {
    const match = QUERY_PATTERN.exec(query);
    if (!match) {
        return null;
    }
    return {
        agg: match[1],
        metric: match[2],
        filters: splitList(match[3]),
        groups: splitList(match[4]),
    };
}

// What the builder starts from when it is given a query it cannot show: the aggregation and the
// metric at the front of it, if there are any.
function builderStart(text: string): string {
    const head = /^\s*(avg|sum|min|max):([A-Za-z0-9_.:-]+)/.exec(text);
    return head ? `${head[1]}:${head[2]}{*}` : 'avg:system.cpu.user{*}';
}

function composeQuery({ agg, metric, filters, groups }: Parts) {
    const scope = filters.length > 0 ? filters.join(',') : '*';
    const by = groups.length > 0 ? ` by {${groups.join(',')}}` : '';
    return `${agg}:${metric}{${scope}}${by}`;
}

function useDebounced<T>(value: T, milliseconds: number) {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = window.setTimeout(() => setDebounced(value), milliseconds);
        return () => window.clearTimeout(timer);
    }, [value, milliseconds]);
    return debounced;
}

type OptionListProps = {
    options: string[];
    active: number;
    onPick: (option: string) => void;
    onHover: (index: number) => void;
    note?: string;
    /** Options that were queried lately in this browser: they carry a small "Recent" tag. */
    recent?: ReadonlySet<string>;
};

function OptionList({ options, active, onPick, onHover, note, recent }: OptionListProps) {
    if (options.length === 0 && !note) {
        return null;
    }
    return (
        <ul className="qb-options" role="listbox">
            {options.map((option, index) => (
                <li
                    key={option}
                    role="option"
                    aria-selected={index === active}
                    className={index === active ? 'active' : ''}
                    // mousedown, not click: the input must not lose focus before the pick lands.
                    onMouseDown={(event) => {
                        event.preventDefault();
                        onPick(option);
                    }}
                    onMouseEnter={() => onHover(index)}
                >
                    {option}
                    {recent?.has(option) && <span className="qb-recent">Recent</span>}
                </li>
            ))}
            {note && <li className="note">{note}</li>}
        </ul>
    );
}

type MetricFieldProps = { value: string; onCommit: (metric: string) => void };

function MetricField({ value, onCommit }: MetricFieldProps) {
    const [text, setText] = useState(value);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const typed = useDebounced(text.trim(), 250);
    const search = useQuery({
        queryKey: ['metric-search', typed],
        queryFn: () => searchMetricNames(typed),
        enabled: open && typed.length >= 2,
        staleTime: 60_000,
        retry: false,
    });
    // The metrics queried lately come first (all of them while the field still shows the current
    // metric, otherwise the ones that contain the typed text), then what the search found.
    const [recent, setRecent] = useState<string[]>([]);
    const needle = text.trim() === value ? '' : text.trim().toLowerCase();
    const recentOptions = open ? recent.filter((name) => name.toLowerCase().includes(needle)) : [];
    const found = open && typed.length >= 2 ? (search.data ?? []) : [];
    const options = [...recentOptions, ...found.filter((name) => !recentOptions.includes(name))];
    const recentSet = new Set(recentOptions);

    const commit = (metric: string) => {
        const next = metric.trim();
        setOpen(false);
        if (next) {
            if (METRIC_NAME_PATTERN.test(next)) {
                rememberMetric(next);
            }
            setText(next);
            if (next !== value) {
                onCommit(next);
            }
        } else {
            setText(value);
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActive((current) => Math.min(current + 1, Math.max(options.length - 1, 0)));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((current) => Math.max(current - 1, 0));
        } else if (event.key === 'Enter') {
            commit(options[active] ?? text);
        } else if (event.key === 'Escape') {
            setOpen(false);
            setText(value);
        }
    };

    return (
        <div className="qb-field qb-metric">
            <input
                aria-label="Metric"
                spellCheck={false}
                placeholder="metric name"
                value={text}
                onChange={(event) => {
                    setText(event.target.value);
                    setActive(0);
                    setOpen(true);
                }}
                onFocus={() => {
                    setRecent(readRecentMetrics());
                    setOpen(true);
                }}
                onBlur={() => commit(text)}
                onKeyDown={onKeyDown}
            />
            <OptionList
                options={options}
                active={active}
                onPick={commit}
                onHover={setActive}
                recent={recentSet}
                note={
                    open && typed.length >= 2 && search.isFetching && options.length === 0
                        ? 'Searching...'
                        : undefined
                }
            />
        </div>
    );
}

type TagFieldProps = {
    label: string;
    placeholder: string;
    tone: 'filter' | 'group';
    tags: string[];
    suggestions: string[];
    onChange: (tags: string[]) => void;
};

function TagField({ label, placeholder, tone, tags, suggestions, onChange }: TagFieldProps) {
    const [text, setText] = useState('');
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const needle = text.trim().toLowerCase();
    const options = open
        ? suggestions
              .filter((entry) => !tags.includes(entry) && entry.toLowerCase().includes(needle))
              .slice(0, MAX_OPTIONS)
        : [];

    const add = (entry: string) => {
        const next = entry.trim();
        setText('');
        setActive(0);
        if (next && !tags.includes(next)) {
            onChange([...tags, next]);
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActive((current) => Math.min(current + 1, Math.max(options.length - 1, 0)));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((current) => Math.max(current - 1, 0));
        } else if (event.key === 'Enter' || event.key === ',') {
            if (options[active] || text.trim()) {
                event.preventDefault();
                add(options[active] ?? text);
            }
        } else if (event.key === 'Backspace' && text === '' && tags.length > 0) {
            onChange(tags.slice(0, -1));
        } else if (event.key === 'Escape') {
            setOpen(false);
        }
    };

    return (
        <div className={`qb-field qb-${tone}`}>
            {tags.map((tag) => (
                <span key={tag} className="qb-chip">
                    {tag}
                    <button
                        type="button"
                        aria-label={`Remove ${tag}`}
                        onClick={() => onChange(tags.filter((entry) => entry !== tag))}
                    >
                        {'×'}
                    </button>
                </span>
            ))}
            <input
                aria-label={label}
                spellCheck={false}
                placeholder={tags.length === 0 ? placeholder : ''}
                value={text}
                size={Math.max(text.length, tags.length === 0 ? placeholder.length : 4)}
                onChange={(event) => {
                    setText(event.target.value);
                    setActive(0);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => {
                    setOpen(false);
                    if (text.trim()) {
                        add(text);
                    }
                }}
                onKeyDown={onKeyDown}
            />
            <OptionList options={options} active={active} onPick={add} onHover={setActive} />
        </div>
    );
}

type QueryBuilderProps = { value: string; onChange: (query: string) => void };

export function QueryBuilder({ value, onChange }: QueryBuilderProps) {
    const parsed = parseQuery(value);
    const [rawMode, setRawMode] = useState(parsed === null);
    const [rawText, setRawText] = useState(value);
    // The builder's width, kept when switching to the text box so the bar does not shrink.
    const rootRef = useRef<HTMLDivElement>(null);
    const [rawWidth, setRawWidth] = useState(0);
    const metric = parsed?.metric ?? '';
    const details = useQuery({
        queryKey: ['metric-details', metric],
        queryFn: () => getMetricDetails(metric),
        enabled: metric !== '',
        staleTime: 5 * 60_000,
        retry: false,
    });

    if (rawMode || !parsed) {
        // A half-typed query ("... by {host") is not sent: say what is wrong and wait.
        const problem = queryProblem(rawText);
        const applyRaw = () => {
            const next = rawText.trim();
            if (next && next !== value && !queryProblem(next)) {
                onChange(next);
            }
        };
        return (
            <div className="qb" style={{ width: rawWidth || 640 }}>
                <input
                    className={`qb-raw${problem && rawText !== value ? ' invalid' : ''}`}
                    aria-label="Metrics query"
                    aria-invalid={problem !== null && rawText !== value}
                    spellCheck={false}
                    value={rawText}
                    onChange={(event) => setRawText(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            applyRaw();
                        }
                    }}
                    onBlur={applyRaw}
                />
                <button
                    type="button"
                    className="qb-toggle"
                    title={
                        parseQuery(rawText) === null
                            ? 'Back to the query builder (what it cannot show is dropped)'
                            : 'Back to the query builder'
                    }
                    aria-label="Back to the query builder"
                    onClick={() => {
                        if (parseQuery(rawText) !== null) {
                            applyRaw();
                        } else {
                            // The builder cannot show this query (a formula, a rollup...): start it
                            // from the metric, so that a query can always be built again.
                            const fallback = builderStart(rawText);
                            setRawText(fallback);
                            onChange(fallback);
                        }
                        setRawMode(false);
                    }}
                >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <path d="M2 4h12M2 8h12M2 12h12" />
                        </g>
                        <g fill="#0a0e26" stroke="currentColor" strokeWidth="1.5">
                            <circle cx="5" cy="4" r="1.7" />
                            <circle cx="11" cy="8" r="1.7" />
                            <circle cx="6.5" cy="12" r="1.7" />
                        </g>
                    </svg>
                </button>
                {problem && rawText !== value && <span className="qb-problem">{problem}</span>}
            </div>
        );
    }

    const update = (change: Partial<Parts>) => onChange(composeQuery({ ...parsed, ...change }));
    const aggregations = details.data?.aggregations ?? DEFAULT_AGGREGATIONS;
    const tags = details.data?.tags ?? [];
    const keys = Array.from(new Set(tags.map((tag) => tag.split(':')[0]))).sort();

    return (
        <div className="qb" ref={rootRef}>
            <MetricField
                key={parsed.metric}
                value={parsed.metric}
                onCommit={(next) => update({ metric: next })}
            />
            <span className="qb-word">from</span>
            <TagField
                label="Filter"
                placeholder="(everywhere)"
                tone="filter"
                tags={parsed.filters}
                suggestions={tags}
                onChange={(filters) => update({ filters })}
            />
            <select
                className="qb-agg"
                aria-label="Aggregation"
                value={parsed.agg}
                onChange={(event) => update({ agg: event.target.value })}
            >
                {Array.from(new Set([parsed.agg, ...aggregations])).map((name) => (
                    <option key={name} value={name}>
                        {name}
                    </option>
                ))}
            </select>
            <span className="qb-word">by</span>
            <TagField
                label="Group by"
                placeholder="(everything)"
                tone="group"
                tags={parsed.groups}
                suggestions={keys}
                onChange={(groups) => update({ groups })}
            />
            <button
                type="button"
                className="qb-toggle"
                title="Edit the query as text"
                onClick={() => {
                    setRawText(value);
                    setRawWidth(rootRef.current?.offsetWidth ?? 0);
                    setRawMode(true);
                }}
            >
                {'</>'}
            </button>
        </div>
    );
}
