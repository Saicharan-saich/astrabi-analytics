/**
 * etlHardening.ts — correctness-critical additions to the ETL pipeline.
 *
 * Everything here is deterministic and pure so it can be unit-tested in
 * isolation. The guiding principle is CLEAN LOUDLY, NEVER SILENTLY: passes that
 * change a NUMBER only do so to make it MORE correct (recovering values that were
 * being dropped, or picking the right date interpretation); passes that could be
 * judgment calls (outliers, typo-like category merges, business-rule violations)
 * only FLAG for review — they never mutate the user's data behind their back.
 */

// ════════════════════════════════════════════════════════════════════
// 1. LOCALE-AWARE NUMBER PARSING
//    Fixes the class of silent data-loss where a real number became null:
//    European decimals (1.234,56), accountant negatives ((500)), magnitude
//    suffixes (1.2K), currency symbols, thousands separators.
// ════════════════════════════════════════════════════════════════════

const CURRENCY_SYMBOLS = /[$€£¥₹₩₫₽¢]/g;
const CURRENCY_SYMBOL_MARKER = /[$€£¥₹₩₫₽¢]/;
// Common ISO-4217 codes seen in uploaded finance, remittance and sales files.
// Keep this as an allow-list: stripping arbitrary three-letter tokens would
// silently turn identifiers such as "123ABC" into numbers.
const CURRENCY_CODES = '(?:AED|ARS|AUD|BDT|BGN|BRL|CAD|CHF|CLP|CNY|COP|CZK|DKK|EGP|EUR|GBP|GHS|HKD|HUF|IDR|ILS|INR|JPY|KES|KRW|LKR|MAD|MXN|MYR|NGN|NOK|NZD|PEN|PHP|PKR|PLN|QAR|RON|RUB|SAR|SEK|SGD|THB|TRY|TWD|UAH|USD|VND|ZAR)';
const CURRENCY_CODE_PREFIX = new RegExp(`^${CURRENCY_CODES}`, 'i');
const CURRENCY_CODE_SUFFIX = new RegExp(`${CURRENCY_CODES}$`, 'i');
const CURRENCY_CODE_MARKER = new RegExp(`(?:^|[^A-Z])${CURRENCY_CODES}(?:$|[^A-Z])`, 'i');
const MAG: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/** True when a cell carries an explicit currency symbol or supported ISO code. */
export function hasCurrencyMarker(raw: any): boolean {
    if (raw === null || raw === undefined) return false;
    const value = String(raw).trim();
    return CURRENCY_SYMBOL_MARKER.test(value) || CURRENCY_CODE_MARKER.test(value);
}

/** Decide which of '.'/',' is the decimal separator and return a JS-parseable
 *  string with '.' as decimal and no thousands separators. */
function disambiguateSeparators(s: string, style?: NumberStyle): string {
    const hasDot = s.includes('.'), hasComma = s.includes(',');
    // A column-level decision settles the single-separator cases that a lone
    // cell cannot: "€1.234" is 1234 in a European column, 1.234 in a US one.
    if (style === 'eu' && !(hasDot && hasComma)) {
        if (hasComma) return s.replace(/\./g, '').replace(',', '.');
        if (hasDot) {
            const parts = s.split('.');
            return parts.slice(1).every(p => p.length === 3) ? s.replace(/\./g, '') : s;
        }
    }
    if (style === 'us' && hasComma && !hasDot) return s.replace(/,/g, '');
    if (hasDot && hasComma) {
        // The separator that appears LAST is the decimal one.
        return s.lastIndexOf('.') > s.lastIndexOf(',')
            ? s.replace(/,/g, '')                       // 1,234.56 → 1234.56
            : s.replace(/\./g, '').replace(',', '.');   // 1.234,56 → 1234.56
    }
    if (hasComma) {
        const parts = s.split(',');
        const cleanThousands = parts.length > 2 && parts.slice(1).every(p => p.length === 3) && parts[0].length >= 1 && parts[0].length <= 3;
        if (cleanThousands) return s.replace(/,/g, '');                 // 12,345,678
        if (parts.length === 2) {
            // "1,234" is ambiguous (thousands vs EU decimal) — 3 trailing digits
            // default to THOUSANDS, the far more common case in real data.
            if (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3) return s.replace(/,/g, '');
            return s.replace(',', '.');                                 // 1,5 / 1,23 / 1,2345 → decimal
        }
        return s.replace(/,/g, '');
    }
    if (hasDot) {
        const parts = s.split('.');
        const euThousands = parts.length > 2 && parts.slice(1).every(p => p.length === 3) && parts[0].length >= 1 && parts[0].length <= 3;
        if (euThousands) return s.replace(/\./g, '');                   // 1.234.567
        return s;                                                       // normal decimal
    }
    return s;
}

/**
 * Parse a messy real-world numeric cell into a number, or null if it truly isn't
 * one. Handles currency symbols, %, parentheses/​trailing negatives, K/M/B/T
 * magnitude suffixes, ISO currency codes ("387 GBP", "USD 10") and US/EU
 * decimal & thousands separators.
 */
export function parseLocaleNumber(raw: any, style?: NumberStyle): number | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw === 'boolean') return null;

    let s = String(raw).trim();
    if (s === '') return null;
    // Strip whitespace (incl. non-breaking/thin) AND zero-width / BOM / bidi marks
    // that otherwise make a real number fail to parse and vanish from sums.
    s = s.replace(/[\s\u00A0\u2007\u202F\u200B\u200C\u200D\u200E\u200F\uFEFF]/g, "").replace(CURRENCY_SYMBOLS, '');
    // Typographic minus and dashes (Word, PDFs, finance tools) are minus signs.
    s = s.replace(/^[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/, '-').replace(/[\u2212\u2012\u2013\u2014\uFE63\uFF0D]$/, '-');

    let sign = 1;
    if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }           // (500) → -500
    if (s.startsWith('+')) s = s.slice(1);
    if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
    if (s.endsWith('-')) { sign = -sign; s = s.slice(0, -1); }           // 500- (trailing minus)

    if (s.endsWith('%')) s = s.slice(0, -1);                            // keep the number (45% → 45)

    // Currency codes can be prefixes or suffixes and may originally have been
    // separated by whitespace ("GBP 387" / "387.00 GBP"). Whitespace was
    // intentionally removed above, so anchored removal is deterministic.
    s = s.replace(CURRENCY_CODE_PREFIX, '').replace(CURRENCY_CODE_SUFFIX, '');

    // Scientific / exponent notation (1.23E+11, 1,5e3): split off the exponent
    // before separator disambiguation so these parse instead of becoming null.
    let expPart = '';
    const em = s.match(/[eE]([+-]?\d+)$/);
    if (em && (em.index ?? 0) > 0) { expPart = 'e' + em[1]; s = s.slice(0, em.index); }

    let mult = 1;
    const suf = s.slice(-1).toLowerCase();
    if (!expPart && MAG[suf] && /[0-9]/.test(s.slice(0, -1))) { mult = MAG[suf]; s = s.slice(0, -1); }

    if (!/[0-9]/.test(s) || !/^[0-9.,]+$/.test(s)) return null;

    const n = Number(disambiguateSeparators(s, style) + expPart);
    if (!Number.isFinite(n)) return null;
    return sign * n * mult;
}

// ════════════════════════════════════════════════════════════════════
// 2. UNICODE / MOJIBAKE REPAIR (safe to apply)
// ════════════════════════════════════════════════════════════════════

const MOJIBAKE: Array<[RegExp, string]> = [
    [/Ã©/g, 'é'], [/Ã¨/g, 'è'], [/Ã¡/g, 'á'], [/Ã /g, 'à'], [/Ã³/g, 'ó'], [/Ã±/g, 'ñ'],
    [/Ã¼/g, 'ü'], [/Ã¶/g, 'ö'], [/Ã¤/g, 'ä'], [/Ã§/g, 'ç'], [/Ã­/g, 'í'], [/Ãº/g, 'ú'],
    [/â€™/g, '’'], [/â€œ/g, '“'], [/â€/g, '”'], [/â€"/g, '—'], [/â€“/g, '–'],
];

/** Repair common UTF-8-as-Latin1 mojibake, normalize smart quotes to ASCII, and
 *  apply Unicode NFC. Deterministic and safe — it only fixes broken encodings. */
export function normalizeUnicode(s: string): string {
    if (typeof s !== 'string' || s === '') return s;
    let out = s;
    for (const [re, ch] of MOJIBAKE) out = out.replace(re, ch);
    out = out.replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"');
    try { out = out.normalize('NFC'); } catch { /* older runtimes */ }
    return out;
}

// ════════════════════════════════════════════════════════════════════
// 3. DATE ORDER DISAMBIGUATION (MM/DD vs DD/MM)
//    Scans the whole column so 03/04/2023 isn't blindly read as US.
// ════════════════════════════════════════════════════════════════════

export type DateOrder = 'MDY' | 'DMY' | 'ambiguous';

/** Inspect a column of slash/dash/dot numeric dates and decide day-month order.
 *  If any first-part > 12 it must be DMY; if any second-part > 12 it must be
 *  MDY; otherwise ambiguous (caller keeps its default). */
export function resolveDateOrder(values: any[]): DateOrder {
    let firstGt12 = false, secondGt12 = false, seen = 0;
    for (const v of values) {
        if (v === null || v === undefined) continue;
        const m = String(v).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
        if (!m) continue;
        seen++;
        const a = +m[1], b = +m[2];
        if (a > 12 && a <= 31) firstGt12 = true;
        if (b > 12 && b <= 31) secondGt12 = true;
    }
    if (seen === 0) return 'ambiguous';
    if (firstGt12 && !secondGt12) return 'DMY';
    if (secondGt12 && !firstGt12) return 'MDY';
    return 'ambiguous';
}

// ════════════════════════════════════════════════════════════════════
// 4. NUMERIC OUTLIER DETECTION (flag only — never auto-removed)
// ════════════════════════════════════════════════════════════════════

export interface OutlierReport {
    count: number;
    lowerBound: number;
    upperBound: number;
    examples: number[];
}

/** IQR outlier detection (Tukey fences, 1.5×IQR). Returns a FLAG report; the
 *  pipeline surfaces it for review and never deletes or edits the values. */
export function detectOutliersIQR(values: any[]): OutlierReport | null {
    const nums = values.map(v => (typeof v === 'number' ? v : Number(v))).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (nums.length < 12) return null; // too few points for a stable quartile
    const q = (p: number) => {
        const idx = (nums.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
        return nums[lo] + (nums[hi] - nums[lo]) * (idx - lo);
    };
    const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
    if (iqr === 0) return null;
    const lowerBound = q1 - 1.5 * iqr, upperBound = q3 + 1.5 * iqr;
    const outliers = nums.filter(v => v < lowerBound || v > upperBound);
    if (outliers.length === 0) return null;
    const examples = [...new Set([...outliers.slice(0, 2), ...outliers.slice(-2)])];
    return { count: outliers.length, lowerBound, upperBound, examples };
}

// ════════════════════════════════════════════════════════════════════
// 5. CATEGORY CANONICALIZATION + NEAR-DUPLICATE FLAGGING
// ════════════════════════════════════════════════════════════════════

/** A case/space/punctuation/diacritic-insensitive key — values sharing it are
 *  the SAME category written differently ("New-York" ≡ "new york"). */
export function canonicalKey(s: string): string {
    return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Build a SAFE surface-form merge map: values that are identical apart from
 * case/spacing/punctuation/diacritics collapse to their most frequent surface
 * form. This is safe to auto-apply (they are provably the same string).
 * Returns only the entries that actually change.
 */
export function buildCanonicalCategoryMap(values: any[]): Map<string, string> {
    const groups = new Map<string, Map<string, number>>();
    for (const v of values) {
        if (v === null || v === undefined || String(v).trim() === '') continue;
        const surface = String(v);
        const key = canonicalKey(surface);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, new Map());
        const g = groups.get(key)!;
        g.set(surface, (g.get(surface) || 0) + 1);
    }
    const map = new Map<string, string>();
    for (const g of groups.values()) {
        if (g.size < 2) continue; // only groups with multiple surface forms
        // canonical = most frequent, ties broken by longer (more specific) form
        const canonical = [...g.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
        for (const surface of g.keys()) if (surface !== canonical) map.set(surface, canonical);
    }
    return map;
}

/** Levenshtein distance with an early-exit ceiling. */
export function levenshtein(a: string, b: string, ceiling = 3): number {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            rowMin = Math.min(rowMin, cur[j]);
        }
        if (rowMin > ceiling) return ceiling + 1;
        prev = cur;
    }
    return prev[b.length];
}

export interface NearDupGroup { canonical: string; variants: string[] }

/** Above this many distinct values a column is free-text (names, notes), not a
 *  category — typo clustering is meaningless AND its pairwise (O(n²)) scan would
 *  freeze on large data, so we skip it. */
const MAX_TYPO_DISTINCT = 300;

/**
 * Flag likely TYPOS among distinct category values (edit distance 1, same first
 * letter, length ≥ 5) — e.g. "Cardiology" / "Cardilogy". These are NOT merged
 * automatically because a 1-character difference can be a genuinely different
 * value; they are surfaced for the user to confirm.
 *
 * Only runs on genuinely categorical columns (≤ MAX_TYPO_DISTINCT distinct
 * values) — high-cardinality free-text is skipped so this stays fast on big data.
 */
export function findNearDuplicateGroups(values: any[]): NearDupGroup[] {
    const freq = new Map<string, number>();
    for (const v of values) {
        if (v === null || v === undefined) continue;
        const s = String(v).trim();
        if (s.length >= 5) freq.set(s, (freq.get(s) || 0) + 1);
        if (freq.size > MAX_TYPO_DISTINCT) return []; // free-text column → skip (and stay O(n))
    }
    const distinct = [...freq.keys()];
    const used = new Set<string>();
    const groups: NearDupGroup[] = [];
    for (let i = 0; i < distinct.length; i++) {
        if (used.has(distinct[i])) continue;
        const variants: string[] = [];
        for (let j = i + 1; j < distinct.length; j++) {
            if (used.has(distinct[j])) continue;
            const a = distinct[i], b = distinct[j];
            if (a[0].toLowerCase() === b[0].toLowerCase() && canonicalKey(a) !== canonicalKey(b) && levenshtein(a.toLowerCase(), b.toLowerCase(), 1) === 1) {
                variants.push(b); used.add(b);
            }
        }
        if (variants.length > 0) {
            used.add(distinct[i]);
            // canonical = the most frequent spelling in the cluster
            const all = [distinct[i], ...variants].sort((x, y) => (freq.get(y)! - freq.get(x)!));
            groups.push({ canonical: all[0], variants: all.slice(1) });
        }
    }
    return groups;
}

// ════════════════════════════════════════════════════════════════════
// 6. BUSINESS-RULE / SEMANTIC VALIDATORS (flag only)
// ════════════════════════════════════════════════════════════════════

const NONNEG_NAME = /(price|cost|amount|qty|quantity|revenue|sales|salary|wage|age|count|units|stock|balance|weight|height|width|length|volume|fee|total|income)/i;

/** Count negative values in a column whose NAME implies it can't be negative. */
export function detectSignAnomalies(name: string, values: any[]): number {
    if (!NONNEG_NAME.test(name)) return 0;
    let n = 0;
    for (const v of values) { const x = typeof v === 'number' ? v : Number(v); if (Number.isFinite(x) && x < 0) n++; }
    return n;
}

/** Count values outside [0,100] in a percentage column, or implausible ages. */
export function detectRangeAnomalies(name: string, values: any[]): { kind: string; count: number } | null {
    const isPct = /(percent|pct|rate|ratio|%)/i.test(name);
    const isAge = /\bage\b/i.test(name);
    let count = 0;
    for (const v of values) {
        const x = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(x)) continue;
        if (isPct && (x < 0 || x > 100) && Math.abs(x) > 1) count++;   // >1 so 0–1 ratios don't trip it
        else if (isAge && (x < 0 || x > 120)) count++;
    }
    if (count === 0) return null;
    return { kind: isPct ? 'percentage outside 0–100' : 'implausible age', count };
}

/** Detect cells that pack multiple values behind a delimiter ("red; blue"). */
export function detectDelimitedCells(values: any[]): { delimiter: string; count: number } | null {
    const delims = [';', '|', ' / ', ', '];
    for (const d of delims) {
        let count = 0;
        for (const v of values) if (typeof v === 'string' && v.includes(d) && v.split(d).filter(p => p.trim()).length >= 2) count++;
        if (count >= Math.max(3, values.length * 0.1)) return { delimiter: d.trim(), count };
    }
    return null;
}

/** Map a 2-digit year to a full year with a sliding window: 00–29 → 2000s,
 *  30–99 → 1900s. Fixes birthdates like "99" being read as 2099. */
export function pivotTwoDigitYear(yy: number): number {
    return yy <= 29 ? 2000 + yy : 1900 + yy;
}

/**
 * True when a numeric-looking column is really a CODE with significant leading
 * zeros (zip 01234, SKU 007) — these must be kept as text, never summed or
 * stripped to "1234". Returns true only if a meaningful share have a leading
 * zero and the values are uniform-ish width (a code, not a measurement).
 */
export function looksLikeLeadingZeroCode(values: any[]): boolean {
    let digits = 0, leadingZero = 0;
    for (const v of values) {
        if (v === null || v === undefined || v === '') continue;
        const s = String(v).trim();
        if (!/^\d+$/.test(s)) return false;      // any non-pure-digit → not this pattern
        digits++;
        if (s.length > 1 && s[0] === '0') leadingZero++;
    }
    return digits >= 4 && leadingZero / digits >= 0.2;
}

/**
 * Flag a numeric column that mixes 0–1 ratios with 0–100 percentages — averaging
 * them together yields a meaningless number. Returns the two sub-counts when both
 * populations are present in force.
 */
export function detectMixedScale(name: string, values: any[]): { ratioLike: number; pctLike: number } | null {
    if (!/(rate|ratio|percent|pct|share|conversion|margin|discount|markdown|%)/i.test(name)) return null;
    let ratioLike = 0, pctLike = 0, seen = 0;
    for (const v of values) {
        const x = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(x)) continue;
        seen++;
        if (x > 0 && x <= 1) ratioLike++;
        else if (x > 1 && x <= 100) pctLike++;
    }
    if (seen < 8) return null;
    // Both populations must be non-trivial to be a genuine mix.
    if (ratioLike >= 3 && pctLike >= 3 && Math.min(ratioLike, pctLike) / seen >= 0.15) return { ratioLike, pctLike };
    return null;
}

/** Count rows where an end date precedes its start date. */
export function detectDateOrderViolations(startVals: any[], endVals: any[]): number {
    let n = 0;
    for (let i = 0; i < Math.min(startVals.length, endVals.length); i++) {
        const a = Date.parse(String(startVals[i])), b = Date.parse(String(endVals[i]));
        if (Number.isFinite(a) && Number.isFinite(b) && b < a) n++;
    }
    return n;
}


// ════════════════════════════════════════════════════════════════════
// MEASURE INTEGRITY — column-level number style, units, currencies,
// totals rows, placeholder values, durations and wide tables.
// ════════════════════════════════════════════════════════════════════

export type NumberStyle = 'us' | 'eu';

/**
 * Decide a column's decimal/thousands convention from its unambiguous cells.
 * "1.234,50", "12,5" and "1.234.567" are European evidence; "1,234.50",
 * "12.50" and "1,234,567" are US evidence. Needs a clear majority.
 */
export function detectNumberStyle(values: any[]): NumberStyle | null {
    let eu = 0, us = 0;
    for (const v of values) {
        if (typeof v !== 'string') continue;
        const s = v.replace(/[^\d.,]/g, '');
        if (!/\d/.test(s)) continue;
        const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
        if (dot >= 0 && comma >= 0) { if (comma > dot) eu++; else us++; continue; }
        if (comma >= 0) {
            const parts = s.split(',');
            if (parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2) eu++;
            else if (parts.length > 2 && parts.slice(1).every(p => p.length === 3)) us++;
            continue;
        }
        if (dot >= 0) {
            const parts = s.split('.');
            if (parts.length > 2 && parts.slice(1).every(p => p.length === 3)) eu++;
            else if (parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2) us++;
        }
    }
    const total = eu + us;
    if (total < 2) return null;
    if (eu / total >= 0.8) return 'eu';
    if (us / total >= 0.8) return 'us';
    return null;
}

const APPROX_PREFIX = /^(?:approx(?:imately)?\.?|about|around|circa|ca\.?|~|≈|est\.?|estimated)\s*/i;
const UNIT_SUFFIX = /^([-+(]?[\d.,\s]+\)?)\s*([a-zA-Z]{1,12}\.?|[a-zA-Z]{1,8}\/[a-zA-Z]{1,8})$/;

/**
 * Numbers written with a unit or an approximation marker: "3 units", "5 kg",
 * "approx 5", "~120", "12 hrs". Returns the number and the unit text (lower
 * case, '' when none), or null when the cell is not of that shape.
 */
export function parseNumberWithUnit(raw: any, style?: NumberStyle): { value: number; unit: string; approximate: boolean } | null {
    if (typeof raw !== 'string') return null;
    let s = raw.trim();
    const approximate = APPROX_PREFIX.test(s);
    s = s.replace(APPROX_PREFIX, '').replace(/\+$/, '').trim();
    const direct = parseLocaleNumber(s, style);
    if (direct !== null) return approximate ? { value: direct, unit: '', approximate } : null;
    const m = s.match(UNIT_SUFFIX);
    if (!m) return null;
    const value = parseLocaleNumber(m[1].trim(), style);
    if (value === null) return null;
    const unit = m[2].toLowerCase().replace(/\.$/, '');
    // A magnitude word is not a unit: "2 million" → 2,000,000.
    const magnitude: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, mn: 1e6, m: 1e6, billion: 1e9, bn: 1e9 };
    if (magnitude[unit]) return { value: value * magnitude[unit], unit: '', approximate };
    return { value, unit, approximate };
}

const SYMBOL_TO_CODE: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₫': 'VND', '₽': 'RUB' };
const CODE_IN_CELL = new RegExp(`(?:^|[^A-Z])(${CURRENCY_CODES.slice(3, -1)})(?:$|[^A-Z])`, 'i');

/** Currency named in a cell ("€12", "12 GBP"), or null. "$" is read as USD. */
export function currencyOf(raw: any): string | null {
    if (typeof raw !== 'string') return null;
    const code = raw.toUpperCase().match(CODE_IN_CELL);
    if (code) return code[1].toUpperCase();
    const symbol = raw.match(CURRENCY_SYMBOL_MARKER);
    return symbol ? SYMBOL_TO_CODE[symbol[0]] || symbol[0] : null;
}

/** Currency named in a column header: "Price (£)", "Revenue GBP", "amount_eur". */
export function currencyOfHeader(header: string): string | null {
    const symbol = header.match(CURRENCY_SYMBOL_MARKER);
    if (symbol) return SYMBOL_TO_CODE[symbol[0]] || null;
    const code = header.toUpperCase().match(new RegExp(`(?:^|[^A-Z])(${CURRENCY_CODES.slice(3, -1)})(?:$|[^A-Z])`));
    return code ? code[1] : null;
}

/** Currencies used in a column, most frequent first, with counts. */
export function detectCurrencies(values: any[]): { currency: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const v of values) {
        const c = currencyOf(v);
        if (c) counts.set(c, (counts.get(c) || 0) + 1);
    }
    return [...counts.entries()].map(([currency, count]) => ({ currency, count })).sort((a, b) => b.count - a.count);
}

/** A label that marks a report's total or subtotal line ("Total", "Grand total", "North Subtotal"). */
export function isTotalLabel(raw: any): boolean {
    if (typeof raw !== 'string') return false;
    const s = raw.trim().toLowerCase().replace(/[:.]+$/, '');
    if (!s || s.length > 60) return false;
    return /^(grand[\s-]*)?(sub[\s-]?)?totals?$/.test(s)
        || /^(grand[\s-]*|sub[\s-]?)totals?\b/.test(s)
        || /^totals?\s+(for|of)\b/.test(s)
        || /\b(sub[\s-]?)?totals?$/.test(s) && s.split(/\s+/).length <= 5
        || /^(sum|summe|totaal|totale|gesamt|overall)$/.test(s);
}

/** Placeholder codes used for "unknown" in exports (9999, 999999, -1, -999). */
export function isPlaceholderNumber(n: number): boolean {
    return n === -1 || n === -9 || n === -99 || n === -999 || n === -9999 || /^9{4,}(\.0+)?$/.test(String(Math.abs(n))) && n > 0;
}

/**
 * Placeholder values hiding in a measure: a 9999-style code far above every
 * real value, or a negative code in an otherwise non-negative column.
 */
export function detectPlaceholderValues(values: (number | null)[]): Set<number> {
    const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (nums.length < 10) return new Set();
    const real = nums.filter(n => !isPlaceholderNumber(n));
    if (real.length < nums.length * 0.8 || real.length === 0) return new Set();
    const sorted = [...real].sort((a, b) => a - b);
    const p99 = sorted[Math.floor((sorted.length - 1) * 0.99)];
    const nonNegative = sorted[0] >= 0;
    // A code is used again and again; a single extreme value is more likely a
    // typo, which is flagged as an outlier and left for the user to judge.
    const counts = new Map<number, number>();
    for (const n of nums) if (isPlaceholderNumber(n)) counts.set(n, (counts.get(n) || 0) + 1);
    const out = new Set<number>();
    for (const [n, count] of counts) {
        if (count < 2) continue;
        if (n > 0 && n >= Math.max(10 * Math.abs(p99), 999)) out.add(n);
        if (n < 0 && nonNegative) out.add(n);
    }
    return out;
}

/** "01:30:00" / "1:30" / "90:00" → minutes; null when not a duration. */
export function parseDurationMinutes(raw: any): number | null {
    if (typeof raw !== 'string') return null;
    const m = raw.trim().match(/^(\d{1,4}):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?$/);
    if (!m) return null;
    const hasSeconds = m[3] !== undefined;
    const a = +m[1], b = +m[2], c = hasSeconds ? +m[3] : 0;
    return hasSeconds ? a * 60 + b + c / 60 : a * 60 + b;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A column header that names a period: "Jan", "January 2024", "2024-03",
 * "Q1 2024", "FY24", "2023". Returns an ISO start date when the header pins
 * one down, '' for a period without a year ("Jan"), or null when not a period.
 */
export function periodFromHeader(header: string): string | null {
    const h = header.trim().toLowerCase().replace(/[_]+/g, ' ');
    let m = h.match(/^(\d{4})[-/ ](\d{1,2})$/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2].padStart(2, '0')}-01`;
    m = h.match(/^([a-z]{3,9})[\s'-]*(\d{2}|\d{4})?$/);
    if (m) {
        const idx = MONTH_NAMES.indexOf(m[1].slice(0, 3));
        if (idx >= 0 && (m[1].length === 3 || 'january february march april may june july august september october november december'.includes(m[1]))) {
            if (!m[2]) return '';
            const year = m[2].length === 2 ? 2000 + +m[2] : +m[2];
            return `${year}-${String(idx + 1).padStart(2, '0')}-01`;
        }
    }
    m = h.match(/^q([1-4])[\s'-]*(\d{2}|\d{4})?$/) || h.match(/^(\d{4})[\s-]*q([1-4])$/);
    if (m) {
        const [q, y] = /^q/.test(h) ? [+m[1], m[2]] : [+m[2], m[1]];
        if (!y) return '';
        const year = y.length === 2 ? 2000 + +y : +y;
        return `${year}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
    }
    m = h.match(/^(?:fy\s*)?((?:19|20)\d{2})$/) || h.match(/^fy\s*(\d{2})$/);
    if (m) return `${m[1].length === 2 ? 2000 + +m[1] : +m[1]}-01-01`;
    return null;
}
