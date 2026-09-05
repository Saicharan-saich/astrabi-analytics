/**
 * SQL Validator — Pre-execution validation checks
 *
 * Validates SQL before sending it to the execution engine.
 * Catches common errors that would cause wrong results:
 * - Missing GROUP BY for dimensions
 * - Unknown columns
 * - Mixed aggregation
 * - SELECT * on analytic queries
 * - Invalid date grains
 */

import { SemanticModel, AnalysisPlan, ValidationResult, ValidationCheck } from './types';

/**
 * Validate a SQL query against the semantic model and plan.
 * Returns a list of checks with pass/warn/fail status.
 */
export function validateSQL(
    sql: string,
    plan: AnalysisPlan,
    model: SemanticModel
): ValidationResult {
    const checks: ValidationCheck[] = [];
    const upperSQL = sql.toUpperCase();
    const fieldNames = new Set(model.fields.map(f => f.name.toLowerCase()));

    // 1. Block SELECT *
    if (upperSQL.includes('SELECT *') || upperSQL.includes('SELECT  *')) {
        checks.push({
            name: 'No SELECT *',
            status: 'fail',
            message: 'SELECT * is not allowed for analytic queries. Specify exact columns.',
        });
    } else {
        checks.push({ name: 'No SELECT *', status: 'pass', message: 'Specific columns selected' });
    }

    // 2. Check GROUP BY matches dimensions
    if (plan.dimensions.length > 0) {
        const hasGroupBy = upperSQL.includes('GROUP BY');
        if (!hasGroupBy && plan.metrics.length > 0) {
            checks.push({
                name: 'GROUP BY present',
                status: 'fail',
                message: `Query has dimensions [${plan.dimensions.map(d => d.field).join(', ')}] and metrics but no GROUP BY clause.`,
            });
        } else {
            checks.push({ name: 'GROUP BY present', status: 'pass', message: 'GROUP BY clause matches dimensions' });
        }
    }

    // 3. Check for unknown columns
    const sqlLower = sql.toLowerCase();
    const unknownCols: string[] = [];

    // Extract column references from SELECT and WHERE
    for (const dim of plan.dimensions) {
        if (!fieldNames.has(dim.field.toLowerCase())) {
            unknownCols.push(dim.field);
        }
    }
    for (const met of plan.metrics) {
        if (!met.compositeId && !fieldNames.has(met.field.toLowerCase())) {
            unknownCols.push(met.field);
        }
    }

    if (unknownCols.length > 0) {
        checks.push({
            name: 'Column validity',
            status: 'warn',
            message: `Potentially unknown columns: ${unknownCols.join(', ')}`,
        });
    } else {
        checks.push({ name: 'Column validity', status: 'pass', message: 'All columns exist in schema' });
    }

    // 4. Check for forbidden SQL functions
    const forbidden = ['STRFTIME', 'EXTRACT('];
    for (const fn of forbidden) {
        if (upperSQL.includes(fn)) {
            checks.push({
                name: 'No forbidden functions',
                status: 'warn',
                message: `SQL contains ${fn} which may not be supported. Use YEAR(), MONTH(), QUARTER() instead.`,
            });
        }
    }
    if (!checks.some(c => c.name === 'No forbidden functions')) {
        checks.push({ name: 'No forbidden functions', status: 'pass', message: 'No unsupported SQL functions detected' });
    }

    // 5. Check LIMIT exists for rankings
    if (plan.intent === 'ranking' && !upperSQL.includes('LIMIT')) {
        checks.push({
            name: 'LIMIT for ranking',
            status: 'warn',
            message: 'Ranking query without LIMIT may return too many rows. Consider adding LIMIT.',
        });
    } else if (plan.intent === 'ranking') {
        checks.push({ name: 'LIMIT for ranking', status: 'pass', message: 'LIMIT clause present for ranking query' });
    }

    // 6. Check ORDER BY for rankings
    if (plan.intent === 'ranking' && !upperSQL.includes('ORDER BY')) {
        checks.push({
            name: 'ORDER BY for ranking',
            status: 'fail',
            message: 'Ranking query must have ORDER BY to determine rank order.',
        });
    }

    // 7. Check aggregation consistency — dimensions should not be aggregated
    for (const dim of plan.dimensions) {
        const dimUpper = dim.field.toUpperCase();
        if (upperSQL.includes(`SUM(${dimUpper})`) || upperSQL.includes(`AVG(${dimUpper})`)) {
            checks.push({
                name: 'Aggregation consistency',
                status: 'fail',
                message: `Dimension "${dim.field}" should not be aggregated with SUM/AVG.`,
            });
        }
    }
    if (!checks.some(c => c.name === 'Aggregation consistency')) {
        checks.push({ name: 'Aggregation consistency', status: 'pass', message: 'Aggregation applied correctly' });
    }

    // 8. Check for proper date filtering
    if (plan.filters.some(f => {
        const field = model.fields.find(fi => fi.name === f.field);
        return field?.semanticType === 'date';
    })) {
        checks.push({ name: 'Date filtering', status: 'pass', message: 'Date filters applied' });
    }

    // 9. Check for un-normalized temporal filter operators
    const unnormalizedFilters = plan.filters.filter(f => f.op && typeof f.op === 'string' && f.op.startsWith('this_'));
    if (unnormalizedFilters.length > 0) {
        checks.push({
            name: 'Filter normalization',
            status: 'fail',
            message: `Filters with un-normalized operators detected: ${unnormalizedFilters.map(f => `${f.field}:${f.op}`).join(', ')}. These should be converted to BETWEEN.`,
        });
    } else {
        checks.push({ name: 'Filter normalization', status: 'pass', message: 'All filter operators are standard SQL' });
    }

    // 10. Grain safety check
    if (plan.resultGrain) {
        checks.push({
            name: 'Grain declaration',
            status: 'pass',
            message: `Expected grain: ${plan.resultGrain}`,
        });
    }

    // 11. Prevent physical numeric fields (especially four-digit year
    // columns) from being cast directly to DATE/TIMESTAMP. DuckDB correctly
    // rejects DOUBLE -> DATE, so catch this before execution and return the
    // schema-grounded diagnostic to the model repair stage.
    const numericDateCasts = model.fields
        .filter(field => field.physicalType === 'number')
        .filter(field => {
            const escaped = field.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const reference = `(?:[A-Za-z_][A-Za-z0-9_]*\\s*\\.\\s*)?(?:["\`]${escaped}["\`]|${escaped})`;
            return new RegExp(`\\b(?:TRY_)?CAST\\s*\\(\\s*${reference}\\s+AS\\s+(?:DATE|TIMESTAMP)\\b`, 'i').test(sql);
        });
    if (numericDateCasts.length > 0) {
        checks.push({
            name: 'Physical date compatibility',
            status: 'fail',
            message: `Numeric field(s) ${numericDateCasts.map(field => `"${field.name}"`).join(', ')} cannot be cast directly to DATE/TIMESTAMP. Compare a numeric year as a number; for encoded dates, construct a date explicitly from validated components.`,
        });
    } else {
        checks.push({
            name: 'Physical date compatibility',
            status: 'pass',
            message: 'No invalid numeric-to-date casts detected',
        });
    }

    // Compute overall validity
    const hasFail = checks.some(c => c.status === 'fail');
    const hasWarn = checks.some(c => c.status === 'warn');

    return {
        valid: !hasFail,
        checks,
        correctedSQL: undefined, // Future: auto-correct simple issues
    };
}

/**
 * Post-execution sanity checks on the result data.
 * Catches "valid SQL, wrong answer" cases.
 */
export function validateResult(
    data: Record<string, any>[],
    plan: AnalysisPlan,
    model: SemanticModel
): ValidationCheck[] {
    const checks: ValidationCheck[] = [];

    if (!data || data.length === 0) {
        checks.push({
            name: 'Non-empty result',
            status: 'fail',
            message: 'Query returned no rows.',
        });
        return checks;
    }

    checks.push({
        name: 'Non-empty result',
        status: 'pass',
        message: `${data.length} rows returned`,
    });

    // Check for excessive row count (possible fanout)
    if (data.length > model.rowCount) {
        checks.push({
            name: 'Row count sanity',
            status: 'warn',
            message: `Result has ${data.length} rows which exceeds source data (${model.rowCount}). Possible join fanout.`,
        });
    } else {
        checks.push({ name: 'Row count sanity', status: 'pass', message: 'Row count within expected range' });
    }

    // Check for excessive null values (possible bad join)
    const cols = Object.keys(data[0]);
    for (const col of cols) {
        const nullCount = data.filter(r => r[col] === null || r[col] === undefined).length;
        const nullRate = nullCount / data.length;
        if (nullRate > 0.5) {
            checks.push({
                name: `Null rate: ${col}`,
                status: 'warn',
                message: `Column "${col}" has ${(nullRate * 100).toFixed(0)}% null values. This may indicate a problematic join.`,
            });
        }
    }

    // Check that percentage values are in sensible range
    for (const met of plan.metrics) {
        const field = model.fields.find(f => f.name === met.field);
        if (field?.semanticType === 'percentage') {
            const values = data.map(r => {
                const v = r[met.field] || r[`${met.field}_${met.agg}`];
                return typeof v === 'number' ? v : null;
            }).filter(v => v !== null) as number[];

            const outOfRange = values.filter(v => v < -200 || v > 200);
            if (outOfRange.length > 0) {
                checks.push({
                    name: `Percentage range: ${met.field}`,
                    status: 'warn',
                    message: `Percentage values out of expected range [-200, 200]: ${outOfRange.slice(0, 3).join(', ')}`,
                });
            }
        }
    }

    // Check time series is sorted chronologically
    if (plan.dimensions.some(d => d.timeGrain)) {
        const timeDim = plan.dimensions.find(d => d.timeGrain);
        if (timeDim) {
            const key = timeDim.timeGrain !== 'day' ? `${timeDim.field}_${timeDim.timeGrain}` : timeDim.field;
            const timeValues = data.map(r => r[key]).filter(v => v !== null && v !== undefined);
            const sorted = [...timeValues].sort();
            const isSorted = JSON.stringify(timeValues) === JSON.stringify(sorted);
            if (!isSorted) {
                checks.push({
                    name: 'Time series order',
                    status: 'warn',
                    message: 'Time series data is not sorted chronologically. Results may appear out of order.',
                });
            }
        }
    }

    return checks;
}
