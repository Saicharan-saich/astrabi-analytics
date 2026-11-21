/**
 * cleaningSteps.ts — recorded cleaning steps, replayed on every clean.
 *
 * A person cleans by adding steps (remove these rows, rename that column, fill
 * these blanks …). Steps name columns, never rows, so the same list runs on
 * next month's file. They run in order after the automatic cleaning, inside the
 * browser, and every step reports what it did in plain words. A step whose
 * column is not in the file is skipped and says so, rather than failing or
 * guessing.
 *
 * Pure: the same function runs in the cleaning worker (whole file) and in the
 * steps editor (a preview on the first rows).
 */

import { ColumnType, type CleaningStep, type ColumnDefinition, type ETLLog, type FilterOp, type StepKind } from '../types';
import { parseLocaleNumber } from './etlHardening';

type Row = Record<string, any>;

/** Another file loaded in the workspace, for the combine step (cleaned rows and columns). */
export interface StepTable { name: string; rows: Row[]; columns: ColumnDefinition[] }
/** What the steps can reach besides the table itself. */
export interface StepContext { tables?: StepTable[]; fileName?: string }

/** "Regions 2026.xlsx" → "Regions 2026". */
export const tableLabel = (name: string) => String(name || '').replace(/\.(csv|tsv|txt|xlsx|xlsm|xls|json|parquet)$/i, '').trim() || String(name || '');
const looseName = (name: string) => tableLabel(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
const looseColumn = (name: string) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The loaded file a combine step means: the same name first (ignoring the
 * extension, case and spacing), otherwise the file whose columns match best
 * (at least three in four), so next month's "regions_v2.csv" is still found.
 */
export function findStepTable(source: CleaningStep['source'], tables: StepTable[] = []): StepTable | null {
    if (!source) return null;
    const byName = tables.find(t => looseName(t.name) === looseName(source.name));
    if (byName) return byName;
    const want = new Set((source.headers || []).map(looseColumn));
    if (!want.size) return null;
    let best: StepTable | null = null, bestScore = 0;
    for (const t of tables) {
        const have = new Set(t.columns.map(c => looseColumn(c.name)));
        const shared = [...want].filter(h => have.has(h)).length;
        const score = shared / new Set([...want, ...have]).size;
        if (score > bestScore) { best = t; bestScore = score; }
    }
    return bestScore >= 0.75 ? best : null;
}

/** The step's record of a file: its name and columns, never its rows. */
export const sourceOf = (table: StepTable): NonNullable<CleaningStep['source']> => ({ name: table.name, headers: table.columns.map(c => c.name).filter(n => !n.startsWith('__')) });

export interface StepResult {
    id: string;
    /** Ran, was switched off, or could not run (a column is missing). */
    status: 'ran' | 'off' | 'skipped';
    /** "12 rows removed" / "Skipped: this file has no column 'region'". */
    text: string;
    rowsBefore: number;
    rowsAfter: number;
    /** Cells changed or filled. */
    changed: number;
    /** Columns the step touched or made (for highlighting). */
    columns: string[];
}

/* ── values ─────────────────────────────────────────────────────────── */

const isBlankValue = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
/** Categories show a blank as "Unknown" after the automatic cleaning; for steps it is still a blank. */
const isBlankIn = (column: ColumnDefinition | undefined, v: unknown) =>
    isBlankValue(v) || (column?.type === ColumnType.DIMENSION && v === 'Unknown');
export const toNumber = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean' || isBlankValue(v)) return null;
    return parseLocaleNumber(v as any);
};
const text = (v: unknown) => (isBlankValue(v) ? '' : String(v));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** "Order Month" → "order_month", unique among the columns. */
export function columnNameFor(wanted: string, columns: ColumnDefinition[], except?: string): string {
    const base = String(wanted || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'new_column';
    const taken = new Set(columns.map(c => c.name).filter(n => n !== except));
    let name = base, n = 2;
    while (taken.has(name)) name = `${base}_${n++}`;
    return name;
}

const physicalFor = (type: ColumnType): ColumnDefinition['physicalType'] =>
    type === ColumnType.METRIC ? 'number' : type === ColumnType.DATE ? 'date' : type === ColumnType.BOOLEAN ? 'boolean' : 'string';
const newColumn = (name: string, type: ColumnType): ColumnDefinition => ({ name, type, originalType: 'step', physicalType: physicalFor(type) });

/** The kind of a column a step made, from its values. */
function inferType(rows: Row[], name: string): ColumnType {
    let seen = 0, numbers = 0, dates = 0;
    for (const row of rows) {
        const v = row[name];
        if (isBlankValue(v)) continue;
        seen++;
        if (typeof v === 'number') numbers++;
        else if (typeof v === 'string' && ISO_DATE.test(v)) dates++;
        if (seen >= 500) break;
    }
    if (!seen) return ColumnType.DIMENSION;
    if (numbers === seen) return ColumnType.METRIC;
    if (dates === seen) return ColumnType.DATE;
    return ColumnType.DIMENSION;
}

const word = (column?: string) => `'${String(column || '').replace(/_/g, ' ')}'`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const list = (items: string[] = []) => items.map(word).join(', ');

/* ── plain descriptions ────────────────────────────────────────────── */

const OP_WORDS: Record<FilterOp, string> = {
    equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain',
    starts_with: 'starts with', ends_with: 'ends with', greater: 'is more than', greater_eq: 'is at least',
    less: 'is less than', less_eq: 'is at most', between: 'is between', blank: 'is blank', not_blank: 'is not blank', one_of: 'is one of',
};
const KIND_WORDS: Record<string, string> = { METRIC: 'a number', DIMENSION: 'a category', DATE: 'a date', ID: 'an identifier', BOOLEAN: 'yes/no' };
const FILL_WORDS: Record<string, string> = { zero: '0', down: 'the value above', up: 'the value below', average: 'the average', median: 'the middle value', most_common: 'the most common value' };
const PART_WORDS: Record<string, string> = { year: 'year', quarter: 'quarter', month: 'month', month_name: 'month name', year_month: 'year and month', week: 'week', weekday: 'day of the week', day: 'day of the month' };
const HOW_WORDS: Record<string, string> = { sum: 'total', average: 'average', count: 'count', min: 'lowest', max: 'highest', count_distinct: 'number of different' };
const PIVOT_WORDS: Record<string, string> = { sum: 'total of', average: 'average of', min: 'lowest', max: 'highest', first: 'first value of', count: 'number of rows' };
const OPERATOR_WORDS: Record<string, string> = { '+': '+', '-': '−', '*': '×', '/': '÷', pct_of: 'as a % of', pct_change: 'change % from' };

/** One plain sentence for a step, e.g. "Remove rows where 'region' is blank". */
export function describeStep(step: CleaningStep): string {
    switch (step.kind) {
        case 'filter_rows': {
            const value = step.op === 'blank' || step.op === 'not_blank' ? ''
                : step.op === 'between' ? ` ${step.value} and ${step.value2}` : step.op === 'one_of' ? ` ${step.value}` : ` '${step.value ?? ''}'`;
            return `${step.action === 'keep' ? 'Keep only rows' : 'Remove rows'} where ${word(step.column)} ${OP_WORDS[step.op || 'equals']}${value}`;
        }
        case 'remove_duplicates':
            return `Remove repeated rows${step.columns?.length ? ` (same ${list(step.columns)})` : ''}, keeping the ${step.keepCopy === 'last' ? 'last' : 'first'}`;
        case 'remove_columns': return `Remove ${step.columns?.length === 1 ? 'the column' : 'columns'} ${list(step.columns)}`;
        case 'keep_columns': return `Keep only the columns ${list(step.columns)}`;
        case 'rename_column': return `Rename ${word(step.column)} to '${step.to}'`;
        case 'change_type': return `Treat ${word(step.column)} as ${KIND_WORDS[step.to || ''] || step.to}`;
        case 'fill_blanks': return `Fill blank ${word(step.column)} with ${step.fill === 'value' ? `'${step.value ?? ''}'` : FILL_WORDS[step.fill || 'zero']}`;
        case 'find_replace': return `Replace ${step.wholeCell ? 'cells that are' : ''}'${step.find ?? ''}' with '${step.replace ?? ''}' in ${word(step.column)}`.replace("Replace cells that are'", "Replace cells that are '");
        case 'group_values': {
            const groups = step.groups || [];
            return groups.length === 1 ? `In ${word(step.column)}, count ${groups[0].from.map(v => `'${v}'`).join(', ')} as '${groups[0].to}'`
                : `Group values in ${word(step.column)} into ${plural(groups.length, 'group')}`;
        }
        case 'tidy_text': {
            const kase = step.textCase && step.textCase !== 'keep' ? `, ${({ upper: 'CAPITALS', lower: 'lower case', title: 'Title Case', sentence: 'Sentence case' } as any)[step.textCase]}` : '';
            return `Tidy text in ${list(step.columns)} (extra spaces${kase})`;
        }
        case 'round_numbers': return `Round ${word(step.column)} to ${plural(step.decimals ?? 0, 'decimal place')}`;
        case 'split_column': return `Split ${word(step.column)} at '${step.separator ?? ','}'${step.names?.length ? ` into ${list(step.names)}` : ''}`;
        case 'join_columns': return `Join ${list(step.columns)} into '${step.name}'`;
        case 'calculated_column': {
            const right = step.rightColumn ? word(step.rightColumn) : String(step.rightNumber ?? 0);
            return step.operator === 'pct_of' ? `New column '${step.name}' = ${word(step.column)} as a % of ${right}`
                : step.operator === 'pct_change' ? `New column '${step.name}' = % change from ${right} to ${word(step.column)}`
                    : `New column '${step.name}' = ${word(step.column)} ${OPERATOR_WORDS[step.operator || '+']} ${right}`;
        }
        case 'date_part': return `New column '${step.name}' = ${PART_WORDS[step.part || 'month']} of ${word(step.column)}`;
        case 'unpivot': return `Turn the columns ${list(step.columns)} into rows ('${step.to || 'label'}', '${step.name || 'value'}')`;
        case 'group_by': return `Total by ${list(step.groupBy)}: ${(step.totals || []).map(t => `${HOW_WORDS[t.how]} of ${word(t.column)}`).join(', ')}`;
        case 'pivot': return `Turn the values of ${word(step.column)} into columns, filled with ${step.how === 'count' ? 'the number of rows' : `the ${PIVOT_WORDS[step.how || 'sum']} ${word(step.valueColumn)}`}${step.groupBy ? (step.groupBy.length ? `, one row for each ${list(step.groupBy)}` : ', in a single row') : ''}`;
        case 'combine': {
            const other = `'${tableLabel(step.source?.name || 'another file')}'`;
            if (step.mode === 'match') return `Bring ${step.columns?.length ? list(step.columns) : 'columns'} from ${other}, matching ${word(step.column)} to ${word(step.rightColumn)}`;
            return `Add the rows of ${other} underneath`;
        }
        default: return 'A step';
    }
}

/** Every column a step reads (to report steps a new file cannot run). */
export function columnsOfStep(step: CleaningStep): string[] {
    // A combine step names the other file's columns too; only the key is in this one.
    if (step.kind === 'combine') return step.mode === 'match' && step.column ? [step.column] : [];
    const out = new Set<string>();
    if (step.valueColumn) out.add(step.valueColumn);
    if (step.column) out.add(step.column);
    for (const c of step.columns || []) out.add(c);
    if (step.rightColumn) out.add(step.rightColumn);
    for (const c of step.groupBy || []) out.add(c);
    for (const t of step.totals || []) if (t.column && t.how !== 'count') out.add(t.column);
    return [...out];
}

/* ── the steps ─────────────────────────────────────────────────────── */

function matches(op: FilterOp, cell: unknown, step: CleaningStep, column?: ColumnDefinition): boolean {
    if (op === 'blank') return isBlankIn(column, cell);
    if (op === 'not_blank') return !isBlankIn(column, cell);
    const value = step.value ?? '';
    const a = toNumber(cell), b = toNumber(value);
    const numeric = column?.type === ColumnType.METRIC || (a !== null && b !== null && typeof cell === 'number');
    const s = text(cell).trim().toLowerCase(), v = value.trim().toLowerCase();
    switch (op) {
        case 'equals': return numeric && a !== null && b !== null ? a === b : s === v;
        case 'not_equals': return numeric && a !== null && b !== null ? a !== b : s !== v;
        case 'contains': return s.includes(v);
        case 'not_contains': return !s.includes(v);
        case 'starts_with': return s.startsWith(v);
        case 'ends_with': return s.endsWith(v);
        case 'one_of': return value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean).includes(s);
        case 'greater': case 'greater_eq': case 'less': case 'less_eq': case 'between': {
            // Numbers compare as numbers; dates (YYYY-MM-DD) compare as text, which orders them correctly.
            const cmp = (x: unknown, y: string) => {
                const nx = toNumber(x), ny = toNumber(y);
                if (nx !== null && ny !== null && !(typeof x === 'string' && ISO_DATE.test(x))) return nx - ny;
                return text(x).localeCompare(y);
            };
            if (isBlankIn(column, cell)) return false;
            if (op === 'between') return cmp(cell, value) >= 0 && cmp(cell, step.value2 ?? '') <= 0;
            const c = cmp(cell, value);
            return op === 'greater' ? c > 0 : op === 'greater_eq' ? c >= 0 : op === 'less' ? c < 0 : c <= 0;
        }
        default: return false;
    }
}

function caseOf(s: string, kase?: CleaningStep['textCase']): string {
    if (kase === 'upper') return s.toUpperCase();
    if (kase === 'lower') return s.toLowerCase();
    if (kase === 'title') return s.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
    if (kase === 'sentence') return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    return s;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function datePart(value: unknown, part: NonNullable<CleaningStep['part']>): string | null {
    const s = text(value);
    if (!ISO_DATE.test(s)) return null;
    const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
    const pad = (n: number) => String(n).padStart(2, '0');
    switch (part) {
        case 'year': return String(y);
        case 'quarter': return `${y} Q${Math.ceil(m / 3)}`;
        case 'month': return pad(m);
        case 'month_name': return MONTHS.at(m - 1) || null;
        case 'year_month': return `${y}-${pad(m)}`;
        case 'day': return pad(d);
        case 'weekday': return DAYS.at(new Date(Date.UTC(y, m - 1, d)).getUTCDay()) || null;
        case 'week': {
            // ISO week number.
            const date = new Date(Date.UTC(y, m - 1, d));
            const day = date.getUTCDay() || 7;
            date.setUTCDate(date.getUTCDate() + 4 - day);
            const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
            const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
            return `${date.getUTCFullYear()}-W${pad(week)}`;
        }
        default: return null;
    }
}

interface Ran { rows: Row[]; columns: ColumnDefinition[]; changed: number; text: string; touched: string[]; removed?: Row[] }

function runOne(step: CleaningStep, rows: Row[], columns: ColumnDefinition[], context: StepContext = {}): Ran {
    const col = (name?: string) => columns.find(c => c.name === name);
    const c = col(step.column);
    const n = rows.length;
    switch (step.kind) {
        case 'filter_rows': {
            const removed: Row[] = [];
            const kept = rows.filter(row => {
                const hit = matches(step.op || 'equals', row[step.column!], step, c);
                const stay = step.action === 'keep' ? hit : !hit;
                if (!stay) removed.push(row);
                return stay;
            });
            return { rows: kept, columns, changed: 0, removed, touched: [step.column!], text: removed.length ? `${plural(removed.length, 'row')} removed` : 'No rows matched' };
        }
        case 'remove_duplicates': {
            const keys = step.columns?.length ? step.columns : columns.map(x => x.name);
            const keyOf = (row: Row) => JSON.stringify(keys.map(k => text(row[k]).trim().toLowerCase()));
            const order = step.keepCopy === 'last' ? [...rows].reverse() : rows;
            const seen = new Set<string>();
            const removed: Row[] = [];
            const kept = order.filter(row => {
                const k = keyOf(row);
                if (seen.has(k)) { removed.push(row); return false; }
                seen.add(k); return true;
            });
            return { rows: step.keepCopy === 'last' ? kept.reverse() : kept, columns, changed: 0, removed, touched: keys, text: removed.length ? `${plural(removed.length, 'repeated row')} removed` : 'No repeated rows' };
        }
        case 'remove_columns':
        case 'keep_columns': {
            const named = new Set(step.columns || []);
            const drop = new Set(columns.filter(x => (step.kind === 'remove_columns' ? named.has(x.name) : !named.has(x.name))).map(x => x.name));
            return {
                rows: rows.map(row => { const out: Row = {}; for (const k of Object.keys(row)) if (!drop.has(k)) out[k] = row[k]; return out; }),
                columns: columns.filter(x => !drop.has(x.name)), changed: 0, touched: [...drop],
                text: `${plural(drop.size, 'column')} removed`,
            };
        }
        case 'rename_column': {
            const to = columnNameFor(step.to || '', columns, step.column);
            if (to === step.column) return { rows, columns, changed: 0, touched: [to], text: 'Name unchanged' };
            return {
                rows: rows.map(row => { const out: Row = {}; for (const [k, v] of Object.entries(row)) out[k === step.column ? to : k] = v; return out; }),
                columns: columns.map(x => (x.name === step.column ? { ...x, name: to } : x)), changed: 0, touched: [to],
                text: `Now called '${to}'`,
            };
        }
        case 'change_type': {
            const type = (step.to as ColumnType) || ColumnType.DIMENSION;
            let changed = 0, unread = 0;
            const out = rows.map(row => {
                const v = row[step.column!];
                if (isBlankValue(v)) return row;
                let next: unknown = v;
                if (type === ColumnType.METRIC) { next = toNumber(v); if (next === null) unread++; }
                else if (type === ColumnType.DATE) {
                    const s = text(v).trim();
                    const parsed = ISO_DATE.test(s) ? s.slice(0, 10) : (() => { const t = Date.parse(s); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); })();
                    next = parsed; if (parsed === null) unread++;
                } else next = text(v);
                if (next !== v) { changed++; return { ...row, [step.column!]: next }; }
                return row;
            });
            return {
                rows: out, columns: columns.map(x => (x.name === step.column ? { ...x, type, physicalType: physicalFor(type) } : x)), changed, touched: [step.column!],
                text: `Now ${KIND_WORDS[type] || type}${unread ? `; ${plural(unread, 'value')} could not be read and became blank` : ''}`,
            };
        }
        case 'fill_blanks': {
            const name = step.column!;
            const numbers = rows.map(r => toNumber(r[name])).filter((x): x is number => x !== null && !isBlankIn(c, x));
            let fixed: unknown = null;
            if (step.fill === 'zero') fixed = 0;
            else if (step.fill === 'value') fixed = c?.type === ColumnType.METRIC ? toNumber(step.value) ?? step.value : step.value ?? '';
            else if (step.fill === 'average') fixed = numbers.length ? numbers.reduce((s, x) => s + x, 0) / numbers.length : null;
            else if (step.fill === 'median') { const s = [...numbers].sort((a, b) => a - b); fixed = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; }
            else if (step.fill === 'most_common') {
                const counts = new Map<string, { v: unknown; n: number }>();
                for (const r of rows) if (!isBlankIn(c, r[name])) { const k = text(r[name]); const e = counts.get(k) || { v: r[name], n: 0 }; e.n++; counts.set(k, e); }
                fixed = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.v ?? null;
            }
            let changed = 0;
            let out: Row[];
            if (step.fill === 'down' || step.fill === 'up') {
                out = rows.map(r => ({ ...r }));
                const order = step.fill === 'down' ? out : [...out].reverse();
                let last: unknown = null;
                for (const r of order) {
                    if (isBlankIn(c, r[name])) { if (last !== null) { r[name] = last; changed++; } }
                    else last = r[name];
                }
            } else {
                out = fixed === null ? rows : rows.map(r => (isBlankIn(c, r[name]) ? (changed++, { ...r, [name]: fixed }) : r));
            }
            return { rows: out, columns, changed, touched: [name], text: changed ? `${plural(changed, 'blank')} filled` : 'No blanks to fill' };
        }
        case 'find_replace': {
            const name = step.column!, find = step.find ?? '';
            if (!find) return { rows, columns, changed: 0, touched: [name], text: 'Nothing to find' };
            const flags = step.matchCase ? 'g' : 'gi';
            const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
            let changed = 0;
            const out = rows.map(r => {
                const v = r[name];
                if (isBlankValue(v)) return r;
                const s = String(v);
                let next: string;
                if (step.wholeCell) next = (step.matchCase ? s.trim() === find : s.trim().toLowerCase() === find.toLowerCase()) ? (step.replace ?? '') : s;
                else next = s.replace(pattern, step.replace ?? '');
                if (next === s) return r;
                changed++;
                const value = c?.type === ColumnType.METRIC ? toNumber(next) : next;
                return { ...r, [name]: value };
            });
            return { rows: out, columns, changed, touched: [name], text: changed ? `${plural(changed, 'cell')} changed` : 'No cells matched' };
        }
        case 'group_values': {
            const name = step.column!;
            const map = new Map<string, string>();
            for (const g of step.groups || []) for (const f of g.from) map.set(f.trim().toLowerCase(), g.to);
            let changed = 0;
            const out = rows.map(r => {
                const to = map.get(text(r[name]).trim().toLowerCase());
                if (to === undefined || r[name] === to) return r;
                changed++; return { ...r, [name]: to };
            });
            return { rows: out, columns, changed, touched: [name], text: changed ? `${plural(changed, 'cell')} grouped` : 'No cells matched' };
        }
        case 'tidy_text': {
            const names = (step.columns || []).filter(x => col(x));
            let changed = 0;
            const out = rows.map(r => {
                let next: Row | null = null;
                for (const name of names) {
                    const v = r[name];
                    if (typeof v !== 'string') continue;
                    const t = caseOf(v.replace(/\s+/g, ' ').trim(), step.textCase);
                    if (t !== v) { next = next || { ...r }; next[name] = t; changed++; }
                }
                return next || r;
            });
            return { rows: out, columns, changed, touched: names, text: changed ? `${plural(changed, 'cell')} tidied` : 'Already tidy' };
        }
        case 'round_numbers': {
            const name = step.column!, f = 10 ** Math.max(0, Math.min(6, step.decimals ?? 0));
            let changed = 0;
            const out = rows.map(r => {
                const v = toNumber(r[name]);
                if (v === null) return r;
                const next = Math.round(v * f) / f;
                if (next === r[name]) return r;
                changed++; return { ...r, [name]: next };
            });
            return { rows: out, columns, changed, touched: [name], text: changed ? `${plural(changed, 'value')} rounded` : 'Already rounded' };
        }
        case 'split_column': {
            const name = step.column!, sep = step.separator || ',';
            let parts = 0;
            const pieces = rows.map(r => { const p = isBlankValue(r[name]) ? [] : String(r[name]).split(sep).map(x => x.trim()); parts = Math.max(parts, p.length); return p; });
            parts = Math.min(Math.max(parts, 2), step.names?.length || 6);
            let made = columns;
            const names: string[] = [];
            for (let i = 0; i < parts; i++) {
                const nm = columnNameFor(step.names?.[i] || `${name}_${i + 1}`, made);
                names.push(nm); made = [...made, newColumn(nm, ColumnType.DIMENSION)];
            }
            const out = rows.map((r, i) => {
                const next: Row = { ...r };
                names.forEach((nm, j) => {
                    // The last column keeps whatever is left over.
                    const p = pieces[i];
                    const v = j === names.length - 1 ? p.slice(j).join(sep) : p[j];
                    next[nm] = v === undefined || v === '' ? null : v;
                });
                if (!step.keepOriginal) delete next[name];
                return next;
            });
            let cols = step.keepOriginal ? made : made.filter(x => x.name !== name);
            cols = cols.map(x => (names.includes(x.name) ? { ...x, type: inferType(out, x.name), physicalType: physicalFor(inferType(out, x.name)) } : x));
            return { rows: out, columns: cols, changed: rows.length, touched: names, text: `${plural(names.length, 'new column')}: ${names.join(', ')}` };
        }
        case 'join_columns': {
            const names = (step.columns || []).filter(x => col(x));
            const nm = columnNameFor(step.name || names.join('_'), columns);
            const sep = step.separator ?? ' ';
            const out = rows.map(r => {
                const joined = names.map(x => r[x]).filter(v => !isBlankValue(v) && v !== 'Unknown').map(String).join(sep);
                const next: Row = { ...r, [nm]: joined || null };
                if (step.keepOriginal === false) for (const x of names) delete next[x];
                return next;
            });
            const cols = [...(step.keepOriginal === false ? columns.filter(x => !names.includes(x.name)) : columns), newColumn(nm, ColumnType.DIMENSION)];
            return { rows: out, columns: cols, changed: rows.length, touched: [nm], text: `New column '${nm}'` };
        }
        case 'calculated_column': {
            const nm = columnNameFor(step.name || 'calculated', columns);
            let blanks = 0;
            const out = rows.map(r => {
                const a = toNumber(r[step.column!]);
                const b = step.rightColumn ? toNumber(r[step.rightColumn]) : (step.rightNumber ?? null);
                let v: number | null = null;
                if (a !== null && b !== null) {
                    switch (step.operator) {
                        case '+': v = a + b; break;
                        case '-': v = a - b; break;
                        case '*': v = a * b; break;
                        case '/': v = b === 0 ? null : a / b; break;
                        case 'pct_of': v = b === 0 ? null : (a / b) * 100; break;
                        case 'pct_change': v = b === 0 ? null : ((a - b) / Math.abs(b)) * 100; break;
                    }
                }
                if (v === null) blanks++;
                return { ...r, [nm]: v === null ? null : Math.round(v * 1e6) / 1e6 };
            });
            return { rows: out, columns: [...columns, newColumn(nm, ColumnType.METRIC)], changed: rows.length - blanks, touched: [nm], text: `New column '${nm}'${blanks ? `; ${plural(blanks, 'row')} left blank (a value missing or a division by 0)` : ''}` };
        }
        case 'date_part': {
            const nm = columnNameFor(step.name || `${step.column}_${step.part}`, columns);
            let made = 0;
            const out = rows.map(r => { const v = datePart(r[step.column!], step.part || 'month'); if (v !== null) made++; return { ...r, [nm]: v }; });
            return { rows: out, columns: [...columns, newColumn(nm, ColumnType.DIMENSION)], changed: made, touched: [nm], text: `New column '${nm}'` };
        }
        case 'unpivot': {
            const names = (step.columns || []).filter(x => col(x));
            const labelName = columnNameFor(step.to || 'label', columns.filter(x => !names.includes(x.name)));
            const valueName = columnNameFor(step.name || 'value', [...columns.filter(x => !names.includes(x.name)), newColumn(labelName, ColumnType.DIMENSION)]);
            const out: Row[] = [];
            for (const r of rows) {
                const base: Row = {};
                for (const [k, v] of Object.entries(r)) if (!names.includes(k)) base[k] = v;
                for (const x of names) out.push({ ...base, [labelName]: x.replace(/_/g, ' '), [valueName]: r[x] });
            }
            const valueType = inferType(out, valueName);
            const cols = [...columns.filter(x => !names.includes(x.name)), newColumn(labelName, ColumnType.DIMENSION), newColumn(valueName, valueType)];
            return { rows: out, columns: cols, changed: 0, touched: [labelName, valueName], text: `${plural(names.length, 'column')} turned into rows; ${plural(out.length, 'row')} now` };
        }
        case 'group_by': {
            const by = (step.groupBy || []).filter(x => col(x));
            const totals = (step.totals || []).filter(t => t.how === 'count' || col(t.column));
            const groups = new Map<string, Row[]>();
            for (const r of rows) {
                const k = JSON.stringify(by.map(x => r[x] ?? null));
                const g = groups.get(k);
                if (g) g.push(r); else groups.set(k, [r]);
            }
            let cols = columns.filter(x => by.includes(x.name));
            const names = totals.map(t => { const nm = columnNameFor(t.name || `${t.how}_${t.column}`, cols); cols = [...cols, newColumn(nm, ColumnType.METRIC)]; return nm; });
            const out: Row[] = [];
            for (const members of groups.values()) {
                const row: Row = {};
                for (const x of by) row[x] = members[0][x];
                totals.forEach((t, i) => {
                    const nums = members.map(m => toNumber(m[t.column])).filter((v): v is number => v !== null);
                    let v: number | null;
                    switch (t.how) {
                        case 'sum': v = nums.reduce((s, x) => s + x, 0); break;
                        case 'average': v = nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null; break;
                        case 'count': v = members.length; break;
                        case 'min': v = nums.length ? Math.min(...nums) : null; break;
                        case 'max': v = nums.length ? Math.max(...nums) : null; break;
                        case 'count_distinct': v = new Set(members.map(m => text(m[t.column])).filter(Boolean)).size; break;
                        default: v = null;
                    }
                    row[names.at(i)!] = v === null ? null : Math.round(v * 1e6) / 1e6;
                });
                out.push(row);
            }
            return { rows: out, columns: cols, changed: 0, touched: [...by, ...names], text: `${plural(n, 'row')} totalled into ${plural(out.length, 'row')}` };
        }
        case 'pivot': {
            const labelName = step.column!;
            const how = step.how || 'sum';
            // The value column is never a key, even when only counting rows.
            const valueName = step.valueColumn;
            // The columns that say which row a value belongs to. Steps saved before
            // this choice existed (no groupBy) keep every other column.
            const others = columns.filter(x => x.name !== labelName && x.name !== valueName && !x.name.startsWith('__'));
            const keys = step.groupBy ? others.filter(x => step.groupBy!.includes(x.name)) : others;
            const dropped = step.groupBy ? others.filter(x => !step.groupBy!.includes(x.name)).map(x => x.name) : [];
            const labels: string[] = [];
            const seenLabels = new Set<string>();
            const groups = new Map<string, { first: Row; cells: Map<string, unknown[]> }>();
            for (const r of rows) {
                const lab = isBlankIn(c, r[labelName]) ? 'blank' : text(r[labelName]).trim();
                if (!seenLabels.has(lab)) {
                    seenLabels.add(lab); labels.push(lab);
                    if (labels.length > MAX_PIVOT_COLUMNS) throw new Error(`${word(labelName)} has more than ${MAX_PIVOT_COLUMNS} different values, too many to turn into columns`);
                }
                const k = JSON.stringify(keys.map(x => r[x.name] ?? null));
                let g = groups.get(k);
                if (!g) { g = { first: r, cells: new Map() }; groups.set(k, g); }
                const list = g.cells.get(lab);
                const v = valueName && how !== 'count' ? r[valueName] : 1;
                if (list) list.push(v); else g.cells.set(lab, [v]);
            }
            let cols = keys.map(x => ({ ...x }));
            const names = labels.map(lab => { const nm = columnNameFor(lab, cols); cols = [...cols, newColumn(nm, ColumnType.METRIC)]; return nm; });
            const out: Row[] = [];
            for (const g of groups.values()) {
                const row: Row = {};
                for (const x of keys) row[x.name] = g.first[x.name];
                labels.forEach((lab, i) => {
                    const vals = g.cells.get(lab);
                    let v: unknown = null;
                    if (vals) {
                        if (how === 'count') v = vals.length;
                        else if (how === 'first') v = vals.find(x => !isBlankValue(x)) ?? null;
                        else {
                            const nums = vals.map(toNumber).filter((x): x is number => x !== null);
                            if (nums.length) {
                                const total = nums.reduce((a, b) => a + b, 0);
                                v = how === 'sum' ? total : how === 'average' ? total / nums.length : how === 'min' ? Math.min(...nums) : Math.max(...nums);
                                v = Math.round((v as number) * 1e6) / 1e6;
                            }
                        }
                    }
                    row[names[i]] = v;
                });
                out.push(row);
            }
            if (how === 'first') cols = cols.map(x => (names.includes(x.name) ? newColumn(x.name, inferType(out, x.name)) : x));
            const shown = names.slice(0, 4).map(word).join(', ') + (names.length > 4 ? ', …' : '');
            return { rows: out, columns: cols, changed: 0, touched: names, text: `${plural(n, 'row')} turned into ${plural(out.length, 'row')} with ${plural(names.length, 'new column')} (${shown})${dropped.length ? `; not kept: ${list(dropped.slice(0, 4))}${dropped.length > 4 ? ', …' : ''}` : ''}` };
        }
        case 'combine': {
            const other = findStepTable(step.source, context.tables)!;
            const otherLabel = `'${tableLabel(other.name)}'`;
            const otherCol = (name: string) => other.columns.find(x => x.name === name);
            if (step.mode === 'match') {
                const key = (v: unknown) => text(v).trim().toLowerCase();
                const theirKey = step.rightColumn!;
                const bring = (step.columns?.length ? step.columns : other.columns.map(x => x.name).filter(x => x !== theirKey && !x.startsWith('__'))).filter(x => otherCol(x));
                const lookup = new Map<string, Row>();
                let repeated = 0;
                for (const r of other.rows) {
                    const k = key(r[theirKey]);
                    if (!k) continue;
                    if (lookup.has(k)) repeated++; else lookup.set(k, r);
                }
                let cols = columns;
                const names = bring.map(x => { const nm = columnNameFor(x, cols); const from = otherCol(x)!; cols = [...cols, { ...from, name: nm, originalType: 'step' }]; return nm; });
                let matched = 0;
                const out = rows.map(r => {
                    const hit = lookup.get(key(r[step.column!]));
                    if (hit) matched++;
                    const row = { ...r };
                    bring.forEach((x, i) => { row[names[i]] = hit ? hit[x] ?? null : null; });
                    return row;
                });
                const missed = n - matched;
                return {
                    rows: out, columns: cols, changed: matched, touched: [step.column!, ...names],
                    text: `${plural(names.length, 'column')} brought from ${otherLabel}; ${matched.toLocaleString('en-GB')} of ${plural(n, 'row')} found a match${missed ? `, ${missed.toLocaleString('en-GB')} did not (left blank)` : ''}${repeated ? `. ${otherLabel} repeats ${plural(repeated, 'key')}; the first row for each is used, so no rows are doubled` : ''}`,
                };
            }
            // Append: line the other file's columns up with these by name.
            const mine = new Map(columns.map(x => [looseColumn(x.name), x]));
            const mapping = new Map<string, string>();
            let cols = columns;
            const onlyThere: string[] = [];
            for (const x of other.columns) {
                if (x.name.startsWith('__')) continue;
                const here = mine.get(looseColumn(x.name));
                if (here) mapping.set(x.name, here.name);
                else { const nm = columnNameFor(x.name, cols); cols = [...cols, { ...x, name: nm, originalType: 'step' }]; mapping.set(x.name, nm); onlyThere.push(nm); }
            }
            const covered = new Set(mapping.values());
            const onlyHere = columns.filter(x => !covered.has(x.name) && !x.name.startsWith('__')).map(x => x.name);
            const typeOf = new Map(cols.map(x => [x.name, x.type]));
            const label = step.name ? columnNameFor(step.name, cols) : '';
            if (label) cols = [...cols, newColumn(label, ColumnType.DIMENSION)];
            const thisLabel = tableLabel(context.fileName || 'this file');
            const out: Row[] = rows.map(r => {
                const row: Row = { ...r };
                for (const nm of onlyThere) row[nm] = null;
                if (label) row[label] = thisLabel;
                return row;
            });
            for (const r of other.rows) {
                const row: Row = {};
                for (const x of cols) row[x.name] = null;
                for (const [from, to] of mapping) {
                    const v = r[from];
                    row[to] = typeOf.get(to) === ColumnType.METRIC && typeof v !== 'number' ? toNumber(v) : v ?? null;
                }
                if (label) row[label] = tableLabel(other.name);
                out.push(row);
            }
            const notes = [
                onlyThere.length ? `${plural(onlyThere.length, 'column')} only in ${otherLabel} (${list(onlyThere.slice(0, 4))}${onlyThere.length > 4 ? ', …' : ''}), blank for this file's rows` : '',
                onlyHere.length ? `${plural(onlyHere.length, 'column')} not in ${otherLabel} (${list(onlyHere.slice(0, 4))}${onlyHere.length > 4 ? ', …' : ''}), blank for its rows` : '',
            ].filter(Boolean);
            return { rows: out, columns: cols, changed: 0, touched: [...onlyThere, ...(label ? [label] : [])], text: `${plural(other.rows.length, 'row')} added from ${otherLabel}; ${plural(out.length, 'row')} now${notes.length ? `. ${notes.join('; ')}` : ''}` };
        }
        default:
            return { rows, columns, changed: 0, touched: [], text: 'Unknown step' };
    }
}

/** Columns a step needs that this table does not have. */
function missingFor(step: CleaningStep, columns: ColumnDefinition[]): string[] {
    const have = new Set(columns.map(c => c.name));
    return columnsOfStep(step).filter(c => !have.has(c));
}

/** Why a combine step cannot run here (the other file is not loaded, or lacks its key). */
function combineProblem(step: CleaningStep, context: StepContext): string {
    if (step.kind !== 'combine') return '';
    const name = `'${tableLabel(step.source?.name || 'the other file')}'`;
    const other = findStepTable(step.source, context.tables);
    if (!other) return `Skipped: the file ${name} is not loaded. Upload it too, then clean again`;
    if (step.mode === 'match' && !other.columns.some(c => c.name === step.rightColumn)) return `Skipped: the file ${name} has no column ${word(step.rightColumn)}`;
    return '';
}

/** Run the steps in order. Each step logs what it did, in plain words. */
export function applySteps(rows: Row[], columns: ColumnDefinition[], steps: CleaningStep[] = [], context: StepContext = {}): { rows: Row[]; columns: ColumnDefinition[]; logs: ETLLog[]; results: StepResult[] } {
    const logs: ETLLog[] = [];
    const results: StepResult[] = [];
    let current = rows, cols = columns;
    steps.forEach((step, index) => {
        const what = describeStep(step);
        const before = current.length;
        if (step.off) {
            results.push({ id: step.id, status: 'off', text: 'Switched off', rowsBefore: before, rowsAfter: before, changed: 0, columns: [] });
            return;
        }
        const missing = missingFor(step, cols);
        const notLoaded = missing.length ? '' : combineProblem(step, context);
        if (missing.length || notLoaded) {
            const why = notLoaded || `Skipped: this file has no column ${list(missing)}`;
            results.push({ id: step.id, status: 'skipped', text: why, rowsBefore: before, rowsAfter: before, changed: 0, columns: [] });
            logs.push({ step: 'Your Step', stepNumber: 6, status: 'info', timestamp: Date.now(), details: `Step ${index + 1}, "${what}": ${why.toLowerCase()}.`, affectedColumns: missing, ...(step.note ? { reason: step.note } : {}) });
            return;
        }
        let ran: Ran;
        try { ran = runOne(step, current, cols, context); }
        catch (error: any) {
            const why = `Could not run: ${error?.message || 'unexpected value'}`;
            results.push({ id: step.id, status: 'skipped', text: why, rowsBefore: before, rowsAfter: before, changed: 0, columns: [] });
            logs.push({ step: 'Your Step', stepNumber: 6, status: 'info', timestamp: Date.now(), details: `Step ${index + 1}, "${what}": ${why.toLowerCase()}.` });
            return;
        }
        current = ran.rows; cols = ran.columns;
        results.push({ id: step.id, status: 'ran', text: ran.text, rowsBefore: before, rowsAfter: current.length, changed: ran.changed, columns: ran.touched });
        logs.push({
            step: 'Your Step', stepNumber: 6, status: 'applied', timestamp: Date.now(),
            details: `Step ${index + 1}, "${what}": ${ran.text}.`,
            affectedColumns: ran.touched, affectedRows: ran.changed || undefined,
            ...(before !== current.length ? { rowsBefore: before, rowsAfter: current.length } : {}),
            ...(ran.removed?.length ? { removedRowSamples: ran.removed.slice(0, 10) } : {}),
            ...(step.note ? { reason: step.note } : {}),
        });
    });
    return { rows: current, columns: cols, logs, results };
}

/** The step kinds, grouped and named for the editor. */
export const STEP_GROUPS: { title: string; kinds: { kind: StepKind; label: string; hint: string }[] }[] = [
    { title: 'Rows', kinds: [
        { kind: 'filter_rows', label: 'Keep or remove rows', hint: 'By a condition, e.g. remove test orders or rows with no region' },
        { kind: 'remove_duplicates', label: 'Remove repeated rows', hint: 'Rows that repeat on all or some columns' },
    ] },
    { title: 'Columns', kinds: [
        { kind: 'remove_columns', label: 'Remove columns', hint: 'Columns you never need' },
        { kind: 'keep_columns', label: 'Keep only some columns', hint: 'Everything else is removed' },
        { kind: 'rename_column', label: 'Rename a column', hint: 'A clearer name for answers and charts' },
        { kind: 'change_type', label: 'Change what a column is', hint: 'Number, category, date, yes/no or identifier' },
        { kind: 'split_column', label: 'Split a column', hint: 'e.g. "Smith, John" into two columns' },
        { kind: 'join_columns', label: 'Join columns', hint: 'e.g. first and last name into one' },
    ] },
    { title: 'Values', kinds: [
        { kind: 'fill_blanks', label: 'Fill blank cells', hint: 'With 0, a value, the value above, or the average' },
        { kind: 'find_replace', label: 'Find and replace', hint: 'Fix a word or code everywhere in a column' },
        { kind: 'group_values', label: 'Group values', hint: 'e.g. "N. West" and "NW" become "North West"' },
        { kind: 'tidy_text', label: 'Tidy text', hint: 'Extra spaces and consistent capitals' },
        { kind: 'round_numbers', label: 'Round numbers', hint: 'To a number of decimal places' },
    ] },
    { title: 'New columns', kinds: [
        { kind: 'calculated_column', label: 'Calculate a column', hint: 'e.g. profit = revenue − cost' },
        { kind: 'date_part', label: 'Take part of a date', hint: 'Year, quarter, month, week or weekday' },
    ] },
    { title: 'Reshape', kinds: [
        { kind: 'unpivot', label: 'Turn columns into rows', hint: 'One column per month → a month column and a value column' },
        { kind: 'pivot', label: 'Turn rows into columns', hint: 'A month column and a value column → one column per month' },
        { kind: 'group_by', label: 'Group and total', hint: 'One row per group; changes what a row means' },
    ] },
    { title: 'Other files', kinds: [
        { kind: 'combine', label: 'Combine with another file', hint: 'Add its rows underneath, or bring its columns across by a matching column' },
    ] },
];

const MAX_PIVOT_COLUMNS = 100;
const newId = () => `step_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** A new step of a kind, with sensible defaults for this table. */
export function newStep(kind: StepKind, columns: ColumnDefinition[]): CleaningStep {
    const first = (type?: ColumnType) => (columns.find(c => !type || c.type === type) || columns[0])?.name;
    const step: CleaningStep = { id: newId(), kind };
    switch (kind) {
        case 'filter_rows': Object.assign(step, { column: first(ColumnType.DIMENSION), op: 'blank', action: 'remove' }); break;
        case 'remove_duplicates': Object.assign(step, { columns: [], keepCopy: 'first' }); break;
        case 'remove_columns': case 'keep_columns': Object.assign(step, { columns: [] }); break;
        case 'rename_column': Object.assign(step, { column: first(), to: '' }); break;
        case 'change_type': Object.assign(step, { column: first(), to: ColumnType.DIMENSION }); break;
        case 'fill_blanks': Object.assign(step, { column: first(ColumnType.METRIC), fill: 'zero' }); break;
        case 'find_replace': Object.assign(step, { column: first(ColumnType.DIMENSION), find: '', replace: '', wholeCell: false }); break;
        case 'group_values': Object.assign(step, { column: first(ColumnType.DIMENSION), groups: [{ from: [], to: '' }] }); break;
        case 'tidy_text': Object.assign(step, { columns: columns.filter(c => c.type === ColumnType.DIMENSION).map(c => c.name), textCase: 'keep' }); break;
        case 'round_numbers': Object.assign(step, { column: first(ColumnType.METRIC), decimals: 2 }); break;
        case 'split_column': Object.assign(step, { column: first(ColumnType.DIMENSION), separator: ',', names: [], keepOriginal: false }); break;
        case 'join_columns': Object.assign(step, { columns: [], separator: ' ', name: '', keepOriginal: true }); break;
        case 'calculated_column': Object.assign(step, { column: first(ColumnType.METRIC), operator: '-', rightColumn: columns.filter(c => c.type === ColumnType.METRIC)[1]?.name, name: '' }); break;
        case 'date_part': Object.assign(step, { column: first(ColumnType.DATE), part: 'month_name', name: '' }); break;
        case 'unpivot': Object.assign(step, { columns: [], to: 'month', name: 'value' }); break;
        case 'group_by': Object.assign(step, { groupBy: [first(ColumnType.DIMENSION)].filter(Boolean), totals: [{ column: first(ColumnType.METRIC) || '', how: 'sum', name: '' }] }); break;
        case 'pivot': {
            // One row per remaining category or date; identifiers and numbers are left out.
            const label = first(ColumnType.DIMENSION);
            Object.assign(step, { column: label, valueColumn: first(ColumnType.METRIC), how: 'sum', groupBy: columns.filter(c => (c.type === ColumnType.DIMENSION || c.type === ColumnType.DATE) && c.name !== label && !c.name.startsWith('__')).map(c => c.name) });
            break;
        }
        case 'combine': Object.assign(step, { mode: 'append', columns: [], name: '' }); break;
    }
    return step;
}

/** What is still needed before a step can be added (empty = ready). */
export function stepProblem(step: CleaningStep): string {
    const need = (ok: unknown, msg: string) => (ok ? '' : msg);
    switch (step.kind) {
        case 'filter_rows': return need(step.column, 'Pick a column') || need(step.op === 'blank' || step.op === 'not_blank' || (step.value ?? '').trim(), 'Type a value') || need(step.op !== 'between' || (step.value2 ?? '').trim(), 'Type the second value');
        case 'remove_columns': case 'keep_columns': return need(step.columns?.length, 'Pick at least one column');
        case 'rename_column': return need(step.column, 'Pick a column') || need((step.to ?? '').trim(), 'Type the new name');
        case 'fill_blanks': return need(step.column, 'Pick a column') || need(step.fill !== 'value' || (step.value ?? '') !== '', 'Type the value to fill in');
        case 'find_replace': return need(step.column, 'Pick a column') || need((step.find ?? '') !== '', 'Type what to find');
        case 'group_values': return need(step.column, 'Pick a column') || need((step.groups || []).some(g => g.from.length && g.to.trim()), 'Pick the values and the name to group them under');
        case 'tidy_text': return need(step.columns?.length, 'Pick at least one column');
        case 'split_column': return need(step.column, 'Pick a column') || need(step.separator, 'Type what to split at');
        case 'join_columns': return need((step.columns?.length || 0) >= 2, 'Pick two or more columns') || need((step.name ?? '').trim(), 'Name the new column');
        case 'calculated_column': return need(step.column, 'Pick a column') || need(step.rightColumn || step.rightNumber !== undefined, 'Pick a second column or type a number') || need((step.name ?? '').trim(), 'Name the new column');
        case 'date_part': return need(step.column, 'Pick a date column') || need((step.name ?? '').trim(), 'Name the new column');
        case 'unpivot': return need((step.columns?.length || 0) >= 2, 'Pick two or more columns');
        case 'group_by': return need(step.groupBy?.length, 'Pick what to group by') || need((step.totals || []).length, 'Add a total');
        case 'pivot': return need(step.column, 'Pick the column whose values become columns') || need(step.how === 'count' || step.valueColumn, 'Pick the column with the values') || need(step.column !== step.valueColumn, 'Pick two different columns');
        case 'combine': return need(step.source, 'Pick the other file') || need(step.mode !== 'match' || step.column, 'Pick the matching column in this file') || need(step.mode !== 'match' || step.rightColumn, 'Pick the matching column in the other file');
        default: return '';
    }
}
