/**
 * What kind of number a column holds, judged from its name by whole words
 * only, and how many decimals to show. One rule for every chart, label,
 * tooltip and sentence, so they cannot disagree.
 *
 * Whole words matter: "rated_tickets" is a count of tickets, not a rate;
 * "success_rate" and "conversion %" are rates; "hourly_rate" is money.
 */

/** "Rated_Tickets" / "avgCsatScore" → ["rated", "tickets"] / ["avg", "csat", "score"]. */
export function nameWords(name: string): string[] {
    return String(name || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9%]+/)
        .filter(Boolean);
}

const RATE_WORDS = new Set(['rate', 'rates', 'percent', 'percentage', 'pct', 'ratio', 'conversion', 'share', 'proportion', '%']);
/** A rate of pay or charge is money, not a percentage. */
const PAY_WORDS = new Set(['hourly', 'daily', 'weekly', 'monthly', 'annual', 'yearly', 'billing', 'bill', 'pay', 'charge', 'base', 'flat', 'day', 'hour', 'exchange', 'fx', 'tax', 'interest']);
const COUNT_WORDS = new Set(['count', 'counts', 'number', 'num', 'qty', 'quantity', 'units', 'volume', 'orders', 'users', 'sessions', 'tickets', 'visits', 'customers', 'transactions', 'items', 'rows', 'records', 'cases', 'calls', 'clicks', 'views', 'signups', 'leads']);

/** Is this column a rate or percentage (by its name)? */
export function isRateName(name: string): boolean {
    const words = nameWords(name);
    if (String(name).includes('%')) return true;
    const at = words.findIndex(word => RATE_WORDS.has(word));
    if (at < 0) return false;
    // "hourly rate", "exchange rate", "tax rate": money or a factor, not a share.
    if (words[at] === 'rate' || words[at] === 'rates') {
        if (at > 0 && PAY_WORDS.has(words[at - 1])) return false;
    }
    return true;
}

/** Is this column a count of things (by its name)? */
export function isCountName(name: string): boolean {
    return nameWords(name).some(word => COUNT_WORDS.has(word)) && !isRateName(name);
}

/**
 * Decimals to show: what the user chose, else none for a whole number and
 * exactly 2 when the value has decimals (4.67, never "5").
 */
export function decimalsFor(value: number, chosen?: number): number {
    if (chosen !== undefined && chosen !== null && Number.isFinite(chosen)) return chosen;
    return Number.isInteger(value) ? 0 : 2;
}
