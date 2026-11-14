/**
 * totalsCheck.ts — does every measure still add up to what the file says?
 *
 * Cleaning must never change a total without saying so. After cleaning, each
 * measure's total is compared two ways:
 *
 *  1. Layout: the file as uploaded vs the rows after layout tidying (removed
 *     total rows, repeated headers, exact copies, blank rows). These removals
 *     are expected to change totals; the check says by how much, so a wrong
 *     removal can't hide.
 *  2. Values: row by row, the number in the uploaded cell vs the cleaned
 *     number. A number that turned blank (unreadable, or a placeholder like
 *     999999) or changed value is counted and its amount reported.
 *
 * It works for any file: measures and headers come from the cleaned columns,
 * and nothing is assumed about names.
 */

import { parseLocaleNumber } from './etlHardening';

type Row = Record<string, any>;

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const toNumber = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (isBlank(v)) return null;
    const parsed = parseLocaleNumber(v as any);
    return parsed === null || !Number.isFinite(parsed) ? null : parsed;
};
const sum = (rows: Row[], column: string) => rows.reduce((total, row) => total + (toNumber(row[column]) ?? 0), 0);

export interface MeasureTotals {
    column: string;
    /** Total in the file as uploaded (null when the column can't be traced back to one uploaded column). */
    uploaded: number | null;
    /** Total after layout tidying, before any value was cleaned. */
    beforeValues: number;
    /** Total after cleaning: what every answer adds up. */
    cleaned: number;
    /** Uploaded numbers that became blank, and what they added up to. */
    blanked: { cells: number; amount: number };
    /** Uploaded numbers that were changed to a different number. */
    changed: { cells: number; amount: number };
}

export interface TotalsCheck {
    measures: MeasureTotals[];
    /** Measures whose cleaned total differs from the file by more than rounding. */
    differences: MeasureTotals[];
    rowsUploaded: number;
    rowsCleaned: number;
}

/** Tolerance: a difference this small is rounding, not a change. */
const tolerance = (reference: number) => Math.max(0.005, Math.abs(reference) * 1e-9);

/**
 * @param uploaded   the rows exactly as read from the file
 * @param tidied     the rows after layout tidying (same columns as `cleaned`, before value cleaning)
 * @param cleaned    the final rows, row for row with `tidied` when nothing was removed in between
 * @param measures   the cleaned columns that are measures
 * @param uploadedColumnFor  the uploaded header each cleaned measure came from, when known
 */
export function checkTotals(
    uploaded: Row[],
    tidied: Row[],
    cleaned: Row[],
    measures: string[],
    uploadedColumnFor: (column: string) => string | null,
): TotalsCheck {
    const sameRows = tidied.length === cleaned.length;
    const results = measures.map<MeasureTotals>(column => {
        const source = uploadedColumnFor(column);
        const blanked = { cells: 0, amount: 0 };
        const changed = { cells: 0, amount: 0 };
        if (sameRows) {
            for (let i = 0; i < tidied.length; i++) {
                const before = toNumber(tidied[i][column]);
                if (before === null) continue;
                const after = toNumber(cleaned[i][column]);
                if (after === null) { blanked.cells++; blanked.amount += before; }
                else if (Math.abs(after - before) > tolerance(before)) { changed.cells++; changed.amount += after - before; }
            }
        }
        return {
            column,
            uploaded: source ? sum(uploaded, source) : null,
            beforeValues: sum(tidied, column),
            cleaned: sum(cleaned, column),
            blanked,
            changed,
        };
    });
    const differs = (m: MeasureTotals) => {
        const reference = m.uploaded ?? m.beforeValues;
        return Math.abs(m.cleaned - reference) > tolerance(reference) || m.blanked.cells > 0 || m.changed.cells > 0;
    };
    return { measures: results, differences: results.filter(differs), rowsUploaded: uploaded.length, rowsCleaned: cleaned.length };
}

const formatAmount = (n: number) => {
    const rounded = Math.round(n * 100) / 100;
    return rounded.toLocaleString('en-GB', { maximumFractionDigits: Number.isInteger(rounded) ? 0 : 2 });
};
/** "budgeted_amount" → "Budgeted amount", so the sentence reads as words. */
const label = (column: string) => {
    const words = column.replace(/[_\s]+/g, ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : column;
};
const formatSigned = (n: number) => `${n < 0 ? '−' : ''}${formatAmount(Math.abs(n))}`;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${formatAmount(Math.abs(n))}`;

/** One plain sentence per measure, for the cleaning review. */
export function describeTotals(check: TotalsCheck): { matches: boolean; lines: string[] } {
    if (!check.measures.length) return { matches: true, lines: [] };
    if (!check.differences.length) {
        const shown = check.measures.slice(0, 4).map(m => `${label(m.column)} ${formatSigned(m.cleaned)}`).join(', ');
        return { matches: true, lines: [`Every total matches the file: ${shown}${check.measures.length > 4 ? ` and ${check.measures.length - 4} more` : ''}.`] };
    }
    const lines = check.differences.map(m => {
        const parts: string[] = [];
        if (m.uploaded !== null && Math.abs(m.uploaded - m.beforeValues) > tolerance(m.uploaded)) {
            parts.push(`tidying the layout (total rows, repeated headers, copies) changed it by ${signed(m.beforeValues - m.uploaded)}`);
        }
        if (m.blanked.cells) parts.push(`${m.blanked.cells} number${m.blanked.cells === 1 ? '' : 's'} adding up to ${formatAmount(m.blanked.amount)} became blank`);
        if (m.changed.cells) parts.push(`${m.changed.cells} number${m.changed.cells === 1 ? ' was' : 's were'} changed (${signed(m.changed.amount)} in all)`);
        const from = m.uploaded ?? m.beforeValues;
        return `${label(m.column)}: the file adds up to ${formatSigned(from)}, the cleaned data to ${formatSigned(m.cleaned)} (${signed(m.cleaned - from)})${parts.length ? ` — ${parts.join('; ')}` : ''}.`;
    });
    return { matches: false, lines };
}
