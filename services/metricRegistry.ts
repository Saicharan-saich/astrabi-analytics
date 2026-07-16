/**
 * metricRegistry.ts — Deterministic Metric Classification
 *
 * RULES:
 *   - Every metric MUST have an explicit aggregation (SUM, AVG, COUNT_DISTINCT, etc.)
 *   - No fallback to AI for aggregation decisions
 *   - Classification is based on column name patterns ONLY (deterministic)
 *   - If classification fails → return null (caller must handle)
 *
 * METRIC BEHAVIOR TYPES:
 *   - additive:       Can be SUMmed across all dimensions (revenue, quantity, cost)
 *   - semi_additive:  Can be SUMmed across some dimensions but not time (balance, inventory)
 *   - non_additive:   Cannot be SUMmed — must use AVG, MIN, MAX, or COUNT (price, rate, percentage)
 *
 * PRINCIPLE: System MUST FAIL instead of GUESS.
 */

import { AggregationType } from '../types';
import type { MetricBehavior } from './semanticModel';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface MetricClassification {
    aggregation: AggregationType;
    behavior: MetricBehavior;
    format: 'currency_usd' | 'currency_eur' | 'percent' | 'raw' | 'count';
    requiresWeighting: boolean;
    weightColumn?: string;
}

export interface DimensionClassification {
    dataType: 'string' | 'date' | 'number';
}

// ═══════════════════════════════════════════════════════════════════
// METRIC CLASSIFICATION RULES
// ═══════════════════════════════════════════════════════════════════

/**
 * Ordered list of classification rules. First match wins.
 * Each rule has:
 *   - pattern: RegExp to match column name (case-insensitive)
 *   - result: the classification
 *
 * NOTE: Order matters — more specific patterns MUST come before general ones.
 */
const METRIC_RULES: { pattern: RegExp; result: MetricClassification }[] = [
    // ──────────────────────────────────────────────────────────
    // ADDITIVE METRICS (can be SUMmed across all dimensions)
    // ──────────────────────────────────────────────────────────

    // Revenue / Sales / Amount — always SUM, currency format
    {
        pattern: /(?:^|[_\s])(revenue|sales|total_sales|gross_sales|net_sales|turnover|proceeds|earning|earnings|income|gross_income|net_income)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
    },
    {
        pattern: /(?:^|[_\s])(amount|total_amount|total|sum|subtotal|sub_total|net_amount|gross_amount)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
    },

    // Quantity SNAPSHOT (inventory levels) — non-additive, use MAX to avoid join inflation
    // MUST come BEFORE the generic quantity pattern to win first-match priority
    {
        pattern: /(?:^|[_\s])(current_quantity|current_qty|available_quantity|available_qty|remaining_quantity|remaining_qty|quantity_on_hand|qty_on_hand|quantity_available|qty_available|quantity_remaining|qty_remaining|current_stock|available_stock|stock_quantity|stock_qty|stock_on_hand|reorder_level|reorder_point|safety_stock|min_quantity|max_quantity|min_qty|max_qty)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.MAX, behavior: 'non_additive', format: 'raw', requiresWeighting: false },
    },

    // Quantity / Units / Volume — always SUM, raw format
    {
        pattern: /(?:^|[_\s])(quantity|qty|units|unit_count|units_sold|volume|items|line_items|pieces|pcs)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.SUM, behavior: 'additive', format: 'raw', requiresWeighting: false },
    },

    // Cost / Expense — always SUM, currency format
    {
        pattern: /(?:^|[_\s])(cost|total_cost|cogs|expense|expenses|expenditure|spend|spending|charge|charges|payment|payout|funding|debt|debit)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
    },

    // Profit / Margin (absolute) — always SUM, currency format
    {
        pattern: /(?:^|[_\s])(profit|net_profit|gross_profit|margin_amount|contribution)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
    },

    // Discount as an absolute DOLLAR amount — SUM, currency format.
    // NOTE: a BARE "discount" column is handled as a RATE below (AVG, percent),
    // because in most datasets (retail/e-commerce) "discount" is a 0–1 / 0–100
    // rate, not a dollar figure. Use "discount_amount" for a currency discount.
    {
        pattern: /(?:^|[_\s])(discount_amount|discount_amt|rebate|savings|coupon_value)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
    },

    // Tax / Fee / Surcharge — SUM, currency format
    {
        pattern: /(?:^|[_\s])(tax|tax_amount|fee|fees|surcharge|tariff|toll|premium|commission|bonus|interest|royalty|stipend|rent|deposit|withdrawal|refund|shipping_cost|freight)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
    },

    // Salary / Wage / Pay — SUM, currency format
    {
        pattern: /(?:^|[_\s])(salary|wage|pay|compensation|base_salary|base_pay|annual_salary|monthly_salary|gross_pay|net_pay|take_home)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
    },

    // ──────────────────────────────────────────────────────────
    // SEMI-ADDITIVE METRICS (can be SUMmed over some dims, not time)
    // ──────────────────────────────────────────────────────────

    // Balance / Stock / Inventory — semi-additive (snapshot, not flow)
    {
        pattern: /(?:^|[_\s])(balance|stock|inventory|on_hand|stock_level|headcount|employee_count)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.SUM, behavior: 'semi_additive', format: 'raw', requiresWeighting: false },
    },

    // Budget — semi-additive
    {
        pattern: /(?:^|[_\s])(budget|budget_amount|forecast|target|quota|goal)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.SUM, behavior: 'semi_additive', format: 'currency_usd', requiresWeighting: false },
    },

    // ──────────────────────────────────────────────────────────
    // NON-ADDITIVE METRICS (MUST NOT be SUMmed)
    // ──────────────────────────────────────────────────────────

    // Price / Rate / Unit Price — always AVG, currency format
    {
        pattern: /(?:^|[_\s])(price|unit_price|unit_cost|cost_per_unit|rate|avg_price|average_price|selling_price|list_price|msrp)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'currency_usd', requiresWeighting: true, weightColumn: 'quantity' },
    },

    // Percentage / Ratio / Rate — always AVG, percent format
    {
        pattern: /(?:^|[_\s])(discount|markdown|percentage|percent|pct|ratio|margin_pct|margin_percent|profit_margin|gross_margin|discount_pct|discount_rate|discount_percent|tax_rate|return_rate|conversion_rate|churn_rate|attrition|retention_rate|growth_rate|click_through_rate|ctr|open_rate|bounce_rate)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'percent', requiresWeighting: false },
    },

    // Score / Rating / Grade — always AVG, raw format
    {
        pattern: /(?:^|[_\s])(score|rating|grade|rank|nps|satisfaction|performance_score|review_score|stars|gpa)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'raw', requiresWeighting: false },
    },

    // Weight / Height / Length / Width / Age — always AVG, raw format
    {
        pattern: /(?:^|[_\s])(weight|height|length|width|depth|age|tenure|experience|duration|distance|area|size)(?:[_\s]|$)/i,
        result: { aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'raw', requiresWeighting: false },
    },

    // ──────────────────────────────────────────────────────────
    // CATCH-ALL NUMERIC PATTERNS (less specific)
    // ──────────────────────────────────────────────────────────

    // Anything ending in _amount, _total, _sum → SUM
    {
        pattern: /_(?:amount|total|sum|value)$/i,
        result: { aggregation: AggregationType.SUM, behavior: 'additive', format: 'raw', requiresWeighting: false },
    },

    // Anything ending in _count, _num, _number → SUM (these are counts of events)
    {
        pattern: /_(?:count|num|number)$/i,
        result: { aggregation: AggregationType.SUM, behavior: 'additive', format: 'raw', requiresWeighting: false },
    },

    // Anything ending in _avg, _average, _mean → AVG
    {
        pattern: /_(?:avg|average|mean)$/i,
        result: { aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'raw', requiresWeighting: false },
    },

    // Anything ending in _rate, _pct, _percent, _ratio → AVG
    {
        pattern: /_(?:rate|pct|percent|percentage|ratio)$/i,
        result: { aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'percent', requiresWeighting: false },
    },
];

// ═══════════════════════════════════════════════════════════════════
// DIMENSION CLASSIFICATION RULES
// ═══════════════════════════════════════════════════════════════════

const DIMENSION_RULES: { pattern: RegExp; dataType: 'string' | 'date' | 'number' }[] = [
    // Date dimensions
    { pattern: /(?:^|[_\s])(date|day|week|month|quarter|year|timestamp|datetime|created|modified|posted|expired)(?:[_\s]|$)/i, dataType: 'date' },

    // Numeric coded dimensions (e.g., zip_code, rating_level)
    { pattern: /(?:^|[_\s])(zip|zip_code|postal|year_born|birth_year)(?:[_\s]|$)/i, dataType: 'number' },

    // All other dimensions are string by default
];

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * Classify a column as a metric with explicit aggregation.
 * Returns null if the column name doesn't match any metric pattern.
 *
 * RULE: If this returns null, the caller MUST NOT guess an aggregation.
 */
export function classifyMetric(columnName: string): MetricClassification | null {
    const normalizedName = columnName.toLowerCase().replace(/\s+/g, '_');

    for (const rule of METRIC_RULES) {
        if (rule.pattern.test(normalizedName) || rule.pattern.test(columnName)) {
            return { ...rule.result };
        }
    }

    // Exact match for standalone common names
    const STANDALONE_METRICS: Record<string, MetricClassification> = {
        'revenue': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
        'sales': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
        'profit': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
        'cost': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
        'quantity': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'raw', requiresWeighting: false },
        'qty': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'raw', requiresWeighting: false },
        'price': { aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'currency_usd', requiresWeighting: true, weightColumn: 'quantity' },
        'amount': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
        'discount': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
        'tax': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
        'total': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
        'score': { aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'raw', requiresWeighting: false },
        'rating': { aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'raw', requiresWeighting: false },
        'salary': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
        'wage': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false },
        'balance': { aggregation: AggregationType.SUM, behavior: 'semi_additive', format: 'currency_usd', requiresWeighting: false },
        'budget': { aggregation: AggregationType.SUM, behavior: 'semi_additive', format: 'currency_usd', requiresWeighting: false },
        'weight': { aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'raw', requiresWeighting: false },
        'age': { aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'raw', requiresWeighting: false },
        'value': { aggregation: AggregationType.SUM, behavior: 'additive', format: 'raw', requiresWeighting: false },
    };

    const standalone = STANDALONE_METRICS[normalizedName];
    if (standalone) return { ...standalone };

    return null;
}

// ═══════════════════════════════════════════════════════════════════
// DATA-AWARE MEASURE CLASSIFICATION
//
// classifyMetric() uses the NAME only, which mis-classifies ambiguous
// columns (e.g. "discount" = rate vs dollars). classifyMeasure() adds the
// column's statistical PROFILE (min/max range, currency/percent glyphs) so
// the DATA disambiguates the name. 100% local/deterministic — no AI, and it
// never inspects or emits raw values, only aggregate stats.
// ═══════════════════════════════════════════════════════════════════

/** Privacy-safe stats about a numeric column (no raw values retained). */
export interface MeasureProfile {
    min?: number;
    max?: number;
    distinctCount?: number;
    totalValues?: number;
    /** A raw value contained a literal "%". */
    percentSignPresent?: boolean;
    /** A raw value contained a currency symbol ($ € £ …). */
    currencyGlyphPresent?: boolean;
}

export interface MeasureClassification extends MetricClassification {
    /** 0–1. Below ~0.6 the column is worth surfacing for user review. */
    confidence: number;
    reason: string;
}

const CURRENCY_GLYPH = /[$€£¥₹₩₫₽¢]/;
const STRONG_CURRENCY_NAME = /(?:^|[_\s])(sales|revenue|price|cost|amount|profit|income|salary|wage|gross|net|subtotal)(?:[_\s]|$)/i;

/**
 * Compute a lightweight, privacy-safe profile from a column's values.
 * Retains only aggregate stats — never the values themselves.
 */
export function computeMeasureProfile(values: any[]): MeasureProfile {
    let min = Infinity, max = -Infinity, numericCount = 0, total = 0;
    let percentSign = false, currencyGlyph = false;
    const distinct = new Set<any>();
    for (const v of values) {
        if (v === null || v === undefined || v === '') continue;
        total++;
        distinct.add(typeof v === 'string' ? v.trim() : v);
        const s = String(v);
        if (!percentSign && s.includes('%')) percentSign = true;
        if (!currencyGlyph && CURRENCY_GLYPH.test(s)) currencyGlyph = true;
        const n = typeof v === 'number' ? v : Number(s.replace(/[$€£¥₹₩₫₽¢,%\s]/g, ''));
        if (!isNaN(n) && isFinite(n)) { numericCount++; if (n < min) min = n; if (n > max) max = n; }
    }
    return {
        min: numericCount ? min : undefined,
        max: numericCount ? max : undefined,
        distinctCount: distinct.size,
        totalValues: total,
        percentSignPresent: percentSign,
        currencyGlyphPresent: currencyGlyph,
    };
}

/**
 * Classify a measure using its name as a PRIOR and its data profile to
 * disambiguate. Always returns a classification (never null) with a
 * confidence and human-readable reason.
 */
export function classifyMeasure(columnName: string, profile?: MeasureProfile): MeasureClassification {
    const named = classifyMetric(columnName);
    const p = profile || {};
    const min = p.min, max = p.max;
    const hasRange = typeof min === 'number' && typeof max === 'number' && isFinite(min) && isFinite(max);
    // Values sitting in [-1, 1] with real spread look like a stored 0–1 rate.
    const fractional = !!hasRange && (min as number) >= -1.0001 && (max as number) <= 1.0001
        && ((max as number) - (min as number)) > 0 && !((min === 0) && (max === 0));

    const rate = (c: number, r: string): MeasureClassification =>
        ({ aggregation: AggregationType.AVG, behavior: 'non_additive', format: 'percent', requiresWeighting: false, confidence: c, reason: r });
    const currency = (c: number, r: string): MeasureClassification =>
        ({ aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false, confidence: c, reason: r });
    const withConf = (m: MetricClassification, c: number, r: string): MeasureClassification =>
        ({ ...m, confidence: c, reason: r });

    // 1. Hard evidence in the raw values wins over any name.
    if (p.percentSignPresent) return rate(0.97, 'Values contain a "%" sign → percentage (AVG).');
    if (p.currencyGlyphPresent && !(named && named.format === 'percent'))
        return currency(0.92, 'Values contain a currency symbol → currency amount (SUM).');

    // 2. Name matched a registry rule.
    if (named) {
        // Data override: name implies a summable amount, but values are a 0–1 rate.
        if (named.behavior === 'additive' && fractional && !STRONG_CURRENCY_NAME.test(columnName)) {
            return rate(0.8, `"${columnName}" looks like an amount by name, but its values sit in 0–1 → treated as a rate (AVG %).`);
        }
        return withConf(named, 0.85, `Matched a name rule for "${columnName}".`);
    }

    // 3. No name match — infer from data shape alone.
    if (fractional) return rate(0.68, `Unrecognised name "${columnName}"; values in 0–1 → inferred rate (AVG %).`);
    if (p.currencyGlyphPresent) return currency(0.68, 'Currency symbols present → currency amount (SUM).');

    // 4. Fallback — additive number, low confidence (worth review).
    return {
        aggregation: AggregationType.SUM, behavior: 'additive', format: 'raw', requiresWeighting: false,
        confidence: 0.45, reason: `No strong name or data signal for "${columnName}" — defaulted to SUM (review recommended).`,
    };
}

/**
 * Classify a column as a dimension with data type.
 * Returns null if the column name doesn't match any dimension pattern
 * (in which case, default to string).
 */
export function classifyDimension(columnName: string): DimensionClassification | null {
    const normalizedName = columnName.toLowerCase().replace(/\s+/g, '_');

    for (const rule of DIMENSION_RULES) {
        if (rule.pattern.test(normalizedName) || rule.pattern.test(columnName)) {
            return { dataType: rule.dataType };
        }
    }

    return { dataType: 'string' };
}

/**
 * Get all registered metric names for display/documentation purposes.
 */
export function getRegisteredMetricNames(): string[] {
    return METRIC_RULES.map(r => r.pattern.source);
}
