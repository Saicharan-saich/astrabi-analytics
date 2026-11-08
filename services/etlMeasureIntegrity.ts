/**
 * etlMeasureIntegrity.ts — row-level safeguards that keep totals correct.
 *
 * Each function is pure and returns what it changed, so the pipeline can log
 * it plainly. The rule throughout: only remove or rewrite data when the
 * evidence is unambiguous (an exact re-exported row under a unique key, a
 * labelled total that equals the rows it totals); otherwise keep the data and
 * flag it.
 */

import { isPerRowName } from '../utils/numberMeaning';
import { isTotalLabel, parseLocaleNumber, periodFromHeader } from './etlHardening';

type Row = Record<string, any>;

const isBlank = (v: any) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const num = (v: any): number | null => (typeof v === 'number' ? (Number.isFinite(v) ? v : null) : parseLocaleNumber(v));

// ─────────────────────────────────────────────────────────────────────
// Duplicates
// ─────────────────────────────────────────────────────────────────────

export interface DedupeResult {
    rows: Row[];
    /** Exact copies removed (only when a key proves rows should be unique). */
    removed: Row[];
    /** Exact repeats kept because nothing shows they are accidental. */
    repeatedKept: number;
    /** Key that proved the table is one-row-per-key, if any. */
    keyColumn: string | null;
    /** ID-like columns that repeat with different content (line items, events). */
    repeatingIdColumns: string[];
}

/**
 * Remove a row only when it is an exact copy of another row AND some ID
 * column is unique once those copies are collapsed — i.e. the table is meant
 * to have one row per key, so a second identical row is a re-export. Without
 * such a key, identical rows are kept (two £3.50 coffees are two sales).
 * Rows that share an ID but differ (order lines) are never removed.
 */
export function dedupeRows(rows: Row[], idPattern: RegExp): DedupeResult {
    const columns = Object.keys(rows[0] || {});
    const seen = new Map<string, number>();
    const unique: Row[] = [];
    const copies: Row[] = [];
    for (const row of rows) {
        const key = columns.map(c => JSON.stringify(row[c] ?? null)).join('|');
        if (seen.has(key)) copies.push(row);
        else { seen.set(key, unique.length); unique.push(row); }
    }
    const idColumns = columns.filter(c => idPattern.test(c));
    const isUniqueIn = (list: Row[], c: string) => {
        const values = list.map(r => r[c]).filter(v => !isBlank(v));
        return values.length >= list.length * 0.95 && new Set(values.map(v => String(v))).size === values.length;
    };
    const keyColumn = idColumns.find(c => isUniqueIn(unique, c)) || null;
    const repeatingIdColumns = idColumns.filter(c => {
        const values = unique.map(r => r[c]).filter(v => !isBlank(v));
        return values.length > 0 && new Set(values.map(String)).size < values.length;
    });
    if (copies.length > 0 && keyColumn) {
        // The ID proves a copy only when it is filled in: two rows with a
        // blank ID may be two real transactions, so those are kept.
        const proven = copies.filter(row => !isBlank(row[keyColumn]));
        if (proven.length === copies.length) return { rows: unique, removed: copies, repeatedKept: 0, keyColumn, repeatingIdColumns };
        const drop = new Set(proven);
        return { rows: rows.filter(row => !drop.has(row)), removed: proven, repeatedKept: copies.length - proven.length, keyColumn, repeatingIdColumns };
    }
    return { rows, removed: [], repeatedKept: copies.length, keyColumn, repeatingIdColumns };
}

// ─────────────────────────────────────────────────────────────────────
// Total and subtotal rows
// ─────────────────────────────────────────────────────────────────────

export interface TotalRowsResult {
    rows: Row[];
    removed: Row[];
    /** Labelled total rows kept because their numbers did not add up. */
    suspicious: Row[];
}

/**
 * Report exports often end (or break) with "Total" / "Subtotal" lines. Summing
 * them doubles the figures. A row is removed when a text cell is a total label
 * AND at least one numeric column equals the sum of the rows it totals (all
 * other rows for a grand total, the rows since the previous total for a
 * subtotal). Labelled rows whose numbers don't reconcile are kept and flagged.
 */
export function removeTotalRows(rows: Row[]): TotalRowsResult {
    if (rows.length < 3) return { rows, removed: [], suspicious: [] };
    const columns = Object.keys(rows[0] || {});
    const isTotalRow = rows.map(row => columns.some(c => typeof row[c] === 'string' && isTotalLabel(row[c])));
    if (!isTotalRow.some(Boolean)) return { rows, removed: [], suspicious: [] };

    // Numeric columns: mostly parseable among non-total rows.
    const numericColumns = columns.filter(c => {
        let n = 0, present = 0;
        rows.forEach((row, i) => {
            if (isTotalRow[i] || isBlank(row[c])) return;
            present++;
            if (num(row[c]) !== null) n++;
        });
        return present > 0 && n / present >= 0.8;
    });
    const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.005);
    // A "Total" line with no numbers left in it ("Total,,,") is an empty label: nothing to keep.
    const emptyTotal = (row: Row) => columns.every(c => isBlank(row[c]) || (typeof row[c] === 'string' && isTotalLabel(row[c])));

    const removed: Row[] = [];
    const suspicious: Row[] = [];
    const keep: boolean[] = rows.map(() => true);
    let blockStart = 0;
    for (let i = 0; i < rows.length; i++) {
        if (!isTotalRow[i]) continue;
        if (emptyTotal(rows[i])) { keep[i] = false; removed.push(rows[i]); blockStart = i + 1; continue; }
        const block = rows.slice(blockStart, i).filter((_, k) => !isTotalRow[blockStart + k]);
        const everything = rows.filter((_, k) => !isTotalRow[k]);
        const matches = numericColumns.some(c => {
            const v = num(rows[i][c]);
            if (v === null) return false;
            const sum = (list: Row[]) => list.reduce((s, r) => s + (num(r[c]) ?? 0), 0);
            return (block.length > 0 && close(v, sum(block))) || close(v, sum(everything));
        });
        if (matches) { keep[i] = false; removed.push(rows[i]); }
        else suspicious.push(rows[i]);
        blockStart = i + 1;
    }
    return { rows: rows.filter((_, i) => keep[i]), removed, suspicious };
}

// ─────────────────────────────────────────────────────────────────────
// Report layouts (profit and loss, balance sheet): section headings and
// calculated lines
// ─────────────────────────────────────────────────────────────────────

/** Lines a report works out from the lines above it (never added to them). */
const CALCULATED_LINE = /^(gross|net|operating)\s+(profit|income|loss|margin|earnings|surplus|deficit)\b|^net\s+(other|operating|ordinary)\s+income\b|^(profit|loss|earnings)\s+(before|after|for)\b|^ebitda?\b|^(total\s+)?net\s+(assets|worth)\b|^retained\s+earnings\s+for\b/i;

export interface ReportSectionsResult {
    rows: Row[];
    labelColumn: string;
    sections: string[];
    /** Calculated lines removed (Gross Profit, Net Income …) and their labels. */
    calculated: Row[];
    calculatedLabels: string[];
    /** The label column was unnamed in the file and is now called this. */
    renamedTo?: string;
}

/**
 * A report export lists its lines under headings ("Income", "Expenses") that
 * carry no numbers, then totals and calculated lines (Gross Profit, Net
 * Income). Recognised only when there are at least two headings and a total
 * line: the headings become a `section` column, calculated lines are removed
 * (they would double-count), and an unnamed label column is named `line_item`.
 * Totals are left for removeTotalRows, which only removes those that add up.
 */
export function foldReportSections(rows: Row[]): ReportSectionsResult | null {
    if (rows.length < 4) return null;
    const columns = Object.keys(rows[0] || {});
    if (columns.includes('section')) return null;
    const labelColumn = columns.find(c => {
        const filled = rows.filter(r => !isBlank(r[c]));
        return filled.length >= rows.length * 0.8 && filled.filter(r => typeof r[c] === 'string' && num(r[c]) === null).length >= filled.length * 0.9;
    });
    if (!labelColumn) return null;
    const others = columns.filter(c => c !== labelColumn);
    const isHeading = (r: Row) => !isBlank(r[labelColumn]) && !isTotalLabel(String(r[labelColumn]).trim()) && others.every(c => isBlank(r[c]));
    const headingRows = rows.filter(isHeading);
    const hasTotal = rows.some(r => isTotalLabel(String(r[labelColumn] ?? '').trim()));
    if (headingRows.length < 2 || !hasTotal) return null;
    const out: Row[] = [];
    const calculated: Row[] = [];
    const calculatedLabels: string[] = [];
    const sections: string[] = [];
    let section: string | null = null;
    const unnamed = /^(column_?\d+|unnamed.*|field_?\d+|_+)?$/i.test(labelColumn);
    const name = unnamed ? 'line_item' : labelColumn;
    for (const r of rows) {
        if (isHeading(r)) { section = String(r[labelColumn]).trim(); sections.push(section); continue; }
        const label = String(r[labelColumn] ?? '').trim();
        if (CALCULATED_LINE.test(label)) { calculated.push(r); calculatedLabels.push(label); continue; }
        const next: Row = { section };
        for (const c of columns) next[c === labelColumn ? name : c] = c === labelColumn ? label : r[c];
        out.push(next);
    }
    return { rows: out, labelColumn: name, sections, calculated, calculatedLabels, renamedTo: unnamed ? name : undefined };
}

// ─────────────────────────────────────────────────────────────────────
// Wide tables (one column per month / quarter / year)
// ─────────────────────────────────────────────────────────────────────

export interface UnpivotResult {
    rows: Row[];
    periodColumns: string[];
    dated: boolean;
    /** Row-total columns ("Total", "YTD") left out: each is the sum of the period columns. */
    totalColumns: string[];
}

/**
 * "Product, Jan 2024, Feb 2024, …" puts time in the column headers, so there
 * is no date to trend and no single measure to sum. When three or more
 * numeric columns are named after periods, reshape to one row per period:
 * the other columns, plus `period` (a date when the header names one) and
 * `value`.
 */
export function unpivotPeriodColumns(rows: Row[]): UnpivotResult | null {
    const columns = Object.keys(rows[0] || {});
    const periods = columns.map(c => ({ column: c, start: periodFromHeader(c) })).filter(p => p.start !== null) as { column: string; start: string }[];
    if (periods.length < 3) return null;
    const numericShare = (c: string) => {
        let n = 0, present = 0;
        for (const r of rows) { if (isBlank(r[c])) continue; present++; if (num(r[c]) !== null) n++; }
        return present === 0 ? 1 : n / present;
    };
    const periodColumns = periods.filter(p => numericShare(p.column) >= 0.9);
    if (periodColumns.length < 3) return null;
    // A "Total" / "YTD" column that adds up the period columns would repeat on every period row.
    const totalColumns = columns.filter(c => {
        if (periodColumns.some(p => p.column === c) || !/^(total|totals|sum|ytd|year_to_date|grand_total|full_year|row_total)$/i.test(c)) return false;
        let checked = 0, adds = 0;
        for (const r of rows) {
            const v = num(r[c]);
            if (v === null) continue;
            checked++;
            const sum = periodColumns.reduce((s, p) => s + (num(r[p.column]) ?? 0), 0);
            if (Math.abs(v - sum) <= Math.max(0.011, Math.abs(sum) * 0.005)) adds++;
        }
        return checked > 0 && adds / checked >= 0.8;
    });
    const idColumns = columns.filter(c => !periodColumns.some(p => p.column === c) && !totalColumns.includes(c));
    // Already long data that merely has a "2023" metric column is not wide.
    if (idColumns.length === 0 && periodColumns.length < 3) return null;
    const dated = periodColumns.every(p => p.start !== '');
    const out: Row[] = [];
    for (const row of rows) {
        for (const p of periodColumns) {
            if (isBlank(row[p.column])) continue;
            const next: Row = {};
            for (const c of idColumns) next[c] = row[c];
            next.period = dated ? p.start : p.column;
            next.value = row[p.column];
            out.push(next);
        }
    }
    return { rows: out, periodColumns: periodColumns.map(p => p.column), dated, totalColumns };
}

// ─────────────────────────────────────────────────────────────────────
// Year + month columns without a date
// ─────────────────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** When there is no date but there are year and month columns, add `period` (first of the month). */
export function addPeriodFromYearMonth(rows: Row[], hasDateColumn: boolean): string | null {
    if (hasDateColumn || rows.length === 0) return null;
    const columns = Object.keys(rows[0]);
    const yearCol = columns.find(c => /^(year|yr|fiscal_?year|fy)$/i.test(c));
    const monthCol = columns.find(c => /^(month|mon|month_?(no|num|number|name))$/i.test(c));
    if (!yearCol || !monthCol || columns.includes('period')) return null;
    const monthOf = (v: any): number | null => {
        if (isBlank(v)) return null;
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
        const i = MONTHS.indexOf(String(v).trim().toLowerCase().slice(0, 3));
        return i >= 0 ? i + 1 : null;
    };
    let ok = 0;
    for (const r of rows) {
        const y = Number(r[yearCol]);
        if (Number.isInteger(y) && y >= 1900 && y <= 2200 && monthOf(r[monthCol]) !== null) ok++;
    }
    if (ok < rows.length * 0.9) return null;
    for (const r of rows) {
        const y = Number(r[yearCol]);
        const m = monthOf(r[monthCol]);
        r.period = Number.isInteger(y) && m ? `${y}-${String(m).padStart(2, '0')}-01` : null;
    }
    return 'period';
}

// ─────────────────────────────────────────────────────────────────────
// Header-level amounts repeated on every line
// ─────────────────────────────────────────────────────────────────────

const PER_UNIT_NAME = /(^|_)(unit|units|per|each|price|rate|pct|percent|ratio|avg|average|mean|qty|quantity|count|pieces|items|discount)(_|$)/i;

/**
 * Order-level amounts (shipping, order total) copied onto every line of the
 * order are counted once per line when summed. Detect additive columns that
 * are constant within each multi-line key group; return them with the key.
 */
export function findRepeatedHeaderAmounts(rows: Row[], keyColumns: string[], metricColumns: string[]): { column: string; key: string; groups: number }[] {
    const out: { column: string; key: string; groups: number }[] = [];
    // A product, customer or place code groups many separate orders: never an order key.
    const notOrderKey = /(sku|product|item|barcode|upc|ean|gtin|variant|customer|cust|client|user|member|patient|account|employee|staff|store|location|branch|supplier|vendor|category)/i;
    for (const key of keyColumns.filter(k => !notOrderKey.test(k))) {
        const groups = new Map<string, Row[]>();
        for (const r of rows) {
            if (isBlank(r[key])) continue;
            const k = String(r[key]);
            const list = groups.get(k);
            if (list) list.push(r); else groups.set(k, [r]);
        }
        const multi = [...groups.values()].filter(g => g.length > 1);
        if (multi.length < 3 || multi.length < groups.size * 0.05) continue;
        // Evidence the lines really differ: another measure varies within the groups.
        const variesWithin = (column: string) => {
            let varying = 0, informative = 0;
            for (const g of multi) {
                const values = g.map(r => num(r[column])).filter((v): v is number => v !== null);
                if (values.length < 2) continue;
                informative++;
                if (values.some(v => v !== values[0])) varying++;
            }
            return informative > 0 && varying / informative >= 0.5;
        };
        if (!metricColumns.some(c => c !== key && variesWithin(c))) continue;
        for (const column of metricColumns) {
            // Per-row figures (a rating, an age, a price) are not order-level amounts.
            if (PER_UNIT_NAME.test(column) || isPerRowName(column) || column === key) continue;
            let constant = 0, informative = 0;
            for (const g of multi) {
                const values = g.map(r => num(r[column])).filter((v): v is number => v !== null);
                if (values.length < 2) continue;
                informative++;
                if (values.every(v => v === values[0]) && values[0] !== 0) constant++;
            }
            if (informative < 3 || constant / informative < 0.9) continue;
            // A column that is mostly one value (a flat £3.95 delivery) looks constant in any grouping.
            const counts = new Map<number, number>();
            let filled = 0;
            for (const r of rows) { const v = num(r[column]); if (v === null) continue; filled++; counts.set(v, (counts.get(v) || 0) + 1); }
            if (filled && Math.max(...counts.values()) / filled >= 0.5) continue;
            // Different groups must carry different values, or it is just a constant column.
            const firstValues = new Set(multi.map(g => num(g[0][column])));
            if (firstValues.size < 2) continue;
            out.push({ column, key, groups: multi.length });
        }
        if (out.length) break; // one key is enough evidence
    }
    return out;
}

export interface OrderDetailsFill {
    key: string;
    /** Text columns filled down from each order's first line. */
    filled: string[];
    /** Amount columns left on the first line only (so they are counted once). */
    firstLineAmounts: string[];
    cells: number;
}

/**
 * Shopify-style exports write an order's details (email, status, currency,
 * city) only on its first line; the other lines of the same order are blank.
 * Those blanks are not "Unknown" — they are the same order. Text details are
 * filled down within each order; amounts (subtotal, shipping, total) stay on
 * the first line so a sum counts them once.
 *
 * Recognised only when a key column runs in consecutive blocks, at least three
 * orders have more than one line, and a column is filled on ≥90% of first
 * lines but blank on ≥95% of the other lines.
 */
export function fillOrderLevelDetails(rows: Row[]): OrderDetailsFill | null {
    if (rows.length < 6) return null;
    const columns = Object.keys(rows[0] || {});
    for (const key of columns) {
        // Consecutive runs, each value in one run only.
        const firsts: number[] = [];
        const seen = new Set<string>();
        let ok = true, blanks = 0;
        for (let i = 0; i < rows.length; i++) {
            if (isBlank(rows[i][key])) { blanks++; ok = false; break; }
            const k = String(rows[i][key]);
            if (i > 0 && k === String(rows[i - 1][key])) continue;
            if (seen.has(k)) { ok = false; break; }
            seen.add(k);
            firsts.push(i);
        }
        if (!ok || blanks || firsts.length === rows.length) continue;
        const isFirst = new Array(rows.length).fill(false);
        firsts.forEach(i => { isFirst[i] = true; });
        const multi = firsts.filter((start, n) => (firsts[n + 1] ?? rows.length) - start > 1).length;
        const continuation = rows.length - firsts.length;
        if (multi < 3 || continuation < rows.length * 0.05) continue;
        const filled: string[] = [];
        const firstLineAmounts: string[] = [];
        for (const c of columns) {
            if (c === key) continue;
            let firstFilled = 0, contBlank = 0;
            rows.forEach((r, i) => {
                if (isFirst[i]) { if (!isBlank(r[c])) firstFilled++; } else if (isBlank(r[c])) contBlank++;
            });
            if (firstFilled / firsts.length < 0.9 || contBlank / continuation < 0.95) continue;
            const sample = firsts.map(i => rows[i][c]).filter(v => !isBlank(v));
            const numeric = sample.filter(v => num(v) !== null).length >= sample.length * 0.9;
            (numeric ? firstLineAmounts : filled).push(c);
        }
        if (!filled.length) continue;
        let cells = 0;
        let current: Row = rows[0];
        rows.forEach((r, i) => {
            if (isFirst[i]) { current = r; return; }
            for (const c of filled) if (isBlank(r[c]) && !isBlank(current[c])) { r[c] = current[c]; cells++; }
        });
        return { key, filled, firstLineAmounts, cells };
    }
    return null;
}

/** Spread a repeated header amount evenly over its lines so sums count it once. */
export function allocateAcrossLines(rows: Row[], column: string, key: string, target: string): void {
    const sizes = new Map<string, number>();
    for (const r of rows) if (!isBlank(r[key])) sizes.set(String(r[key]), (sizes.get(String(r[key])) || 0) + 1);
    for (const r of rows) {
        const v = num(r[column]);
        const size = isBlank(r[key]) ? 1 : sizes.get(String(r[key])) || 1;
        r[target] = v === null ? null : Math.round((v / size) * 1e6) / 1e6;
    }
}

// ─────────────────────────────────────────────────────────────────────
// Line totals: derive when missing, reconcile when present
// ─────────────────────────────────────────────────────────────────────

const QTY_NAME = /(^|_)(qty|quantity|units|units_sold|unit_count|pieces|pcs|items|volume)($|_)/i;
const UNIT_PRICE_NAME = /(^|_)(unit_?price|price_?per_?unit|price_?each|selling_?price|sale_?price|list_?price|price|rate)($|_)/i;
const UNIT_COST_NAME = /(^|_)(unit_?cost|cost_?per_?unit|cost_?each|cost_?price)($|_)/i;
const LINE_AMOUNT_NAME = /(^|_)(revenue|sales|amount|line_?total|line_?amount|total|subtotal|sub_total|net_?sales|gross_?sales|extended_?price|value)($|_)/i;
const TOTAL_COST_NAME = /(^|_)(total_?cost|line_?cost|cogs|cost_?of_?goods|cost)($|_)/i;

export interface LineTotals {
    quantity?: string;
    unitPrice?: string;
    unitCost?: string;
    lineAmount?: string;
    totalCost?: string;
}

/** Find the quantity, unit price/cost and line amount/cost columns among the metrics. */
export function findLineColumns(metricColumns: string[]): LineTotals {
    const quantity = metricColumns.find(c => QTY_NAME.test(c));
    const unitCost = metricColumns.find(c => UNIT_COST_NAME.test(c));
    const unitPrice = metricColumns.find(c => UNIT_PRICE_NAME.test(c) && c !== unitCost && !/total|amount/i.test(c));
    const lineAmount = metricColumns.find(c => LINE_AMOUNT_NAME.test(c) && !/(unit|price|per|each|tax|discount|shipping|freight|cost)/i.test(c));
    const totalCost = metricColumns.find(c => TOTAL_COST_NAME.test(c) && c !== unitCost && !/(unit|per|each)/i.test(c));
    return { quantity, unitPrice, unitCost, lineAmount, totalCost };
}

/** Share of rows where amount ≠ quantity × unit price (beyond rounding). */
export function reconcileLineTotals(rows: Row[], quantity: string, unitPrice: string, amount: string): { checked: number; mismatched: number; examples: string[] } {
    let checked = 0, mismatched = 0;
    const examples: string[] = [];
    for (const r of rows) {
        const q = num(r[quantity]), p = num(r[unitPrice]), a = num(r[amount]);
        if (q === null || p === null || a === null) continue;
        checked++;
        const expected = q * p;
        if (Math.abs(a - expected) > Math.max(0.011, Math.abs(expected) * 0.01)) {
            mismatched++;
            if (examples.length < 3) examples.push(`${q} × ${p} = ${Math.round(expected * 100) / 100} but ${amount} = ${a}`);
        }
    }
    return { checked, mismatched, examples };
}
