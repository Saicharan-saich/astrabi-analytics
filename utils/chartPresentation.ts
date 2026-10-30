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
