/**
 * Failure classification for the benchmark.
 * ─────────────────────────────────────────────────────────────────────
 * "❌ Wrong" is not useful for a research write-up. This module classifies WHY
 * a case failed, from the gold-vs-actual result shape, the pipeline error, and
 * the case's table cardinality. Pure + Node-testable (no DuckDB / DOM).
 */

export type FailureCategory =
    | 'correct'
    | 'execution_error'   // pipeline threw / SQL failed to run
    | 'empty_result'      // system returned nothing but gold had rows
    | 'join_grain'        // multi-table fan-out scaled the numbers
    | 'aggregation'       // right groups, wrong aggregate value
    | 'cardinality'       // wrong number of rows (extra/missing groups)
    | 'ordering'          // right rows, wrong order (ORDER BY not honored)
    | 'value_mismatch'    // categorical/label values differ
    | 'unknown';          // mismatch we can't attribute

export interface ClassifierInput {
    match: boolean;
    error?: string;
    reason?: string;
    tableCount: number;
    expectedRows: number;
    actualRows: number;
    expectedSample: Record<string, any>[];
    actualSample: Record<string, any>[];
}

export interface Classification {
    category: FailureCategory;
    detail: string;
}

const HELPER_KEYS = new Set([
    'growth_pct', 'growth_abs', 'previous_value', 'running_total', 'moving_avg', 'day_name', 'period',
]);

function numbers(rows: Record<string, any>[]): number[] {
    const out: number[] = [];
    for (const r of rows) {
        for (const [k, v] of Object.entries(r)) {
            if (HELPER_KEYS.has(k.toLowerCase())) continue;
            const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,]/g, ''));
            if (!Number.isNaN(n) && String(v).trim() !== '' && typeof v !== 'boolean') out.push(n);
        }
    }
    return out.sort((a, b) => a - b);
}

function strings(rows: Record<string, any>[]): string[] {
    const out: string[] = [];
    for (const r of rows) {
        for (const [k, v] of Object.entries(r)) {
            if (HELPER_KEYS.has(k.toLowerCase())) continue;
            if (v === null || v === undefined) continue;
            const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,]/g, ''));
            if (Number.isNaN(n) || String(v).trim() === '') out.push(String(v).trim().toLowerCase());
        }
    }
    return out.sort();
}

function setsEqual(a: string[], b: string[]): boolean {
    const sa = new Set(a), sb = new Set(b);
    if (sa.size !== sb.size) return false;
    for (const x of sa) if (!sb.has(x)) return false;
    return true;
}

/** Is `actual` ≈ `gold` scaled by a small integer factor (join fan-out)? */
function looksScaled(gold: number[], actual: number[]): boolean {
    if (gold.length === 0 || actual.length === 0) return false;
    const gSum = gold.reduce((s, n) => s + n, 0);
    const aSum = actual.reduce((s, n) => s + n, 0);
    if (gSum === 0) return false;
    const ratio = aSum / gSum;
    // A fan-out inflates totals by ~2x, 3x… (or deflates by 1/2, 1/3).
    for (const k of [2, 3, 4, 5]) {
        if (Math.abs(ratio - k) < 0.05 || Math.abs(ratio - 1 / k) < 0.02) return true;
    }
    return false;
}

export function classifyFailure(input: ClassifierInput): Classification {
    if (input.match) return { category: 'correct', detail: 'Result matched gold' };

    if (input.error) {
        return { category: 'execution_error', detail: input.error.slice(0, 200) };
    }

    if (input.expectedRows > 0 && input.actualRows === 0) {
        return { category: 'empty_result', detail: 'System returned no rows' };
    }

    if (input.reason && /order/i.test(input.reason)) {
        return { category: 'ordering', detail: 'Correct rows in the wrong order (ORDER BY not honored)' };
    }

    const goldNums = numbers(input.expectedSample);
    const actNums = numbers(input.actualSample);
    const goldStrs = strings(input.expectedSample);
    const actStrs = strings(input.actualSample);

    // Multi-table + inflated/deflated totals → join grain (fan-out).
    if (input.tableCount > 1 && looksScaled(goldNums, actNums)) {
        return { category: 'join_grain', detail: 'Numbers scaled by a join fan-out (wrong grain after denormalization)' };
    }

    // Same labels/groups but wrong numbers → aggregation error.
    if (goldStrs.length > 0 && setsEqual(goldStrs, actStrs) && goldNums.join() !== actNums.join()) {
        return { category: 'aggregation', detail: 'Correct groups, wrong aggregate value (SUM/AVG/COUNT)' };
    }

    // Different number of rows → cardinality (missing/extra groups or filter).
    if (input.expectedRows !== input.actualRows) {
        return {
            category: 'cardinality',
            detail: `Row count differs (gold ${input.expectedRows}, system ${input.actualRows})`,
        };
    }

    // Same shape, different categorical values.
    if (!setsEqual(goldStrs, actStrs)) {
        return { category: 'value_mismatch', detail: 'Categorical/label values differ from gold' };
    }

    return { category: 'unknown', detail: input.reason || 'Result differs from gold' };
}

export const FAILURE_LABELS: Record<FailureCategory, string> = {
    correct: 'Correct',
    execution_error: 'Execution error',
    empty_result: 'Empty result',
    join_grain: 'Join grain / fan-out',
    aggregation: 'Aggregation error',
    cardinality: 'Cardinality (rows)',
    ordering: 'Ordering',
    value_mismatch: 'Value mismatch',
    unknown: 'Unclassified',
};
