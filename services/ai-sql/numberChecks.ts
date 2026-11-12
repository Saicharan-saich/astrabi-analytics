/**
 * Checks on the numbers in an AI SQL answer, run on the user's computer
 * after the query (nothing is sent to the AI):
 *
 *  - An average that hides very uneven values (sales of 100, 0, 0, 0 average
 *    25, but nobody sold 25). The query is run again with AVG(x) swapped for
 *    LIST(x), so the check sees exactly the values behind each average —
 *    whatever filters, joins or sub-queries the AI wrote ("average sales per
 *    person" first totals each person, then averages those totals).
 *  - An average resting on very few values.
 *  - A per-item figure (unit price, age, rating) added up with SUM, which
 *    gives a number that means nothing.
 */
import type { ColumnDefinition } from '../../types';
import { averageCaution, formatAverageNumber, smallSampleNote } from '../../utils/averageCheck';
import { inferDefaultAggregationForGrain } from '../smartAggregation';

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))?`;
const unquote = (name: string) => name.split('.').pop()!.trim().replace(/^"|"$/g, '');
const words = (name: string) => name.replace(/_/g, ' ').trim();

/**
 * The query with its one averaged column returned as a list of values, and
 * any final LIMIT removed so every group is checked. Null when the query
 * averages more than one thing or an expression rather than a column.
 */
export function averageValuesQuery(sql: string): { sql: string; column: string } | null {
    const averages = [...sql.matchAll(new RegExp(String.raw`\bAVG\s*\(\s*(DISTINCT\s+)?(${IDENT})\s*\)`, 'gi'))];
    if (!averages.length) return null;
    const columns = new Set(averages.map(match => unquote(match[2]).toLowerCase()));
    if (columns.size !== 1 || averages.some(match => match[1])) return null;
    // Anything else inside AVG(...) (an expression) is left alone.
    if ((sql.match(/\bAVG\s*\(/gi) || []).length !== averages.length) return null;
    const column = unquote(averages[0][2]);
    let listed = sql.replace(
        new RegExp(String.raw`\bROUND\s*\(\s*AVG\s*\(\s*(${IDENT})\s*\)\s*,\s*\d+\s*\)|\bAVG\s*\(\s*(${IDENT})\s*\)`, 'gi'),
        (_whole, inRound, plain) => `LIST(CAST(${inRound || plain} AS DOUBLE))`,
    );
    // HAVING on an average cannot be kept once it is a list.
    if (/\bHAVING\b[^)]*\bLIST\(/i.test(listed)) return null;
    listed = listed.replace(/\s+LIMIT\s+\d+\s*;?\s*$/i, '');
    return { sql: listed, column };
}

const keyOf = (row: Record<string, any>, dimensions: string[]) => dimensions.map(name => String(row[name] ?? '')).join(' | ');

/**
 * Read the LIST query's result and say when an average misleads or rests on
 * very few values. `shown` are the answer's rows, so only groups the user
 * sees are mentioned.
 */
export function averageNotesFromValues(
    listRows: Record<string, any>[], shown: Record<string, any>[], dimensions: string[], column: string,
): string[] {
    const label = words(column);
    const asList = (value: unknown): unknown[] | undefined => Array.isArray(value) ? value
        : value && typeof value === 'object' && typeof (value as any).toArray === 'function' ? Array.from((value as any).toArray() as ArrayLike<unknown>)
            : ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : undefined;
    const groups = listRows
        .map(row => ({ row, values: Object.values(row).map(asList).find(Boolean) }))
        .filter((item): item is { row: Record<string, any>; values: unknown[] } => Boolean(item.values));
    if (!groups.length) return [];
    const visible = new Set(shown.map(row => keyOf(row, dimensions)));
    const relevant = dimensions.length ? groups.filter(group => visible.has(keyOf(group.row, dimensions))) : groups;
    const notes: string[] = [];

    if (!dimensions.length || relevant.length === 1) {
        const values = relevant[0]?.values || [];
        const caution = averageCaution(values, 'value');
        if (caution) notes.push(caution.message.replace('The average', `The average ${label}`));
        const small = smallSampleNote(values.filter(v => v !== null && v !== undefined).length, 'average');
        if (small) notes.push(small);
        return notes;
    }

    const flagged = relevant
        .map(group => ({ key: keyOf(group.row, dimensions), caution: averageCaution(group.values, 'value') }))
        .filter(item => item.caution);
    if (flagged.length) {
        const first = flagged[0];
        const others = flagged.length > 1 ? ` The same is true for ${flagged.length - 1} other ${flagged.length === 2 ? 'group' : 'groups'}.` : '';
        notes.push(`Careful with the average for ${first.key || '(blank)'}: ${first.caution!.message.replace(/^The average \([^)]*\) can mislead here: /, `it is ${formatAverageNumber(first.caution!.mean)}, but `)}${others}`);
    }
    const thin = relevant
        .map(group => ({ key: keyOf(group.row, dimensions), n: group.values.filter(v => v !== null && v !== undefined).length }))
        .filter(group => group.n < 5)
        .sort((a, b) => a.n - b.n);
    if (thin.length) {
        const names = thin.slice(0, 3).map(group => `${group.key || '(blank)'} (${group.n} row${group.n === 1 ? '' : 's'})`).join(', ');
        notes.push(`Some averages rest on very few rows, so they can swing a lot: ${names}${thin.length > 3 ? ` and ${thin.length - 3} more` : ''}.`);
    }
    return notes;
}

/** "SUM of unit price" means nothing: say so, and what to ask instead. */
export function perItemSumNote(sql: string, columns: ColumnDefinition[], datasetName = ''): string | null {
    for (const match of sql.matchAll(new RegExp(String.raw`\bSUM\s*\(\s*(${IDENT})\s*\)`, 'gi'))) {
        const name = unquote(match[1]);
        const column = columns.find(item => item.name.toLowerCase() === name.toLowerCase());
        if (!column || String(column.type) !== 'METRIC') continue;
        if (inferDefaultAggregationForGrain(column.name, 'METRIC', columns, datasetName) !== 'AVG') continue;
        const quantity = columns.find(item => String(item.type) === 'METRIC' && /(quantity|qty|units)/i.test(item.name));
        const label = words(column.name);
        return `Adding up ${label} gives a number that means little: ${label} is a per-item figure. Ask for the average ${label}${quantity ? `, or ${label} × ${words(quantity.name)} for a total` : ''}.`;
    }
    return null;
}

/** Columns the AI should average, never add up (metadata only, from names). */
export function perItemColumns(columns: ColumnDefinition[], datasetName = ''): Set<string> {
    return new Set(columns
        .filter(column => String(column.type) === 'METRIC' && inferDefaultAggregationForGrain(column.name, 'METRIC', columns, datasetName) === 'AVG')
        .map(column => column.name));
}

// ── Time series: missing months and a part-month at the end ─────────────

const MONTH_KEY = /^(\d{4})-(\d{2})(?:-01)?(?:[T ].*)?$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (y: number, m: number) => `${MONTHS[m - 1]} ${y}`;

/**
 * A monthly series with months missing draws a line straight across them as
 * if nothing happened. Months with no rows are added: 0 for totals and
 * counts, blank for averages (an average of nothing is not 0).
 */
export function fillMonthlyGaps(
    rows: Record<string, any>[], timeColumn: string, measures: string[], sql: string,
): { rows: Record<string, any>[]; missing: string[] } {
    if (rows.length < 2 || !measures.length) return { rows, missing: [] };
    const keys = rows.map(row => String(row[timeColumn] ?? '').match(MONTH_KEY));
    if (keys.some(match => !match)) return { rows, missing: [] };
    const index = (match: RegExpMatchArray) => Number(match[1]) * 12 + Number(match[2]) - 1;
    const present = new Map(keys.map((match, i) => [index(match!), rows[i]]));
    if (present.size !== rows.length) return { rows, missing: [] }; // more than one row per month: not a single series
    const sorted = [...present.keys()].sort((a, b) => a - b);
    const first = sorted[0], last = sorted[sorted.length - 1];
    if (last - first + 1 === rows.length || last - first > 240) return { rows, missing: [] };
    const zeroFill = !/\b(AVG|MEDIAN|MIN|MAX|QUANTILE|STDDEV)\s*\(/i.test(sql);
    const shape = String(rows[0][timeColumn]);
    const missing: string[] = [];
    const filled: Record<string, any>[] = [];
    for (let i = first; i <= last; i++) {
        const existing = present.get(i);
        if (existing) { filled.push(existing); continue; }
        const y = Math.floor(i / 12), m = (i % 12) + 1;
        const key = /^\d{4}-\d{2}-01/.test(shape) ? `${y}-${String(m).padStart(2, '0')}-01` : `${y}-${String(m).padStart(2, '0')}`;
        missing.push(monthLabel(y, m));
        filled.push({ ...Object.fromEntries(Object.keys(rows[0]).map(k => [k, null])), [timeColumn]: key, ...Object.fromEntries(measures.map(name => [name, zeroFill ? 0 : null])) });
    }
    // Keep the order the query asked for.
    const descending = index(keys[0]!) > index(keys[keys.length - 1]!);
    return { rows: descending ? filled.reverse() : filled, missing };
}

export function missingMonthsNote(missing: string[], zeroFilled: boolean): string | null {
    if (!missing.length) return null;
    const names = missing.length > 3 ? `${missing.slice(0, 3).join(', ')} and ${missing.length - 3} more` : missing.join(missing.length === 2 ? ' and ' : ', ');
    return `No rows in ${names}: ${missing.length === 1 ? 'it is' : 'they are'} shown as ${zeroFilled ? '0' : 'a gap'} rather than skipped.`;
}

/** The data stops part-way through its last month: a total for it looks like a fall. */
export function partialMonthNote(rows: Record<string, any>[], timeColumn: string, maxDate: string | undefined, sql: string): string | null {
    if (!maxDate || rows.length < 2 || !/\b(SUM|COUNT)\s*\(/i.test(sql)) return null;
    const max = String(maxDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!max) return null;
    const lastShown = rows.map(row => String(row[timeColumn] ?? '').match(MONTH_KEY)).filter(Boolean)
        .map(match => `${match![1]}-${match![2]}`).sort().pop();
    if (lastShown !== `${max[1]}-${max[2]}`) return null;
    const y = Number(max[1]), m = Number(max[2]), d = Number(max[3]);
    const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d >= daysIn - 1) return null;
    return `${monthLabel(y, m)} is only partly in the data (up to ${d} ${MONTHS[m - 1]}), so its total looks lower than a full month would be.`;
}

// ── Per-row figures, order lines and balances ───────────────────────────

const RATIO_NAME = /(pct|percent|percentage|rate|ratio|margin|share|conversion|discount)/i;
const BALANCE_NAME = /(balance|stock|inventory|on_?hand|headcount|head_?count|level|snapshot|outstanding|backlog|open_?orders)/i;
const ORDER_WORDS = /\b(order|orders|basket|invoice|transaction|receipt|booking|purchase)\b/i;
const ORDER_ID = /(order|invoice|transaction|receipt|basket|booking)[_\s-]?(id|no|number|ref)?$/i;

/** AVG of a per-row percentage weights a £5 sale the same as a £5,000 one. */
export function averagedRatioNote(sql: string, columns: ColumnDefinition[]): string | null {
    for (const match of sql.matchAll(new RegExp(String.raw`\bAVG\s*\(\s*(${IDENT})\s*\)`, 'gi'))) {
        const name = unquote(match[1]);
        const column = columns.find(item => item.name.toLowerCase() === name.toLowerCase());
        if (!column || String(column.type) !== 'METRIC' || !RATIO_NAME.test(column.name) || /(price|cost|amount)$/i.test(column.name)) continue;
        const label = words(column.name);
        return `This averages each row's ${label} equally, so a small sale counts as much as a large one. The overall ${label}, worked out from the totals, can be quite different.`;
    }
    return null;
}

/**
 * Rows are lines of an order (the order ID repeats), but the question is about
 * orders and the query averages a value per row: that is per line, not per order.
 */
export function perLineAverageNote(sql: string, question: string, rows: Record<string, any>[], columns: ColumnDefinition[]): string | null {
    if (!ORDER_WORDS.test(question) || !/\bAVG\s*\(/i.test(sql) || /COUNT\s*\(\s*DISTINCT/i.test(sql)) return null;
    const id = columns.find(column => ORDER_ID.test(column.name));
    if (!id || sql.toLowerCase().includes(id.name.toLowerCase())) return null;
    const sample = rows.slice(0, 20000);
    const distinct = new Set(sample.map(row => row[id.name]).filter(v => v !== null && v !== undefined && v !== '')).size;
    if (!distinct || distinct > sample.length * 0.95) return null;
    const thing = words(id.name).replace(/\s*(id|no|number|ref)$/i, '').trim() || 'order';
    return `One ${thing} spans several rows here (one row per line), so this is the average per line, not per ${thing}. For the average per ${thing}, ask for the total divided by the number of ${thing}s.`;
}

/** Stock or balances are snapshots: adding them up across dates double-counts. */
export function summedBalanceNote(sql: string, columns: ColumnDefinition[]): string | null {
    const hasDate = columns.some(column => String(column.type) === 'DATE');
    if (!hasDate) return null;
    for (const match of sql.matchAll(new RegExp(String.raw`\bSUM\s*\(\s*(${IDENT})\s*\)`, 'gi'))) {
        const name = unquote(match[1]);
        const column = columns.find(item => item.name.toLowerCase() === name.toLowerCase());
        if (!column || String(column.type) !== 'METRIC' || !BALANCE_NAME.test(column.name)) continue;
        const label = words(column.name);
        return `${label.charAt(0).toUpperCase() + label.slice(1)} looks like a snapshot (a level on a given date), so adding it up across dates counts the same stock or balance again and again. Use the latest date's value, or the average over the period.`;
    }
    return null;
}

/**
 * AVG("sales" / "qty") gives every row the same weight, so a row of 1 unit
 * counts as much as a row of 50; the average price is total sales over total
 * quantity. Rewritten for two number columns of the data only; the same when
 * every row has the same quantity.
 */
export function weightedAverages(sql: string, columns: ColumnDefinition[]): { sql: string; note: string | null } {
    const metric = (name: string) => columns.some(item => item.name.toLowerCase() === unquote(name).toLowerCase() && String(item.type) === 'METRIC');
    let note: string | null = null;
    const pattern = new RegExp(String.raw`\bAVG\s*\(\s*(${IDENT})\s*/\s*(?:NULLIF\s*\(\s*(${IDENT})\s*,\s*0\s*\)|(${IDENT}))\s*\)`, 'gi');
    const next = sql.replace(pattern, (whole, a: string, b1: string | undefined, b2: string | undefined) => {
        const b = b1 || b2!;
        if (!metric(a) || !metric(b)) return whole;
        note = `The average is worked out as total ${words(unquote(a))} divided by total ${words(unquote(b))}, so a row with more ${words(unquote(b))} counts for more. Averaging each row's own figure would count every row the same.`;
        return `SUM(${a}) / NULLIF(SUM(${b}), 0)`;
    });
    return { sql: next, note };
}
