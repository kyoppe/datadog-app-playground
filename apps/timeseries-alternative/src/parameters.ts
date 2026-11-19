import { defineDatadogAppParameters } from '@datadog/apps-frontend/parameters';

// The settings of one embed: Datadog shows these as a form when the app is added to a dashboard
// as a widget, stores the values with that widget, and hands them back every time it opens. Two
// widgets on one dashboard can therefore chart two different metrics.
//
// Keep the declaration literal (no variables, no spreads): the build reads it from the source.
export const appParameters = defineDatadogAppParameters({
    query: {
        type: 'string',
        label: 'Metrics query',
        description:
            'For example avg:system.cpu.user{env:prod} by {host}. Build it in the app on its own (the query builder, then the </> button shows it as text), copy it and paste it here. The widget has no query bar: it charts this query.',
        default: '',
    },
    limit: {
        type: 'string',
        label: 'Number of series',
        description:
            'How many series to show: the strongest ones, by their maximum in the time frame.',
        default: '10',
        options: ['5', '10', '25', '50'],
    },
    stacked: {
        type: 'boolean',
        label: 'Stacked',
        description: 'Stack the series into one tower per time bucket.',
        default: false,
    },
    sort: {
        type: 'string',
        label: 'Sort order',
        description:
            'How the rows are ordered: value (highest first), value:asc (lowest first), or one of the tags the series are grouped by, such as host (A to Z) or host:desc (Z to A).',
        default: 'value',
    },
    background: {
        type: 'string',
        label: 'Background',
        description:
            'The colour behind the chart, as #rrggbb (for example #1d2342), or transparent (the dashboard shows through). Empty is the usual dark background. Open Options at the lower right of the widget, pick Background from the list or the colour wheel, and copy the code shown there.',
        default: '',
    },
    view: {
        type: 'string',
        label: 'Starting view',
        description:
            'The angle and zoom the board starts at, as "turn,tilt,zoom": for example 0,48,1 is the usual view (turn in degrees from it, tilt in degrees, zoom: smaller is closer). Press Query at the top left of the widget to read the current view, and copy it here. Empty: the usual view. A viewer who has turned the board sees the view they left it in, until this setting is changed.',
        default: '',
    },
    spin: {
        type: 'boolean',
        label: 'Spin',
        description: 'Slowly turn the board.',
        default: false,
    },
    alertAt: {
        type: 'number',
        label: 'Alert at or above',
        description: 'Roofs at or above this value glow red. 0 turns it off.',
        default: 0,
    },
});
