/**
 * itemRows.ts — the rows a checklist item is about, for "View rows".
 *
 * In order of preference:
 *  1. Rows still in the cleaned data that the entry points at (unusual
 *     values, possible typos, negatives, impossible values, blanks): found
 *     again in the data itself, so every one is listed.
 *  2. Rows the step removed (kept with the entry, up to 200).
 *  3. Rows a flag kept as examples.
 *  4. For steps that changed values: before → after pairs.
 * Everything here is worked out on this computer.
 */
import type { ETLLog, RowMatch } from '../types';

type Row = Record<string, any>;

export interface ItemRows {
    mode: 'rows';
    rows: Row[];
    /** How many rows the entry is about (may be more than are listed). */
    total: number;
    /** Columns to show first and highlight. */
    highlight: string[];
    /** Where the rows come from, in plain words. */
    source: 'data' | 'removed' | 'examples';
    /** Rows from the data whose values can be changed here: this column (with the usual value per `by` value, for pairings). */
    edit?: { column: string; by?: string; usual?: Record<string, string> };
}
export interface ItemChanges {
    mode: 'changes';
    changes: { column: string; before: unknown; after: unknown }[];
    total: number;
    highlight: string[];
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const asNumber = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || !v.trim()) return null;
    const n = Number(v.replace(/[£$€,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
};

/** Does this row belong to the match? */
export function rowMatches(row: Row, match: RowMatch): boolean {
    const v = row[match.column];
    if (match.blank) return isBlank(v);
    if (match.outside) {
        const n = asNumber(v);
        if (n === null || match.exempt?.includes(n)) return false;
        return n < match.outside[0] || n > match.outside[1];
    }
    if (match.negative) { const n = asNumber(v); return n !== null && n < 0; }
    if (match.by && match.usual) {
        const by = row[match.by];
        if (isBlank(by) || isBlank(v)) return false;
        const usual = match.usual[String(by)];
        return usual !== undefined && String(v) !== usual;
    }
    if (match.values) return !isBlank(v) && match.values.includes(String(v).trim());
    return false;
}

/** A pairing flag cleaned before matches were recorded: work out the usual pairs again. */
function legacyPairing(log: ETLLog, rows: Row[]): RowMatch | undefined {
    const key = /^mapping:(.+)->(.+)$/.exec(log.decision?.key || '');
    if (!key) return undefined;
    const [, a, b] = key;
    const counts = new Map<string, Map<string, number>>();
    for (const row of rows) {
        if (isBlank(row[a]) || isBlank(row[b])) continue;
        const inner = counts.get(String(row[a])) || new Map<string, number>();
        inner.set(String(row[b]), (inner.get(String(row[b])) || 0) + 1);
        counts.set(String(row[a]), inner);
    }
    const usual: Record<string, string> = {};
    for (const [va, inner] of counts) {
        const sum = [...inner.values()].reduce((s, n) => s + n, 0);
        if (sum < 3) continue;
        const [value, count] = [...inner.entries()].sort((x, y) => y[1] - x[1])[0];
        if (count / sum >= 0.8) usual[va] = value;
    }
    return { column: b, by: a, usual };
}

/** Entries cleaned before matches were recorded: read the range from the words. */
function legacyMatch(log: ETLLog, rows: Row[] = []): RowMatch | undefined {
    if (log.decision?.key?.startsWith('mapping:')) return legacyPairing(log, rows);
    if (!/^Outlier (Flag|Confirmed)$/.test(log.step)) return undefined;
    const column = log.decision?.column || log.affectedColumns?.[0];
    const range = /range \[(-?[\d.]+), (-?[\d.]+)\]/.exec(log.details || '');
    if (!column || !range) return undefined;
    return { column, outside: [Number(range[1]), Number(range[2])] };
}

export function rowsForLog(log: ETLLog | undefined, rows: Row[]): ItemRows | ItemChanges | null {
    if (!log) return null;
    const highlight = log.rowMatch ? [log.rowMatch.column] : (log.affectedColumns || []).slice(0, 3);
    const match = log.rowMatch || legacyMatch(log, rows);
    if (match) {
        const found = rows.filter(row => rowMatches(row, match));
        if (found.length) {
            return {
                mode: 'rows', rows: found, total: found.length, highlight: match.by ? [match.by, match.column] : [match.column], source: 'data',
                edit: { column: match.column, ...(match.by ? { by: match.by, usual: match.usual } : {}) },
            };
        }
    }
    if (log.removedRowSamples?.length) {
        const removed = log.rowsBefore !== undefined && log.rowsAfter !== undefined ? log.rowsBefore - log.rowsAfter : (log.affectedRows || 0);
        return { mode: 'rows', rows: log.removedRowSamples, total: Math.max(removed, log.removedRowSamples.length), highlight, source: 'removed' };
    }
    if (log.sampleRows?.length) {
        return { mode: 'rows', rows: log.sampleRows, total: Math.max(log.affectedRows || 0, log.sampleRows.length), highlight, source: 'examples' };
    }
    if (log.transformSamples?.length) {
        return { mode: 'changes', changes: log.transformSamples, total: Math.max(log.affectedRows || 0, log.transformSamples.length), highlight };
    }
    return null;
}

/** Blank cells still blank in the cleaned data. */
export function blankRows(column: string, rows: Row[]): ItemRows | null {
    const found = rows.filter(row => isBlank(row[column]));
    return found.length ? { mode: 'rows', rows: found, total: found.length, highlight: [column], source: 'data', edit: { column } } : null;
}

/** The button's words: "View the 18 rows", "View 10 of 240 removed rows"… */
export function viewLabel(view: ItemRows | ItemChanges): string {
    const n = (x: number) => x.toLocaleString('en-GB');
    if (view.mode === 'changes') return view.total > view.changes.length ? `View ${n(view.changes.length)} example changes` : `View the ${view.total === 1 ? 'change' : `${n(view.total)} changes`}`;
    const word = view.source === 'removed' ? 'removed row' : 'row';
    const plural = (x: number) => `${word}${x === 1 ? '' : 's'}`;
    if (view.rows.length < view.total) return `View ${n(view.rows.length)} of ${n(view.total)} ${plural(view.total)}`;
    return view.total === 1 ? `View the ${word}` : `View the ${n(view.total)} ${plural(view.total)}`;
}

/** The rows as a CSV file (for "Download these rows"). */
export function rowsToCsv(rows: Row[], columns: string[]): string {
    const cell = (v: unknown) => {
        if (v === null || v === undefined) return '';
        let s = String(v);
        // A cell starting with = + - @ would run as a formula in a spreadsheet.
        if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [columns.map(cell).join(','), ...rows.map(r => columns.map(c => cell(r[c])).join(','))].join('\r\n');
}
