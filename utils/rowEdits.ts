/**
 * rowEdits.ts — turn values changed in "View rows" into fixes that repeat.
 *
 * Pairings (a product under the wrong category): a change that covers every
 * listed row of one pair ("Milk" under "Bakery") is saved for the pair, so
 * next month's file is fixed too. Otherwise a change is saved for that row by
 * the file's identifier column, or, without one, for every row with the same
 * value.
 */
import type { ValueFix } from '../types';

type Row = Record<string, any>;
const text = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v));
const word = (s: string) => s.replace(/_/g, ' ');

export function fixesFromEdits(
    rows: Row[],
    edits: Map<number, string>,
    { column, by, idColumn, isNumber }: { column: string; by?: string; idColumn?: string; isNumber?: boolean },
): { fixes: ValueFix[]; summary: string } {
    const to = (value: string): string | null => (value.trim() === '' ? null : value.trim());
    const fixes = new Map<string, ValueFix>();
    const add = (fix: ValueFix) => fixes.set(JSON.stringify([fix.column, Object.entries(fix.where).sort()]), fix);
    let forPairs = 0, forRows = 0, forValues = 0;
    const hasId = (row: Row) => Boolean(idColumn && text(row[idColumn]).trim());

    if (by) {
        const groups = new Map<string, number[]>();
        rows.forEach((row, i) => { const key = JSON.stringify([text(row[by]), text(row[column])]); groups.set(key, [...(groups.get(key) || []), i]); });
        for (const members of groups.values()) {
            const changed = members.filter(i => edits.has(i));
            if (!changed.length) continue;
            const values = new Set(changed.map(i => edits.get(i)!));
            const row = rows[members[0]];
            if (changed.length === members.length && values.size === 1) {
                add({ column, where: { [by]: text(row[by]), [column]: text(row[column]) }, to: to([...values][0]) });
                forPairs++;
            } else {
                for (const i of changed) {
                    if (hasId(rows[i])) { add({ column, where: { [idColumn!]: text(rows[i][idColumn!]) }, to: to(edits.get(i)!) }); forRows++; }
                    else { add({ column, where: { [by]: text(rows[i][by]), [column]: text(rows[i][column]) }, to: to(edits.get(i)!) }); forValues++; }
                }
            }
        }
    } else {
        for (const [i, value] of edits) {
            const row = rows[i];
            if (!row) continue;
            if (hasId(row)) { add({ column, where: { [idColumn!]: text(row[idColumn!]) }, to: to(value) }); forRows++; }
            else { add({ column, where: { [column]: text(row[column]) }, to: to(value) }); forValues++; }
        }
    }

    const parts: string[] = [];
    const fixWord = (n: number) => `${n} fix${n === 1 ? '' : 'es'}`;
    if (forPairs) parts.push(`${fixWord(forPairs)} for each ${word(by!)}, so next month’s file is fixed the same way`);
    if (forRows) parts.push(`${fixWord(forRows)} for single rows, by ${word(idColumn!)}`);
    if (forValues) parts.push(`${fixWord(forValues)} for every row with the same ${by ? `${word(by)} and ${word(column)}` : word(column)} (the file has no ID to tell rows apart)`);
    const notNumbers = isNumber ? [...edits.values()].filter(v => v.trim() && !Number.isFinite(Number(v.replace(/[£$€,\s]/g, '')))) : [];
    const warn = notNumbers.length ? ` '${notNumbers[0]}' is not a number, so it would be left blank.` : '';
    return { fixes: [...fixes.values()], summary: `Saves as ${parts.join('; ')}.${warn}` };
}
