/**
 * Values that cannot be right, worked out for any column from what its name
 * means and what its own values look like — never from a particular file.
 *
 *   Limits by meaning (the column's bulk must already sit inside them, so a
 *   "rate" stored as a fraction or an interest rate above 100 is left alone):
 *     hours in a day ≤ 24, hours in a week ≤ 168, minutes in a day ≤ 1,440,
 *     ages 0–125, percentages 0–100, month numbers 1–12, days of the month
 *     1–31, years 1900–2100.
 *   Wildly out of line: more than 20 interquartile ranges beyond the middle
 *     half of the column's own values (a typo like 342 among 0–16).
 *
 * Used by the cleaner (flagged for review, never changed) and by the answer
 * check (an answer that includes such a value says so, with the effect of
 * leaving it out).
 */

export interface ImpossibleRule { min?: number; max?: number; why: string }

const tokens = (name: string) => name.toLowerCase().replace(/([a-z])([A-Z])/g, '$1_$2').split(/[^a-z0-9]+/).filter(Boolean);
const has = (t: string[], ...words: string[]) => words.some(w => t.includes(w));

/** The limit a column's meaning sets, if any. */
export function limitByMeaning(column: string): ImpossibleRule | null {
    const t = tokens(column);
    const perDay = has(t, 'day', 'daily', 'days', 'nightly', 'night');
    const perWeek = has(t, 'week', 'weekly');
    if (has(t, 'hour', 'hours', 'hrs', 'hr') && perDay && !perWeek) return { min: 0, max: 24, why: 'a day has 24 hours' };
    if (has(t, 'hour', 'hours', 'hrs', 'hr') && perWeek) return { min: 0, max: 168, why: 'a week has 168 hours' };
    if (has(t, 'minute', 'minutes', 'mins') && perDay) return { min: 0, max: 1440, why: 'a day has 1,440 minutes' };
    if (has(t, 'age') && !has(t, 'average', 'stage', 'page', 'percentage', 'usage', 'mileage', 'damage', 'storage', 'package', 'wage', 'wages')) return { min: 0, max: 125, why: 'ages run from 0 to 125' };
    if (has(t, 'pct', 'percent', 'percentage') && !has(t, 'change', 'growth', 'diff', 'difference', 'delta', 'increase', 'decrease', 'uplift', 'lift', 'return', 'yield', 'vs', 'variance')) return { min: 0, max: 100, why: 'a percentage runs from 0 to 100' };
    if (t.length <= 2 && has(t, 'month') && !has(t, 'months')) return { min: 1, max: 12, why: 'months run from 1 to 12' };
    if (has(t, 'dayofmonth') || (has(t, 'day') && has(t, 'month') && has(t, 'of'))) return { min: 1, max: 31, why: 'a month has at most 31 days' };
    if (t.length <= 2 && has(t, 'year') && !has(t, 'years')) return { min: 1900, max: 2100, why: 'years outside 1900–2100 are almost certainly typos' };
    return null;
}

export interface SuspectValue { value: number; row: number; why: string }

/**
 * Values in one column that cannot be right, with the reason. The rule by
 * meaning applies only when at least 95% of the column already fits it.
 */
export function suspectValues(values: unknown[], column: string): SuspectValue[] {
    const nums: { v: number; row: number }[] = [];
    values.forEach((raw, row) => {
        if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return;
        const v = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,£$€\s]/g, ''));
        if (Number.isFinite(v)) nums.push({ v, row });
    });
    if (nums.length < 8) return [];
    const out: SuspectValue[] = [];
    const seen = new Set<number>();
    const rule = limitByMeaning(column);
    if (rule) {
        const inside = nums.filter(n => (rule.min === undefined || n.v >= rule.min) && (rule.max === undefined || n.v <= rule.max)).length;
        if (inside / nums.length >= 0.95) {
            for (const n of nums) {
                if ((rule.min !== undefined && n.v < rule.min) || (rule.max !== undefined && n.v > rule.max)) {
                    out.push({ value: n.v, row: n.row, why: rule.why });
                    seen.add(n.row);
                }
            }
        }
    }
    const sorted = nums.map(n => n.v).sort((a, b) => a - b);
    const q = (p: number) => { const pos = (sorted.length - 1) * p; const lo = Math.floor(pos); return sorted[lo] + (sorted[Math.ceil(pos)] - sorted[lo]) * (pos - lo); };
    const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
    if (iqr > 0) {
        for (const n of nums) {
            if (seen.has(n.row)) continue;
            if (n.v > q3 + 20 * iqr || n.v < q1 - 20 * iqr) out.push({ value: n.v, row: n.row, why: 'it is far outside every other value in the column' });
        }
    }
    return out;
}

/** 95% Wilson interval for a share k/n (0–1). */
export function wilsonInterval(share: number, n: number): { low: number; high: number } {
    if (n <= 0) return { low: 0, high: 1 };
    const z = 1.96, z2 = z * z;
    const p = Math.min(Math.max(share, 0), 1);
    const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
    const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Is a rate too uncertain to compare? True when its 95% range spans more than
 * 30 points (±15) — e.g. 1 in 4 (25%) could really be anywhere from 5% to 70%.
 */
export function rateTooUncertain(share: number, n: number): { low: number; high: number } | null {
    const range = wilsonInterval(share, n);
    return range.high - range.low > 0.3 ? range : null;
}
