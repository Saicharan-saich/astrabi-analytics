/**
 * smartAggregation.ts — Infer the correct default aggregation for a metric column.
 *
 * SUM is correct for additive measures (revenue, cost, quantity).
 * AVG is correct for intensive/rate-like measures (age, score, rating, price).
 *
 * This closes the gap where the AI profiler times out and the deterministic
 * fallback blindly defaults everything to SUM.
 */

// Columns whose values should be AVERAGED (non-additive / intensive)
const AVG_PATTERNS = [
    'age', 'avg', 'average', 'mean',
    'score', 'rating', 'satisfaction', 'nps',
    'price', 'unit_price', 'unit_cost', 'rate', 'hourly',
    'percentage', 'percent', 'ratio', 'proportion',
    'temperature', 'temp', 'humidity', 'pressure',
    'bmi', 'weight', 'height', 'gpa', 'grade',
    'duration', 'latency', 'response_time',
    'margin', 'yield', 'efficiency',
    'density', 'velocity', 'speed',
];

// Columns whose values should be SUMMED (additive / extensive)
const SUM_PATTERNS = [
    'sales', 'revenue', 'income', 'earnings',
    'cost', 'expense', 'spend', 'budget',
    'profit', 'loss', 'amount', 'total',
    'quantity', 'qty', 'count', 'units', 'volume',
    'hours', 'days', 'minutes',
    'distance', 'miles', 'kilometers',
    'payment', 'fee', 'charge', 'tax', 'discount',
];

/**
 * Given a column name and type, return the most semantically correct
 * default aggregation. Falls back to SUM if no pattern matches.
 */
export function inferDefaultAggregation(columnName: string, columnType: string): string {
    if (columnType !== 'METRIC') {
        if (columnType === 'ID') return 'COUNT_DISTINCT';
        if (columnType === 'BOOLEAN') return 'COUNT';
        return 'NONE';
    }

    const lower = columnName.toLowerCase().replace(/[^a-z0-9]/g, '_');

    // Check AVG patterns first (more specific)
    for (const pattern of AVG_PATTERNS) {
        if (lower === pattern || lower.includes(pattern)) {
            return 'AVG';
        }
    }

    // Check SUM patterns
    for (const pattern of SUM_PATTERNS) {
        if (lower === pattern || lower.includes(pattern)) {
            return 'SUM';
        }
    }

    // Default: SUM (safe for most business metrics)
    return 'SUM';
}
