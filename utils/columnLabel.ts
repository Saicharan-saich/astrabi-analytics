/**
 * A column name as it should appear in menus and headings: "order_id" →
 * "Order ID", "funnel_stage" → "Funnel stage", "slaMet" → "SLA met".
 * Works for any file: it only tidies the name, never changes what it refers to.
 */
import { spokenName } from './spokenName';

/** Short words that are written in capitals when they stand alone. */
const ACRONYMS = new Set([
    'id', 'ids', 'sku', 'skus', 'sla', 'csat', 'nps', 'kpi', 'roi', 'roas', 'aov', 'ltv', 'cac', 'mrr', 'arr',
    'vat', 'gst', 'uk', 'us', 'usa', 'eu', 'gbp', 'usd', 'eur', 'url', 'utm', 'ip', 'api', 'crm', 'erp',
    'gdp', 'ppc', 'cpc', 'cpm', 'ctr', 'seo', 'hr', 'it', 'pnl', 'ebitda', 'yoy', 'mom', 'qoq', 'ytd', 'mtd',
    'nhs', 'gp', 'los', 'ae', 'icu', 'bmi',
]);
// "it" and "us" are ordinary words too: only capitalise them when they are the whole name.
const ONLY_ALONE = new Set(['it', 'us', 'mom']);

export function columnLabel(name: string): string {
    if (!name) return name;
    const words = spokenName(name).split(' ').filter(Boolean);
    const out = words.map((word, i) => {
        const lower = word.toLowerCase();
        if (ACRONYMS.has(lower) && (!ONLY_ALONE.has(lower) || words.length === 1)) return lower.toUpperCase();
        return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    });
    return out.join(' ') || name;
}
