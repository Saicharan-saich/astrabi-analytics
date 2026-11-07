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
