/**
 * etlPipeline.ts — 7-Layer Deterministic ETL Pipeline
 *
 * Architecture:
 *   Layer 1: Structural Normalization
 *   Layer 2: Canonical Value Prep
 *   Layer 3: Column Profiling
 *   Layer 4: Rule Planner (Classification Gates)
 *   Layer 5: Transformation Engine
 *   Layer 6: Data Contract Validation
 *   Layer 7: Column Lineage Graph
 *   Post:    TimeContext + DimDate + Quality Score
 */

import { ColumnDefinition, ColumnType, DimDateRow, ETLLog, TimeContext } from '../types';
import { generateDimDate } from './dimDateGenerator';

// ╔══════════════════════════════════════════════════════════════════╗
// ║  TYPES                                                          ║
// ╚══════════════════════════════════════════════════════════════════╝

export interface LineageNode {
    column: string;
    step: string;
    rowsChanged: number;
    rowsFailed: number;
    inputSamples: string[];
    outputSamples: string[];
}

export interface ColumnLineage {
    column: string;
    chain: LineageNode[];
}

export interface ColumnProfileData {
    name: string;
    nullRate: number;
    distinctCount: number;
    totalValues: number;
    numericParseRate: number;
    dateParseRate: number;
    booleanTokenRate: number;
    min?: number;
    max?: number;
    dateFormatCandidate: string | null;
    currencyDetected: boolean;
    percentageDetected: boolean;
    wordNumberRate: number;
}

export interface TransformStep {
    name: string;
    fn: (v: any) => any;
}

export interface TransformPlan {
    column: string;
    type: ColumnType;
    steps: TransformStep[];
}

export interface ContractViolation {
    column: string;
    rule: string;
    severity: 'hard' | 'soft';
    message: string;
}

export interface DataContract {
    status: 'safe' | 'warning' | 'unsafe';
    violations: ContractViolation[];
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  CONSTANTS                                                      ║
// ╚══════════════════════════════════════════════════════════════════╝

const NULL_TOKENS = new Set([
    'null', 'nil', 'none', 'na', 'n/a', 'n.a.', 'n.a', '#n/a', '#na',
    'nan', '#nan', 'undefined', 'missing', '-', '--', '—', '.',
    'not available', 'not applicable', 'unknown', 'blank', 'empty',
    '#value!', '#ref!', '#div/0!', '#name?', 'err', '#error'
]);

const BOOLEAN_TOKENS: Record<string, boolean> = {
    'true': true, 'false': false, 'yes': true, 'no': false,
    't': true, 'f': false, 'y': true, 'n': false, '1': true, '0': false
};

const WORD_NUMBERS: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
    fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    hundred: 100, thousand: 1000, million: 1000000
};

const CURRENCY_REGEX = /[$€£¥₹₩₫₽¢]/;

// Product/value synonym normalization dictionary
const CATEGORY_SYNONYMS: Record<string, Record<string, string>> = {
    // Product name synonyms (applied after Title Case)
    product_name: {
        'Tab': 'Tablet',
        'Tabs': 'Tablet',
        'Cell Phone': 'Phone',
        'Cellphone': 'Phone',
        'Smartphone': 'Phone',
        'Mobile': 'Phone',
        'Mobile Phone': 'Phone',
        'Phone': 'Smart Phone',
        'Notebook': 'Laptop',
        'Pc': 'Desktop',
        'Personal Computer': 'Desktop',
        'Console': 'Gaming Console',
        'Ultra-Laptop': 'Ultra Laptop',
        'Earbuds': 'Wireless Earbuds',
    },
    // Channel synonyms
    channel: {
        'Web': 'Online',
        'Website': 'Online',
        'Ecommerce': 'Online',
        'E-Commerce': 'Online',
        'In-Store': 'Store',
        'In Store': 'Store',
        'Brick And Mortar': 'Store',
        'Wholesale': 'Retail',
    },
    // Region synonyms
    region: {
        'No': 'North',
        'So': 'South',
        'Ea': 'East',
        'We': 'West',
        'N': 'North',
        'S': 'South',
        'E': 'East',
        'W': 'West',
        'Ne': 'Northeast',
        'Nw': 'Northwest',
        'Se': 'Southeast',
        'Sw': 'Southwest',
    },
};
const CURRENCY_STRIP_REGEX = /[$€£¥₹₩₫₽¢,\s]/g;

// Date formats ordered by specificity
const DATE_FORMATS: { id: string; regex: RegExp; parse: (m: RegExpMatchArray) => { y: number; m: number; d: number } | null }[] = [
    // ISO: 2023-06-08, 2023/06/08
    { id: 'YYYY-MM-DD', regex: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/, parse: (m) => ({ y: +m[1], m: +m[2], d: +m[3] }) },
    // ISO with dots: 2023.06.08
    { id: 'YYYY.MM.DD', regex: /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/, parse: (m) => ({ y: +m[1], m: +m[2], d: +m[3] }) },
    // US: 06/08/2023, 6/8/2023
    { id: 'MM/DD/YYYY', regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/, parse: (m) => ({ y: +m[3], m: +m[1], d: +m[2] }) },
    // EU: 08-06-2023
    { id: 'DD/MM/YYYY', regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/, parse: (m) => ({ y: +m[3], m: +m[2], d: +m[1] }) },
    // Short year: 06/08/23, 6/8/23
    { id: 'MM/DD/YY', regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/, parse: (m) => ({ y: 2000 + +m[3], m: +m[1], d: +m[2] }) },
    { id: 'DD/MM/YY', regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/, parse: (m) => ({ y: 2000 + +m[3], m: +m[2], d: +m[1] }) },
    // Text with spaces: "Jan 5, 2023", "5 Jan 2023", "January 5 2023"
    { id: 'MON_DD_YYYY', regex: /^([A-Za-z]+)[\s\-/]+(\d{1,2}),?[\s\-/]+(\d{4})$/, parse: (m) => { const mo = monthFromText(m[1]); return mo ? { y: +m[3], m: mo, d: +m[2] } : null; } },
    { id: 'DD_MON_YYYY', regex: /^(\d{1,2})[\s\-/]+([A-Za-z]+)[\s\-/]+(\d{4})$/, parse: (m) => { const mo = monthFromText(m[2]); return mo ? { y: +m[3], m: mo, d: +m[1] } : null; } },
    // Text with hyphens and short year: "21-May-25", "7-Mar-23", "1-Sep-24"
    { id: 'DD_MON_YY', regex: /^(\d{1,2})[\s\-/]+([A-Za-z]+)[\s\-/]+(\d{2})$/, parse: (m) => { const mo = monthFromText(m[2]); return mo ? { y: 2000 + +m[3], m: mo, d: +m[1] } : null; } },
    { id: 'MON_DD_YY', regex: /^([A-Za-z]+)[\s\-/]+(\d{1,2}),?[\s\-/]+(\d{2})$/, parse: (m) => { const mo = monthFromText(m[1]); return mo ? { y: 2000 + +m[3], m: mo, d: +m[2] } : null; } },
    // YYYYMMDD
    { id: 'YYYYMMDD', regex: /^(\d{4})(\d{2})(\d{2})$/, parse: (m) => ({ y: +m[1], m: +m[2], d: +m[3] }) },
];

const MONTH_MAP: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6,
    jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// ID column name patterns — includes abbreviated forms like acid (account-id), brid (branch-id), tno (txn-no)
const ID_PATTERNS = /(?:^id$|_id$|^id_|order_?id|cust(?:omer)?_?id|product_?id|trans(?:action)?_?id|invoice_?id|sku|code$|_code$|_no$|_num$|number$|_key$|^pk_|^fk_|^.{1,4}id$|^.{1,4}no$|^.{1,4}cd$|^s_?no$|^t_?no$|^sr_?no$|^acc_?(?:id|no)$|^acct_?(?:id|no)$|^emp_?(?:id|no)$|^cust_?(?:id|no)$|^br_?(?:id|no)$)/i;

// ╔══════════════════════════════════════════════════════════════════╗
// ║  HELPER FUNCTIONS                                               ║
// ╚══════════════════════════════════════════════════════════════════╝

function monthFromText(s: string): number | null {
    return MONTH_MAP[s.toLowerCase().slice(0, 3)] || null;
}

function isNullish(v: any): boolean {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    return false;
}

function excelDateToISO(serial: number): string | null {
    if (serial < 1 || serial > 2958465) return null; // Excel valid range
    const utcDays = Math.floor(serial - 25569);
    const ms = utcDays * 86400 * 1000;
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || day < 1 || day > 31) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function wordToNumber(s: string): number | null {
    const lower = s.toLowerCase().trim();
    if (WORD_NUMBERS[lower] !== undefined) return WORD_NUMBERS[lower];
    // Handle compound: "twenty-three", "twenty three"
    const parts = lower.split(/[-\s]+/);
    if (parts.length === 2) {
        const a = WORD_NUMBERS[parts[0]];
        const b = WORD_NUMBERS[parts[1]];
        if (a !== undefined && b !== undefined) {
            if (a >= 20 && b < 10) return a + b; // twenty-three = 23
            if (b === 100) return a * b; // two hundred = 200
            if (b === 1000) return a * b; // three thousand = 3000
        }
    }
    if (parts.length === 3) {
        const a = WORD_NUMBERS[parts[0]];
        const b = WORD_NUMBERS[parts[1]];
        const c = WORD_NUMBERS[parts[2]];
        if (a !== undefined && b === 100 && c !== undefined) return a * 100 + c; // five hundred three
    }
    return null;
}

function toTitleCase(s: string): string {
    return s.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function toISO(y: number, m: number, d: number): string {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isValidDate(y: number, m: number, d: number): boolean {
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return d <= daysInMonth;
}

/** Try parsing a single value as a date using a specific format ID */
function tryParseDateWithFormat(raw: any, formatId: string): string | null {
    if (raw === null || raw === undefined) return null;
    // JS Date object (from Excel parsing)
    if (raw instanceof Date) {
        const y = raw.getFullYear();
        const m = raw.getMonth() + 1;
        const d = raw.getDate();
        return isValidDate(y, m, d) ? toISO(y, m, d) : null;
    }
    // Excel serial number
    if (typeof raw === 'number' && raw > 30000 && raw < 60000) return excelDateToISO(raw);
    const s = String(raw).trim();
    if (!s) return null;
    // Already ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        return isValidDate(y, m, d) ? s : null;
    }
    // ISO datetime
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
        const [y, m, d] = s.split('T')[0].split('-').map(Number);
        return isValidDate(y, m, d) ? toISO(y, m, d) : null;
    }
    // Find matching format
    for (const fmt of DATE_FORMATS) {
        if (fmt.id !== formatId) continue;
        const match = s.match(fmt.regex);
        if (!match) continue;
        const parsed = fmt.parse(match);
        if (parsed && isValidDate(parsed.y, parsed.m, parsed.d)) {
            return toISO(parsed.y, parsed.m, parsed.d);
        }
    }
    return null;
}

/** Try parsing a value as a date using ANY format (for profiling) */
function tryParseDateAny(raw: any): { iso: string; formatId: string } | null {
    if (raw === null || raw === undefined) return null;
    // JS Date object (from Excel/XLSX parsing — this is the most common case!)
    if (raw instanceof Date) {
        if (!isNaN(raw.getTime())) {
            const y = raw.getFullYear();
            const m = raw.getMonth() + 1;
            const d = raw.getDate();
            if (isValidDate(y, m, d)) {
                return { iso: toISO(y, m, d), formatId: 'JS_DATE' };
            }
        }
        return null;
    }
    // Excel serial numbers
    if (typeof raw === 'number' && raw >= 30000 && raw <= 60000) {
        const iso = excelDateToISO(raw);
        return iso ? { iso, formatId: 'EXCEL_SERIAL' } : null;
    }
    const s = String(raw).trim();
    if (!s) return null;
    // ISO YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        return isValidDate(y, m, d) ? { iso: s, formatId: 'YYYY-MM-DD' } : null;
    }
    // ISO datetime
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
        const [y, m, d] = s.split('T')[0].split('-').map(Number);
        return isValidDate(y, m, d) ? { iso: toISO(y, m, d), formatId: 'YYYY-MM-DD' } : null;
    }
    // Try native JS Date parsing for long strings like "Tue Nov 08 2016 00:00:00 GMT..."
    // Only for strings that look like they might be dates (not pure numbers or short text)
    if (s.length > 10 && /[a-zA-Z]/.test(s)) {
        const nativeDate = new Date(s);
        if (!isNaN(nativeDate.getTime())) {
            const y = nativeDate.getFullYear();
            const m = nativeDate.getMonth() + 1;
            const d = nativeDate.getDate();
            if (isValidDate(y, m, d)) {
                return { iso: toISO(y, m, d), formatId: 'NATIVE_JS' };
            }
        }
    }
    for (const fmt of DATE_FORMATS) {
        const match = s.match(fmt.regex);
        if (!match) continue;
        const parsed = fmt.parse(match);
        if (parsed && isValidDate(parsed.y, parsed.m, parsed.d)) {
            return { iso: toISO(parsed.y, parsed.m, parsed.d), formatId: fmt.id };
        }
    }
    return null;
}

function log(step: string, layer: number, status: ETLLog['status'], details: string, extra?: Partial<ETLLog>): ETLLog {
    return { step, stepNumber: layer, details, status, timestamp: Date.now(), ...extra };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  LAYER 1: STRUCTURAL NORMALIZATION                              ║
// ╚══════════════════════════════════════════════════════════════════╝

function layer1_structuralNormalization(
    rawRows: Record<string, any>[]
): { rows: Record<string, any>[]; logs: ETLLog[]; columnsRemoved: number; duplicatesRemoved: number } {
    const logs: ETLLog[] = [];
    let columnsRemoved = 0;
    let duplicatesRemoved = 0;
    let rows = rawRows.map(r => ({ ...r }));

    // ── 1a: Header Normalization ──
    {
        const headerMap: Record<string, string> = {};
        let renamedCount = 0;
        Object.keys(rows[0]).forEach(h => {
            // Insert underscore before camelCase boundaries: SaleDate → Sale_Date, OrderID → Order_ID
            const camelSplit = h.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
            const normalized = camelSplit.trim().toLowerCase().replace(/[\s\W]+/g, '_').replace(/^_+|_+$/g, '') || `col_${Math.random().toString(36).substr(2, 5)}`;
            headerMap[h] = normalized;
            if (h !== normalized) renamedCount++;
        });
        rows = rows.map(row => {
            const newRow: any = {};
            Object.keys(row).forEach(k => newRow[headerMap[k] || k] = row[k]);
            return newRow;
        });
        logs.push(log('Header Normalization', 1, 'applied',
            `Normalized ${Object.keys(headerMap).length} headers to snake_case. ${renamedCount} renamed.`,
            { affectedColumns: Object.values(headerMap) }
        ));
    }

    // ── 1b: Auto-Merge Name Columns ──
    {
        const keys = Object.keys(rows[0] || {});
        const lk = keys.map(k => k.toLowerCase());
        const firstCol = keys.find((_, i) => ['first_name', 'firstname', 'first', 'given_name'].includes(lk[i]));
        const lastCol = keys.find((_, i) => ['last_name', 'lastname', 'last', 'surname', 'family_name'].includes(lk[i]));
        const middleCol = keys.find((_, i) => ['middle_name', 'middlename', 'middle', 'middle_initial'].includes(lk[i]));

        if (firstCol && lastCol) {
            const isCust = firstCol.toLowerCase().includes('customer') || lastCol.toLowerCase().includes('customer');
            const mergedName = isCust ? 'customer_name' : 'full_name';
            rows = rows.map(row => {
                const first = (row[firstCol] || '').toString().trim();
                const last = (row[lastCol] || '').toString().trim();
                const mid = middleCol ? (row[middleCol] || '').toString().trim() : '';
                const parts = [first, mid, last].filter(p => p.length > 0);
                const newRow: any = {};
                for (const [k, v] of Object.entries(row)) {
                    if (k === firstCol || k === lastCol || (middleCol && k === middleCol)) continue;
                    newRow[k] = v;
                }
                newRow[mergedName] = parts.join(' ') || 'Unknown';
                return newRow;
            });
            logs.push(log('Auto-Merge Name Columns', 1, 'applied',
                `Merged ${firstCol} + ${lastCol} → ${mergedName}.`,
                { affectedColumns: [firstCol, lastCol, mergedName] }
            ));
        } else {
            logs.push(log('Auto-Merge Name Columns', 1, 'skipped', 'No first/last name pair detected.'));
        }
    }

    // ── 1c: Duplicate Column Removal ──
    {
        const keys = Object.keys(rows[0]);
        const seen = new Set<string>();
        const dupes: string[] = [];
        keys.forEach(k => { if (seen.has(k)) dupes.push(k); else seen.add(k); });
        if (dupes.length > 0) {
            rows = rows.map(row => {
                const nr: any = {}; const added = new Set<string>();
                Object.keys(row).forEach(k => { if (!added.has(k)) { nr[k] = row[k]; added.add(k); } });
                return nr;
            });
            columnsRemoved += dupes.length;
            logs.push(log('Duplicate Column Removal', 1, 'applied', `Removed ${dupes.length} duplicate column(s).`, { affectedColumns: dupes }));
        } else {
            logs.push(log('Duplicate Column Removal', 1, 'skipped', 'No duplicate columns.'));
        }
    }

    // ── 1d: Empty Column Removal ──
    {
        const allKeys = Object.keys(rows[0]);
        const emptyCols = allKeys.filter(key => {
            const filled = rows.filter(r => !isNullish(r[key])).length;
            return filled / rows.length < 0.05;
        });
        if (emptyCols.length > 0) {
            rows = rows.map(row => {
                const nr: any = {};
                Object.keys(row).forEach(k => { if (!emptyCols.includes(k)) nr[k] = row[k]; });
                return nr;
            });
            columnsRemoved += emptyCols.length;
            logs.push(log('Empty Column Removal', 1, 'applied', `Removed ${emptyCols.length} column(s) with >95% empty.`, { affectedColumns: emptyCols }));
        } else {
            logs.push(log('Empty Column Removal', 1, 'skipped', 'All columns have >5% fill rate.'));
        }
    }

    // ── 1e: Empty Row Removal ──
    {
        const before = rows.length;
        const activeKeys = Object.keys(rows[0] || {});
        const emptyRows: Record<string, any>[] = [];
        const keptRows: Record<string, any>[] = [];
        for (const row of rows) {
            if (activeKeys.some(k => !isNullish(row[k]))) {
                keptRows.push(row);
            } else {
                if (emptyRows.length < 10) emptyRows.push(row);
            }
        }
        rows = keptRows;
        const removed = before - rows.length;
        if (removed > 0) {
            logs.push(log('Empty Row Removal', 1, 'applied', `Removed ${removed} empty row(s).`, { rowsBefore: before, rowsAfter: rows.length, removedRowSamples: emptyRows }));
        } else {
            logs.push(log('Empty Row Removal', 1, 'skipped', 'No empty rows.'));
        }
    }

    // ── 1f: Duplicate Row Removal (using truly unique ID/PK columns only) ──
    {
        const before = rows.length;
        const allCols = Object.keys(rows[0] || {});

        // Find candidate ID columns by name pattern
        const candidateIdCols = allCols.filter(col => ID_PATTERNS.test(col));

        // Validate candidates: only use columns with high uniqueness (≥90% distinct)
        // This prevents foreign keys (branch_id, product_id) from being used as primary keys
        const trueIdCols = candidateIdCols.filter(col => {
            const vals = rows.map(r => r[col]);
            const distinct = new Set(vals.map(v => JSON.stringify(v))).size;
            return distinct / rows.length >= 0.9;
        });

        const dedupCols = trueIdCols.length > 0 ? trueIdCols : allCols;
        const strategy = trueIdCols.length > 0
            ? `primary key match on ${trueIdCols.length} unique ID column(s): ${trueIdCols.join(', ')}`
            : `exact match across all ${allCols.length} columns`;

        const seen = new Set<string>();
        const duplicateRows: Record<string, any>[] = [];
        const uniqueRows: Record<string, any>[] = [];
        for (const row of rows) {
            const key = dedupCols.map(c => JSON.stringify(row[c])).join('|');
            if (seen.has(key)) {
                if (duplicateRows.length < 10) duplicateRows.push(row);
            } else {
                seen.add(key);
                uniqueRows.push(row);
            }
        }

        // Safety guard: if dedup removes >50% of rows, it's likely a false positive
        const wouldRemove = before - uniqueRows.length;
        if (wouldRemove > before * 0.5 && trueIdCols.length > 0) {
            // Don't apply — too aggressive, likely using wrong keys
            logs.push(log('Duplicate Row Removal', 1, 'skipped',
                `Skipped: dedup on ${trueIdCols.join(', ')} would remove ${wouldRemove} of ${before} rows (${Math.round(wouldRemove / before * 100)}%). Likely foreign keys, not primary keys.`));
        } else {
            rows = uniqueRows;
            duplicatesRemoved = before - rows.length;
            if (duplicatesRemoved > 0) {
                logs.push(log('Duplicate Row Removal', 1, 'applied',
                    `Removed ${duplicatesRemoved} duplicate row(s). Strategy: ${strategy}.`,
                    { rowsBefore: before, rowsAfter: rows.length, removedRowSamples: duplicateRows, affectedColumns: dedupCols }));
            } else {
                logs.push(log('Duplicate Row Removal', 1, 'skipped', `No duplicate rows found (strategy: ${strategy}).`));
            }
        }
    }

    return { rows, logs, columnsRemoved, duplicatesRemoved };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  LAYER 2: CANONICAL VALUE PREP                                  ║
// ╚══════════════════════════════════════════════════════════════════╝

function layer2_canonicalValuePrep(
    rows: Record<string, any>[]
): { rows: Record<string, any>[]; logs: ETLLog[]; nullsFixed: number } {
    const logs: ETLLog[] = [];
    let trimCount = 0;
    let nullTokenCount = 0;
    const trimCols = new Set<string>();
    const nullCols = new Set<string>();

    rows = rows.map(row => {
        const nr: any = {};
        Object.keys(row).forEach(k => {
            let v = row[k];
            if (typeof v === 'string') {
                // Trim + collapse spaces
                const trimmed = v.trim().replace(/\s+/g, ' ');
                if (trimmed !== v) { trimCount++; trimCols.add(k); }
                v = trimmed;
                // Null token check (on lowered version, but keep original)
                if (v !== '' && NULL_TOKENS.has(v.toLowerCase())) {
                    v = null;
                    nullTokenCount++;
                    nullCols.add(k);
                }
            }
            nr[k] = v;
        });
        return nr;
    });

    if (trimCount > 0) {
        logs.push(log('Whitespace Normalization', 2, 'applied',
            `Trimmed/collapsed whitespace in ${trimCount} cell(s) across ${trimCols.size} column(s).`,
            { affectedColumns: [...trimCols], affectedRows: trimCount }
        ));
    } else {
        logs.push(log('Whitespace Normalization', 2, 'skipped', 'No whitespace issues.'));
    }

    if (nullTokenCount > 0) {
        logs.push(log('Null Token Standardization', 2, 'applied',
            `Converted ${nullTokenCount} null token(s) (N/A, null, -, etc.) to NULL in ${nullCols.size} column(s).`,
            { affectedColumns: [...nullCols], affectedRows: nullTokenCount }
        ));
    } else {
        logs.push(log('Null Token Standardization', 2, 'skipped', 'No null tokens detected.'));
    }

    return { rows, logs, nullsFixed: nullTokenCount };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  LAYER 3: COLUMN PROFILING                                      ║
// ╚══════════════════════════════════════════════════════════════════╝

function layer3_columnProfiling(rows: Record<string, any>[]): { profiles: ColumnProfileData[]; logs: ETLLog[] } {
    const logs: ETLLog[] = [];
    const keys = Object.keys(rows[0] || {});
    const profiles: ColumnProfileData[] = [];

    for (const col of keys) {
        const values = rows.map(r => r[col]);
        const total = values.length;
        const nonNull = values.filter(v => v !== null && v !== undefined);
        const nullRate = total > 0 ? (total - nonNull.length) / total : 0;
        const strValues = nonNull.map(v => String(v).trim()).filter(s => s !== '');
        const distinctCount = new Set(strValues.map(s => s.toLowerCase())).size;

        // Numeric parse rate (after stripping currency/commas)
        let numericCount = 0;
        let min = Infinity;
        let max = -Infinity;
        let currencyDetected = false;
        let percentageDetected = false;
        let wordNumberCount = 0;

        for (const v of nonNull) {
            const s = String(v);
            if (CURRENCY_REGEX.test(s)) currencyDetected = true;
            if (s.includes('%')) percentageDetected = true;
            // Word number check
            if (typeof v === 'string' && wordToNumber(v) !== null) {
                wordNumberCount++;
                numericCount++;
                continue;
            }
            const stripped = s.replace(CURRENCY_STRIP_REGEX, '').replace(/%/g, '').trim();
            // Use Number() instead of parseFloat() to prevent partial parsing
            // parseFloat("9/17/2024") returns 9 (wrong!), Number("9/17/2024") returns NaN (correct)
            if (stripped === '') continue;
            const num = Number(stripped);
            if (!isNaN(num)) {
                numericCount++;
                if (num < min) min = num;
                if (num > max) max = num;
            }
        }

        // Date parse rate — count TOTAL parseable values across ALL formats
        let bestDateFormat: string | null = null;
        let totalDateParseable = 0;
        const formatCounts: Record<string, number> = {};

        for (const v of nonNull) {
            // Check for Excel serial date numbers (30000-60000 range)
            if (typeof v === 'number' && v >= 30000 && v <= 60000) {
                const isoDate = excelDateToISO(v);
                if (isoDate) {
                    totalDateParseable++;
                    formatCounts['EXCEL_SERIAL'] = (formatCounts['EXCEL_SERIAL'] || 0) + 1;
                    continue;
                }
            }
            const result = tryParseDateAny(v);
            if (result) {
                totalDateParseable++;
                formatCounts[result.formatId] = (formatCounts[result.formatId] || 0) + 1;
            }
        }

        // Disambiguate MM/DD vs DD/MM using evidence
        let hasDayOver12 = false;
        let hasMonthOver12 = false;
        for (const v of nonNull) {
            const s = String(v).trim();
            const match = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
            if (match) {
                const first = +match[1];
                const second = +match[2];
                if (first > 12) hasDayOver12 = true; // First num > 12 → must be day → DD/MM
                if (second > 12) hasMonthOver12 = true; // Second num > 12 → must be day → MM/DD
            }
        }
        // Resolve ambiguity
        if (hasDayOver12 && !hasMonthOver12) {
            delete formatCounts['MM/DD/YYYY'];
            delete formatCounts['MM/DD/YY'];
        } else if (hasMonthOver12 && !hasDayOver12) {
            delete formatCounts['DD/MM/YYYY'];
            delete formatCounts['DD/MM/YY'];
        }
        // Pick format with most matches (for actual parsing later)
        let bestDateRate = 0;
        for (const [fmt, count] of Object.entries(formatCounts)) {
            if (count > bestDateRate) { bestDateRate = count; bestDateFormat = fmt; }
        }
        // dateParseRate = total parseable / total non-null (across ALL formats combined)
        const dateParseRate = nonNull.length > 0 ? totalDateParseable / nonNull.length : 0;

        // Boolean token rate
        const boolCount = nonNull.filter(v => typeof v === 'string' && BOOLEAN_TOKENS[v.toLowerCase().trim()] !== undefined).length;

        const profile: ColumnProfileData = {
            name: col,
            nullRate,
            distinctCount,
            totalValues: nonNull.length,
            numericParseRate: nonNull.length > 0 ? numericCount / nonNull.length : 0,
            dateParseRate,
            booleanTokenRate: nonNull.length > 0 ? boolCount / nonNull.length : 0,
            min: min === Infinity ? undefined : min,
            max: max === -Infinity ? undefined : max,
            dateFormatCandidate: bestDateFormat,
            currencyDetected,
            percentageDetected,
            wordNumberRate: nonNull.length > 0 ? wordNumberCount / nonNull.length : 0,
        };

        profiles.push(profile);
    }

    // Log profiling results
    const summary = profiles.map(p =>
        `${p.name}: num=${(p.numericParseRate * 100).toFixed(0)}% date=${(p.dateParseRate * 100).toFixed(0)}% bool=${(p.booleanTokenRate * 100).toFixed(0)}% null=${(p.nullRate * 100).toFixed(0)}% distinct=${p.distinctCount}` +
        (p.dateFormatCandidate ? ` fmt=${p.dateFormatCandidate}` : '') +
        (p.currencyDetected ? ' $' : '') +
        (p.percentageDetected ? ' %' : '')
    ).join('\n');
    logs.push(log('Column Profiling', 3, 'applied',
        `Profiled ${profiles.length} columns.\n${summary}`,
        { affectedColumns: profiles.map(p => p.name) }
    ));

    return { profiles, logs };
}

// Continued in Layers 4-7 and main pipeline below...

// ╔══════════════════════════════════════════════════════════════════╗
// ║  LAYER 4: RULE PLANNER (Classification Gates)                   ║
// ╚══════════════════════════════════════════════════════════════════╝

function layer4_rulePlanner(
    profiles: ColumnProfileData[],
    columnTypeOverrides?: Record<string, ColumnType>
): { columns: ColumnDefinition[]; plans: TransformPlan[]; logs: ETLLog[] } {
    const logs: ETLLog[] = [];
    const columns: ColumnDefinition[] = [];
    const plans: TransformPlan[] = [];

    // Metric name patterns — exact match for standalone names
    const METRIC_NAME_EXACT = /^(quantity|qty|amount|amt|price|cost|total|sum|count|revenue|sales|profit|discount|tax|fee|rate|score|weight|volume|height|width|length|balance|budget|salary|wage|income|expense|margin|stock|inventory|units|value|avg|average|num|number)$/i;

    // Metric keyword fragments — for compound names like txn_amount, total_sales, net_revenue
    const METRIC_KEYWORDS = /(?:^|[_\s])(amount|amt|qty|quantity|price|cost|total|sum|count|revenue|sales|profit|discount|tax|fee|rate|score|weight|volume|height|width|length|balance|budget|salary|wage|income|expense|margin|stock|inventory|units|value|average|avg|number|num|charge|payment|spend|earning|payout|funding|debt|credit|debit|turnover|premium|commission|bonus|interest|deposit|withdrawal|refund|surcharge|tariff|fare|toll|rent|royalty|stipend)(?:[_\s]|$)/i;

    // Date name patterns (strong signal for date classification)
    const DATE_NAME_PATTERNS = /^(date|sale_?date|order_?date|purchase_?date|created_?at|updated_?at|ship_?date|delivery_?date|birth_?date|dob|start_?date|end_?date|due_?date|invoice_?date|payment_?date|registration_?date|timestamp|datetime|created|modified|posted|expired|effective)$/i;

    for (const p of profiles) {
        let type: ColumnType;
        const steps: TransformStep[] = [];

        // Apply user override if present
        if (columnTypeOverrides && columnTypeOverrides[p.name]) {
            type = columnTypeOverrides[p.name];
            logs.push(log('User Override', 4, 'info', `Column '${p.name}' set to ${type} (manual override).`, { affectedColumns: [p.name] }));
        } else {
            const isMetricName = METRIC_NAME_EXACT.test(p.name) || METRIC_KEYWORDS.test(p.name);
            const isDateName = DATE_NAME_PATTERNS.test(p.name);
            const effectiveNumericRate = p.numericParseRate + (p.wordNumberRate || 0);

            // ── Gate 1: ID detection (by name pattern) ──
            if (ID_PATTERNS.test(p.name)) {
                type = ColumnType.ID;
            }
            // ── Gate 2: Date gate (>50% parse rate) ──
            else if (p.dateParseRate >= 0.5) {
                type = ColumnType.DATE;
            }
            // ── Gate 2b: Date by name — trust the column name pattern ──
            else if (isDateName) {
                type = ColumnType.DATE;
            }
            // ── Gate 3: Boolean gate (≥60% boolean tokens) ──
            else if (p.booleanTokenRate >= 0.6) {
                type = ColumnType.BOOLEAN; // Booleans get their own type with bool normalization
            }
            // ── Gate 4: Metric by name + numeric data — trust the name ──
            else if (isMetricName && effectiveNumericRate >= 0.3) {
                type = ColumnType.METRIC;
            }
            // ── Gate 4b: Metric gate (high numeric rate + sufficient cardinality) ──
            // BUT: first check if this is a numeric ATTRIBUTE (age, rating, etc.)
            // using statistical signals — bounded range, integer values, low cardinality
            else if (effectiveNumericRate >= 0.7 && p.distinctCount >= 10 && !ID_PATTERNS.test(p.name)) {
                // Check if this looks like a numeric attribute vs a business metric
                const pMin = p.min;
                const pMax = p.max;
                const isAttribute = (() => {
                    if (pMin === undefined || pMax === undefined) return false;

                    // Never reclassify columns with strong business metric names
                    const STRONG_METRIC = /(?:^|[_\s])(sales|revenue|profit|cost|price|amount|total|income|salary|wage|pay|compensation|expense|fee|charge|payment|spend|earning|bonus|commission|balance|budget|discount|tax|shipping|freight|margin|debt|credit|debit|turnover|premium|interest|deposit|refund|rent|royalty|stipend|funding|payout)(?:[_\s]|$)/i;
                    if (STRONG_METRIC.test(p.name)) return false;

                    const span = pMax - pMin;
                    const maxVal = Math.max(Math.abs(pMin), Math.abs(pMax));

                    // Signal 1: Bounded human-scale range (0–200)
                    const bounded = maxVal > 0 && maxVal <= 200 && span > 0 && span <= 200;
                    // Signal 2: Integer-only values
                    const integers = Number.isInteger(pMin) && Number.isInteger(pMax);
                    // Signal 3: Low distinct-to-row ratio (< 15% unique)
                    const lowDistinct = p.totalValues > 0 && (p.distinctCount / p.totalValues) < 0.15;

                    const signals = [bounded, integers, lowDistinct].filter(Boolean).length;
                    return signals >= 2;
                })();

                if (isAttribute) {
                    type = ColumnType.DIMENSION;
                    logs.push(log('Attribute Detection', 4, 'info',
                        `Column '${p.name}' reclassified as DIMENSION (numeric attribute) — ` +
                        `range: ${pMin}–${pMax}, distinct: ${p.distinctCount}/${p.totalValues}`,
                        { affectedColumns: [p.name] }));
                } else {
                    type = ColumnType.METRIC;
                }
            }
            // ── Gate 5: Low-cardinality numeric = ID ──
            else if (p.numericParseRate >= 0.9 && p.distinctCount < 10 && p.totalValues > 0 && p.distinctCount / p.totalValues < 0.05) {
                type = ColumnType.ID;
            }
            // ── Default: Dimension ──
            else {
                type = ColumnType.DIMENSION;
            }
        }

        // Build transform plan based on type
        if (type === ColumnType.METRIC) {
            if (p.currencyDetected) steps.push({ name: 'REMOVE_CURRENCY', fn: (v: any) => typeof v === 'string' ? v.replace(CURRENCY_STRIP_REGEX, '') : v });
            if (p.percentageDetected) steps.push({ name: 'REMOVE_PERCENTAGE', fn: (v: any) => typeof v === 'string' ? v.replace(/%/g, '').trim() : v });
            if (p.wordNumberRate > 0) steps.push({ name: 'WORD_TO_NUMBER', fn: (v: any) => { if (typeof v !== 'string') return v; const n = wordToNumber(v); return n !== null ? n : v; } });
            steps.push({ name: 'PARSE_NUMBER', fn: (v: any) => { if (typeof v === 'number') return v; const s = String(v).replace(/[,\s]/g, ''); const n = parseFloat(s); return isNaN(n) ? null : n; } });
            steps.push({ name: 'IMPUTE_NULL', fn: (v: any) => (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) ? null : v });
        } else if (type === ColumnType.DATE) {
            const fmt = p.dateFormatCandidate || 'YYYY-MM-DD';
            steps.push({ name: `PARSE_DATE(${fmt})`, fn: (v: any) => tryParseDateWithFormat(v, fmt) || tryParseDateAny(v)?.iso || null });
        } else if (type === ColumnType.BOOLEAN) {
            steps.push({
                name: 'NORMALIZE_BOOLEAN', fn: (v: any) => {
                    if (v === true) return 'True';
                    if (v === false) return 'False';
                    if (typeof v === 'number') return v === 1 ? 'True' : v === 0 ? 'False' : String(v);
                    if (typeof v !== 'string') return v;
                    const b = BOOLEAN_TOKENS[v.toLowerCase().trim()];
                    return b !== undefined ? (b ? 'True' : 'False') : v;
                }
            });
            steps.push({ name: 'IMPUTE_UNKNOWN', fn: (v: any) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) ? 'Unknown' : v });
        } else if (type === ColumnType.DIMENSION) {
            steps.push({ name: 'TITLE_CASE', fn: (v: any) => typeof v === 'string' && v.trim() !== '' ? toTitleCase(v) : v });
            // Add synonym normalization step
            steps.push({
                name: 'SYNONYM_MAP', fn: (v: any) => {
                    if (typeof v !== 'string' || v.trim() === '') return v;
                    const colSynonyms = CATEGORY_SYNONYMS[p.name];
                    if (colSynonyms && colSynonyms[v]) return colSynonyms[v];
                    for (const group of Object.values(CATEGORY_SYNONYMS)) {
                        if (group[v]) return group[v];
                    }
                    return v;
                }
            });
            steps.push({ name: 'IMPUTE_UNKNOWN', fn: (v: any) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) ? 'Unknown' : v });
        } else if (type === ColumnType.ID) {
            // Cast IDs to clean integer strings (1.0 → "1", not "1.0")
            steps.push({
                name: 'CAST_ID', fn: (v: any) => {
                    if (v === null || v === undefined || v === '') return v;
                    const n = Number(v);
                    if (!isNaN(n) && Number.isFinite(n)) return String(Math.round(n));
                    return String(v).trim();
                }
            });
        }

        columns.push({ name: p.name, type, originalType: 'string' });
        plans.push({ column: p.name, type, steps });
    }

    const metrics = columns.filter(c => c.type === ColumnType.METRIC).length;
    const dates = columns.filter(c => c.type === ColumnType.DATE).length;
    const dims = columns.filter(c => c.type === ColumnType.DIMENSION).length;
    const ids = columns.filter(c => c.type === ColumnType.ID).length;

    logs.push(log('Column Classification', 4, 'applied',
        `Classified ${columns.length} columns: ${metrics} metric(s), ${dates} date(s), ${dims} dimension(s), ${ids} ID(s).`,
        { affectedColumns: columns.map(c => c.name) }
    ));

    // Log transform plans
    const planSummary = plans.filter(p => p.steps.length > 0).map(p =>
        `${p.column} (${p.type}): ${p.steps.map(s => s.name).join(' → ')}`
    ).join('\n');
    logs.push(log('Transform Plans', 4, 'info', `Generated ${plans.length} transform plans:\n${planSummary}`));

    return { columns, plans, logs };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  LAYER 5: TRANSFORMATION ENGINE                                 ║
// ╚══════════════════════════════════════════════════════════════════╝

function layer5_transformationEngine(
    rows: Record<string, any>[],
    plans: TransformPlan[]
): { rows: Record<string, any>[]; lineage: ColumnLineage[]; logs: ETLLog[]; typeCastCount: number } {
    const logs: ETLLog[] = [];
    const lineage: ColumnLineage[] = [];
    let typeCastCount = 0;

    for (const plan of plans) {
        if (plan.steps.length === 0) {
            lineage.push({ column: plan.column, chain: [] });
            continue;
        }

        const chain: LineageNode[] = [];

        for (const step of plan.steps) {
            let changed = 0;
            let failed = 0;
            const inputSamples: string[] = [];
            const outputSamples: string[] = [];
            let samplesCollected = 0;

            for (let i = 0; i < rows.length; i++) {
                const oldVal = rows[i][plan.column];
                try {
                    const newVal = step.fn(oldVal);
                    if (newVal !== oldVal && !(oldVal === undefined && newVal === undefined)) {
                        changed++;
                        typeCastCount++;
                        if (samplesCollected < 5) {
                            inputSamples.push(String(oldVal ?? 'null'));
                            outputSamples.push(String(newVal ?? 'null'));
                            samplesCollected++;
                        }
                    }
                    rows[i][plan.column] = newVal;
                } catch {
                    failed++;
                }
            }

            chain.push({ column: plan.column, step: step.name, rowsChanged: changed, rowsFailed: failed, inputSamples, outputSamples });

            if (changed > 0 || failed > 0) {
                const sampleStr = inputSamples.slice(0, 3).map((inp, i) => `"${inp}" → "${outputSamples[i]}"`).join(', ');
                const tSamples = inputSamples.slice(0, 5).map((inp, i) => ({ column: plan.column, before: inp, after: outputSamples[i] }));
                logs.push(log(`Transform: ${step.name}`, 5, 'applied',
                    `Column '${plan.column}': ${changed} changed, ${failed} failed. Samples: ${sampleStr}`,
                    { affectedColumns: [plan.column], affectedRows: changed, transformSamples: tSamples }
                ));
            }
        }

        lineage.push({ column: plan.column, chain });
    }

    logs.push(log('Transformation Engine', 5, 'applied',
        `Executed ${plans.reduce((s, p) => s + p.steps.length, 0)} transform steps across ${plans.length} columns. ${typeCastCount} total cell changes.`
    ));

    return { rows, lineage, logs, typeCastCount };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  LAYER 6: DATA CONTRACT VALIDATION                              ║
// ╚══════════════════════════════════════════════════════════════════╝

function layer6_dataContractValidation(
    rows: Record<string, any>[],
    columns: ColumnDefinition[]
): { contract: DataContract; logs: ETLLog[] } {
    const logs: ETLLog[] = [];
    const violations: ContractViolation[] = [];

    // ── Hard contracts ──
    if (rows.length === 0) {
        violations.push({ column: '*', rule: 'MIN_ROWS', severity: 'hard', message: 'Dataset has 0 rows after cleaning.' });
    }
    if (columns.length === 0) {
        violations.push({ column: '*', rule: 'MIN_COLUMNS', severity: 'hard', message: 'Dataset has 0 columns after cleaning.' });
    }
    const metricCols = columns.filter(c => c.type === ColumnType.METRIC);
    if (metricCols.length === 0 && columns.length > 0) {
        violations.push({ column: '*', rule: 'NO_METRICS', severity: 'soft', message: 'No metric columns detected. Analytics may be limited.' });
    }

    // ── Soft contracts per column ──
    const allKeys = Object.keys(rows[0] || {});
    for (const col of allKeys) {
        const colDef = columns.find(c => c.name === col);
        const values = rows.map(r => r[col]);
        const nullCount = values.filter(v => v === null || v === undefined || v === '').length;
        const nullRate = rows.length > 0 ? nullCount / rows.length : 0;

        // Completeness check
        if (nullRate > 0.2) {
            violations.push({ column: col, rule: 'COMPLETENESS', severity: 'soft', message: `${col}: ${(nullRate * 100).toFixed(0)}% null (>20% threshold).` });
        }

        // Metric-specific
        if (colDef?.type === ColumnType.METRIC) {
            const lc = col.toLowerCase();
            const shouldBePositive = ['price', 'revenue', 'sales', 'quantity', 'qty', 'units', 'count', 'amount', 'total'].some(k => lc.includes(k));
            if (shouldBePositive) {
                const negCount = values.filter(v => typeof v === 'number' && v < 0).length;
                if (negCount > 0) {
                    violations.push({ column: col, rule: 'NON_NEGATIVE', severity: 'soft', message: `${col}: ${negCount} negative value(s) in typically positive column.` });
                }
            }

            // Outlier detection (IQR)
            const numVals = values.filter(v => typeof v === 'number' && !isNaN(v)).sort((a, b) => a - b) as number[];
            if (numVals.length >= 10) {
                const q1 = numVals[Math.floor(numVals.length * 0.25)];
                const q3 = numVals[Math.floor(numVals.length * 0.75)];
                const iqr = q3 - q1;
                if (iqr > 0) {
                    const lower = q1 - 1.5 * iqr;
                    const upper = q3 + 1.5 * iqr;
                    const outliers = numVals.filter(v => v < lower || v > upper);
                    const outlierCount = outliers.length;
                    if (outlierCount > 0) {
                        const examples = outliers.slice(0, 5).map(v => v.toLocaleString(undefined, { maximumFractionDigits: 2 })).join(', ');
                        violations.push({ column: col, rule: 'OUTLIER', severity: 'soft', message: `${col}: ${outlierCount} outlier(s) outside [${lower.toFixed(1)}, ${upper.toFixed(1)}]. Examples: ${examples}` });
                    }
                }
            }
        }

        // Date-specific
        if (colDef?.type === ColumnType.DATE) {
            const today = new Date().toISOString().split('T')[0];
            const futureCount = values.filter(v => typeof v === 'string' && v > today).length;
            if (futureCount > 0) {
                violations.push({ column: col, rule: 'FUTURE_DATE', severity: 'soft', message: `${col}: ${futureCount} future date(s) detected.` });
            }
        }
    }

    const hardCount = violations.filter(v => v.severity === 'hard').length;
    const softCount = violations.filter(v => v.severity === 'soft').length;
    const status: DataContract['status'] = hardCount > 0 ? 'unsafe' : softCount > 0 ? 'warning' : 'safe';

    const contract: DataContract = { status, violations };

    if (violations.length > 0) {
        const details = violations.map(v => `[${v.severity.toUpperCase()}] ${v.message}`).join('\n');
        logs.push(log('Data Contract Validation', 6, hardCount > 0 ? 'info' : 'applied',
            `Contract: ${status.toUpperCase()}. ${hardCount} hard, ${softCount} soft violation(s).\n${details}`,
            { affectedColumns: [...new Set(violations.map(v => v.column))] }
        ));
    } else {
        logs.push(log('Data Contract Validation', 6, 'applied', 'All data contracts passed. Dataset is safe for analytics.'));
    }

    return { contract, logs };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  POST-PIPELINE: TimeContext + DimDate + Quality Score            ║
// ╚══════════════════════════════════════════════════════════════════╝

function buildTimeContext(rows: Record<string, any>[], columns: ColumnDefinition[]): { timeContext?: TimeContext; logs: ETLLog[] } {
    const logs: ETLLog[] = [];
    let dateCols = columns.filter(c => c.type === ColumnType.DATE).map(c => c.name);

    // Helper: try to parse any date string to ISO (YYYY-MM-DD)
    const tryParseToISO = (v: any): string | null => {
        if (v == null) return null;
        const s = String(v).trim();
        // Already ISO
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        // M/D/YYYY or MM/DD/YYYY
        const slashMatch = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
        if (slashMatch) {
            const [, p1, p2, yr] = slashMatch;
            const m = p1.padStart(2, '0');
            const d = p2.padStart(2, '0');
            if (+m <= 12 && +d <= 31) return `${yr}-${m}-${d}`;
            // Try D/M/YYYY
            if (+p2 <= 12 && +p1 <= 31) return `${yr}-${p2.padStart(2, '0')}-${p1.padStart(2, '0')}`;
        }
        // YYYY/MM/DD
        const ymdSlash = s.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/);
        if (ymdSlash) {
            const [, yr, m, d] = ymdSlash;
            if (+m <= 12 && +d <= 31) return `${yr}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
        // Try JS Date parse for other formats (e.g., "Jan 3, 2017")
        const d = new Date(s);
        if (!isNaN(d.getTime()) && d.getFullYear() > 1900 && d.getFullYear() < 2100) {
            return d.toISOString().split('T')[0];
        }
        return null;
    };

    // Fallback 1: if no DATE-typed columns, check columns with date-like NAMES
    if (dateCols.length === 0 && rows.length > 0) {
        const DATE_NAME_HINTS = /(?:date|_dt$|_date$|created|updated|timestamp|order_date|ship_date|sale_date|invoice_date|purchase_date)/i;
        const allKeys = Object.keys(rows[0] || {});

        // First priority: columns whose names look like dates
        for (const col of allKeys) {
            if (!DATE_NAME_HINTS.test(col)) continue;
            const sample = rows.slice(0, Math.min(30, rows.length));
            const dateCount = sample.filter(r => tryParseToISO(r[col]) !== null).length;
            if (dateCount >= sample.length * 0.4) {
                dateCols.push(col);
            }
        }

        // Second priority: any column with >50% parseable date values
        if (dateCols.length === 0) {
            for (const col of allKeys) {
                const sample = rows.slice(0, Math.min(20, rows.length));
                const dateCount = sample.filter(r => tryParseToISO(r[col]) !== null).length;
                if (dateCount >= sample.length * 0.5) {
                    dateCols.push(col);
                }
            }
        }

        if (dateCols.length > 0) {
            logs.push(log('TimeContext', 7, 'info', `No DATE-typed columns found. Detected date values in: ${dateCols.join(', ')}.`));
        }
    }

    if (dateCols.length === 0) {
        logs.push(log('TimeContext', 7, 'skipped', 'No date columns detected.'));
        return { logs };
    }

    let gMin = '';
    let gMax = '';
    const perColMax: Record<string, string> = {};

    rows.forEach(row => {
        dateCols.forEach(col => {
            const iso = tryParseToISO(row[col]);
            if (iso) {
                if (!gMin || iso < gMin) gMin = iso;
                if (!gMax || iso > gMax) gMax = iso;
                if (!perColMax[col] || iso > perColMax[col]) perColMax[col] = iso;
            }
        });
    });

    if (!gMin || !gMax) {
        logs.push(log('TimeContext', 7, 'skipped', 'No valid date values found.'));
        return { logs };
    }

    // Auto-detect anchor column by priority
    const priorityTests: ((lc: string) => boolean)[] = [
        lc => lc.includes('order') && !lc.includes('ship'),
        lc => lc.includes('transaction'),
        lc => lc.includes('invoice'),
        lc => lc === 'sale_date' || lc === 'sales_date' || lc === 'saledate',
        lc => lc === 'date',
    ];
    let anchorCol = '';
    for (const test of priorityTests) {
        const match = dateCols.find(c => test(c.toLowerCase()));
        if (match && perColMax[match]) { anchorCol = match; break; }
    }
    if (!anchorCol) anchorCol = dateCols.find(c => perColMax[c]) || dateCols[0];

    const timeContext: TimeContext = {
        minDate: gMin,
        maxDate: gMax,
        defaultAnchorDate: perColMax[anchorCol] || gMax,
        anchorDateColumn: anchorCol,
        dateColumnMaxDates: perColMax,
    };

    logs.push(log('TimeContext', 7, 'applied',
        `Built TimeContext: anchor="${anchorCol}" (${timeContext.defaultAnchorDate}), range ${gMin} → ${gMax}.`
    ));

    return { timeContext, logs };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  MAIN PIPELINE: runETLPipeline                                  ║
// ╚══════════════════════════════════════════════════════════════════╝

export function runETLPipeline(
    rawData: Record<string, any>[],
    _fileName: string,
    columnTypeOverrides?: Record<string, ColumnType>
): {
    rows: Record<string, any>[];
    columns: ColumnDefinition[];
    logs: ETLLog[];
    timeContext?: TimeContext;
    dimDate?: DimDateRow[];
    qualityScore: number;
    lineage?: ColumnLineage[];
    contract?: DataContract;
    summary: {
        totalRowsBefore: number; totalRowsAfter: number;
        totalColumnsOriginal: number; totalColumnsFinal: number;
        rowsRemoved: number; columnsRemoved: number;
        nullsFixed: number; duplicatesRemoved: number;
        typeCastCount: number;
    };
} {
    const allLogs: ETLLog[] = [];
    const totalRowsBefore = rawData.length;
    const totalColumnsOriginal = rawData.length > 0 ? Object.keys(rawData[0]).length : 0;

    if (!rawData || rawData.length === 0) {
        return {
            rows: [], columns: [], logs: [], qualityScore: 0,
            summary: { totalRowsBefore: 0, totalRowsAfter: 0, totalColumnsOriginal: 0, totalColumnsFinal: 0, rowsRemoved: 0, columnsRemoved: 0, nullsFixed: 0, duplicatesRemoved: 0, typeCastCount: 0 }
        };
    }

    console.log(`[ETL] Starting 7-Layer Pipeline on ${totalRowsBefore} rows, ${totalColumnsOriginal} columns`);

    // ── LAYER 1: Structural Normalization ──
    const l1 = layer1_structuralNormalization(rawData);
    let rows = l1.rows;
    allLogs.push(...l1.logs);
    console.log(`[ETL L1] Structural: ${rows.length} rows, ${Object.keys(rows[0] || {}).length} cols`);

    // ── LAYER 2: Canonical Value Prep ──
    const l2 = layer2_canonicalValuePrep(rows);
    rows = l2.rows;
    allLogs.push(...l2.logs);
    console.log(`[ETL L2] Canonical: ${l2.nullsFixed} null tokens fixed`);

    // ── LAYER 3: Column Profiling ──
    const l3 = layer3_columnProfiling(rows);
    allLogs.push(...l3.logs);
    console.log(`[ETL L3] Profiled ${l3.profiles.length} columns`);

    // ── LAYER 4: Rule Planner ──
    const l4 = layer4_rulePlanner(l3.profiles, columnTypeOverrides);
    allLogs.push(...l4.logs);
    console.log(`[ETL L4] Classified: ${l4.columns.map(c => `${c.name}=${c.type}`).join(', ')}`);

    // ── LAYER 5: Transformation Engine ──
    const l5 = layer5_transformationEngine(rows, l4.plans);
    rows = l5.rows;
    allLogs.push(...l5.logs);
    console.log(`[ETL L5] Transformed: ${l5.typeCastCount} cell changes`);

    // ── LAYER 6: Data Contract Validation ──
    const l6 = layer6_dataContractValidation(rows, l4.columns);
    allLogs.push(...l6.logs);
    console.log(`[ETL L6] Contract: ${l6.contract.status} (${l6.contract.violations.length} violations)`);

    // ── POST: TimeContext ──
    const tc = buildTimeContext(rows, l4.columns);
    allLogs.push(...tc.logs);

    // ── POST: DimDate ──
    let dimDate: DimDateRow[] | undefined;
    if (tc.timeContext?.minDate && tc.timeContext?.maxDate) {
        dimDate = generateDimDate(tc.timeContext.minDate, tc.timeContext.maxDate);
        allLogs.push(log('DimDate Generation', 7, 'applied',
            `Generated ${dimDate.length} date rows: ${tc.timeContext.minDate} → ${tc.timeContext.maxDate}.`
        ));
    } else {
        allLogs.push(log('DimDate Generation', 7, 'skipped', 'No date range available.'));
    }

    // ── POST: Quality Score ──
    const allKeys = Object.keys(rows[0] || {});
    let completenessSum = 0;
    allKeys.forEach(key => {
        const filled = rows.filter(r => r[key] !== null && r[key] !== undefined && r[key] !== '').length;
        completenessSum += rows.length > 0 ? filled / rows.length : 0;
    });
    const avgCompleteness = allKeys.length > 0 ? (completenessSum / allKeys.length) * 100 : 0;
    const dupePenalty = l1.duplicatesRemoved > 0 ? Math.min(10, (l1.duplicatesRemoved / totalRowsBefore) * 100) : 0;
    const nullPenalty = l2.nullsFixed > 0 ? Math.min(10, (l2.nullsFixed / (totalRowsBefore * allKeys.length)) * 100) : 0;
    const qualityScore = Math.round(Math.max(0, Math.min(100, avgCompleteness - dupePenalty - nullPenalty)));

    // Final summary log
    const totalRowsAfter = rows.length;
    const totalColumnsFinal = allKeys.length;
    const applied = allLogs.filter(l => l.status === 'applied').length;
    const skipped = allLogs.filter(l => l.status === 'skipped').length;
    const flagged = allLogs.filter(l => l.status === 'info').length;

    allLogs.push(log('Final Summary', 7, 'applied',
        `7-Layer Pipeline complete. ${applied} step(s) applied, ${skipped} skipped, ${flagged} flagged. ` +
        `${totalRowsAfter} clean rows from ${totalRowsBefore} original. Data quality: ${qualityScore}/100. Contract: ${l6.contract.status}.`,
        { rowsBefore: totalRowsBefore, rowsAfter: totalRowsAfter }
    ));

    console.log(`[ETL] Complete: ${totalRowsAfter} rows, quality=${qualityScore}, contract=${l6.contract.status}`);

    // ── POST: Column Ordering (ID → Date → Dimension → Metric) ──
    const typeOrder: Record<string, number> = { ID: 0, DATE: 1, DIMENSION: 2, METRIC: 3 };
    const sortedColumns = [...l4.columns].sort((a, b) => (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99));
    const columnOrder = sortedColumns.map(c => c.name);
    rows = rows.map(row => {
        const ordered: Record<string, any> = {};
        for (const key of columnOrder) ordered[key] = row[key];
        return ordered;
    });
    allLogs.push(log('Column Ordering', 7, 'applied',
        `Reordered columns: ${columnOrder.join(', ')}`,
        { affectedColumns: columnOrder }
    ));

    return {
        rows,
        columns: sortedColumns,
        logs: allLogs,
        timeContext: tc.timeContext,
        dimDate,
        qualityScore,
        lineage: l5.lineage,
        contract: l6.contract,
        summary: {
            totalRowsBefore,
            totalRowsAfter,
            totalColumnsOriginal,
            totalColumnsFinal,
            rowsRemoved: totalRowsBefore - totalRowsAfter,
            columnsRemoved: l1.columnsRemoved,
            nullsFixed: l2.nullsFixed,
            duplicatesRemoved: l1.duplicatesRemoved,
            typeCastCount: l5.typeCastCount,
        }
    };
}
