/**
 * calculationEngine.ts — Derived-metric calculation engine.
 *
 * Handles complex calculations that can't be expressed in a single SQL template,
 * such as growth percentages, ratios between different time periods, and
 * composite KPIs that require multiple passes over the data.
 *
 * Design rationale: Simple aggregates (SUM, AVG, COUNT) are handled by SQL templates.
 * This engine handles multi-step calculations like:
 *   - Period-over-period growth (requires two queries)
 *   - Weighted averages across dimensions
 *   - Running totals / cumulative sums
 *   - Derived ratios (e.g., Revenue Per Employee = Revenue / Headcount)
 */

export interface CalculationResult {
    value: number | null;
    label: string;
    formattedValue: string;
    metadata?: Record<string, any>;
}

export interface TimeSeriesPoint {
    label: string;
    value: number;
    previousValue?: number;
}

export type CalculationType =
    | 'GROWTH_PCT'          // (current - previous) / previous * 100
    | 'PERIOD_COMPARISON'   // current vs previous period side-by-side
    | 'RUNNING_TOTAL'       // cumulative sum over time
    | 'MOVING_AVERAGE'      // N-period rolling average
    | 'RATIO'               // numerator / denominator
    | 'WEIGHTED_AVERAGE'    // weighted average across groups
    | 'ATTRITION_RATE'      // terminations / headcount * 100
    | 'RETENTION_RATE'      // 1 - attrition
    | 'YIELD_RATE'          // accepted / applied * 100
    | 'NET_CHANGE';         // current - previous

// ═══════════════════════════════════════════════════════════════════
// CORE CALCULATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Calculate growth percentage between two values.
 * Returns null if previous value is 0 (avoid division by zero).
 */
export function calcGrowthPct(current: number, previous: number): number | null {
    if (previous === 0) return current > 0 ? 100 : null;
    return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Calculate a running total (cumulative sum) from a time series.
 */
export function calcRunningTotal(series: TimeSeriesPoint[]): TimeSeriesPoint[] {
    let cumulative = 0;
    return series.map(pt => {
        cumulative += pt.value;
        return { ...pt, value: cumulative, previousValue: pt.value };
    });
}

/**
 * Calculate a moving average from a time series.
 * @param windowSize Number of periods to average (default 3)
 */
export function calcMovingAverage(series: TimeSeriesPoint[], windowSize = 3): TimeSeriesPoint[] {
    return series.map((pt, i) => {
        const start = Math.max(0, i - windowSize + 1);
        const window = series.slice(start, i + 1);
        const avg = window.reduce((sum, p) => sum + p.value, 0) / window.length;
        return { ...pt, value: Math.round(avg * 100) / 100, previousValue: pt.value };
    });
}

/**
 * Calculate a ratio between two values with division-by-zero safety.
 */
export function calcRatio(numerator: number, denominator: number): number | null {
    if (denominator === 0) return null;
    return numerator / denominator;
}

/**
 * Calculate attrition rate: terminations / headcount * 100
 */
export function calcAttritionRate(terminations: number, headcount: number): number | null {
    if (headcount === 0) return null;
    return (terminations / headcount) * 100;
}

/**
 * Calculate retention rate: (1 - attrition/100) * 100
 */
export function calcRetentionRate(terminations: number, headcount: number): number | null {
    const attrition = calcAttritionRate(terminations, headcount);
    if (attrition === null) return null;
    return 100 - attrition;
}

/**
 * Calculate net change between two values.
 */
export function calcNetChange(current: number, previous: number): number {
    return current - previous;
}

/**
 * Calculate weighted average: sum(value * weight) / sum(weight)
 */
export function calcWeightedAverage(
    items: Array<{ value: number; weight: number }>
): number | null {
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight === 0) return null;
    const weightedSum = items.reduce((sum, item) => sum + item.value * item.weight, 0);
    return weightedSum / totalWeight;
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-LEVEL CALCULATION DISPATCHER
// ═══════════════════════════════════════════════════════════════════

/**
 * Apply a named calculation to raw SQL query results.
 * This is the main entry point used by the Workbench when a question
 * requires post-processing beyond what SQL templates provide.
 */
export function applyCalculation(
    calcType: CalculationType,
    data: any[],
    options: {
        currentPeriodLabel?: string;
        previousPeriodLabel?: string;
        windowSize?: number;
        numeratorField?: string;
        denominatorField?: string;
    } = {}
): CalculationResult {
    switch (calcType) {
        case 'GROWTH_PCT': {
            if (data.length < 2) return { value: null, label: 'Growth %', formattedValue: 'N/A' };
            const current = data[data.length - 1]?.value ?? 0;
            const previous = data[data.length - 2]?.value ?? 0;
            const growth = calcGrowthPct(current, previous);
            return {
                value: growth,
                label: 'Growth %',
                formattedValue: growth !== null ? `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%` : 'N/A',
                metadata: { current, previous },
            };
        }
        case 'NET_CHANGE': {
            if (data.length < 2) return { value: null, label: 'Net Change', formattedValue: 'N/A' };
            const current = data[data.length - 1]?.value ?? 0;
            const previous = data[data.length - 2]?.value ?? 0;
            const change = calcNetChange(current, previous);
            return {
                value: change,
                label: 'Net Change',
                formattedValue: `${change >= 0 ? '+' : ''}${change.toLocaleString()}`,
                metadata: { current, previous },
            };
        }
        case 'RATIO': {
            const numField = options.numeratorField || 'numerator';
            const denField = options.denominatorField || 'denominator';
            const num = data.reduce((s, r) => s + (Number(r[numField]) || 0), 0);
            const den = data.reduce((s, r) => s + (Number(r[denField]) || 0), 0);
            const ratio = calcRatio(num, den);
            return {
                value: ratio,
                label: 'Ratio',
                formattedValue: ratio !== null ? ratio.toFixed(2) : 'N/A',
                metadata: { numerator: num, denominator: den },
            };
        }
        case 'ATTRITION_RATE': {
            const terms = data.filter(r => r.is_terminated || r.exit_type).length;
            const total = data.length;
            const rate = calcAttritionRate(terms, total);
            return {
                value: rate,
                label: 'Attrition Rate',
                formattedValue: rate !== null ? `${rate.toFixed(1)}%` : 'N/A',
                metadata: { terminations: terms, headcount: total },
            };
        }
        case 'RETENTION_RATE': {
            const terms = data.filter(r => r.is_terminated || r.exit_type).length;
            const total = data.length;
            const rate = calcRetentionRate(terms, total);
            return {
                value: rate,
                label: 'Retention Rate',
                formattedValue: rate !== null ? `${rate.toFixed(1)}%` : 'N/A',
                metadata: { terminations: terms, headcount: total },
            };
        }
        default:
            return { value: null, label: calcType, formattedValue: 'Not implemented' };
    }
}
