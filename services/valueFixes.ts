/**
 * valueFixes.ts — values changed by hand in "View rows".
 *
 * Each fix says: in rows where these columns have these values, set this
 * column to this value. They are stored with the cleaning choices, applied
 * after values are tidied and before the checks (so a fixed problem is no
 * longer flagged), and repeat on future files with a saved setup.
 */
import { ColumnType, type ColumnDefinition, type ETLLog, type ValueFix } from '../types';

type Row = Record<string, any>;
const MAX_FIXES = 5000;

const same = (a: unknown, b: string) => {
    if (a === null || a === undefined) return b === '';
    if (typeof a === 'number') { const n = Number(b); return Number.isFinite(n) ? a === n : String(a) === b; }
    if (a instanceof Date) return a.toISOString() === b || a.toISOString().slice(0, 10) === b;
    return String(a).trim() === b.trim();
};

export const fixKey = (where: Record<string, string>) => JSON.stringify(Object.entries(where).sort(([a], [b]) => a.localeCompare(b)));

const asNumber = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const n = Number(String(v ?? '').replace(/[£$€,\s]/g, ''));
    return String(v ?? '').trim() && Number.isFinite(n) ? n : null;
};

/** The value as the column holds it: numbers for number columns, blank for empty text. */
export function typedValue(value: unknown, column?: ColumnDefinition): string | number | null {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    if (column?.type === ColumnType.METRIC) return asNumber(value);
    return typeof value === 'number' ? value : String(value).trim();
}

export function applyValueFixes(rows: Row[], columns: ColumnDefinition[], fixes: ValueFix[] = []): { rows: Row[]; log?: ETLLog } {
    const usable = fixes.slice(0, MAX_FIXES).filter(f => columns.some(c => c.name === f.column) && Object.keys(f.where || {}).every(k => columns.some(c => c.name === k)));
    const skipped = fixes.length - usable.length;
    if (!usable.length && !skipped) return { rows };
    const byName = new Map(columns.map(c => [c.name, c]));
    let changed = 0;
    const samples: { column: string; before: unknown; after: unknown }[] = [];
    const touched = new Set<string>();
    const out = rows.map(row => {
        let next: Row | null = null;
        for (const fix of usable) {
            const current: Row = next || row;
            if (!Object.entries(fix.where).every(([k, v]) => same(current[k], v))) continue;
            const to = typedValue(fix.to, byName.get(fix.column));
            if (current[fix.column] === to) continue;
            if (samples.length < 200) samples.push({ column: fix.column, before: current[fix.column], after: to });
            next = { ...current, [fix.column]: to };
            touched.add(fix.column);
            changed++;
        }
        return next || row;
    });
    const columnsWord = [...touched].map(c => `'${c}'`).join(', ');
    const details = changed
        ? `${changed.toLocaleString()} value${changed === 1 ? '' : 's'} changed by hand${columnsWord ? ` in ${columnsWord}` : ''} (${usable.length} fix${usable.length === 1 ? '' : 'es'}).${skipped ? ` ${skipped} fix${skipped === 1 ? '' : 'es'} skipped: this file has no such column.` : ''}`
        : `Your ${usable.length} fix${usable.length === 1 ? '' : 'es'} found no matching rows in this file.${skipped ? ` ${skipped} skipped: this file has no such column.` : ''}`;
    return {
        rows: out,
        log: {
            step: 'Your Fixes', stepNumber: 5, status: changed ? 'applied' : 'info', timestamp: Date.now(), details,
            affectedColumns: [...touched], affectedRows: changed, transformSamples: samples,
            reason: 'You changed these values in View rows; they are changed the same way every time this file (or the next one, with a saved setup) is cleaned.',
            revert: { option: 'valueFixes', value: [] as any, label: 'Undo your fixes' },
        } as ETLLog,
    };
}

/** "Change 'menu category' where 'menu item' is 'Milk' and 'menu category' is 'Bakery' to 'Dairy'" */
export function describeFix(fix: ValueFix): string {
    const word = (s: string) => `'${s.replace(/_/g, ' ')}'`;
    const where = Object.entries(fix.where).map(([k, v]) => `${word(k)} is '${v}'`).join(' and ');
    return `Set ${word(fix.column)} to ${fix.to === null ? 'blank' : `'${fix.to}'`} where ${where}`;
}

/** Add fixes, replacing any earlier fix for the same column and rows. */
export function mergeFixes(existing: ValueFix[] = [], added: ValueFix[]): ValueFix[] {
    const key = (f: ValueFix) => `${f.column}|${fixKey(f.where)}`;
    const replaced = new Set(added.map(key));
    return [...existing.filter(f => !replaced.has(key(f))), ...added];
}
