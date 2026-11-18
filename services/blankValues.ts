/**
 * blankValues.ts — what blank cells mean, decided per column.
 *
 * Every cleaning measures each column's blank cells (how many, what the filled
 * cells add up to, what the other numbers add up to on the blank rows) before
 * any choice is applied. The screen turns that one measurement into an exact
 * before/after for every choice, so a person can see what each choice does to
 * their totals and averages without re-running anything.
 *
 * Choices (EtlOptions.blankDecisions), all reversible:
 *   leave   numbers and dates stay blank; categories show as "Unknown" (default)
 *   zero    a blank number means none: count it as 0
 *   typical fill a blank number with the column's typical (median) value
 *   remove  leave rows with a blank here out of every answer
 *
 * Nothing here knows any column by name: kinds come from the cleaned roles.
 */

import { ColumnType, type BlankChoice, type BlankProfile, type ColumnDefinition, type ETLLog, type EtlOptions } from '../types';
import { parseLocaleNumber } from './etlHardening';

type Row = Record<string, any>;

const isBlank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const toNumber = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (isBlank(value) || typeof value === 'boolean') return null;
    return parseLocaleNumber(value);
};

/** The words the cleaning writes into blank category cells. */
const FILL_WORDS = ['Unknown', 'None'];

function kindOf(type: ColumnType): BlankProfile['kind'] {
    if (type === ColumnType.METRIC) return 'number';
    if (type === ColumnType.DATE) return 'date';
    if (type === ColumnType.DIMENSION) return 'category';
    return 'other';
}

function median(sorted: number[]): number {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** What each number column adds up to on these rows (numbers only, at least 80% readable). */
export function amountsIn(rows: Row[]): Record<string, number> {
    const out: Record<string, number> = {};
    if (!rows.length) return out;
    const keys = new Set<string>();
    rows.forEach(row => Object.keys(row).forEach(key => keys.add(key)));
    for (const key of keys) {
        let filled = 0, read = 0, total = 0;
        for (const row of rows) {
            if (isBlank(row[key])) continue;
            filled++;
            const n = toNumber(row[key]);
            if (n !== null) { read++; total += n; }
        }
        if (read > 0 && read >= filled * 0.8 && total !== 0) out[key] = total;
    }
    return out;
}

/** A blank cell for this profile (categories: also the word the cleaning filled in). */
function blankFor(profile: Pick<BlankProfile, 'kind' | 'fillWord'>, value: unknown): boolean {
    if (isBlank(value)) return true;
    return profile.kind === 'category' && profile.fillWord !== undefined && value === profile.fillWord;
}

/** Measure every column's blank cells, as they are before any blank decision. */
export function profileBlanks(rows: Row[], columns: ColumnDefinition[], decisions: EtlOptions['blankDecisions'] = {}): BlankProfile[] {
    const measures = columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
    const profiles: BlankProfile[] = [];
    for (const column of columns) {
        const kind = kindOf(column.type);
        if (kind === 'other' || column.name.startsWith('__')) continue;
        let fillWord: string | undefined;
        if (kind === 'category') {
            const counts = FILL_WORDS.map(word => [word, rows.filter(row => row[column.name] === word).length] as const);
            const best = counts.sort((a, b) => b[1] - a[1])[0];
            if (best && best[1] > 0) fillWord = best[0];
        }
        const probe = { kind, fillWord };
        const blankRows = rows.filter(row => blankFor(probe, row[column.name]));
        if (!blankRows.length) continue;
        const profile: BlankProfile = { column: column.name, kind, blanks: blankRows.length, rows: rows.length, choice: decisions?.[column.name] || 'leave' };
        if (fillWord) profile.fillWord = fillWord;
        if (kind === 'number') {
            const numbers = rows.map(row => toNumber(row[column.name])).filter((n): n is number => n !== null).sort((a, b) => a - b);
            profile.filled = numbers.length;
            profile.sum = numbers.reduce((s, n) => s + n, 0);
            profile.median = numbers.length ? median(numbers) : 0;
            profile.zeros = numbers.filter(n => n === 0).length;
        }
        const others = measures.filter(m => m !== column.name)
            .map(m => ({ column: m, amount: blankRows.reduce((s, row) => s + (toNumber(row[m]) ?? 0), 0) }))
            .filter(m => m.amount !== 0)
            .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
            .slice(0, 3);
        if (others.length) profile.onBlankRows = others;
        profiles.push(profile);
    }
    return profiles;
}

/** Choices that make sense for a kind of column. */
export function choicesFor(kind: BlankProfile['kind']): BlankChoice[] {
    if (kind === 'number') return ['leave', 'zero', 'typical', 'remove'];
    if (kind === 'category' || kind === 'date') return ['leave', 'remove'];
    return ['leave'];
}

const words = (column: string) => column.replace(/_/g, ' ');

/** Apply each column's blank decision; one plain log per applied decision. */
export function applyBlankDecisions(rows: Row[], profiles: BlankProfile[], decisions: EtlOptions['blankDecisions'] = {}): { rows: Row[]; logs: ETLLog[] } {
    const logs: ETLLog[] = [];
    let out = rows;
    for (const profile of profiles) {
        const choice = decisions?.[profile.column];
        if (!choice || choice === 'leave' || !choicesFor(profile.kind).includes(choice)) continue;
        const rest = { ...(decisions || {}) };
        delete rest[profile.column];
        const revert = { option: 'blankDecisions' as const, value: Object.keys(rest).length ? rest : null, label: profile.kind === 'category' ? `Show them as "${profile.fillWord || 'Unknown'}"` : 'Leave them blank' };
        const base = { stepNumber: 5, timestamp: Date.now(), affectedColumns: [profile.column], revert };
        if (choice === 'remove') {
            const before = out.length;
            const removed: Row[] = [];
            out = out.filter(row => (blankFor(profile, row[profile.column]) ? (removed.push(row), false) : true));
            if (!removed.length) continue;
            logs.push({
                ...base, step: 'Blanks Decision', status: 'applied',
                details: `Your choice: ${removed.length} row(s) with no '${words(profile.column)}' are left out of every answer.`,
                rowsBefore: before, rowsAfter: out.length, affectedRows: removed.length,
                removedRowSamples: removed.slice(0, 10), removedAmounts: amountsIn(removed),
            });
            continue;
        }
        if (profile.kind !== 'number') continue;
        const fill = choice === 'zero' ? 0 : profile.median ?? 0;
        let filled = 0;
        out = out.map(row => {
            if (!isBlank(row[profile.column])) return row;
            filled++;
            return { ...row, [profile.column]: fill };
        });
        if (!filled) continue;
        logs.push({
            ...base, step: 'Blanks Decision', status: 'applied', affectedRows: filled,
            details: choice === 'zero'
                ? `Your choice: ${filled} blank '${words(profile.column)}' value(s) are counted as 0.`
                : `Your choice: ${filled} blank '${words(profile.column)}' value(s) are filled with the typical value (${fill}). These are estimates, not recorded values.`,
        });
    }
    return { rows: out, logs };
}
