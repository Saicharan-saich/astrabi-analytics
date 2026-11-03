/**
 * Data-quality checks beyond the core clean-up: the problems BI tools look
 * for (Power Query / Tableau Prep profiling, Great Expectations / dbt tests)
 * that a spreadsheet upload can carry.
 *
 * Every check either fixes something that is unambiguous (with an undo), or
 * FLAGS the affected rows and offers the user a decision — keep, remove, or a
 * specific fix. Decisions are stored in the cleaning options, so the same
 * file cleans the same way on every re-run. Nothing here guesses silently.
 *
 * Two checks need no rule written in advance:
 *  - "Unusual rows": rows that are rare in two or more ways at once.
 *  - Custom rules: an analyst writes a rule once (e.g. price > 0) and it is
 *    applied on every re-run — how a new kind of problem is handled forever.
 */
import { ColumnType, type ColumnDefinition, type ETLLog, type EtlOptions, type CleaningRule } from '../types';
import { parseNumberWithUnit } from './etlHardening';

type Row = Record<string, any>;
export type FlagChoice = 'keep' | 'remove' | 'fix';

const now = () => Date.now();
const entry = (step: string, status: ETLLog['status'], details: string, extra: Partial<ETLLog> = {}): ETLLog =>
    ({ step, stepNumber: 6, status, details, timestamp: now(), ...extra });

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const quote = (v: unknown) => `'${String(v)}'`;

// ── The decision scaffold every flag uses ────────────────────────────

interface FlagSpec {
    /** Stable key for the decision, e.g. "format:postcode". */
    key: string;
    /** Base step name, e.g. "Invalid Format". The flag is "<base> Flag". */
    base: string;
    column: string;
    columns?: string[];
    /** Rows this flag is about. */
    hits: Set<Row>;
    details: string;
    /** Choices offered, in order; 'keep' is always offered. */
    options: { choice: FlagChoice; label: string }[];
    /** For 'fix': the corrected row. */
    fix?: (row: Row) => Row;
    /** Plain words for the applied result, e.g. "cleared 3 invalid emails". */
    fixedWords?: string;
}

function undoValue(decisions: Record<string, FlagChoice>, key: string) {
    const { [key]: _gone, ...rest } = decisions;
    return Object.keys(rest).length ? rest : null;
}

/** Apply the user's decision on a flag (or raise the flag). */
function applyFlag(rows: Row[], spec: FlagSpec, decisions: Record<string, FlagChoice>, logs: ETLLog[]): Row[] {
    if (spec.hits.size === 0) return rows;
    const choice = decisions[spec.key];
    const affectedColumns = spec.columns || [spec.column];
    const samples = [...spec.hits].slice(0, 5);
    const undo = { option: 'flagDecisions' as const, value: undoValue(decisions, spec.key) as any, label: 'Review again' };
    if (choice === 'remove') {
        const before = rows.length;
        const kept = rows.filter(row => !spec.hits.has(row));
        logs.push(entry(`${spec.base} Rows Removed`, 'applied',
            `${spec.details} You chose to remove ${plural(before - kept.length, 'row')}.`,
            { affectedColumns, rowsBefore: before, rowsAfter: kept.length, removedRowSamples: samples, revert: { ...undo, label: 'Put these rows back' } }));
        return kept;
    }
    if (choice === 'fix' && spec.fix) {
        const transformSamples: { column: string; before: unknown; after: unknown }[] = [];
        let changed = 0;
        const fixed = rows.map(row => {
            if (!spec.hits.has(row)) return row;
            const next = spec.fix!(row);
            changed++;
            if (transformSamples.length < 6) transformSamples.push({ column: spec.column, before: row[spec.column], after: next[spec.column] });
            return next;
        });
        logs.push(entry(`${spec.base} Fixed`, 'applied',
            `${spec.details} You chose to fix them: ${spec.fixedWords || `${plural(changed, 'value')} corrected`}.`,
            { affectedColumns, affectedRows: changed, transformSamples, revert: { ...undo, label: 'Undo this fix' } }));
        return fixed;
    }
    if (choice === 'keep') {
        logs.push(entry(`${spec.base} Confirmed`, 'applied', `${spec.details} You checked them and kept them as they are.`,
            { affectedColumns, affectedRows: spec.hits.size, revert: undo }));
        return rows;
    }
    logs.push(entry(`${spec.base} Flag`, 'info', spec.details, {
        affectedColumns, affectedRows: spec.hits.size, sampleRows: samples,
        decision: { kind: 'flag', column: spec.column, key: spec.key, options: spec.options },
    }));
    return rows;
}

// ── 1. Mixed units: convert within one family, flag across families ──

const UNIT_FAMILIES: Record<string, { family: string; toBase: number; name: string }> = {
    mg: { family: 'mass', toBase: 0.001, name: 'mg' }, g: { family: 'mass', toBase: 1, name: 'g' }, gram: { family: 'mass', toBase: 1, name: 'g' }, grams: { family: 'mass', toBase: 1, name: 'g' },
    kg: { family: 'mass', toBase: 1000, name: 'kg' }, kgs: { family: 'mass', toBase: 1000, name: 'kg' }, kilo: { family: 'mass', toBase: 1000, name: 'kg' }, kilos: { family: 'mass', toBase: 1000, name: 'kg' },
    t: { family: 'mass', toBase: 1e6, name: 'tonnes' }, tonne: { family: 'mass', toBase: 1e6, name: 'tonnes' }, tonnes: { family: 'mass', toBase: 1e6, name: 'tonnes' },
    lb: { family: 'mass', toBase: 453.592, name: 'lb' }, lbs: { family: 'mass', toBase: 453.592, name: 'lb' }, oz: { family: 'mass', toBase: 28.3495, name: 'oz' },
    mm: { family: 'length', toBase: 0.001, name: 'mm' }, cm: { family: 'length', toBase: 0.01, name: 'cm' }, km: { family: 'length', toBase: 1000, name: 'km' },
    in: { family: 'length', toBase: 0.0254, name: 'in' }, inch: { family: 'length', toBase: 0.0254, name: 'in' }, inches: { family: 'length', toBase: 0.0254, name: 'in' },
    ft: { family: 'length', toBase: 0.3048, name: 'ft' }, mi: { family: 'length', toBase: 1609.344, name: 'miles' }, mile: { family: 'length', toBase: 1609.344, name: 'miles' }, miles: { family: 'length', toBase: 1609.344, name: 'miles' },
    ml: { family: 'volume', toBase: 0.001, name: 'ml' }, l: { family: 'volume', toBase: 1, name: 'litres' }, litre: { family: 'volume', toBase: 1, name: 'litres' }, litres: { family: 'volume', toBase: 1, name: 'litres' }, liter: { family: 'volume', toBase: 1, name: 'litres' }, liters: { family: 'volume', toBase: 1, name: 'litres' },
    kb: { family: 'data', toBase: 1, name: 'KB' }, mb: { family: 'data', toBase: 1024, name: 'MB' }, gb: { family: 'data', toBase: 1048576, name: 'GB' }, tb: { family: 'data', toBase: 1073741824, name: 'TB' },
};

export function convertMixedUnits(rows: Row[], sourceRows: Row[], columns: ColumnDefinition[], opts: EtlOptions, logs: ETLLog[]): Row[] {
    if (sourceRows.length !== rows.length) return rows;
    let out = rows;
    for (const c of columns.filter(col => col.type === ColumnType.METRIC)) {
        const parsed = sourceRows.map(row => parseNumberWithUnit(row[c.name]));
        const units = new Map<string, number>();
        for (const p of parsed) if (p?.unit) units.set(p.unit, (units.get(p.unit) || 0) + 1);
        if (units.size < 2) continue;
        const known = [...units.keys()].map(unit => UNIT_FAMILIES[unit]);
        const families = new Set(known.map(k => k?.family || 'unknown'));
        const listing = [...units.entries()].map(([unit, n]) => `${unit} (${n})`).join(', ');
        if (families.size !== 1 || families.has('unknown')) {
            logs.push(entry('Mixed Units Flag', 'info',
                `Column '${c.name}' mixes units that cannot be converted into each other (${listing}). Totals and averages of this column add different things together.`,
                { affectedColumns: [c.name] }));
            continue;
        }
        const target = [...units.entries()].sort((a, b) => b[1] - a[1])[0][0];
        if (opts.keepMixedUnits) {
            logs.push(entry('Kept As Uploaded', 'info', `Column '${c.name}': mixed units (${listing}) were left unconverted, as you chose.`,
                { affectedColumns: [c.name], revert: { option: 'keepMixedUnits', value: null, label: 'Convert them' } }));
            continue;
        }
        const factor = UNIT_FAMILIES[target].toBase;
        let changed = 0;
        const samples: { column: string; before: unknown; after: unknown }[] = [];
        out = out.map((row, index) => {
            const p = parsed[index];
            if (!p?.unit || p.unit === target) return row;
            const info = UNIT_FAMILIES[p.unit];
            const value = Math.round((p.value * info.toBase / factor) * 1e6) / 1e6;
            changed++;
            if (samples.length < 6) samples.push({ column: c.name, before: sourceRows[index][c.name], after: `${value} ${UNIT_FAMILIES[target].name}` });
            return { ...row, [c.name]: value };
        });
        logs.push(entry('Mixed Units Converted', 'applied',
            `Column '${c.name}' mixed ${listing}. Converted ${plural(changed, 'value')} to ${UNIT_FAMILIES[target].name}, the most common unit, so totals add like with like.`,
            { affectedColumns: [c.name], affectedRows: changed, transformSamples: samples, revert: { option: 'keepMixedUnits', value: true, label: 'Leave units as written' } }));
    }
    return out;
}

// ── 2. Format consistency: one odd shape in a column of codes ────────

/** "SW1A 1AA" → "A9A 9A": letters, digits and punctuation, runs collapsed. */
export function shapeOf(value: unknown): string {
    return String(value).trim()
        .replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '9')
        .replace(/(A)\1+/g, '$1').replace(/(a)\1+/g, '$1').replace(/(9)\1+/g, '$1');
}

function formatConsistency(rows: Row[], columns: ColumnDefinition[], decisions: Record<string, FlagChoice>, logs: ETLLog[]): Row[] {
    let out = rows;
    for (const c of columns.filter(col => col.type === ColumnType.DIMENSION || col.type === ColumnType.ID)) {
        if (FORMATS.some(format => format.test.test(c.name))) continue; // checked against its real format instead
        const filled = out.filter(row => !isBlank(row[c.name]));
        if (filled.length < 50) continue;
        const avgLength = filled.reduce((sum, row) => sum + String(row[c.name]).length, 0) / filled.length;
        if (avgLength > 24) continue;
        const shapes = new Map<string, number>();
        for (const row of filled) { const s = shapeOf(row[c.name]); shapes.set(s, (shapes.get(s) || 0) + 1); }
        const [topShape, topCount] = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0];
        if (topCount / filled.length < 0.9 || !/9/.test(topShape)) continue; // codes, not free words
        const rare = new Set([...shapes.entries()].filter(([, n]) => n / filled.length < 0.01).map(([s]) => s));
        const hits = new Set(filled.filter(row => rare.has(shapeOf(row[c.name]))));
        if (!hits.size || hits.size > filled.length * 0.05) continue;
        const example = [...hits].slice(0, 3).map(row => quote(row[c.name])).join(', ');
        out = applyFlag(out, {
            key: `format:${c.name}`, base: 'Format Inconsistency', column: c.name, hits,
            details: `Column '${c.name}': ${plural(hits.size, 'value')} ${hits.size === 1 ? "doesn't" : "don't"} follow the format of the other ${(filled.length - hits.size).toLocaleString()} (e.g. ${example}). They may be typing mistakes.`,
            options: [{ choice: 'keep', label: 'Values are correct' }, { choice: 'remove', label: 'Remove these rows' }, { choice: 'fix', label: 'Clear these values' }],
            fix: row => ({ ...row, [c.name]: null }), fixedWords: `${plural(hits.size, 'value')} set to blank`,
        }, decisions, logs);
    }
    return out;
}

// ── 3. Standard formats: email, UK postcode, phone, web address ──────

const FORMATS: { test: RegExp; name: string; valid: (v: string) => boolean; minValidShare?: number }[] = [
    { test: /e-?mail/i, name: 'email address', valid: v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) },
    { test: /post_?code|postal_?code/i, name: 'UK postcode', valid: v => /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(v), minValidShare: 0.8 },
    { test: /phone|mobile|telephone|^tel$|_tel$/i, name: 'phone number', valid: v => { const d = v.replace(/[^\d]/g, ''); return d.length >= 7 && d.length <= 15 && /^[\d\s()+.-]+$/.test(v) && !/(\d)\1{6,}/.test(d); } },
    { test: /website|url|web_?address|homepage/i, name: 'web address', valid: v => /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(v) },
];

function standardFormats(rows: Row[], columns: ColumnDefinition[], decisions: Record<string, FlagChoice>, logs: ETLLog[]): Row[] {
    let out = rows;
    for (const c of columns) {
        const format = FORMATS.find(f => f.test.test(c.name));
        if (!format) continue;
        const filled = out.filter(row => !isBlank(row[c.name]));
        if (filled.length < 5) continue;
        const hits = new Set(filled.filter(row => !format.valid(String(row[c.name]).trim())));
        const validShare = 1 - hits.size / filled.length;
        if (!hits.size || validShare < (format.minValidShare ?? 0.7)) continue;
        const example = [...hits].slice(0, 3).map(row => quote(row[c.name])).join(', ');
        out = applyFlag(out, {
            key: `valid:${c.name}`, base: 'Invalid Format', column: c.name, hits,
            details: `Column '${c.name}': ${plural(hits.size, 'value')} ${hits.size === 1 ? "doesn't" : "don't"} look like a valid ${format.name} (e.g. ${example}).`,
            options: [{ choice: 'keep', label: 'Keep them' }, { choice: 'fix', label: 'Clear the invalid values' }, { choice: 'remove', label: 'Remove these rows' }],
            fix: row => ({ ...row, [c.name]: null }), fixedWords: `${plural(hits.size, 'invalid value')} set to blank`,
        }, decisions, logs);
    }
    return out;
}

// ── 4. Inconsistent mappings: one product filed under two categories ──

function inconsistentMappings(rows: Row[], columns: ColumnDefinition[], decisions: Record<string, FlagChoice>, logs: ETLLog[]): Row[] {
    let out = rows;
    const dims = columns.filter(c => c.type === ColumnType.DIMENSION).map(c => c.name).slice(0, 14);
    if (out.length < 30 || dims.length < 2) return out;
    const distinct = new Map(dims.map(name => [name, new Set(out.map(row => row[name]).filter(v => !isBlank(v))).size]));
    const reported = new Set<string>();
    for (const a of dims) {
        const da = distinct.get(a)!;
        if (da < 3 || da > out.length * 0.5) continue;
        for (const b of dims) {
            if (a === b || reported.has(`${b}->${a}`)) continue;
            const db = distinct.get(b)!;
            if (db < 2 || db > da) continue;
            const pairs = new Map<string, Map<string, number>>();
            for (const row of out) {
                const va = row[a], vb = row[b];
                if (isBlank(va) || isBlank(vb)) continue;
                const inner = pairs.get(String(va)) || new Map<string, number>();
                inner.set(String(vb), (inner.get(String(vb)) || 0) + 1);
                pairs.set(String(va), inner);
            }
            let total = 0, dominantTotal = 0;
            const dominant = new Map<string, { value: string; share: number; count: number; total: number }>();
            for (const [va, inner] of pairs) {
                const sum = [...inner.values()].reduce((s, n) => s + n, 0);
                if (sum < 3) continue;
                const [value, count] = [...inner.entries()].sort((x, y) => y[1] - x[1])[0];
                total += sum; dominantTotal += count;
                dominant.set(va, { value, share: count / sum, count, total: sum });
            }
            if (!total || dominantTotal / total < 0.97) continue;
            const hits = new Set(out.filter(row => {
                const d = dominant.get(String(row[a]));
                return d && d.share >= 0.8 && !isBlank(row[b]) && String(row[b]) !== d.value;
            }));
            if (!hits.size || hits.size > out.length * 0.03) continue;
            reported.add(`${a}->${b}`);
            const first = [...hits][0];
            const d = dominant.get(String(first[a]))!;
            out = applyFlag(out, {
                key: `mapping:${a}->${b}`, base: 'Inconsistent Mapping', column: b, columns: [a, b], hits,
                details: `Each '${a}' almost always has one '${b}', but ${plural(hits.size, 'row')} disagree${hits.size === 1 ? 's' : ''}: e.g. ${quote(first[a])} is under ${quote(d.value)} ${d.count.toLocaleString()} times but ${quote(first[b])} in some rows.`,
                options: [{ choice: 'fix', label: `Use the usual ${b.replace(/_/g, ' ')}` }, { choice: 'keep', label: 'Both are correct' }, { choice: 'remove', label: 'Remove these rows' }],
                fix: row => ({ ...row, [b]: dominant.get(String(row[a]))!.value }), fixedWords: `${plural(hits.size, 'row')} set to the usual ${b.replace(/_/g, ' ')}`,
            }, decisions, logs);
        }
    }
    return out;
}

// ── 5. Dates: in the future, implausibly old, missing periods ────────

const EVENT_DATE = /(order|sale|sold|transaction|txn|created|purchase|invoice|paid|payment|booking|signup|sign_up|registered|visit|admission|date)$/i;
const PLANNED_DATE = /(due|expir|forecast|plan|target|renewal|scheduled|deadline|valid|maturity|until|end)/i;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateChecks(rows: Row[], columns: ColumnDefinition[], decisions: Record<string, FlagChoice>, logs: ETLLog[], today = new Date()): Row[] {
    let out = rows;
    const tomorrow = new Date(today.getTime() + 86_400_000).toISOString().slice(0, 10);
    for (const c of columns.filter(col => col.type === ColumnType.DATE)) {
        const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
        if (EVENT_DATE.test(c.name) && !PLANNED_DATE.test(c.name)) {
            const hits = new Set(out.filter(row => { const d = day(row[c.name]); return d !== null && d > tomorrow; }));
            if (hits.size && hits.size <= out.length * 0.2) {
                out = applyFlag(out, {
                    key: `future:${c.name}`, base: 'Future Date', column: c.name, hits,
                    details: `Column '${c.name}': ${plural(hits.size, 'row')} ${hits.size === 1 ? 'is' : 'are'} dated after today (e.g. ${day([...hits][0][c.name])}). For records of things that happened, this is usually a typing mistake.`,
                    options: [{ choice: 'keep', label: 'Dates are correct' }, { choice: 'remove', label: 'Remove these rows' }, { choice: 'fix', label: 'Clear these dates' }],
                    fix: row => ({ ...row, [c.name]: null }), fixedWords: `${plural(hits.size, 'date')} set to blank`,
                }, decisions, logs);
            }
        }
        const old = new Set(out.filter(row => { const d = day(row[c.name]); return d !== null && d < '1900-01-01'; }));
        if (old.size && old.size <= out.length * 0.2) {
            out = applyFlag(out, {
                key: `old:${c.name}`, base: 'Implausible Date', column: c.name, hits: old,
                details: `Column '${c.name}': ${plural(old.size, 'date')} before 1900 (e.g. ${day([...old][0][c.name])}). These are rarely real.`,
                options: [{ choice: 'keep', label: 'Dates are correct' }, { choice: 'fix', label: 'Clear these dates' }, { choice: 'remove', label: 'Remove these rows' }],
                fix: row => ({ ...row, [c.name]: null }), fixedWords: `${plural(old.size, 'date')} set to blank`,
            }, decisions, logs);
        }
        // Missing months between the first and last month with data.
        // Dates already flagged as future or pre-1900 do not stretch the range.
        const months = new Set(out.map(row => day(row[c.name])).filter((d): d is string => Boolean(d) && d! <= tomorrow && d! >= '1900-01-01').map(d => d.slice(0, 7)));
        if (months.size >= 6) {
            const sorted = [...months].sort();
            const [fy, fm] = sorted[0].split('-').map(Number);
            const [ly, lm] = sorted[sorted.length - 1].split('-').map(Number);
            const span = (ly - fy) * 12 + (lm - fm) + 1;
            if (span <= 600) {
                const missing: string[] = [];
                for (let i = 0; i < span; i++) {
                    const y = fy + Math.floor((fm - 1 + i) / 12), m = ((fm - 1 + i) % 12) + 1;
                    const key = `${y}-${String(m).padStart(2, '0')}`;
                    if (!months.has(key)) missing.push(`${MONTH_NAMES[m - 1]} ${y}`);
                }
                if (missing.length && missing.length <= span * 0.3) {
                    logs.push(entry('Missing Period Note', 'info',
                        `Column '${c.name}': no rows at all for ${plural(missing.length, 'month')} between ${MONTH_NAMES[fm - 1]} ${fy} and ${MONTH_NAMES[lm - 1]} ${ly} (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}). If data is expected every month, part of the export may be missing.`,
                        { affectedColumns: [c.name] }));
                }
            }
        }
    }
    return out;
}

// ── 6. Values off by ×100 or ×1000 (pence vs pounds, units vs thousands) ──

function scaleShift(rows: Row[], columns: ColumnDefinition[], decisions: Record<string, FlagChoice>, logs: ETLLog[]): Row[] {
    let out = rows;
    for (const c of columns.filter(col => col.type === ColumnType.METRIC)) {
        const values = out.map(row => row[c.name]).filter((v): v is number => typeof v === 'number' && v > 0).sort((a, b) => a - b);
        if (values.length < 30) continue;
        const q = (p: number) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))];
        const q1 = q(0.25), median = q(0.5), q3 = q(0.75);
        if (q1 <= 0 || q3 / q1 > 20) continue; // only for tight columns, where a ×100 jump stands out
        const factorOf = (v: number): number | null => {
            for (const f of [100, 1000]) {
                if (v / median >= f * 0.6 && v / median <= f * 1.7) return f;
                if (median / v >= f * 0.6 && median / v <= f * 1.7) return 1 / f;
            }
            return null;
        };
        let hits = new Set(out.filter(row => typeof row[c.name] === 'number' && row[c.name] > 0 && factorOf(row[c.name]) !== null));
        // Only a group cut off from the rest: the low end of an even spread
        // (mileage from 1,000 to 200,000) is not a different unit.
        const isolated = (direction: 'low' | 'high') => {
            const group = [...hits].map(row => row[c.name] as number).filter(v => (direction === 'low' ? v < median : v > median));
            if (!group.length) return true;
            const others = values.filter(v => (direction === 'low' ? v < median : v > median) && !group.includes(v));
            return direction === 'low'
                ? !others.length || Math.min(...others) >= Math.max(...group) * 10
                : !others.length || Math.max(...others) * 10 <= Math.min(...group);
        };
        const keepLow = isolated('low'), keepHigh = isolated('high');
        hits = new Set([...hits].filter(row => (row[c.name] < median ? keepLow : keepHigh)));
        if (!hits.size || hits.size > out.length * 0.05) continue;
        const factors = [...hits].map(row => factorOf(row[c.name])!);
        const factor = factors.sort((a, b) => factors.filter(x => x === b).length - factors.filter(x => x === a).length)[0];
        const words = factor > 1 ? `about ${factor}× larger` : `about ${Math.round(1 / factor)}× smaller`;
        out = applyFlag(out, {
            key: `scale:${c.name}`, base: 'Scale Shift', column: c.name, hits,
            details: `Column '${c.name}': ${plural(hits.size, 'value')} ${hits.size === 1 ? 'is' : 'are'} ${words} than the typical ${median.toLocaleString()} (e.g. ${[...hits].slice(0, 3).map(row => row[c.name].toLocaleString()).join(', ')}). They may be in a different unit, such as pence instead of pounds.`,
            options: [{ choice: 'fix', label: factor > 1 ? `Divide them by ${factor}` : `Multiply them by ${Math.round(1 / factor)}` }, { choice: 'keep', label: 'Values are correct' }, { choice: 'remove', label: 'Remove these rows' }],
            fix: row => { const f = factorOf(row[c.name]); return f ? { ...row, [c.name]: Math.round((row[c.name] / f) * 100) / 100 } : row; },
            fixedWords: `${plural(hits.size, 'value')} rescaled`,
        }, decisions, logs);
    }
    return out;
}

// ── 7. Columns that hold one value only ──────────────────────────────

function constantColumns(rows: Row[], columns: ColumnDefinition[], logs: ETLLog[]): void {
    for (const c of columns) {
        const filled = rows.map(row => row[c.name]).filter(v => !isBlank(v));
        if (filled.length < 10) continue;
        const values = new Set(filled.map(v => String(v)));
        if (values.size === 1) {
            logs.push(entry('Constant Column Note', 'info',
                `Column '${c.name}' has the same value (${quote(filled[0])}) in every filled row, so it cannot split or explain anything.`,
                { affectedColumns: [c.name] }));
        }
    }
}

// ── 8. Near-duplicate rows: the same record typed slightly differently ──

const normalised = (v: unknown) => isBlank(v) ? '' : String(v).toLowerCase()
    .replace(/(\d)\.(\d)/g, '$1\u0002$2')      // keep decimal points in numbers
    .replace(/[^a-z0-9\u0002]+/g, ' ').trim();

function nearDuplicates(rows: Row[], columns: ColumnDefinition[], decisions: Record<string, FlagChoice>, logs: ETLLog[]): Row[] {
    if (rows.length < 2 || rows.length > 200_000) return rows;
    const names = columns.map(c => c.name);
    const seen = new Map<string, { raw: string; count: number }>();
    const hits = new Set<Row>();
    for (const row of rows) {
        const key = names.map(name => normalised(row[name])).join('\u0001');
        if (!key.replace(/\u0001/g, '')) continue;
        const raw = names.map(name => String(row[name] ?? '')).join('\u0001');
        const first = seen.get(key);
        if (!first) { seen.set(key, { raw, count: 1 }); continue; }
        if (first.raw !== raw) hits.add(row); // differs only in case, spacing or punctuation
    }
    if (!hits.size || hits.size > Math.max(2, rows.length * 0.1)) return rows;
    return applyFlag(rows, {
        key: 'near-duplicates', base: 'Near-Duplicate Rows', column: names[0], columns: names.slice(0, 6), hits,
        details: `${plural(hits.size, 'row')} ${hits.size === 1 ? 'matches' : 'match'} an earlier row except for capital letters, spaces or punctuation. They are probably the same record entered twice.`,
        options: [{ choice: 'remove', label: 'Remove the copies' }, { choice: 'keep', label: 'They are different records' }],
    }, decisions, logs);
}

// ── 9. Unusual rows: rare in two or more ways at once (no rule needed) ──

function unusualRows(rows: Row[], columns: ColumnDefinition[], decisions: Record<string, FlagChoice>, logs: ETLLog[]): Row[] {
    if (rows.length < 200) return rows;
    const reasons = new Map<Row, string[]>();
    const note = (row: Row, why: string) => { const list = reasons.get(row) || []; list.push(why); reasons.set(row, list); };
    for (const c of columns.filter(col => col.type === ColumnType.METRIC)) {
        const values = rows.map(row => row[c.name]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
        if (values.length < 50) continue;
        const median = values[Math.floor(values.length / 2)];
        const deviations = values.map(v => Math.abs(v - median)).sort((a, b) => a - b);
        const mad = deviations[Math.floor(deviations.length / 2)] * 1.4826;
        if (!mad) continue;
        for (const row of rows) {
            const v = row[c.name];
            if (typeof v === 'number' && Math.abs(v - median) / mad > 6) note(row, `${c.name} ${v.toLocaleString()} is far from the usual ${median.toLocaleString()}`);
        }
    }
    for (const c of columns.filter(col => col.type === ColumnType.DIMENSION)) {
        const counts = new Map<string, number>();
        for (const row of rows) if (!isBlank(row[c.name])) counts.set(String(row[c.name]), (counts.get(String(row[c.name])) || 0) + 1);
        if (counts.size < 3 || rows.length / counts.size < 20) continue; // only where categories normally repeat a lot
        for (const row of rows) if (counts.get(String(row[c.name])) === 1) note(row, `${c.name} ${quote(row[c.name])} appears only once`);
    }
    const hits = new Set([...reasons.entries()].filter(([, why]) => new Set(why.map(w => w.split(' ')[0])).size >= 2).map(([row]) => row));
    if (!hits.size || hits.size > rows.length * 0.01) return rows;
    const first = [...hits][0];
    return applyFlag(rows, {
        key: 'unusual-rows', base: 'Unusual Row', column: columns[0]?.name || '', columns: [...new Set((reasons.get(first) || []).map(w => w.split(' ')[0]))], hits,
        details: `${plural(hits.size, 'row')} ${hits.size === 1 ? 'is' : 'are'} unusual in two or more ways at once, which often means a data-entry or export error. For example: ${(reasons.get(first) || []).slice(0, 2).join('; ')}.`,
        options: [{ choice: 'keep', label: 'Rows are correct' }, { choice: 'remove', label: 'Remove these rows' }],
    }, decisions, logs);
}

// ── 10. Custom rules the analyst writes once ─────────────────────────

export function describeRule(rule: CleaningRule): string {
    const column = rule.column.replace(/_/g, ' ');
    switch (rule.test) {
        case 'min': return `${column} is at least ${rule.value}`;
        case 'max': return `${column} is at most ${rule.value}`;
        case 'not_blank': return `${column} is never blank`;
        case 'one_of': return `${column} is one of: ${rule.value}`;
        case 'matches': return `${column} matches ${rule.value}`;
        case 'unique': return `${column} has no repeated values`;
        case 'not_future': return `${column} is not in the future`;
    }
}

export function ruleViolations(rows: Row[], rule: CleaningRule, today = new Date()): Set<Row> {
    const value = rule.value ?? '';
    const number = Number(value);
    const allowed = new Set(String(value).split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
    let pattern: RegExp | null = null;
    if (rule.test === 'matches') { try { pattern = new RegExp(String(value), 'i'); } catch { return new Set(); } }
    const todayIso = today.toISOString().slice(0, 10);
    const seen = new Set<string>();
    const hits = new Set<Row>();
    for (const row of rows) {
        const v = row[rule.column];
        let bad = false;
        switch (rule.test) {
            case 'min': bad = typeof v === 'number' && Number.isFinite(number) && v < number; break;
            case 'max': bad = typeof v === 'number' && Number.isFinite(number) && v > number; break;
            case 'not_blank': bad = isBlank(v); break;
            case 'one_of': bad = !isBlank(v) && allowed.size > 0 && !allowed.has(String(v).trim().toLowerCase()); break;
            case 'matches': bad = !isBlank(v) && !pattern!.test(String(v)); break;
            case 'unique': if (!isBlank(v)) { const k = String(v); bad = seen.has(k); seen.add(k); } break;
            case 'not_future': bad = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && v.slice(0, 10) > todayIso; break;
        }
        if (bad) hits.add(row);
    }
    return hits;
}

function customRules(rows: Row[], opts: EtlOptions, decisions: Record<string, FlagChoice>, logs: ETLLog[]): Row[] {
    let out = rows;
    for (const rule of opts.customRules || []) {
        if (!out.length || !(rule.column in out[0])) {
            logs.push(entry('Rule Skipped', 'skipped', `Your rule "${describeRule(rule)}" was not checked: column '${rule.column}' is not in this data.`, { affectedColumns: [rule.column] }));
            continue;
        }
        const hits = ruleViolations(out, rule);
        const words = describeRule(rule);
        const without = (opts.customRules || []).filter(r => r.id !== rule.id);
        const removeRule = { option: 'customRules' as const, value: (without.length ? without : null) as any, label: 'Delete this rule' };
        if (!hits.size) {
            logs.push(entry('Rule Passed', 'skipped', `Your rule "${words}" holds for every row.`, { affectedColumns: [rule.column], revert: removeRule }));
            continue;
        }
        if (rule.action === 'remove') {
            const before = out.length;
            out = out.filter(row => !hits.has(row));
            logs.push(entry('Rule Applied', 'applied', `Your rule "${words}": removed ${plural(before - out.length, 'row')} that broke it.`,
                { affectedColumns: [rule.column], rowsBefore: before, rowsAfter: out.length, removedRowSamples: [...hits].slice(0, 5), revert: removeRule }));
            continue;
        }
        out = applyFlag(out, {
            key: `rule:${rule.id}`, base: 'Rule Violation', column: rule.column, hits,
            details: `Your rule "${words}" is broken by ${plural(hits.size, 'row')}.`,
            options: [{ choice: 'keep', label: 'Keep them' }, { choice: 'remove', label: 'Remove these rows' }],
        }, decisions, logs);
    }
    return out;
}

// ── Entry point ──────────────────────────────────────────────────────

/**
 * Run every check in a fixed order. Called by the pipeline after the core
 * clean-up, so values are already parsed (numbers are numbers, dates ISO).
 */
export function runQualityChecks(rows: Row[], columns: ColumnDefinition[], opts: EtlOptions = {}, today = new Date()): { rows: Row[]; logs: ETLLog[] } {
    const logs: ETLLog[] = [];
    const decisions = (opts.flagDecisions || {}) as Record<string, FlagChoice>;
    let out = rows;
    out = nearDuplicates(out, columns, decisions, logs);
    out = standardFormats(out, columns, decisions, logs);
    out = formatConsistency(out, columns, decisions, logs);
    out = inconsistentMappings(out, columns, decisions, logs);
    out = dateChecks(out, columns, decisions, logs, today);
    out = scaleShift(out, columns, decisions, logs);
    constantColumns(out, columns, logs);
    out = customRules(out, opts, decisions, logs);
    out = unusualRows(out, columns, decisions, logs);
    return { rows: out, logs };
}
