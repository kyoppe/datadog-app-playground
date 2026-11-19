// The colour behind the chart (the widget's "Background" setting): a few good ones, or any #rrggbb,
// or transparent (the dashboard shows through).

export const TRANSPARENT = 'transparent';

export const PRESETS: { name: string; color: string }[] = [
    { name: 'Default', color: '' },
    { name: 'Transparent', color: TRANSPARENT },
    { name: 'Midnight', color: '#1d2342' },
    { name: 'Charcoal', color: '#2b2c31' },
    { name: 'Forest', color: '#2f4a3c' },
    { name: 'Wine', color: '#55263b' },
    { name: 'Datadog purple', color: '#632ca6' },
    { name: 'Sky', color: '#3f6f9e' },
    { name: 'Sand', color: '#cbbf9f' },
    { name: 'Paper', color: '#e8e4dc' },
];

export function hexToRgb(hex: string): [number, number, number] | null {
    const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!match) {
        return null;
    }
    const n = parseInt(match[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
