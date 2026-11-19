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
            'For example avg:system.cpu.user{env:prod} by {host}. Leave empty to pick one in the widget itself (not saved).',
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
