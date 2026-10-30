/** Keep chart text readable when a saved light-theme formatting choice is
 * displayed on a dark canvas (or vice versa). */
export function readableChartTextColor(color: string | undefined, dark: boolean, fallback: string): string {
    if (!color) return fallback;
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
    if (!match) return color;
    const hex = match[1].length === 3
        ? match[1].split('').map(part => part + part).join('')
        : match[1];
    const channels = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const linear = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    return (dark && luminance < 0.19) || (!dark && luminance > 0.75) ? fallback : color;
}

/** The tooltip body already contains a row for each plotted dataset. Only
 * include genuinely additional numeric fields from the source row. */
export function extraTooltipMetricKeys(
    row: Record<string, unknown>,
    plottedLabels: string[],
    excludedKeys: ReadonlySet<string>,
): string[] {
    const normalize = (label: string) => label.replace(/[_\s]+/g, ' ').trim().toLowerCase();
    const shown = new Set(plottedLabels.map(normalize));
    return Object.keys(row).filter(key => {
        if (excludedKeys.has(key) || typeof row[key] !== 'number' || !Number.isFinite(row[key])) return false;
        const label = normalize(key);
        if (shown.has(label)) return false;
        shown.add(label);
        return true;
    });
}

/**
 * Legend/tooltip name for a series: "SUM of revenue by quarter" → "Revenue",
 * "AVG of order value" → "Average order value". Titles elsewhere keep the
 * full wording; only series names are shortened.
 */
export const friendlySeriesLabel = (label: string | undefined): string => {
    if (!label) return 'Value';
    const match = label.match(/^(SUM|AVG|AVERAGE|COUNT_DISTINCT|COUNT|MIN|MAX|MEDIAN)\s+of\s+(.+?)(?:\s+by\s+.+)?$/i);
    if (!match) return label;
    const field = match[2].replace(/_/g, ' ').trim();
    const prefix: Record<string, string> = { AVG: 'Average ', AVERAGE: 'Average ', COUNT_DISTINCT: 'Distinct ', COUNT: 'Count of ', MIN: 'Minimum ', MAX: 'Maximum ', MEDIAN: 'Median ' };
    const text = `${prefix[match[1].toUpperCase()] || ''}${field}`;
    return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Round up to a readable ceiling: 1, 2, 2.5, 5 or 10 × a power of ten. */
export function niceCeiling(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    const step = [1, 2, 2.5, 5, 10].find(m => m * power >= value) || 10;
    return step * power;
}

/**
 * Scale for a gauge: the KPI goal when one is set, 100% (or 1.0) for a rate,
 * otherwise a rounded ceiling just above the value.
 */
export function gaugeScale(values: number[], goal: number | undefined, metricName: string): { value: number; max: number; basis: 'goal' | 'percent' | 'ceiling' } {
    const value = values.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
    if (goal && Number.isFinite(goal) && goal > 0) return { value, max: Math.max(goal, value), basis: 'goal' };
    const name = metricName.toLowerCase();
    const looksLikeRate = /(percent|pct|ratio|rate|share|conversion|margin)/.test(name);
    if (looksLikeRate && value >= 0 && value <= 1) return { value, max: 1, basis: 'percent' };
    if (looksLikeRate && value >= 0 && value <= 100) return { value, max: 100, basis: 'percent' };
    return { value, max: niceCeiling(value * 1.15), basis: 'ceiling' };
}
