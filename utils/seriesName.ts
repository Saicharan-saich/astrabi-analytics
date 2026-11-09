/**
 * A column name as a person reads it on a chart: "no_show_rate_pct" → "No Show
 * Rate", "unitPrice" → "Unit Price", "avg_aov" → "Avg AOV". A trailing unit
 * word (pct, percent, percentage) is left out — the axis and the values
 * already show the % — and short known acronyms stay in capitals. Works on any
 * column name, so every chart, legend and tooltip reads the same way.
 */
const UNIT_SUFFIX = /[_\s-]+(pct|percent|percentage)$/i;
const ACRONYMS = new Set(['id', 'sku', 'aov', 'ctr', 'cpc', 'cpm', 'cpa', 'roas', 'roi', 'kpi', 'nps', 'gdp', 'vat', 'uk', 'us', 'eu', 'sms', 'url', 'ytd', 'mtd', 'qtd', 'arpu', 'ltv', 'cogs', 'ebitda', 'hr', 'it', 'gp']);

export function seriesName(column: string): string {
    const base = String(column || '').replace(UNIT_SUFFIX, '') || String(column || '');
    return base
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map(word => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
        .join(' ');
}
