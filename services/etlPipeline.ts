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

import { suspectValues } from '../utils/plausibility';
import { localDateKey } from '../utils/dateKey';
import { isLabelName, isYesNoValues } from '../utils/twoValues';
import { ColumnDefinition, ColumnType, DimDateRow, ETLLog, EtlOptions, PhysicalDataType, TimeContext } from '../types';
import { generateDimDate } from './dimDateGenerator';
import { convertMixedUnits, runQualityChecks } from './etlQualityChecks';
import {
    parseLocaleNumber, hasCurrencyMarker, normalizeUnicode, resolveDateOrder, detectOutliersIQR,
    buildCanonicalCategoryMap, findNearDuplicateGroups, pivotTwoDigitYear,
    looksLikeLeadingZeroCode, detectMixedScale,
    detectSignAnomalies, detectRangeAnomalies, detectDelimitedCells, detectDateOrderViolations,
    detectNumberStyle, parseNumberWithUnit, parseDurationMinutes, detectCurrencies, currencyOf, currencyOfHeader,
    detectPlaceholderValues, type NumberStyle,
} from './etlHardening';
import {
    dedupeRows, removeTotalRows, unpivotPeriodColumns, addPeriodFromYearMonth, foldReportSections, fillOrderLevelDetails,
    findRepeatedHeaderAmounts, allocateAcrossLines, findLineColumns, reconcileLineTotals,
} from './etlMeasureIntegrity';

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
    /** Day-first reading for d/d/yyyy values in this column. */
    slashDayFirst?: boolean;
    currencyDetected: boolean;
    /** Share of filled values written as money: exactly two decimals ("79.00", "1,234.50"). */
    moneyFormatRate?: number;
    percentageDetected: boolean;
    wordNumberRate: number;
    /** Fraction of numeric values that are whole integers (0–1). Key columns are integer-heavy. */
    integerRate?: number;
    /** True when integer values form a near-contiguous run (max−min+1 ≈ distinct) — an auto-increment / serial key. */
    looksSequential?: boolean;
    /** True when the column is dominated by messy human casing (e.g. "waTtS") and should be force-normalized. */
    messyCasing?: boolean;
    /** True when numeric-looking values are really codes with significant leading zeros (zip 01234, SKU 007) — keep as text, never sum. */
    leadingZeroCode?: boolean;
    /** Column-wide decimal/thousands convention, when the data shows one. */
    numberStyle?: NumberStyle | null;
    /** Share of values that are numbers written with a unit ("3 units", "~5"). */
    unitNumberRate?: number;
    /** Share of values that are durations ("01:30:00"). */
    durationRate?: number;
    /** "15:06" in a column named like a clock time (clock_in, start, time next to a date): a time of day, not a duration. */
    timeOfDay?: boolean;
    /** Filled cells read as sentences (free text). */
    sentenceLike?: boolean;
    /** Every value is a 2- or 3-letter code (country, currency). */
    codeLength?: 2 | 3;
    /** 'points' when "12%" cells sit beside plain fractions (0.12) that must be scaled to match. */
    percentMode?: 'points' | null;
    /** Share of numeric cells written with a % sign ("12.5%"). */
    percentCellRate?: number;
}

export interface TransformStep {
    name: string;
    fn: (v: any) => any;
}

export interface TransformPlan {
    column: string;
    type: ColumnType;
    steps: TransformStep[];
    /** Logs describing what the steps did, produced after they run. */
    notes?: () => ETLLog[];
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


// Value synonyms — only expansions that cannot change meaning. Business
// vocabularies (Wholesale vs Retail, Closed vs Inactive, Phone vs Smart Phone)
// are the user's to merge; guessing silently moved sales between categories.
const CATEGORY_SYNONYMS: Record<string, Record<string, string>> = {
    region: {
        'N': 'North', 'S': 'South', 'E': 'East', 'W': 'West',
        'Ne': 'Northeast', 'Nw': 'Northwest', 'Se': 'Southeast', 'Sw': 'Southwest',
    },
    gender: { 'M': 'Male', 'F': 'Female' },
    sex: { 'M': 'Male', 'F': 'Female' },
};

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
    // Dotted day-first (Germany, Switzerland, much of Europe): 07.05.2025, 7.5.25
    { id: 'DD.MM.YYYY', regex: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, parse: (m) => ({ y: +m[3], m: +m[2], d: +m[1] }) },
    { id: 'DD.MM.YY', regex: /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/, parse: (m) => ({ y: pivotTwoDigitYear(+m[3]), m: +m[2], d: +m[1] }) },
    // Short year: 06/08/23, 6/8/23
    { id: 'MM/DD/YY', regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/, parse: (m) => ({ y: pivotTwoDigitYear(+m[3]), m: +m[1], d: +m[2] }) },
    { id: 'DD/MM/YY', regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/, parse: (m) => ({ y: pivotTwoDigitYear(+m[3]), m: +m[2], d: +m[1] }) },
    // Text with spaces: "Jan 5, 2023", "5 Jan 2023", "January 5 2023"
    { id: 'MON_DD_YYYY', regex: /^([A-Za-z]+)[\s\-/]+(\d{1,2}),?[\s\-/]+(\d{4})$/, parse: (m) => { const mo = monthFromText(m[1]); return mo ? { y: +m[3], m: mo, d: +m[2] } : null; } },
    { id: 'DD_MON_YYYY', regex: /^(\d{1,2})[\s\-/]+([A-Za-z]+)[\s\-/]+(\d{4})$/, parse: (m) => { const mo = monthFromText(m[2]); return mo ? { y: +m[3], m: mo, d: +m[1] } : null; } },
    // Text with hyphens and short year: "21-May-25", "7-Mar-23", "1-Sep-24"
    { id: 'DD_MON_YY', regex: /^(\d{1,2})[\s\-/]+([A-Za-z]+)[\s\-/]+(\d{2})$/, parse: (m) => { const mo = monthFromText(m[2]); return mo ? { y: pivotTwoDigitYear(+m[3]), m: mo, d: +m[1] } : null; } },
    { id: 'MON_DD_YY', regex: /^([A-Za-z]+)[\s\-/]+(\d{1,2}),?[\s\-/]+(\d{2})$/, parse: (m) => { const mo = monthFromText(m[1]); return mo ? { y: pivotTwoDigitYear(+m[3]), m: mo, d: +m[2] } : null; } },
    // YYYYMMDD
    { id: 'YYYYMMDD', regex: /^(\d{4})(\d{2})(\d{2})$/, parse: (m) => ({ y: +m[1], m: +m[2], d: +m[3] }) },
];

const MONTH_MAP: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6,
    jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// ─── CLASSIFICATION VOCABULARY ──────────────────────────────────────
// The name-pattern signals that drive Layer-4 role classification, kept
// together so the rules are easy to reason about and extend. Used by
// classifyColumnRole() below.

// ID column name patterns — includes abbreviated forms like acid (account-id), brid (branch-id), tno (txn-no)
/** Ordinary words that end like an ID: "paid", "void", "valid", "casino", "piano". */
const NOT_ID_WORDS = /^(paid|unpaid|prepaid|raid|said|laid|maid|void|avoid|valid|invalid|rapid|humid|fluid|solid|timid|vivid|acid|arid|lucid|covid|squid|druid|lipid|hybrid|stupid|liquid|casino|piano|volcano|techno|mono|stereo|keno|domino|tornado|ammo|logo|promo|demo|memo|tempo|veto|hero|zero|euro|auto|photo|video|radio|ratio|audio|studio|portfolio|scenario|bingo|mango|cargo|lingo|jumbo|combo|turbo)$/i;
/** Columns people type sentences into: kept exactly as written. */
const FREE_TEXT_NAME = /(^|_)(comments?|notes?|feedback|remarks?|reviews?|review_text|message|messages|memo|free_text|verbatim|suggestions?|complaints?|what_could_we_improve|anything_else|other_comments)($|_)/i;
/** Most filled cells read as sentences: several words and few repeats. */
function looksLikeSentences(rows: Record<string, any>[], col: string): boolean {
    const values = rows.map(r => r[col]).filter(v => typeof v === 'string' && v.trim() !== '') as string[];
    if (values.length < 10) return false;
    const words = values.reduce((sum, v) => sum + v.trim().split(/\s+/).length, 0) / values.length;
    const distinct = new Set(values.map(v => v.trim().toLowerCase())).size / values.length;
    return words >= 6 && distinct >= 0.6;
}
/** Every filled value is a code of this many letters ("GBP", "gb"). */
function strValuesAreCodes(rows: Record<string, any>[], col: string, length: number): boolean {
    const values = rows.map(r => r[col]).filter(v => typeof v === 'string' && v.trim() !== '') as string[];
    return values.length > 0 && values.every(v => new RegExp(`^[A-Za-z]{${length}}$`).test(v.trim()));
}

/** Names of a clock time (when something happened), as opposed to how long it took. */
const CLOCK_NAME = /(^|_)(clock_?in|clock_?out|clocked_?in|clocked_?out|time_?in|time_?out|start|start_?time|end|end_?time|starts|ends|opens?|closes?|opening|closing|arrival|arrived|departure|departed|check_?in|check_?out|shift_?start|shift_?end|slot|from|until|in|out)($|_)/i;
const HOW_LONG_NAME = /(duration|elapsed|length|worked|spent|wait|waiting|hours|hrs|minutes|mins|seconds|secs|total|taken|lap|runtime|run_time|break|overtime|handle|talk|hold|response|resolution|turnaround|lead|average|avg|mean)/i;
function isClockTimeName(name: string, siblings: string[]): boolean {
    if (HOW_LONG_NAME.test(name)) return false;
    if (CLOCK_NAME.test(name)) return true;
    // A bare "time" beside a date column is when it happened (POS exports: Date, Time).
    return /^(time|time_of_day|local_time|txn_time|transaction_time|order_time|sale_time)$/i.test(name)
        && siblings.some(other => other !== name && /(^|_)(date|day)($|_)/i.test(other));
}

/** Small whole-number scales that are measured: rating 1–5, bedrooms, children, stars. */
const SCALE_NAME = /(recommend|likely|likelihood|reorder|level|threshold|capacity|rating|score|stars?|satisfaction|nps|likert|rank|bedrooms?|bathrooms?|rooms?|children|kids|people|persons?|guests?|adults?|members?|items|visits|nights|floors?|seats?|doors?|cylinders?|dependents?|siblings?|parch|sibsp|attempts|calls|logins|tickets|purchases|orders|employees|staff|headcount)/i;
const ID_PATTERNS = /(?:^id$|_id$|^id_|order_?id|cust(?:omer)?_?id|product_?id|trans(?:action)?_?id|invoice_?id|sku|code$|_code$|_no$|_num$|number$|_key$|^pk_|^fk_|^.{1,4}id$|^.{1,4}no$|^.{1,4}cd$|^s_?no$|^t_?no$|^sr_?no$|^acc_?(?:id|no)$|^acct_?(?:id|no)$|^emp_?(?:id|no)$|^cust_?(?:id|no)$|^br_?(?:id|no)$)/i;

// Metric name patterns — exact match for standalone names
const METRIC_NAME_EXACT = /^(quantity|qty|amount|amt|price|cost|total|sum|count|revenue|sales|profit|discount|tax|fee|rate|score|weight|volume|height|width|length|balance|budget|salary|wage|income|expense|margin|stock|inventory|units|value|avg|average|num|number)$/i;

// Metric keyword fragments — for compound names like txn_amount, total_sales, net_revenue
const METRIC_KEYWORDS = /(?:^|[_\s])(amount|amt|qty|quantity|price|cost|total|sum|count|revenue|sales|profit|discount|tax|fee|rate|score|weight|volume|height|width|length|balance|budget|salary|wage|income|expense|margin|stock|inventory|units|value|average|avg|number|num|charge|payment|spend|earning|payout|funding|debt|credit|debit|turnover|premium|commission|bonus|interest|deposit|withdrawal|refund|surcharge|tariff|fare|toll|rent|royalty|stipend|hours|hrs|minutes|mins|seconds|secs|days|duration|visits|clicks|impressions|views|sessions|calls|tickets|items|pieces|downloads|signups|installs|leads|conversions|kg|kgs|lbs|km|miles|distance)(?:[_\s]|$)/i;

// Date name patterns (strong signal for date classification)
const DATE_NAME_PATTERNS = /^(date|sale_?date|order_?date|purchase_?date|created_?at|updated_?at|ship_?date|delivery_?date|birth_?date|dob|start_?date|end_?date|due_?date|invoice_?date|payment_?date|registration_?date|timestamp|datetime|created|modified|posted|expired|effective)$/i;

// Strong business-metric names — a numeric column with one of these is a measure,
// never reclassified as a numeric attribute.
const STRONG_METRIC_NAME = /(?:^|[_\s])(sales|revenue|profit|cost|price|amount|total|income|salary|wage|pay|compensation|expense|fee|charge|payment|spend|earning|bonus|commission|balance|budget|discount|tax|shipping|freight|margin|debt|credit|debit|turnover|premium|interest|deposit|refund|rent|royalty|stipend|funding|payout)(?:[_\s]|$)/i;

/** Details an order or visit only sometimes has: a blank one means there wasn't one. */
const OPTIONAL_DETAIL_NAME = /(^|_)(discount|discounts|coupon|coupons|promo|promotion|voucher|vouchers|referral|referrer|tag|tags|note|notes|gift|modifier|modifiers|addon|addons|add_on|add_ons|extra|extras|allergy|allergies|instruction|instructions|offer|campaign)(_|$)/i;

/** Money written the way exports write it: two decimals, optional symbol, sign or brackets. */
const MONEY_FORMAT = /^[-(]?\s*[£$€¥]?\s*-?\d+(?:[,.\s]\d{3})*[.,]\d{2}\)?$/;

/**
 * The name with joined and plural forms split out, so "subtotal", "grandtotal",
 * "taxes" and "fees" read like "sub_total", "grand_total", "tax" and "fee".
 */
function metricNameForm(name: string): string {
    return name.toLowerCase()
        .replace(/(^|_)(sub|grand|net|gross)(?=total|sales|amount|price)/g, '$1$2_')
        .split('_')
        .map(t => t.length > 3 && /(x|s|ch|sh)es$/.test(t) ? t.slice(0, -2) : t.length > 3 && /[^s]s$/.test(t) ? t.slice(0, -1) : t)
        .join('_');
}

/**
 * Distinguishes a numeric ATTRIBUTE (age, rating, score) from a business MEASURE.
 * Attributes have a bounded human-scale range, integer values, and/or low
 * distinct-to-row ratio; strong metric names are never attributes.
 */
function isNumericAttribute(p: ColumnProfileData): boolean {
    const pMin = p.min, pMax = p.max;
    if (pMin === undefined || pMax === undefined) return false;
    if (STRONG_METRIC_NAME.test(p.name) || STRONG_METRIC_NAME.test(metricNameForm(p.name))) return false;
    // Written as money ("£4.80", "79.00"): an amount, however few distinct values it has.
    if (p.currencyDetected || (p.moneyFormatRate ?? 0) >= 0.9) return false;
    const span = pMax - pMin;
    const maxVal = Math.max(Math.abs(pMin), Math.abs(pMax));
    const bounded = maxVal > 0 && maxVal <= 200 && span > 0 && span <= 200; // Signal 1
    const integers = Number.isInteger(pMin) && Number.isInteger(pMax);      // Signal 2
    const lowDistinct = p.totalValues > 0 && (p.distinctCount / p.totalValues) < 0.15; // Signal 3
    return [bounded, integers, lowDistinct].filter(Boolean).length >= 2;
}

/**
 * The Layer-4 role decision for a single column, as an explicit ORDERED list of
 * named rules — first match wins. Pure (no logging/side-effects) so it can be
 * unit-tested directly and reasoned about in one place. Rule order is
 * significant and documented per-rule; the returned `note`, when present, is the
 * structured reason the caller logs.
 */
export type RoleDecision = { type: ColumnType; note?: { label: string; message: string } };
export function classifyColumnRole(p: ColumnProfileData): RoleDecision {
    const nameForm = metricNameForm(p.name);
    const isMetricName = METRIC_NAME_EXACT.test(p.name) || METRIC_KEYWORDS.test(p.name) || STRONG_METRIC_NAME.test(p.name)
        || METRIC_KEYWORDS.test(p.name.replace(/s($|_)/g, '$1')) || METRIC_NAME_EXACT.test(nameForm) || METRIC_KEYWORDS.test(nameForm);
    const isDateName = DATE_NAME_PATTERNS.test(p.name);
    const effectiveNumericRate = p.numericParseRate + (p.wordNumberRate || 0) + (p.unitNumberRate || 0);
    const keySig = keySignalFor(p, isMetricName);
    // R0 — Durations ("01:30:00") are measures (minutes), not text.
    if (p.timeOfDay) {
        return { type: ColumnType.DIMENSION, note: { label: 'Time Of Day', message: `Column '${p.name}' holds clock times (when something happened), so it is kept as a time of day — not added up as a duration.` } };
    }
    if ((p.durationRate || 0) >= 0.8) {
        return { type: ColumnType.METRIC, note: { label: 'Duration Detection', message: `Column '${p.name}' holds durations (h:mm:ss); converted to minutes so it can be summed and averaged.` } };
    }

    // R1 — ID by name pattern (order_id, sku, *_code …).
    // A coded category ("gender_code" 0/1, "region_no" 1–5) is a grouping, not a key.
    if (ID_PATTERNS.test(p.name) && !NOT_ID_WORDS.test(p.name)
        && !((isLabelName(p.name) || /(^|_)(code|cd)$/i.test(p.name)) && p.distinctCount <= 20 && p.totalValues > p.distinctCount * 5)) return { type: ColumnType.ID };
    // R1b — Leading-zero CODE (zip 01234, SKU 007): numeric-looking but the zeros
    // are significant, so it must be preserved as text and never summed. Strong
    // metric names (never a code) are exempt.
    if (p.leadingZeroCode && !STRONG_METRIC_NAME.test(p.name)) {
        return { type: ColumnType.ID, note: { label: 'Leading-Zero Code', message: `Column '${p.name}' classified as ID/code — values carry significant leading zeros (e.g. postal/SKU); preserved as text, never summed.` } };
    }
    // R2 — Date by data: a majority of values parse as dates. GUARD: for a
    // metric-named, purely numeric column (salary, amount, price…) the "date"
    // parses can only come from Excel-serial interpretation of plain numbers
    // in 30000–60000 — that's money, not dates (salaries live in exactly that
    // range). Let it fall through to the metric rule. A genuinely date-named
    // column (payment_date…) still classifies as DATE via isDateName.
    if (p.dateParseRate >= 0.5 && !(isMetricName && !isDateName && p.numericParseRate >= 0.7)) return { type: ColumnType.DATE };
    // R3 — Date by name (trust the column name when data is inconclusive).
    if (isDateName) return { type: ColumnType.DATE };
    // R3b — Map coordinates: numbers, but a position, never added up or averaged as a measure.
    if (/(^|[_\s.-])(lat|latitude|lon|lng|longitude)$/i.test(p.name) && p.numericParseRate >= 0.8) {
        return { type: ColumnType.DIMENSION, note: { label: 'Coordinate Detection', message: `Column '${p.name}' holds map coordinates — kept as a position, not a measure.` } };
    }
    // R4 — Metric by name + numeric data. MUST precede the boolean rule because
    // boolean tokens include '1'/'0', which would misclassify e.g. a "quantity"
    // column that happens to be mostly 1s as BOOLEAN.
    if (isMetricName && effectiveNumericRate >= 0.3) return { type: ColumnType.METRIC };
    // R5 — Boolean (≥60% true/false tokens).
    if (p.booleanTokenRate >= 0.6) return { type: ColumnType.BOOLEAN };
    // R6 — Data-driven key: near-unique or serial integers are identifiers, not
    // measures, even when the name gives nothing away. Precedes the metric rule
    // so keys are never summed/averaged.
    if (keySig.isKey) return { type: ColumnType.ID, note: { label: 'Key Detection', message: `Column '${p.name}' classified as ID — ${keySig.reason}.` } };
    // R7 — Numeric: a business metric UNLESS it looks like a numeric attribute.
    if (effectiveNumericRate >= 0.7 && p.distinctCount >= 10 && !ID_PATTERNS.test(p.name)) {
        // A 0–10 recommend score or a reorder level is measured: averaged, not a label.
        if (SCALE_NAME.test(p.name) && p.min !== undefined && p.min >= 0) {
            return { type: ColumnType.METRIC, note: { label: 'Scale Detection', message: `Column '${p.name}' is a number scale — averaged, not summed by default.` } };
        }
        if (isNumericAttribute(p)) {
            return { type: ColumnType.DIMENSION, note: { label: 'Attribute Detection', message: `Column '${p.name}' reclassified as DIMENSION (numeric attribute) — range: ${p.min}–${p.max}, distinct: ${p.distinctCount}/${p.totalValues}` } };
        }
        return { type: ColumnType.METRIC };
    }
    // R8 — A small set of whole numbers repeated over and over: a scale that is
    // averaged (rating 1–5, bedrooms, children), a year, or a numbered
    // category (store 1–9, class 1–3) — never a key, since keys don't repeat.
    if (p.numericParseRate >= 0.9 && p.distinctCount < 10 && p.totalValues > 0 && p.distinctCount / p.totalValues < 0.05) {
        if (SCALE_NAME.test(p.name)) return { type: ColumnType.METRIC, note: { label: 'Scale Detection', message: `Column '${p.name}' is a small number scale — averaged, not summed by default.` } };
        return { type: ColumnType.DIMENSION };
    }
    // R9 — Default: dimension (categorical text or anything unclassified above).
    return { type: ColumnType.DIMENSION };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  HELPER FUNCTIONS                                               ║
// ╚══════════════════════════════════════════════════════════════════╝

/** Day-first dates everywhere except US-style locales (and when no locale is known). */
export function prefersDayFirst(): boolean {
    const lang = typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : '';
    if (!lang) return false;
    return !/^(en-US|es-US|en-PH|fil|en-CA)$/i.test(lang);
}

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

/**
 * Case-normalize a dimension value WITHOUT destroying meaningful casing.
 *
 * Plain words with inconsistent casing ("north AMERICA" → "North America")
 * are normalized, but tokens that carry real meaning in their casing are
 * preserved verbatim so the ETL never corrupts legitimate values:
 *   - alphanumeric codes / models: "WH-1000XM5", "PS5", "34\"", "S24"
 *   - brand / camelCase names:     "iPhone", "eBay", "MacBook", "AirPods"
 *   - short acronyms:              "USA", "NYC", "IBM", "EU"
 *
 * Exported for unit testing.
 */
export function toTitleCase(s: string): string {
    const part = (w: string) => {
        if (!w) return w;
        // Contains a digit → alphanumeric code/model number → leave as-is.
        if (/\d/.test(w)) return w;
        // Internal capital (camelCase / brand) → leave as-is (iPhone, eBay, MacBook).
        if (/[a-z][A-Z]/.test(w)) return w;
        // Short all-caps token → acronym (USA, NYC, IBM) → leave as-is.
        if (w.length <= 4 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;
        // Otherwise normalize: first letter up, rest down.
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    };
    // A whole value in capitals with a long word in it ("JARDIM DA PENHA",
    // "ILHA DO PRÍNCIPE") is shouting: every word is normalised, short joining
    // words go lower case, and only 2–3 letter words (USA, UK) stay capitals.
    const letterWords = s.split(/\s+/).filter(w => /\p{L}/u.test(w));
    if (letterWords.length >= 2 && s === s.toUpperCase() && /\p{Lu}/u.test(s) && letterWords.some(w => w.replace(/[^\p{L}]/gu, '').length >= 5) && !/\d/.test(s)) {
        const JOINING = /^(da|de|do|das|dos|du|del|della|di|la|le|el|van|von|der|den|of|and|the|on|in|at|upon|y|e)$/i;
        return s.split(/(\s+)/).map((w, i) => {
            if (!/\p{L}/u.test(w)) return w;
            if (JOINING.test(w)) return i > 0 ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase();
            if (w.length <= 3 && /^[A-Z]+$/.test(w)) return w;
            return w.split(/([-/'])/).map(piece => (/^[-/']$/.test(piece) ? piece : piece.charAt(0) + piece.slice(1).toLowerCase())).join('');
        }).join('');
    }
    // Each part of a hyphenated or slashed word is a word of its own:
    // "Mercedes-Benz", "C-Class", "Stoke-on-Trent" keep their capitals.
    // Short joining words inside a name stay lower case ("Cost of Goods Sold",
    // "Point of Sale"); the first word is always capitalised.
    const JOIN = /^(of|and|the|for|or|with|from|per|vs)$/i;
    return s.replace(/\w\S*/g, (w, offset: number) => {
        if (offset > 0 && JOIN.test(w)) return w.toLowerCase();
        if (/\d/.test(w) || !/[-/]/.test(w)) return /\d/.test(w) ? w : part(w);
        // "MERCEDES-BENZ" is shouting, not acronyms: only 1–2 letter parts stay capitals.
        const shouting = w === w.toUpperCase();
        return w.split(/([-/])/).map(piece => (piece === '-' || piece === '/' ? piece
            : shouting && piece.length > 2 ? piece.charAt(0) + piece.slice(1).toLowerCase() : part(piece))).join('');
    });
}

/**
 * Aggressive Title Case that does NOT preserve brand/camelCase casing. Used only
 * for columns detected as "messy-cased" human text (see isMessyCasedColumn),
 * where preservation is the wrong call. "andrEw waTtS" → "Andrew Watts",
 * "EDWaRDs" → "Edwards", "mRS. jamiE" → "Mrs. Jamie".
 */
export function forceTitleCase(s: string): string {
    return s.toLowerCase().replace(/(^|[^a-zA-Z])([a-z])/g, (_, pre, c) => pre + c.toUpperCase());
}

/**
 * True when a single token has irregular human casing that is NOT a recognizable
 * brand / camelCase / acronym / code pattern. "waTtS", "EDWaRDs", "adrIENNE",
 * "CHrisTInA" → chaotic; "iPhone", "eBay", "MacBook", "AirPods", "USA", "PS5",
 * "Watts", "watts", "WATTS" → not chaotic.
 */
function isChaoticCasedWord(w: string): boolean {
    const core = w.replace(/[^A-Za-z]/g, '');
    if (core.length < 2) return false;
    if (/\d/.test(w)) return false;                     // model code
    if (/^[a-z]+$/.test(core)) return false;            // all lowercase
    if (/^[A-Z]+$/.test(core)) return false;            // all UPPERCASE / acronym
    if (/^[A-Z][a-z]+$/.test(core)) return false;       // Title case
    if (/^[a-z]+[A-Z][a-z]+$/.test(core)) return false; // camelCase: eBay, iPhone
    if (/^([A-Z][a-z]+){2,}$/.test(core)) return false; // PascalCase brand: MacBook
    return true;                                         // anything else = chaotic
}

/**
 * Column-level detector: is a text column dominated by messy human casing? When
 * true, the ETL normalizes it with forceTitleCase instead of the brand-preserving
 * toTitleCase. A genuine product column ("iPhone 15", "MacBook Pro") scores ~0%
 * chaotic and is left alone; a name column full of "waTtS"/"EDWaRDs" trips it.
 */
export function isMessyCasedColumn(values: any[]): boolean {
    let considered = 0;
    let chaotic = 0;
    for (const v of values) {
        if (typeof v !== 'string') continue;
        const t = v.trim();
        if (!t || /\d/.test(t)) continue; // ignore blanks and codes/numbers
        considered++;
        if (t.split(/\s+/).some(isChaoticCasedWord)) chaotic++;
    }
    return considered >= 4 && chaotic / considered >= 0.25;
}

function toISO(y: number, m: number, d: number): string {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * A month or weekday name — the marker that a free-text string is a written
 * date ("Tue Nov 08 2016", "November 8, 2016") rather than a label that merely
 * contains a number ("Employee 10", "Customer 25").
 */
const MONTH_OR_WEEKDAY_NAME = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)/i;
/** A plausible calendar year, so "Employee 10" cannot qualify. */
const FOUR_DIGIT_YEAR = /\b(1[89]\d{2}|20\d{2}|21\d{2})\b/;

function isValidDate(y: number, m: number, d: number): boolean {
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return d <= daysInMonth;
}

/** Try parsing a single value as a date using a specific format ID */
/**
 * A date with a clock time after it ("07.05.2025 13:35", "02/01/2025 9:05 PM"):
 * the date part, and the time as HH:MM[:SS] so hour and minute grains still work.
 */
function splitClockTime(s: string): { date: string; time: string } | null {
    const m = s.match(/^(.*\d)[\sT,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp]\.?[Mm]\.?)?$/);
    if (!m) return null;
    let hour = +m[2];
    const pm = m[5] && /^p/i.test(m[5]);
    if (m[5]) { if (hour > 12) return null; if (pm && hour < 12) hour += 12; if (!pm && hour === 12) hour = 0; }
    if (hour > 23 || +m[3] > 59 || (m[4] !== undefined && +m[4] > 59)) return null;
    const pad = (n: number | string) => String(n).padStart(2, '0');
    return { date: m[1].trim(), time: `${pad(hour)}:${m[3]}${m[4] !== undefined ? `:${m[4]}` : ''}` };
}

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
    // ISO datetime (with T or space separator)
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) {
        const datePart = s.substring(0, 10);
        const [y, m, d] = datePart.split('-').map(Number);
        // Preserve full datetime string (crucial for hour/minute grains)
        return isValidDate(y, m, d) ? s.replace(' ', 'T').split('.')[0].replace(/\s*(Z|[+-]\d{2}:?\d{2})$/, '') : null;
    }
    // Find matching format (a clock time after the date is kept)
    const clock = splitClockTime(s);
    const body = clock ? clock.date : s;
    for (const fmt of DATE_FORMATS) {
        if (fmt.id !== formatId) continue;
        const match = body.match(fmt.regex);
        if (!match) continue;
        const parsed = fmt.parse(match);
        if (parsed && isValidDate(parsed.y, parsed.m, parsed.d)) {
            return toISO(parsed.y, parsed.m, parsed.d) + (clock ? `T${clock.time}` : '');
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
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}/.test(s)) {
        const datePart = s.substring(0, 10);
        const [y, m, d] = datePart.split('-').map(Number);
        // Preserve full datetime (crucial for hour/minute grains)
        return isValidDate(y, m, d) ? { iso: s.replace(' ', 'T').split('.')[0].replace(/\s*(Z|[+-]\d{2}:?\d{2})$/, ''), formatId: 'YYYY-MM-DD' } : null;
    }
    // Try native JS Date parsing for long strings like "Tue Nov 08 2016 00:00:00 GMT..."
    //
    // new Date() is dangerously lenient: new Date("Employee 10") returns
    // 2001-10-01, because it ignores the word and reads "10" as a month. A guard
    // of "longer than 10 characters and contains a letter" lets almost any
    // labelled text through, which silently turned employee_name and
    // customer_name into DATE columns — and their fake 1950..2049 range then
    // drove the whole dataset's time context and dim_date.
    //
    // So only hand a string to the native parser when it genuinely reads as a
    // written date: a month or weekday name AND a four-digit year.
    if (s.length > 10 && MONTH_OR_WEEKDAY_NAME.test(s) && FOUR_DIGIT_YEAR.test(s)) {
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
    const clock = splitClockTime(s);
    const body = clock ? clock.date : s;
    for (const fmt of DATE_FORMATS) {
        const match = body.match(fmt.regex);
        if (!match) continue;
        const parsed = fmt.parse(match);
        if (parsed && isValidDate(parsed.y, parsed.m, parsed.d)) {
            return { iso: toISO(parsed.y, parsed.m, parsed.d) + (clock ? `T${clock.time}` : ''), formatId: fmt.id };
        }
    }
    return null;
}

function log(step: string, layer: number, status: ETLLog['status'], details: string, extra?: Partial<ETLLog>): ETLLog {
    return { step, stepNumber: layer, details, status, timestamp: Date.now(), ...extra };
}

/** A step the user reversed: say what was left as uploaded, and offer to clean it again. */
function keptLog(option: keyof EtlOptions, details: string, extra?: Partial<ETLLog>): ETLLog {
    return log('Kept As Uploaded', 1, 'info', details, { ...extra, revert: { option, value: null, label: 'Clean this again' } });
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  LAYER 1: STRUCTURAL NORMALIZATION                              ║
// ╚══════════════════════════════════════════════════════════════════╝

function layer1_structuralNormalization(
    rawRows: Record<string, any>[],
    preserveRowMultiplicity = false,
    opts: EtlOptions = {},
): { rows: Record<string, any>[]; logs: ETLLog[]; columnsRemoved: number; duplicatesRemoved: number } {
    const logs: ETLLog[] = [];
    let columnsRemoved = 0;
    let duplicatesRemoved = 0;
    let rows = rawRows.map(r => ({ ...r }));

    // ── 1a: Header Normalization ──
    {
        const headerMap: Record<string, string> = {};
        let renamedCount = 0;
        const used = new Map<string, number>();
        const collisions: string[] = [];
        Object.keys(rows[0]).forEach((h, index) => {
            let normalized = normalizeHeaderName(h, index);
            // "Sales" and "sales " normalise to the same name: keep both columns.
            const n = (used.get(normalized) || 0) + 1;
            used.set(normalized, n);
            if (n > 1) { collisions.push(`${h} → ${normalized}_${n}`); normalized = `${normalized}_${n}`; }
            headerMap[h] = normalized;
            if (h !== normalized) renamedCount++;
        });
        if (collisions.length > 0) {
            logs.push(log('Header Collision', 1, 'applied',
                `${collisions.length} header(s) became identical after normalising and were kept separately: ${collisions.join(', ')}.`,
                { affectedColumns: collisions.map(c => c.split(' → ')[1]) }));
        }
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

        if (firstCol && lastCol && opts.keepNameColumns) {
            logs.push(keptLog('keepNameColumns', `'${firstCol}' and '${lastCol}' were kept as separate columns.`, { affectedColumns: [firstCol, lastCol] }));
        } else if (firstCol && lastCol) {
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
                { affectedColumns: [firstCol, lastCol, mergedName], revert: { option: 'keepNameColumns', value: true, label: 'Keep them separate' } }
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
        // Only columns with no values at all. A sparse column (refunds on 3% of
        // orders, a rarely-used discount code) is real data, not padding.
        const emptyCols = allKeys.filter(key => !rows.some(r => !isNullish(r[key])));
        if (emptyCols.length > 0) {
            rows = rows.map(row => {
                const nr: any = {};
                Object.keys(row).forEach(k => { if (!emptyCols.includes(k)) nr[k] = row[k]; });
                return nr;
            });
            columnsRemoved += emptyCols.length;
            logs.push(log('Empty Column Removal', 1, 'applied', `Removed ${emptyCols.length} completely empty column(s): ${emptyCols.join(', ')}.`, { affectedColumns: emptyCols }));
        } else {
            logs.push(log('Empty Column Removal', 1, 'skipped', 'No completely empty columns.'));
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

    // ── 1e1: Header rows repeated inside the data (concatenated exports) ──
    {
        const keys = Object.keys(rows[0] || {});
        const before = rows.length;
        const isHeaderEcho = (row: Record<string, any>) => {
            let filled = 0, echoes = 0;
            for (const k of keys) {
                const v = row[k];
                if (isNullish(v)) continue;
                filled++;
                if (String(v).trim().toLowerCase().replace(/[\s\W]+/g, '_') === k) echoes++;
            }
            return filled >= 2 && echoes / filled >= 0.8;
        };
        rows = rows.filter(row => !isHeaderEcho(row));
        if (rows.length < before) {
            logs.push(log('Repeated Header Rows', 1, 'applied',
                `Removed ${before - rows.length} row(s) that repeat the column headers (files joined together).`,
                { rowsBefore: before, rowsAfter: rows.length }));
        }
    }

    // ── 1e1b: Report layouts (profit and loss): headings → a section column ──
    if (!opts.keepTotalRows) {
        const r = foldReportSections(rows);
        if (r) {
            const before = rows.length;
            rows = r.rows;
            const calc = r.calculatedLabels;
            logs.push(log('Report Layout', 1, 'applied',
                `Read this as a report: the headings (${r.sections.slice(0, 4).join(', ')}${r.sections.length > 4 ? ', …' : ''}) became a 'section' column`
                + (r.renamedTo ? `, the unnamed first column became '${r.renamedTo}'` : '')
                + (calc.length ? `, and ${calc.length} calculated line(s) (${calc.slice(0, 3).join(', ')}) were removed — they are worked out from the lines above, so adding them in would count money twice` : '')
                + `. ${before} rows → ${rows.length}.`,
                { rowsBefore: before, rowsAfter: rows.length, affectedColumns: ['section', r.labelColumn], removedRowSamples: r.calculated.slice(0, 10), revert: { option: 'keepTotalRows', value: true, label: 'Keep the report as uploaded' } }));
        }
    }

    // ── 1e2: Total / subtotal rows from report exports ──
    {
        const t = removeTotalRows(rows);
        if (t.removed.length > 0 && opts.keepTotalRows) {
            logs.push(keptLog('keepTotalRows', `${t.removed.length} total/subtotal row(s) were kept. Sums that include them count those figures twice.`,
                { removedRowSamples: t.removed.slice(0, 10), affectedRows: t.removed.length }));
        } else if (t.removed.length > 0) {
            rows = t.rows;
            logs.push(log('Total Row Removal', 1, 'applied',
                `Removed ${t.removed.length} total/subtotal row(s) — their figures equal the rows they total, so keeping them would double-count.`,
                { rowsBefore: rows.length + t.removed.length, rowsAfter: rows.length, removedRowSamples: t.removed.slice(0, 10), revert: { option: 'keepTotalRows', value: true, label: 'Keep these rows' } }));
        }
        if (t.suspicious.length > 0) {
            logs.push(log('Total Row Flag', 6, 'info',
                `${t.suspicious.length} row(s) are labelled like totals but their numbers don't match the rows above, so they were kept. Check whether they should be counted.`,
                { removedRowSamples: t.suspicious.slice(0, 10), affectedRows: t.suspicious.length }));
        }
    }

    // ── 1e3: Wide tables — one column per period → one row per period ──
    {
        const u = unpivotPeriodColumns(rows);
        if (u && opts.keepWideLayout) {
            logs.push(keptLog('keepWideLayout', `The ${u.periodColumns.length} period columns (${u.periodColumns.slice(0, 4).join(', ')}${u.periodColumns.length > 4 ? ', …' : ''}) were kept side by side, so trends over time are not available.`,
                { affectedColumns: u.periodColumns }));
        } else if (u) {
            const before = rows.length;
            rows = u.rows;
            logs.push(log('Unpivot Period Columns', 1, 'applied',
                `Reshaped ${u.periodColumns.length} period columns (${u.periodColumns.slice(0, 4).join(', ')}${u.periodColumns.length > 4 ? ', …' : ''}) into 'period'${u.dated ? ' (as dates)' : ''} and 'value' so time can be trended and totals summed once.`
                + (u.totalColumns.length ? ` The ${u.totalColumns.map(c => `'${c}'`).join(', ')} column adds up the periods, so it was left out (it would repeat on every period).` : '')
                + ` ${before} rows → ${rows.length}.`,
                { rowsBefore: before, rowsAfter: rows.length, affectedColumns: [...u.periodColumns, 'period', 'value'], revert: { option: 'keepWideLayout', value: true, label: 'Keep the original layout' } }));
        }
    }

    // ── 1e3b: Order details written only on an order's first line → filled down ──
    {
        const f = fillOrderLevelDetails(rows);
        if (f) {
            logs.push(log('Order Details Filled', 1, 'applied',
                `Orders with several lines had their details (${f.filled.slice(0, 5).join(', ')}${f.filled.length > 5 ? ', …' : ''}) only on the first line of each '${f.key}'. They were copied to the order's other lines (${f.cells} cells) instead of being marked Unknown.`
                + (f.firstLineAmounts.length ? ` Order amounts (${f.firstLineAmounts.slice(0, 4).join(', ')}) stay on the first line, so totals count each order once.` : ''),
                { affectedColumns: f.filled, affectedRows: f.cells }));
        }
    }

    // ── 1e4: Year + month columns but no date → a period date ──
    {
        const keys = Object.keys(rows[0] || {});
        const hasDate = keys.some(k => DATE_NAME_PATTERNS.test(k) || /(_date|_at|_time|^period)$/i.test(k)
            || rows.slice(0, 50).filter(r => /^\d{4}-\d{2}-\d{2}/.test(String(r[k] ?? '')) || r[k] instanceof Date).length >= 25);
        const added = addPeriodFromYearMonth(rows, hasDate);
        if (added) {
            logs.push(log('Period From Year And Month', 1, 'applied',
                `No date column found; built '${added}' (first day of each month) from the year and month columns so trends work.`,
                { affectedColumns: [added] }));
        }
    }

    // ── 1f: Duplicate Row Removal (exact copies under a unique key only) ──
    {
        if (preserveRowMultiplicity) {
            logs.push(log('Duplicate Row Removal', 1, 'skipped',
                'Skipped for a relational source table so fact multiplicity and duplicate-key evidence remain intact.'));
        } else if (opts.keepDuplicateRows) {
            const d = dedupeRows(rows, ID_PATTERNS);
            if (d.removed.length > 0) logs.push(keptLog('keepDuplicateRows', `${d.removed.length} exact duplicate row(s) were kept, so they are counted more than once.`,
                { removedRowSamples: d.removed.slice(0, 10), affectedRows: d.removed.length }));
        } else {
        const before = rows.length;
        const d = dedupeRows(rows, ID_PATTERNS);
        rows = d.rows;
        duplicatesRemoved = d.removed.length;
        if (duplicatesRemoved > 0) {
            logs.push(log('Duplicate Row Removal', 1, 'applied',
                `Removed ${duplicatesRemoved} exact duplicate row(s). '${d.keyColumn}' is unique once copies are removed, so the repeats were re-exported copies.`,
                { rowsBefore: before, rowsAfter: rows.length, removedRowSamples: d.removed.slice(0, 10), affectedColumns: d.keyColumn ? [d.keyColumn] : [], revert: { option: 'keepDuplicateRows', value: true, label: 'Keep the copies' } }));
        } else {
            logs.push(log('Duplicate Row Removal', 1, 'skipped', d.keyColumn
                ? `No duplicate rows ('${d.keyColumn}' is unique).`
                : 'No unique key column to prove duplicates, so no rows were removed.'));
        }
        if (d.repeatedKept > 0) {
            logs.push(log('Repeated Rows Kept', 6, 'info',
                d.keyColumn
                    ? `${d.repeatedKept} row(s) exactly repeat another row but have no '${d.keyColumn}', so nothing proves they are copies: they may be genuine repeat transactions and were kept. If they are accidental copies, remove them in Data Studio.`
                    : `${d.repeatedKept} row(s) exactly repeat another row. With no unique ID they may be genuine repeat transactions, so they were kept. If they are accidental copies, remove them in Data Studio.`,
                { affectedRows: d.repeatedKept }));
        }
        if (d.repeatingIdColumns.length > 0) {
            logs.push(log('Repeating ID Note', 6, 'info',
                `${d.repeatingIdColumns.map(c => `'${c}'`).join(', ')} repeat across rows with different values (for example several lines per order). Each row is kept as its own line.`,
                { affectedColumns: d.repeatingIdColumns }));
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
                // Repair broken encodings (Café → Café, smart quotes) before anything else.
                v = normalizeUnicode(v);
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

function layer3_columnProfiling(rows: Record<string, any>[], dayFirst = prefersDayFirst()): { profiles: ColumnProfileData[]; logs: ETLLog[] } {
    const logs: ETLLog[] = [];
    const keys = Object.keys(rows[0] || {});
    const profiles: ColumnProfileData[] = [];

    for (const col of keys) {
        const values = rows.map(r => r[col]);
        const total = values.length;
        // Blank cells are missing values, not text: a sparse numeric column
        // (refunds on 3% of rows) must still profile as numeric.
        const nonNull = values.filter(v => v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === ''));
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
        let integerCount = 0;
        let unitNumberCount = 0;
        let durationCount = 0;
        let durationOver24h = false;
        const numberStyle = detectNumberStyle(nonNull);
        const percentValues: number[] = [];
        let plainFractions = 0;
        let moneyFormatCount = 0;

        for (const v of nonNull) {
            if (typeof v === 'string' && MONEY_FORMAT.test(v.trim())) moneyFormatCount++;
            if (typeof v === 'string') { const mins = parseDurationMinutes(v); if (mins !== null) { durationCount++; if (mins >= 1440) durationOver24h = true; continue; } }
            const s = String(v);
            if (hasCurrencyMarker(v)) currencyDetected = true;
            if (s.includes('%')) percentageDetected = true;
            // Word number check
            if (typeof v === 'string' && wordToNumber(v) !== null) {
                const wordNumber = wordToNumber(v)!;
                wordNumberCount++;
                numericCount++;
                if (Number.isInteger(wordNumber)) integerCount++;
                if (wordNumber < min) min = wordNumber;
                if (wordNumber > max) max = wordNumber;
                continue;
            }
            // Profile with the exact parser used by Layer 5. This prevents a
            // value such as "387.00 GBP" from being classified as text and
            // later reaching DuckDB as SUM(VARCHAR).
            const num = parseLocaleNumber(v, numberStyle || undefined);
            if (num !== null) {
                numericCount++;
                if (Number.isInteger(num)) integerCount++;
                if (num < min) min = num;
                if (num > max) max = num;
                if (s.includes('%')) percentValues.push(num);
                else if (Math.abs(num) <= 1 && num !== 0) plainFractions++;
            } else {
                const withUnit = parseNumberWithUnit(v, numberStyle || undefined);
                if (withUnit) {
                    unitNumberCount++;
                    if (withUnit.value < min) min = withUnit.value;
                    if (withUnit.value > max) max = withUnit.value;
                }
            }
        }
        // "12%" cells next to plain 0.12 cells: the plain ones are fractions of
        // the same rate and must be scaled to points, or averages mix scales.
        const sortedPct = [...percentValues].sort((a, b) => a - b);
        const percentMode: 'points' | null = percentValues.length >= 1 && plainFractions >= 1
            && percentValues.length >= (percentValues.length + plainFractions) * 0.1
            && (sortedPct[Math.floor(sortedPct.length / 2)] ?? 0) > 1 ? 'points' : null;
        // Key-shape signals (relationship/uniqueness): integer-heaviness and whether the
        // integer values form a near-contiguous run (auto-increment / serial key).
        const integerRate = numericCount > 0 ? integerCount / numericCount : 0;
        const looksSequential = (() => {
            if (integerRate < 0.99 || min === Infinity || max === -Infinity) return false;
            if (distinctCount < 20) return false; // too few to distinguish a run from a small category
            const span = max - min + 1;
            // A serial key visits nearly every integer in its range exactly once.
            return span > 0 && distinctCount / span >= 0.9 && distinctCount / span <= 1.1;
        })();

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
            const match = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:[\sT,]+\d{1,2}:\d{2}.*)?$/);
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
        } else if (!hasDayOver12 && !hasMonthOver12) {
            // Nothing in the data decides it (every part ≤ 12): follow the
            // user's locale — day first everywhere except the US.
            // Ambiguous values were counted under the US reading (it is tried
            // first), so move those counts rather than just dropping them.
            const move = (from: string, to: string) => {
                if (formatCounts[from]) formatCounts[to] = (formatCounts[to] || 0) + formatCounts[from];
                delete formatCounts[from];
            };
            if (dayFirst) { move('MM/DD/YYYY', 'DD/MM/YYYY'); move('MM/DD/YY', 'DD/MM/YY'); }
            else { move('DD/MM/YYYY', 'MM/DD/YYYY'); move('DD/MM/YY', 'MM/DD/YY'); }
        }
        // How to read d/d/yyyy values when another format wins the count
        // (a column mixing "01 Jan 2025", "2025-01-03" and "02/01/2025").
        const slashDayFirst = hasDayOver12 && !hasMonthOver12 ? true : hasMonthOver12 && !hasDayOver12 ? false : dayFirst;
        // Pick format with most matches (for actual parsing later)
        let bestDateRate = 0;
        for (const [fmt, count] of Object.entries(formatCounts)) {
            if (count > bestDateRate) { bestDateRate = count; bestDateFormat = fmt; }
        }
        // dateParseRate = total parseable / total non-null (across ALL formats combined)
        const dateParseRate = nonNull.length > 0 ? totalDateParseable / nonNull.length : 0;

        // Boolean token rate
        let sawTrue = false;
        let sawFalse = false;
        const boolCount = nonNull.filter(v => {
            const token = typeof v === 'boolean' ? v : typeof v === 'string' ? BOOLEAN_TOKENS[v.toLowerCase().trim()] : undefined;
            if (token === true) sawTrue = true;
            if (token === false) sawFalse = true;
            return token !== undefined;
        }).length;
        // "F"/"M" (gender) or "N"/"S" (north/south) match only one side of a
        // yes/no pair, with other values beside them: a category, not yes/no.
        const oneSidedBoolean = !(sawTrue && sawFalse) && boolCount < nonNull.length;
        // The one shared rule (utils/twoValues): true/false, yes/no, y/n, t/f
        // or 0/1 — and not a coded category such as gender 0/1.
        const exactYesNo = isYesNoValues(nonNull, col);
        const messyYesNo = !oneSidedBoolean && sawTrue && sawFalse && !isLabelName(col) && nonNull.some(v => typeof v !== 'number');

        const profile: ColumnProfileData = {
            name: col,
            nullRate,
            distinctCount,
            totalValues: nonNull.length,
            numericParseRate: nonNull.length > 0 ? numericCount / nonNull.length : 0,
            dateParseRate,
            booleanTokenRate: exactYesNo ? 1 : nonNull.length > 0 && messyYesNo ? boolCount / nonNull.length : 0,
            min: min === Infinity ? undefined : min,
            max: max === -Infinity ? undefined : max,
            dateFormatCandidate: bestDateFormat,
            slashDayFirst,
            currencyDetected,
            moneyFormatRate: nonNull.length > 0 ? moneyFormatCount / nonNull.length : 0,
            percentageDetected,
            wordNumberRate: nonNull.length > 0 ? wordNumberCount / nonNull.length : 0,
            integerRate,
            looksSequential,
            messyCasing: isMessyCasedColumn(strValues),
            leadingZeroCode: looksLikeLeadingZeroCode(nonNull),
            numberStyle,
            unitNumberRate: nonNull.length > 0 ? unitNumberCount / nonNull.length : 0,
            durationRate: nonNull.length > 0 ? durationCount / nonNull.length : 0,
            sentenceLike: looksLikeSentences(rows, col),
            codeLength: strValuesAreCodes(rows, col, 3) ? 3 : strValuesAreCodes(rows, col, 2) ? 2 : undefined,
            timeOfDay: nonNull.length > 0 && durationCount / nonNull.length >= 0.8 && !durationOver24h && isClockTimeName(col, keys),
            percentMode,
            percentCellRate: numericCount > 0 ? percentValues.length / numericCount : 0,
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

/**
 * Data-driven KEY detection (Phase 4). Numeric columns whose SHAPE says "this is
 * an identifier, not a measure" — even when the column NAME gives nothing away.
 * Aggregating a key (SUM of order numbers, AVG of a serial id) is meaningless, so
 * catching these before the metric gate keeps auto-analysis honest.
 *
 * Two relationship/uniqueness signals, both requiring integer-heavy numeric data
 * with no money/percent formatting:
 *   • primary-key   — values are near-unique (a candidate key for the row)
 *   • serial-key    — values form a near-contiguous run (auto-increment id)
 *
 * Deliberately conservative: it never fires on columns with a strong metric name,
 * on non-integer/decimal data (measures have cents), or on low-cardinality data
 * (that's a category, handled elsewhere).
 */
export function keySignalFor(
    p: Pick<ColumnProfileData, 'distinctCount' | 'totalValues' | 'numericParseRate' | 'currencyDetected' | 'percentageDetected' | 'integerRate' | 'looksSequential'>,
    isMetricName: boolean
): { isKey: boolean; reason: string } {
    // Never override a real measure: money/percent formatting or a metric name means "measure".
    if (isMetricName || p.currencyDetected || p.percentageDetected) return { isKey: false, reason: '' };
    // Must be integer-heavy numeric data — keys don't have decimals.
    if (p.numericParseRate < 0.9 || (p.integerRate ?? 0) < 0.99) return { isKey: false, reason: '' };

    const cardRatio = p.totalValues > 0 ? p.distinctCount / p.totalValues : 0;
    // Serial / auto-increment key: a contiguous run of integers that also visits
    // each value ~once (near-unique per row). The near-uniqueness guard is what
    // separates a real serial id from a bounded, repeating attribute like age or
    // year, whose values are also contiguous but recur across many rows.
    if (p.looksSequential && cardRatio >= 0.9) return { isKey: true, reason: 'integer values form a sequential run — looks like a serial identifier, not a measure' };
    // Primary-key: near-unique integers with enough rows to be sure.
    if (p.distinctCount >= 20 && cardRatio >= 0.95)
        return { isKey: true, reason: 'integer values are near-unique — looks like an identifier, not a measure' };
    return { isKey: false, reason: '' };
}

/**
 * Confidence (0–1) that a column's assigned ROLE is correct, from the strength
 * of the signals that drove it. Advisory only — it does not change the
 * decision; it surfaces genuinely ambiguous columns for user review (e.g. a
 * low-cardinality numeric that could be a category/year rather than an ID).
 */
export function roleConfidenceFor(
    type: ColumnType,
    p: Pick<ColumnProfileData, 'distinctCount' | 'totalValues' | 'numericParseRate' | 'dateParseRate' | 'booleanTokenRate'>,
    signals: { isIdName: boolean; isDateName: boolean; isMetricName: boolean; effectiveNumericRate: number }
): { confidence: number; reason: string } {
    const cardRatio = p.totalValues > 0 ? p.distinctCount / p.totalValues : 0;
    const { isIdName, isDateName, isMetricName, effectiveNumericRate } = signals;
    switch (type) {
        case ColumnType.ID:
            if (isIdName) return { confidence: 0.92, reason: '' };
            if (cardRatio > 0.9) return { confidence: 0.85, reason: 'values are near-unique' };
            if (p.numericParseRate >= 0.9 && p.distinctCount < 10 && cardRatio < 0.05)
                return { confidence: 0.5, reason: 'low-cardinality number — could be a category or year, not an ID' };
            return { confidence: 0.6, reason: '' };
        case ColumnType.DATE:
            if (p.dateParseRate >= 0.8) return { confidence: 0.95, reason: '' };
            if (isDateName) return { confidence: 0.72, reason: 'classified by name; not all values parse as dates' };
            return { confidence: 0.62, reason: 'only about half the values parse as dates' };
        case ColumnType.BOOLEAN:
            return p.booleanTokenRate >= 0.8
                ? { confidence: 0.9, reason: '' }
                : { confidence: 0.6, reason: 'mixed true/false tokens' };
        case ColumnType.METRIC:
            if (isMetricName && effectiveNumericRate >= 0.7) return { confidence: 0.9, reason: '' };
            if (isMetricName) return { confidence: 0.72, reason: '' };
            if (effectiveNumericRate >= 0.7) return { confidence: 0.68, reason: 'numeric by data, but the name is not a known metric' };
            return { confidence: 0.5, reason: 'weak metric signal' };
        case ColumnType.DIMENSION:
            if (effectiveNumericRate < 0.3) return { confidence: 0.85, reason: '' };
            return { confidence: 0.58, reason: 'a numeric column treated as a category — verify it should not be a metric' };
        default:
            return { confidence: 0.6, reason: '' };
    }
}

function layer4_rulePlanner(
    profiles: ColumnProfileData[],
    columnTypeOverrides?: Record<string, ColumnType>
): { columns: ColumnDefinition[]; plans: TransformPlan[]; logs: ETLLog[] } {
    const logs: ETLLog[] = [];
    const columns: ColumnDefinition[] = [];
    const plans: TransformPlan[] = [];

    for (const p of profiles) {
        let type: ColumnType;
        const steps: TransformStep[] = [];

        // Apply user override if present
        if (columnTypeOverrides && columnTypeOverrides[p.name]) {
            type = columnTypeOverrides[p.name];
            logs.push(log('User Override', 4, 'info', `Column '${p.name}' set to ${type} (manual override).`, { affectedColumns: [p.name] }));
        } else {
            // ── Role decision: pure, explicitly-ordered named rules (see
            //    classifyColumnRole). This block only logs the outcome. ──
            const decision = classifyColumnRole(p);
            type = decision.type;
            if (decision.note) {
                logs.push(log(decision.note.label, 4, 'info', decision.note.message, { affectedColumns: [p.name] }));
            }

            // Advisory confidence — surface ambiguous columns for review (no
            // change to the decision above).
            const rc = roleConfidenceFor(type, p, {
                isIdName: ID_PATTERNS.test(p.name),
                isDateName: DATE_NAME_PATTERNS.test(p.name),
                isMetricName: METRIC_NAME_EXACT.test(p.name) || METRIC_KEYWORDS.test(p.name),
                effectiveNumericRate: p.numericParseRate + (p.wordNumberRate || 0),
            });
            if (rc.confidence < 0.6) {
                logs.push(log('Low-Confidence Classification', 4, 'info',
                    `Column '${p.name}' → ${type} (${Math.round(rc.confidence * 100)}% confidence)${rc.reason ? ` — ${rc.reason}` : ''}. Review recommended.`,
                    { affectedColumns: [p.name] }));
            }
        }

        // Build transform plan based on type
        if (type === ColumnType.METRIC) {
            // Spelled-out numbers first ("twenty" → 20), then a single locale-aware
            // parse that handles currency symbols, %, (parentheses)/trailing
            // negatives, K/M/B suffixes, and US *and* EU decimal/thousands
            // separators — recovering values the old comma-strip turned into null.
            if (p.wordNumberRate > 0) steps.push({ name: 'WORD_TO_NUMBER', fn: (v: any) => { if (typeof v !== 'string') return v; const n = wordToNumber(v); return n !== null ? n : v; } });
            const style = p.numberStyle || undefined;
            const seen = { units: new Map<string, number>(), approximate: 0, scaled: 0, durations: 0 };
            const inHours = /(^|_)(hours?|hrs?)($|_)/i.test(p.name);
            steps.push({
                name: `PARSE_NUMBER(${style === 'eu' ? 'European format' : style === 'us' ? 'US format' : 'locale-aware'})`,
                fn: (v: any) => {
                    if (typeof v === 'string' && (p.durationRate || 0) >= 0.5) {
                        const minutes = parseDurationMinutes(v);
                        // A column named in hours ("hours_worked" 7:30) keeps hours: 7.5.
                        if (minutes !== null) { seen.durations++; return inHours ? Math.round(minutes / 60 * 100) / 100 : Math.round(minutes * 100) / 100; }
                    }
                    let n = parseLocaleNumber(v, style);
                    if (n === null) {
                        const withUnit = parseNumberWithUnit(v, style);
                        if (withUnit) {
                            n = withUnit.value;
                            if (withUnit.unit) seen.units.set(withUnit.unit, (seen.units.get(withUnit.unit) || 0) + 1);
                            if (withUnit.approximate) seen.approximate++;
                        }
                    }
                    if (n !== null && p.percentMode === 'points' && !(typeof v === 'string' && v.includes('%')) && Math.abs(n) <= 1 && n !== 0) {
                        seen.scaled++;
                        return Math.round(n * 100 * 1e6) / 1e6;
                    }
                    return n;
                },
            });
            steps.push({ name: 'IMPUTE_NULL', fn: (v: any) => (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) ? null : v });
            const column = p.name;
            const plan: TransformPlan = { column, type, steps, notes: () => {
                const out: ETLLog[] = [];
                if (seen.units.size > 0 || seen.approximate > 0) {
                    const units = [...seen.units.entries()].map(([u, n]) => `${u} (${n})`).join(', ');
                    out.push(log('Units Removed', 5, 'applied',
                        `Column '${column}': read numbers written with text${units ? ` (units seen: ${units})` : ''}${seen.approximate ? `; ${seen.approximate} marked approximate` : ''}.`
                        + (seen.units.size > 1 ? ' More than one unit appears; see the units step below.' : ''),
                        { affectedColumns: [column] }));
                }
                if (seen.scaled > 0) out.push(log('Percent Scale Standardized', 5, 'applied',
                    `Column '${column}': ${seen.scaled} value(s) written as fractions (0.12) were scaled to percent points (12) to match the cells written as "12%".`,
                    { affectedColumns: [column], affectedRows: seen.scaled }));
                if (seen.durations > 0) out.push(log('Durations Converted', 5, 'applied',
                    `Column '${column}': ${seen.durations} duration(s) (h:mm:ss) converted to ${inHours ? 'hours' : 'minutes'}.`,
                    { affectedColumns: [column], affectedRows: seen.durations }));
                return out;
            } };
            // Cells written as "12.5%" are kept as 12.5, so charts must not rescale them.
            const inPoints = p.percentMode === 'points' || (p.percentCellRate ?? 0) >= 0.5;
            columns.push(inPoints
                ? { name: p.name, type, originalType: 'string', valueUnit: 'percent_points' }
                : { name: p.name, type, originalType: 'string' });
            plans.push(plan);
            continue;
        } else if (type === ColumnType.DATE) {
            const fmt = p.dateFormatCandidate || 'YYYY-MM-DD';
            const slashOrder = p.slashDayFirst ? ['DD/MM/YYYY', 'DD/MM/YY'] : ['MM/DD/YYYY', 'MM/DD/YY'];
            steps.push({ name: `PARSE_DATE(${fmt})`, fn: (v: any) => tryParseDateWithFormat(v, fmt)
                || tryParseDateWithFormat(v, slashOrder[0]) || tryParseDateWithFormat(v, slashOrder[1])
                || tryParseDateAny(v)?.iso || null });
        } else if (type === ColumnType.BOOLEAN) {
            // BOOLEAN is a semantic role, not permission to rewrite the
            // source's Yes/No, Y/N, True/False or native boolean values.
            // Layer 2 has already handled whitespace and null tokens.
        } else if (type === ColumnType.DIMENSION) {
            // A user may expose a boolean-coded field as a dimension for
            // grouping. Keep its original category labels exactly as uploaded.
            if (p.booleanTokenRate >= 0.6) {
                columns.push({ name: p.name, type, originalType: 'string' });
                plans.push({ column: p.name, type, steps });
                continue;
            }
            // Free text (comments, notes, reviews) is left as written: no title
            // case, and a blank stays blank rather than becoming "Unknown".
            const freeText = FREE_TEXT_NAME.test(p.name) || Boolean(p.sentenceLike);
            // Contact details are never re-cased or filled in.
            const contact = /(^|_)(e_?mail|email_address|phone|mobile|tel|telephone|url|website|web_?site|link)($|_)/i.test(p.name);
            // Currency and country codes are capitals ("gbp" → "GBP").
            const isoCode = (/(^|_)(currency|currency_code|ccy)$/i.test(p.name) && p.codeLength === 3)
                || (/(^|_)(country|country_code|iso_country|country_iso|card_issue_country)$/i.test(p.name) && p.codeLength === 2);
            if (isoCode) {
                steps.push({ name: 'UPPER_CASE(code)', fn: (v: any) => typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : v });
            } else if (!freeText && !contact) {
                // Messy-cased columns (human-typed names like "waTtS") get aggressive
                // normalization; clean/brand columns keep preservation-aware casing.
                const titleFn = p.messyCasing ? forceTitleCase : toTitleCase;
                steps.push({ name: p.messyCasing ? 'TITLE_CASE(normalize)' : 'TITLE_CASE', fn: (v: any) => typeof v === 'string' && v.trim() !== '' ? titleFn(v) : v });
            }
            // Add synonym normalization step (case-insensitive column + value matching)
            steps.push({
                name: 'SYNONYM_MAP', fn: (v: any) => {
                    if (typeof v !== 'string' || v.trim() === '') return v;
                    const val = v.trim();
                    // 1. Match by exact column name (case-insensitive)
                    const colKey = Object.keys(CATEGORY_SYNONYMS).find(k => k.toLowerCase() === p.name.toLowerCase());
                    if (colKey) {
                        const group = CATEGORY_SYNONYMS[colKey];
                        // Try exact match first, then case-insensitive
                        if (group[val]) return group[val];
                        const valKey = Object.keys(group).find(k => k.toLowerCase().trim() === val.toLowerCase());
                        if (valKey) return group[valKey];
                    }
                    // Never borrow a mapping from an unrelated column: "No"
                    // may mean a return flag, not the region "North".
                    return v;
                }
            });
            // A blank discount code, gift note or add-on means there wasn't one, not that it is unknown.
            const blankMeansNone = OPTIONAL_DETAIL_NAME.test(p.name);
            if (!freeText && !contact) steps.push({ name: blankMeansNone ? 'IMPUTE_NONE' : 'IMPUTE_UNKNOWN', fn: (v: any) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) ? (blankMeansNone ? 'None' : 'Unknown') : v });
        } else if (type === ColumnType.ID) {
            // Cast IDs to clean integer strings (1.0 → "1", not "1.0")
            steps.push({
                name: 'CAST_ID', fn: (v: any) => {
                    if (v === null || v === undefined || v === '') return v;
                    const s = String(v).trim();
                    // Preserve significant leading zeros (zip 01234, SKU 007) —
                    // rounding would silently corrupt the code to "1234"/"7".
                    if (/^0\d+$/.test(s)) return s;
                    // Long numeric IDs (card, account, order numbers) lose digits as
                    // JS numbers; keep the text exactly as uploaded.
                    if (/^\d{16,}$/.test(s)) return s;
                    const n = Number(v);
                    if (!isNaN(n) && Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER && /^-?\d+(\.0+)?$/.test(s)) return String(Math.round(n));
                    return s;
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
            // Coercion loss: a real (non-empty) value that a PARSE step turned into
            // null — i.e. it was silently dropped from every future sum/average.
            const isParse = step.name.startsWith('PARSE_NUMBER');
            let coercionLoss = 0;
            const lostSamples: string[] = [];

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
                    if (isParse && newVal === null && oldVal !== null && oldVal !== undefined && String(oldVal).trim() !== ''
                        && !NULL_TOKENS.has(String(oldVal).trim().toLowerCase())) {
                        coercionLoss++;
                        if (lostSamples.length < 5) lostSamples.push(String(oldVal));
                    }
                    rows[i][plan.column] = newVal;
                } catch {
                    failed++;
                }
            }

            chain.push({ column: plan.column, step: step.name, rowsChanged: changed, rowsFailed: failed, inputSamples, outputSamples });

            if (coercionLoss > 0) {
                logs.push(log('Coercion Loss Flag', 6, 'info',
                    `Column '${plan.column}': ${coercionLoss} non-empty value(s) could not be parsed as numbers and were dropped (e.g. ${lostSamples.slice(0, 3).map(s => `"${s}"`).join(', ')}). These are excluded from sums/averages — review them.`,
                    { affectedColumns: [plan.column], affectedRows: coercionLoss }));
            }

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
        if (plan.notes) logs.push(...plan.notes());
    }

    logs.push(log('Transformation Engine', 5, 'applied',
        `Executed ${plans.reduce((s, p) => s + p.steps.length, 0)} transform steps across ${plans.length} columns. ${typeCastCount} total cell changes.`
    ));

    return { rows, lineage, logs, typeCastCount };
}

function detectPhysicalDataType(values: any[]): PhysicalDataType {
    const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
    if (nonNull.length === 0) return 'unknown';
    const kinds = new Set(nonNull.map(v => {
        if (v instanceof Date) return 'date';
        if (typeof v === 'number' && Number.isFinite(v)) return 'number';
        if (typeof v === 'boolean') return 'boolean';
        return 'string';
    }));
    return kinds.size === 1 ? [...kinds][0] as PhysicalDataType : 'mixed';
}

function normalizedTypeForRole(type: ColumnType, physicalType: PhysicalDataType): PhysicalDataType {
    if (type === ColumnType.METRIC) return 'number';
    if (type === ColumnType.DATE) return 'date';
    if (type === ColumnType.BOOLEAN) return physicalType;
    if (type === ColumnType.ID || type === ColumnType.DIMENSION) return 'string';
    return 'unknown';
}

function isValidNormalizedValue(value: any, type: ColumnType): boolean {
    if (value === null || value === undefined || value === '') return false;
    if (type === ColumnType.METRIC) return typeof value === 'number' && Number.isFinite(value);
    if (type === ColumnType.DATE) return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value);
    if (type === ColumnType.BOOLEAN) return typeof value === 'boolean'
        || (typeof value === 'string' && BOOLEAN_TOKENS[value.toLowerCase().trim()] !== undefined)
        || (typeof value === 'number' && (value === 0 || value === 1));
    if (type === ColumnType.ID) return typeof value === 'string' || typeof value === 'number';
    return true;
}

/** snake_case column name for a raw header ("Price (£)" → "price"). */
export function normalizeHeaderName(header: string, index: number): string {
    // Insert underscore before camelCase boundaries: SaleDate → Sale_Date, OrderID → Order_ID
    const camelSplit = header.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
    // Deterministic name for a blank header, so a re-upload maps to the same column.
    return camelSplit.trim().toLowerCase().replace(/[\s\W]+/g, '_').replace(/^_+|_+$/g, '') || `column_${index + 1}`;
}

/**
 * Money columns keep the currency the file used, from the header
 * ("Price (£)") or, failing that, from most of the values ("£12,000").
 */
function attachCurrencies(
    columns: ColumnDefinition[],
    rawHeaders: string[],
    sourceRows: Record<string, any>[],
): ColumnDefinition[] {
    const fromHeader = new Map<string, string>();
    rawHeaders.forEach((header, index) => {
        const currency = currencyOfHeader(header);
        if (currency) fromHeader.set(normalizeHeaderName(header, index), currency);
    });
    const sample = sourceRows.length > 2000 ? sourceRows.slice(0, 2000) : sourceRows;
    return columns.map(column => {
        if (column.type !== ColumnType.METRIC) return column;
        let currency = fromHeader.get(column.name) || null;
        if (!currency) {
            const values = sample.map(row => row[column.name]).filter(value => value !== null && value !== undefined && value !== '');
            const top = detectCurrencies(values)[0];
            if (top && top.count >= values.length * 0.5) currency = top.currency;
        }
        return currency ? { ...column, currency } : column;
    });
}

/**
 * Currency for each money column from the original file rows: the header
 * ("Price (£)") or, failing that, most of the values ("£12,000"). Used for
 * datasets saved before currencies were recorded.
 */
export function withDetectedCurrencies(columns: ColumnDefinition[], rawRows: Record<string, any>[]): ColumnDefinition[] {
    if (!rawRows?.length || columns.some(column => column.currency)) return columns;
    const headers = Object.keys(rawRows[0] || {});
    const sample = rawRows.length > 2000 ? rawRows.slice(0, 2000) : rawRows;
    const found = new Map<string, string>();
    headers.forEach((header, index) => {
        const name = normalizeHeaderName(header, index);
        let currency = currencyOfHeader(header);
        if (!currency) {
            const values = sample.map(row => row[header]).filter(value => value !== null && value !== undefined && value !== '');
            const top = detectCurrencies(values)[0];
            if (top && top.count >= values.length * 0.5) currency = top.currency;
        }
        if (currency) found.set(name, currency);
    });
    if (!found.size) return columns;
    let changed = false;
    const next = columns.map(column => {
        const currency = column.type === ColumnType.METRIC ? found.get(column.name) : undefined;
        if (!currency) return column;
        changed = true;
        return { ...column, currency };
    });
    return changed ? next : columns;
}

function attachConversionProfiles(
    columns: ColumnDefinition[],
    sourceRows: Record<string, any>[],
    normalizedRows: Record<string, any>[],
): ColumnDefinition[] {
    return columns.map(column => {
        const sourceValues = sourceRows.map(row => row[column.name]);
        const normalizedValues = normalizedRows.map(row => row[column.name]);
        const nonNullIndexes = sourceValues
            .map((value, index) => ({ value, index }))
            .filter(({ value }) => value !== null && value !== undefined && value !== '');
        let invalidCount = 0;
        let convertedCount = 0;
        const samples: { before: any; after: any }[] = [];

        for (const { value, index } of nonNullIndexes) {
            const normalized = normalizedValues[index];
            if (!isValidNormalizedValue(normalized, column.type)) invalidCount++;
            const changed = typeof value !== typeof normalized || String(value) !== String(normalized);
            if (changed) {
                convertedCount++;
                if (samples.length < 5) samples.push({ before: value, after: normalized });
            }
        }

        const nonNullCount = nonNullIndexes.length;
        const sourceType = detectPhysicalDataType(sourceValues);
        const physicalType = detectPhysicalDataType(normalizedValues);
        return {
            ...column,
            originalType: sourceType,
            physicalType,
            conversion: {
                sourceType,
                normalizedType: normalizedTypeForRole(column.type, physicalType),
                nonNullCount,
                convertedCount,
                invalidCount,
                parseSuccessRate: nonNullCount > 0 ? (nonNullCount - invalidCount) / nonNullCount : 1,
                samples,
            },
        };
    });
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  LAYER 5b: CORRECTNESS HARDENING                                ║
// ║  Safe canonical merges (applied) + data-quality FLAGS (never    ║
// ║  mutating numbers behind the user's back).                      ║
// ╚══════════════════════════════════════════════════════════════════╝

function layer5b_hardening(
    rows: Record<string, any>[],
    inputColumns: ColumnDefinition[],
    sourceRows: Record<string, any>[] = [],
    opts: EtlOptions = {},
    dayFirst = prefersDayFirst(),
): { rows: Record<string, any>[]; logs: ETLLog[]; columns: ColumnDefinition[] } {
    const logs: ETLLog[] = [];
    const columns = [...inputColumns];
    // Mixed units first, while rows still line up with the values as written.
    rows = convertMixedUnits(rows, sourceRows, columns, opts, logs);
    const valuesOf = (col: string) => rows.map(r => r[col]);
    const metricNames = () => columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
    const addColumn = (name: string, type: ColumnType) => {
        if (!columns.some(c => c.name === name)) columns.push({ name, type, originalType: type === ColumnType.METRIC ? 'number' : 'string' });
    };

    // ── 0a. Placeholder codes (999999, -1) in measures → missing, not huge numbers. ──
    for (const c of columns.filter(c => c.type === ColumnType.METRIC)) {
        const placeholders = detectPlaceholderValues(valuesOf(c.name));
        if (placeholders.size === 0) continue;
        if (opts.keepPlaceholders) {
            logs.push(keptLog('keepPlaceholders', `Column '${c.name}': placeholder value(s) ${[...placeholders].join(', ')} were kept as numbers and are included in sums and averages.`, { affectedColumns: [c.name] }));
            continue;
        }
        let changed = 0;
        for (const row of rows) if (typeof row[c.name] === 'number' && placeholders.has(row[c.name])) { row[c.name] = null; changed++; }
        logs.push(log('Placeholder Values Removed', 5, 'applied',
            `Column '${c.name}': ${changed} placeholder value(s) (${[...placeholders].join(', ')}) treated as missing — they sit far outside every real value and would distort sums and averages.`,
            { affectedColumns: [c.name], affectedRows: changed, revert: { option: 'keepPlaceholders', value: true, label: 'Keep these values' } }));
    }

    // ── 0b. Several currencies in one measure: never add them together blindly. ──
    for (const c of columns.filter(c => c.type === ColumnType.METRIC)) {
        const raw = sourceRows.length === rows.length ? sourceRows.map(r => r[c.name]) : [];
        const currencies = detectCurrencies(raw);
        const marked = currencies.reduce((s, x) => s + x.count, 0);
        if (currencies.length < 2 || currencies[1].count < Math.max(2, marked * 0.05)) continue;
        const target = `${c.name}_currency`;
        rows.forEach((row, i) => { row[target] = currencyOf(raw[i]) || 'Unspecified'; });
        addColumn(target, ColumnType.DIMENSION);
        logs.push(log('Mixed Currency Flag', 6, 'info',
            `Column '${c.name}' mixes ${currencies.map(x => `${x.currency} (${x.count})`).join(', ')}. Totals across currencies are not meaningful, so '${target}' was added — filter or group by it, or convert to one currency before summing.`,
            { affectedColumns: [c.name, target] }));
    }

    // ── 0c. Order-level amounts repeated on every line → counted once. ──
    {
        const keyColumns = columns.filter(c => c.type === ColumnType.ID).map(c => c.name);
        for (const hit of opts.skipAllocation ? [] : findRepeatedHeaderAmounts(rows, keyColumns, metricNames())) {
            const target = `${hit.column}_allocated`;
            allocateAcrossLines(rows, hit.column, hit.key, target);
            addColumn(target, ColumnType.METRIC);
            logs.push(log('Repeated Order-Level Amount', 6, 'info',
                `Column '${hit.column}' repeats the same value on every line of each '${hit.key}' (${hit.groups} multi-line groups), so summing it counts it once per line. '${target}' spreads it across the lines so totals count it once — use that for sums.`,
                { affectedColumns: [hit.column, target], revert: { option: 'skipAllocation', value: true, label: `Don't add '${target}'` } }));
        }
    }

    // ── 0c2. Placeholder dates (1900-01-01, 9999-12-31) → missing. ──
    for (const c of columns.filter(c => c.type === ColumnType.DATE)) {
        const values = rows.map(r => r[c.name]).filter((v): v is string => typeof v === 'string');
        const isEpochZero = (v: string) => v.startsWith('1970-01-01');
        const real = values.filter(v => !isEpochZero(v) && !/^(1899|1900|9999|2099|2999|3000)-/.test(v)).map(v => v.slice(0, 4));
        const realMin = real.length ? real.reduce((a, b) => (a < b ? a : b)) : '0000';
        // 1970-01-01 (epoch zero) only counts as a placeholder when real dates are much later.
        const isPlaceholder = (v: any) => typeof v === 'string'
            && (/^(1900-01-0[01]|1899-12-3[01]|9999-12-31|2099-12-31|2999-12-31|3000-01-01)/.test(v) || (isEpochZero(v) && realMin > '1975'));
        const hits = rows.filter(r => isPlaceholder(r[c.name])).length;
        if (hits === 0) continue;
        if (opts.keepPlaceholders) {
            logs.push(keptLog('keepPlaceholders', `Column '${c.name}': ${hits} placeholder date(s) such as 1900-01-01 were kept and stretch time ranges.`, { affectedColumns: [c.name], affectedRows: hits }));
            continue;
        }
        for (const row of rows) if (isPlaceholder(row[c.name])) row[c.name] = null;
        logs.push(log('Placeholder Dates Removed', 5, 'applied',
            `Column '${c.name}': ${hits} placeholder date(s) such as 1900-01-01 or 9999-12-31 treated as missing, so they don't stretch every time range.`,
            { affectedColumns: [c.name], affectedRows: hits, revert: { option: 'keepPlaceholders', value: true, label: 'Keep these dates' } }));
    }

    // ── 0d. Line totals: derive when missing, reconcile when present. ──
    {
        const line = findLineColumns(metricNames());
        if (line.quantity && line.unitPrice && !line.lineAmount) {
            // Not materialised: AI SQL governs "revenue = price × quantity" as a
            // composite metric, and the automatic analysis computes it the same
            // way. A second, physical revenue column would bypass that guard.
            logs.push(log('Revenue From Price × Quantity', 6, 'info',
                `There is no line amount column, so revenue is ${line.quantity} × ${line.unitPrice}. AI SQL and the automatic analysis compute it that way; never sum or average '${line.unitPrice}' on its own for sales.`,
                { affectedColumns: [line.quantity, line.unitPrice] }));
        } else if (line.quantity && line.unitPrice && line.lineAmount) {
            const r = reconcileLineTotals(rows, line.quantity, line.unitPrice, line.lineAmount);
            if (r.checked > 0 && r.mismatched / r.checked >= 0.05) {
                logs.push(log('Line Total Mismatch Flag', 6, 'info',
                    `'${line.lineAmount}' differs from ${line.quantity} × ${line.unitPrice} on ${Math.round((r.mismatched / r.checked) * 100)}% of rows (e.g. ${r.examples.join('; ')}). This is normal when discounts, tax or shipping are included — otherwise check the source.`,
                    { affectedColumns: [line.lineAmount, line.quantity, line.unitPrice], affectedRows: r.mismatched }));
            } else if (r.checked > 0) {
                logs.push(log('Line Totals Verified', 6, 'info',
                    `'${line.lineAmount}' equals ${line.quantity} × ${line.unitPrice} on ${r.checked - r.mismatched} of ${r.checked} rows.`,
                    { affectedColumns: [line.lineAmount] }));
            }
        }
        if (line.quantity && line.unitCost && !line.totalCost && !opts.skipLineCost) {
            const target = columns.some(c => c.name === 'line_cost') ? 'line_cost_derived' : 'line_cost';
            for (const row of rows) {
                const q = row[line.quantity], u = row[line.unitCost];
                row[target] = typeof q === 'number' && typeof u === 'number' ? Math.round(q * u * 100) / 100 : null;
            }
            addColumn(target, ColumnType.METRIC);
            logs.push(log('Line Cost Derived', 5, 'applied',
                `'${target}' = ${line.quantity} × ${line.unitCost} was added so cost and profit add up per line (the unit cost alone must not be summed).`,
                { affectedColumns: [line.quantity, line.unitCost, target], revert: { option: 'skipLineCost', value: true, label: `Don't add '${target}'` } }));
        }
    }

    // ── 1. Category canonicalization (SAFE auto-merge: same string, different
    //       punctuation/diacritics/spacing → the most frequent surface form). ──
    for (const c of opts.keepCategorySpellings ? [] : columns.filter(c => c.type === ColumnType.DIMENSION)) {
        const map = buildCanonicalCategoryMap(valuesOf(c.name));
        if (map.size === 0) continue;
        let changed = 0;
        const samples: string[] = [];
        for (const row of rows) {
            const v = row[c.name];
            if (typeof v === 'string' && map.has(v)) {
                if (samples.length < 3) samples.push(`"${v}" → "${map.get(v)}"`);
                row[c.name] = map.get(v); changed++;
            }
        }
        if (changed > 0) {
            logs.push(log('Category Canonicalization', 5, 'applied',
                `Column '${c.name}': merged ${map.size} spelling variant(s) into canonical forms (${changed} cell(s)). ${samples.join(', ')}`,
                { affectedColumns: [c.name], affectedRows: changed, revert: { option: 'keepCategorySpellings', value: true, label: 'Keep original spellings' } }));
        }
    }

    // ── 2. FLAGS (surfaced for review; data is NOT changed) ──
    // 2-. Values that cannot be right, by the column's meaning (hours in a day,
    //     ages, percentages…) or by being wildly out of line with the column.
    for (const c of columns.filter(c => c.type === ColumnType.METRIC || c.type === ColumnType.DIMENSION)) {
        const found = suspectValues(valuesOf(c.name), c.name);
        if (!found.length) continue;
        const examples = [...new Set(found.map(f => f.value))].slice(0, 3).map(v => v.toLocaleString('en-GB'));
        logs.push(log('Impossible Values', 6, 'info',
            `Column '${c.name}': ${found.length} value(s) can't be right — ${examples.join(', ')} (${found[0].why}). Kept as they are, and every answer that uses them says so; correct or remove them in the file if you know the right value.`,
            { affectedColumns: [c.name], affectedRows: found.length }));
    }
    // 2a. Numeric outliers per metric — flagged, or handled as the user decided.
    const outlierDecisions = opts.outlierDecisions || {};
    /** The decisions without this column: what "undo" goes back to. */
    const withoutDecision = <T extends string>(decisions: Record<string, T>, column: string) => {
        const { [column]: _removed, ...rest } = decisions;
        return Object.keys(rest).length ? rest : null;
    };
    for (const c of columns.filter(c => c.type === ColumnType.METRIC)) {
        const r = detectOutliersIQR(valuesOf(c.name));
        if (!r) continue;
        const choice = outlierDecisions[c.name];
        const range = `[${r.lowerBound.toFixed(2)}, ${r.upperBound.toFixed(2)}]`;
        const isOutlier = (value: unknown) => {
            if (value === null || value === undefined || value === '') return false;
            const n = Number(value);
            return Number.isFinite(n) && (n < r.lowerBound || n > r.upperBound);
        };
        const undo = { option: 'outlierDecisions' as const, value: withoutDecision(outlierDecisions, c.name), label: `Review '${c.name}' again` };
        if (choice === 'keep') {
            logs.push(log('Outlier Confirmed', 6, 'applied',
                `Column '${c.name}': ${r.count} value(s) outside the usual range ${range} (e.g. ${r.examples.join(', ')}) were checked and kept as correct.`,
                { affectedColumns: [c.name], affectedRows: r.count, revert: undo }));
        } else if (choice === 'remove') {
            const before = rows.length;
            const removed = rows.filter(row => isOutlier(row[c.name]));
            rows = rows.filter(row => !isOutlier(row[c.name]));
            logs.push(log('Outlier Removal', 6, 'applied',
                `Column '${c.name}': removed ${removed.length} row(s) with values outside the usual range ${range}, as you chose.`,
                { affectedColumns: [c.name], rowsBefore: before, rowsAfter: rows.length, removedRowSamples: removed.slice(0, 10), revert: { ...undo, label: 'Put these rows back' } }));
        } else if (choice === 'cap') {
            const samples: { column: string; before: unknown; after: unknown }[] = [];
            let changed = 0;
            rows = rows.map(row => {
                if (!isOutlier(row[c.name])) return row;
                const n = Number(row[c.name]);
                const capped = Math.round((n < r.lowerBound ? r.lowerBound : r.upperBound) * 100) / 100;
                changed++;
                if (samples.length < 6) samples.push({ column: c.name, before: row[c.name], after: capped });
                return { ...row, [c.name]: capped };
            });
            logs.push(log('Outlier Capping', 6, 'applied',
                `Column '${c.name}': ${changed} value(s) outside the usual range were set to the nearest edge of ${range}, as you chose.`,
                { affectedColumns: [c.name], affectedRows: changed, transformSamples: samples as any, revert: { ...undo, label: 'Restore original values' } }));
        } else {
            logs.push(log('Outlier Flag', 6, 'info',
                `Column '${c.name}': ${r.count} value(s) outside the expected range ${range} (e.g. ${r.examples.join(', ')}). Review before trusting sums/averages — not auto-removed.`,
                { affectedColumns: [c.name], affectedRows: r.count, decision: { kind: 'outlier', column: c.name } }));
        }
    }
    // 2b. Likely typos among category values (edit distance 1).
    const typoDecisions = opts.typoDecisions || {};
    for (const c of columns.filter(c => c.type === ColumnType.DIMENSION)) {
        const groups = findNearDuplicateGroups(valuesOf(c.name));
        const typoChoice = typoDecisions[c.name];
        const typoUndo = { option: 'typoDecisions' as const, value: withoutDecision(typoDecisions, c.name), label: `Review '${c.name}' again` };
        if (groups.length > 0 && typoChoice === 'merge') {
            const map = new Map<string, string>();
            for (const group of groups) for (const variant of group.variants) map.set(variant, group.canonical);
            let changed = 0;
            rows = rows.map(row => {
                const value = row[c.name];
                const key = value === null || value === undefined ? '' : String(value).trim();
                const target = map.get(key);
                if (target === undefined || target === value) return row;
                changed++;
                return { ...row, [c.name]: target };
            });
            const ex = groups.slice(0, 2).map(g => `"${g.variants[0]}" → "${g.canonical}"`).join(', ');
            logs.push(log('Typo Merge', 6, 'applied',
                `Column '${c.name}': merged ${groups.length} likely typo(s) into the common spelling (${ex}; ${changed} cell(s)), as you chose.`,
                { affectedColumns: [c.name], affectedRows: changed, revert: { ...typoUndo, label: 'Keep original spellings' } }));
            continue;
        }
        if (groups.length > 0 && typoChoice === 'keep') {
            logs.push(log('Typo Review', 6, 'applied',
                `Column '${c.name}': ${groups.length} similar value(s) were checked and kept as different values.`,
                { affectedColumns: [c.name], revert: typoUndo }));
            continue;
        }
        if (groups.length > 0) {
            const ex = groups.slice(0, 2).map(g => `"${g.variants[0]}"≈"${g.canonical}"`).join(', ');
            logs.push(log('Possible Typo Flag', 6, 'info',
                `Column '${c.name}': ${groups.length} near-duplicate value(s) that may be typos (${ex}). Not merged automatically — confirm to combine.`,
                { affectedColumns: [c.name], decision: { kind: 'typo', column: c.name } }));
        }
    }
    // 2c. Sign / range / delimited-cell / completeness flags.
    for (const c of columns) {
        const vals = valuesOf(c.name);
        if (c.type === ColumnType.METRIC) {
            const neg = detectSignAnomalies(c.name, vals);
            if (neg > 0) logs.push(log('Sign Anomaly Flag', 6, 'info',
                `Column '${c.name}': ${neg} negative value(s) in a field that is usually non-negative. Verify these are intentional.`,
                { affectedColumns: [c.name], affectedRows: neg }));
            const range = detectRangeAnomalies(c.name, vals);
            if (range) logs.push(log('Range Anomaly Flag', 6, 'info',
                `Column '${c.name}': ${range.count} value(s) are ${range.kind}. Verify units/entry.`,
                { affectedColumns: [c.name], affectedRows: range.count }));
            const scale = detectMixedScale(c.name, vals);
            if (scale) logs.push(log('Mixed Scale Flag', 6, 'info',
                `Column '${c.name}': mixes ${scale.ratioLike} ratio-like (0–1) and ${scale.pctLike} percent-like (0–100) value(s) — averaging them together is misleading. Standardize to one scale.`,
                { affectedColumns: [c.name] }));
        }
        if (c.type === ColumnType.DIMENSION) {
            const d = detectDelimitedCells(vals);
            if (d) logs.push(log('Multi-Value Cell Flag', 6, 'info',
                `Column '${c.name}': ${d.count} cell(s) pack multiple values separated by '${d.delimiter}'. Consider splitting for accurate grouping.`,
                { affectedColumns: [c.name], affectedRows: d.count }));
        }
        // Completeness — high missingness distorts averages silently.
        const nonNull = vals.filter(v => v !== null && v !== undefined && v !== '').length;
        const missing = vals.length > 0 ? 1 - nonNull / vals.length : 0;
        if (missing >= 0.3 && nonNull > 0) {
            logs.push(log('Missing Data Flag', 6, 'info',
                `Column '${c.name}': ${Math.round(missing * 100)}% of values are missing — aggregates cover only the ${nonNull} row(s) with data.`,
                { affectedColumns: [c.name] }));
        }
    }
    // 2d. Ambiguous date order (parsing defaulted; user should confirm).
    for (const c of columns.filter(c => c.type === ColumnType.DATE)) {
        // Judge the values as written: after parsing they are ISO dates.
        const written = sourceRows.length === rows.length ? sourceRows.map(r => r[c.name]) : valuesOf(c.name);
        if (resolveDateOrder(written) === 'ambiguous'
            && written.some(v => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(String(v ?? '').trim()))) {
            const example = written.find(v => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(String(v ?? '').trim()));
            logs.push(log('Ambiguous Date Flag', 6, 'info',
                `Column '${c.name}': dates such as ${example} could be day/month or month/day, and nothing in the file decides it. They were read as ${dayFirst ? 'day/month (DD/MM)' : 'month/day (MM/DD)'}.`,
                { affectedColumns: [c.name], revert: { option: 'dateOrder', value: dayFirst ? 'month_first' : 'day_first', label: dayFirst ? 'Read as month/day' : 'Read as day/month' } }));
        }
    }
    // 2e. End-before-start across a start/end date pair.
    const dateCols = columns.filter(c => c.type === ColumnType.DATE).map(c => c.name);
    const startCol = dateCols.find(n => /(start|admission|admit|hire|order|begin|open|purchase|checkin)/i.test(n));
    const endCol = dateCols.find(n => /(end|discharge|term|exit|ship|deliver|close|checkout|complete)/i.test(n));
    if (startCol && endCol && startCol !== endCol) {
        const bad = detectDateOrderViolations(valuesOf(startCol), valuesOf(endCol));
        if (bad > 0) logs.push(log('Date Order Flag', 6, 'info',
            `${bad} row(s) where '${endCol}' is before '${startCol}'. These may be data-entry errors.`,
            { affectedColumns: [startCol, endCol], affectedRows: bad }));
    }

    // 3. The wider data-quality checks (formats, mappings, dates, scale,
    //    near-duplicates, unusual rows, the user's own rules).
    const quality = runQualityChecks(rows, columns, opts);
    rows = quality.rows;
    logs.push(...quality.logs);

    return { rows, logs, columns };
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
            // Type consistency: non-date values in DATE column
            const nonNullVals = values.filter(v => v !== null && v !== undefined && v !== '');
            const nonDateVals = nonNullVals.filter(v => {
                if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return false; // Valid ISO date
                return true;
            });
            if (nonDateVals.length > 0) {
                const examples = nonDateVals.slice(0, 5).map(v => `"${String(v)}"`).join(', ');
                violations.push({ column: col, rule: 'TYPE_CONSISTENCY', severity: 'soft',
                    message: `${col}: ${nonDateVals.length} non-date value(s) in DATE column. Examples: ${examples}` });
            }
        }

        // ── Type Consistency: non-numeric values in METRIC columns ──
        if (colDef?.type === ColumnType.METRIC) {
            const nonNullVals = values.filter(v => v !== null && v !== undefined);
            const nonNumericVals = nonNullVals.filter(v => typeof v !== 'number' || isNaN(v));
            if (nonNumericVals.length > 0) {
                const examples = nonNumericVals.slice(0, 5).map(v => `"${String(v)}"`).join(', ');
                violations.push({ column: col, rule: 'TYPE_CONSISTENCY', severity: 'soft',
                    message: `${col}: ${nonNumericVals.length} non-numeric value(s) in METRIC column. These cannot be aggregated. Examples: ${examples}` });
            }
        }

        // ── Type Consistency: non-numeric values in ID columns ──
        if (colDef?.type === ColumnType.ID) {
            const nonNullVals = values.filter(v => v !== null && v !== undefined && v !== '');
            const nonNumericIds = nonNullVals.filter(v => {
                const s = String(v).trim();
                return isNaN(Number(s)) && !/^\d+$/.test(s);
            });
            // Only flag if the column is predominantly numeric (>80% numeric IDs)
            const numericIds = nonNullVals.length - nonNumericIds.length;
            const numericRate = nonNullVals.length > 0 ? numericIds / nonNullVals.length : 0;
            if (nonNumericIds.length > 0 && numericRate > 0.8) {
                const examples = nonNumericIds.slice(0, 5).map(v => `"${String(v)}"`).join(', ');
                violations.push({ column: col, rule: 'TYPE_CONSISTENCY', severity: 'soft',
                    message: `${col}: ${nonNumericIds.length} non-numeric value(s) in a numeric ID column (${(numericRate * 100).toFixed(0)}% are numbers). Possible data entry error or column misalignment. Examples: ${examples}` });
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
        // Bare numeric values (including decimal measurements such as 0.5 or
        // 8.0 hours) are not dates. JavaScript otherwise interprets several of
        // them as dates in 2000/2001 and can poison the dataset time context.
        if (/^[+-]?\d+(?:\.\d+)?$/.test(s)) return null;
        // Try JS Date parse for other formats (e.g., "Jan 3, 2017")
        const d = new Date(s);
        if (!isNaN(d.getTime()) && d.getFullYear() > 1900 && d.getFullYear() < 2100) {
            // The written day, not UTC (which moves "1 June" to 31 May east of UTC).
            return localDateKey(d);
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
    columnTypeOverrides?: Record<string, ColumnType>,
    options?: { preserveRowMultiplicity?: boolean } & EtlOptions,
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
    const etlOptions: EtlOptions = options || {};
    const dayFirst = etlOptions.dateOrder ? etlOptions.dateOrder === 'day_first' : prefersDayFirst();
    const l1 = layer1_structuralNormalization(rawData, options?.preserveRowMultiplicity, etlOptions);
    let rows = l1.rows;
    allLogs.push(...l1.logs);
    console.log(`[ETL L1] Structural: ${rows.length} rows, ${Object.keys(rows[0] || {}).length} cols`);

    // ── LAYER 2: Canonical Value Prep ──
    const l2 = layer2_canonicalValuePrep(rows);
    rows = l2.rows;
    // Preserve the canonical source values so conversion can be audited after
    // Layer 5 without retaining a second full raw dataset in the ETL result.
    const preTransformRows = rows.map(row => ({ ...row }));
    allLogs.push(...l2.logs);
    console.log(`[ETL L2] Canonical: ${l2.nullsFixed} null tokens fixed`);

    // ── LAYER 3: Column Profiling ──
    const l3 = layer3_columnProfiling(rows, dayFirst);
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

    // ── LAYER 5b: Correctness Hardening (canonical merges + quality flags) ──
    const l5b = layer5b_hardening(rows, l4.columns, preTransformRows, etlOptions, dayFirst);
    rows = l5b.rows;
    const finalColumns = l5b.columns;
    allLogs.push(...l5b.logs);
    console.log(`[ETL L5b] Hardening: ${l5b.logs.filter(l => l.status === 'applied').length} merge(s), ${l5b.logs.filter(l => l.status === 'info').length} flag(s)`);

    // ── LAYER 6: Data Contract Validation ──
    const l6 = layer6_dataContractValidation(rows, finalColumns);
    allLogs.push(...l6.logs);
    console.log(`[ETL L6] Contract: ${l6.contract.status} (${l6.contract.violations.length} violations)`);

    // ── POST: TimeContext ──
    const tc = buildTimeContext(rows, finalColumns);
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
    const profiledColumns = attachCurrencies(
        attachConversionProfiles(finalColumns, preTransformRows, rows),
        Object.keys(rawData[0] || {}),
        preTransformRows,
    );
    const sortedColumns = [...profiledColumns].sort((a, b) => (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99));
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
