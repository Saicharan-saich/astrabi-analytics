/**
 * What each sheet of a workbook is, before the sheets are linked:
 *
 *   One table split across sheets. Sheets with the same columns (Jan, Feb,
 *   Mar; 2024, 2025; Shop A, Shop B) are the same records cut into pieces, so
 *   they are put back together into one table, with a "sheet" column saying
 *   where each row came from. Otherwise "total sales" would cover one sheet.
 *   Not combined: sheets that are plans set against actuals (budget, target,
 *   forecast…), exact copies (used once), and sheets that share many
 *   identical rows (overlapping versions) — those would be counted twice.
 *
 *   Not records. A summary someone built from the data (a "Summary" or
 *   "Pivot" sheet, or a small sheet with a Total line) and written notes
 *   ("How to use this workbook") are kept for reference but are not linked,
 *   opened as the main view, or offered to AI SQL: figures are worked out
 *   from the records themselves.
 *
 * Worked out from headers, names and the shape of the values — never from a
 * particular file.
 */
import type { ETLLog, RelatedTable } from '../types';
import { isTotalLabel } from './etlHardening';

/** report: a summary made from the records; notes: written notes; copy: an exact copy of another sheet. */
export type SheetRole = 'report' | 'notes' | 'copy';

const headerKey = (name: string) => String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const columnsOf = (table: RelatedTable) => {
    const seen = new Set<string>();
    for (const column of table.columns || []) seen.add(column);
    for (const row of table.rows.slice(0, 500)) for (const column of Object.keys(row)) seen.add(column);
    return [...seen];
};
const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== '';
/** A column with no values at all is layout, not part of the record. */
const usedColumns = (table: RelatedTable) => columnsOf(table).filter(c => !/^__EMPTY/.test(c) && table.rows.some(r => filled(r[c])));

/** Plans and targets are set against actuals: adding them to the actuals would be wrong. */
const PLAN_WORD = /\b(budgets?|plans?|planned|targets?|forecasts?|projections?|projected|estimates?|goals?|quotas?|scenarios?|actuals?)\b/i;
/** Copies and old versions of a sheet. */
const COPY_WORD = /\b(copy|backup|old|archive|draft|v\d+)\b|\(\d+\)\s*$/i;
const REPORT_NAME = /\b(summary|summaries|pivot|dashboard|overview|report|totals|chart|charts|kpis?|scorecard)\b/i;
const NOTES_NAME = /\b(notes?|readme|read me|instructions?|how to|help|about|guide|info|cover)\b/i;

const rowKey = (row: Record<string, any>, columns: string[]) => JSON.stringify(columns.map(c => {
    const v = row[c];
    return v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v).trim();
}));

/** The words two or more sheet names share at the start ("Sales Jan", "Sales Feb" → "Sales"). */
function commonName(names: string[]): string {
    const words = names.map(n => n.trim().split(/[\s_-]+/));
    const common: string[] = [];
    for (let i = 0; i < words[0].length; i++) {
        if (words.every(w => w[i] && w[i].toLowerCase() === words[0][i].toLowerCase())) common.push(words[0][i]);
        else break;
    }
    return common.join(' ').trim();
}

export interface SheetPlan {
    tables: (RelatedTable & { sheetRole?: SheetRole })[];
    logs: ETLLog[];
    /** Sheets put back together, by the name of the combined table. */
    combined: { name: string; from: string[] }[];
    /** Sheets kept for reference only, and why. */
    leftOut: { name: string; role: SheetRole }[];
}

/** Written notes: one or two text columns of sentences, no numbers or dates. */
function looksLikeNotes(table: RelatedTable): boolean {
    const columns = usedColumns(table);
    if (!columns.length) return false;
    if (NOTES_NAME.test(table.name) && table.rows.length <= 200) {
        const numeric = table.rows.slice(0, 200).some(r => columns.some(c => typeof r[c] === 'number' || r[c] instanceof Date));
        if (!numeric) return true;
    }
    if (columns.length > 2) return false;
    const values = table.rows.slice(0, 200).flatMap(r => columns.map(c => r[c])).filter(filled);
    if (!values.length || values.some(v => typeof v === 'number' || v instanceof Date)) return false;
    const sentences = values.filter(v => String(v).trim().split(/\s+/).length >= 5).length;
    const headerSentence = columns.some(c => c.trim().split(/\s+/).length >= 4);
    return sentences >= values.length * 0.5 || (headerSentence && sentences >= values.length * 0.3);
}

/**
 * A summary built from other sheets: named like one, or a small sheet with a
 * Total line — and only when a larger sheet of records exists beside it.
 */
function looksLikeReport(table: RelatedTable, largest: number): boolean {
    if (table.rows.length * 3 > largest || table.rows.length > 500) return false;
    if (REPORT_NAME.test(table.name)) return true;
    const columns = usedColumns(table);
    const hasNumbers = table.rows.some(r => columns.some(c => typeof r[c] === 'number'));
    return hasNumbers && table.rows.some(r => columns.some(c => isTotalLabel(r[c])));
}

/** Sort the sheets out before cleaning: combine split tables, set aside summaries and notes. */
export function planWorkbookSheets(input: RelatedTable[]): SheetPlan {
    const logs: ETLLog[] = [];
    const now = Date.now();
    const log = (step: string, details: string, status: ETLLog['status'] = 'applied') => logs.push({ step, details, status, timestamp: now } as ETLLog);
    const leftOut: SheetPlan['leftOut'] = [];
    const combined: SheetPlan['combined'] = [];

    // Empty sheets keep their headings (a template still says what it would hold).
    let tables: (RelatedTable & { sheetRole?: SheetRole })[] = [...input];

    // ── Same columns → one table split across sheets ──
    const groups = new Map<string, RelatedTable[]>();
    for (const table of tables) {
        const columns = usedColumns(table).map(headerKey).filter(Boolean);
        if (columns.length < 2) continue;
        const key = [...new Set(columns)].sort().join('|');
        groups.set(key, [...(groups.get(key) || []), table]);
    }
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        if (group.some(t => PLAN_WORD.test(t.name))) {
            log('Plan Sheets Kept Apart', `${group.map(t => t.name).join(', ')} have the same columns, but plans or targets are set against actuals, so they were not added together.`, 'info');
            continue;
        }
        const columns = usedColumns(group[0]);
        const byKey = (t: RelatedTable) => {
            const map = new Map(usedColumns(t).map(c => [headerKey(c), c]));
            return columns.map(c => map.get(headerKey(c))!);
        };
        // Exact copies are used once; overlapping versions are not combined.
        const prints = group.map(t => { const own = byKey(t); return new Set(t.rows.map(r => rowKey(r, own))); });
        const keep: number[] = [];
        let overlapping = false;
        for (let i = 0; i < group.length; i++) {
            const copyOf = keep.find(k => prints[k].size === prints[i].size && [...prints[i]].every(x => prints[k].has(x)));
            if (copyOf !== undefined) {
                log('Copied Sheet', `${group[i].name} is an exact copy of ${group[copyOf].name}, so its rows were used once.`);
                leftOut.push({ name: group[i].name, role: 'copy' });
                tables = tables.map(t => t === group[i] ? { ...t, sheetRole: 'copy' as SheetRole } : t);
                continue;
            }
            for (const k of keep) {
                const shared = [...prints[i]].filter(x => prints[k].has(x)).length;
                if (shared >= Math.min(prints[i].size, prints[k].size) * 0.2 && shared >= 5) overlapping = true;
            }
            keep.push(i);
        }
        if (keep.length < 2) continue;
        const parts = keep.map(i => group[i]);
        if (overlapping || parts.some(t => COPY_WORD.test(t.name))) {
            log('Sheets Kept Apart', `${parts.map(t => t.name).join(', ')} have the same columns but share many identical rows (or one is a copy or an old version), so adding them together would count records twice. They were kept as separate sheets.`, 'info');
            continue;
        }
        const sheetColumn = columns.some(c => headerKey(c) === 'sheet') ? 'source_sheet' : 'sheet';
        const name = commonName(parts.map(t => t.name)) || parts.map(t => t.name).join(' + ');
        const rows: Record<string, any>[] = [];
        for (const part of parts) {
            const own = byKey(part);
            for (const row of part.rows) {
                if (!Object.values(row).some(filled)) continue;
                const record: Record<string, any> = { [sheetColumn]: part.name };
                columns.forEach((c, i) => { record[c] = row[own[i]] ?? null; });
                rows.push(record);
            }
        }
        const table = { name, rows, columns: [sheetColumn, ...columns] };
        tables = [...tables.filter(t => !parts.includes(t)), table];
        combined.push({ name, from: parts.map(t => t.name) });
        log('Sheets Combined', `${parts.map(t => t.name).join(', ')} have the same columns, so they are one table split across sheets. They were put back together (${rows.length.toLocaleString('en-GB')} rows), with a "${sheetColumn}" column saying which sheet each row came from.`);
    }

    // ── Summaries and notes are not records ──
    const records = tables.filter(t => !t.sheetRole && t.rows.length > 0);
    const largest = Math.max(0, ...records.map(t => t.rows.length));
    for (const table of records) {
        if (records.filter(t => !t.sheetRole).length <= 1) break; // the only sheet is always the data
        const role: SheetRole | null = looksLikeNotes(table) ? 'notes' : looksLikeReport(table, largest) ? 'report' : null;
        if (!role) continue;
        (table as any).sheetRole = role;
        leftOut.push({ name: table.name, role });
        log(role === 'notes' ? 'Notes Sheet' : 'Summary Sheet', role === 'notes'
            ? `${table.name} holds written notes, not records. It is kept for reference and not used for answers.`
            : `${table.name} looks like a summary made from the other sheets. Figures are worked out from the records themselves, so it is kept for reference and not used for answers.`, 'info');
    }
    return { tables, logs, combined, leftOut };
}

/** Sheets that hold records: not summaries, notes or copies, and not empty. */
export const recordSheets = <T extends { sheetRole?: SheetRole; rows: unknown[] }>(tables: T[]) => tables.filter(t => !t.sheetRole && t.rows.length > 0);
