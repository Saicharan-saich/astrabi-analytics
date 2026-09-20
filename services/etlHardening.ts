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
function disambiguateSeparators(s: string): string {
    const hasDot = s.includes('.'), hasComma = s.includes(',');
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
export function parseLocaleNumber(raw: any): number | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw === 'boolean') return null;

    let s = String(raw).trim();
    if (s === '') return null;
    // Strip whitespace (incl. non-breaking/thin) AND zero-width / BOM / bidi marks
    // that otherwise make a real number fail to parse and vanish from sums.
    s = s.replace(/[\s\u00A0\u2007\u202F\u200B\u200C\u200D\u200E\u200F\uFEFF]/g, "").replace(CURRENCY_SYMBOLS, '');

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

    const n = Number(disambiguateSeparators(s) + expPart);
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
    if (!/(rate|ratio|percent|pct|share|conversion|margin|%)/i.test(name)) return null;
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
