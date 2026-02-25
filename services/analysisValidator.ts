/**
 * Analysis Validator — Transparent Middleware
 * 
 * Validates analysis at every stage without impacting performance.
 * All checks are synchronous, O(1) or O(columns), never iterating over rows.
 */

import { Dataset, QueryConfig, AnalysisResult, ColumnType, AggregationType } from '../types';

// ─── Types ─────────────────────────────────────────────────────────

export interface ValidationCheck {
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
}

export interface ValidationResult {
    status: 'valid' | 'warning' | 'error';
    checks: ValidationCheck[];
    summary: string;
}

// ─── Allowed Values (Whitelists) ───────────────────────────────────

const ALLOWED_AGGREGATIONS = new Set([
    'SUM', 'AVG', 'COUNT', 'MAX', 'MIN', 'COUNT_DISTINCT',
    'sum', 'avg', 'count', 'max', 'min', 'count_distinct'
]);

const SAFE_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_ ]*$/;

const DANGEROUS_SQL_PATTERNS = [
    /;\s*(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|EXEC|EXECUTE)/i,
    /--.*$/m,
    /\/\*[\s\S]*?\*\//,
    /'\s*(OR|AND)\s+'.*='/i,
    /UNION\s+(ALL\s+)?SELECT/i,
    /xp_/i,
    /sys\./i,
];

// ─── Pre-Execution Validation ──────────────────────────────────────

export function validatePre(dataset: Dataset, query: QueryConfig): ValidationResult {
    const checks: ValidationCheck[] = [];

    // 1. Dataset existence
    if (!dataset || !dataset.rows || dataset.rows.length === 0) {
        checks.push({
            name: 'Dataset Loaded',
            status: 'fail',
            message: 'No dataset is loaded or the dataset is empty.'
        });
        return summarize(checks);
    }
    checks.push({ name: 'Dataset Loaded', status: 'pass', message: `${dataset.rows.length} rows available.` });

    // 2. Column existence for metric
    if (query.metric) {
        const colDef = dataset.columns.find(c => c.name === query.metric);
        if (!colDef) {
            // Check case-insensitive
            const fuzzy = dataset.columns.find(c => c.name.toLowerCase() === query.metric.toLowerCase());
            if (fuzzy) {
                checks.push({
                    name: 'Metric Column',
                    status: 'warn',
                    message: `Metric "${query.metric}" matched case-insensitively to "${fuzzy.name}".`
                });
            } else {
                checks.push({
                    name: 'Metric Column',
                    status: 'fail',
                    message: `Metric column "${query.metric}" does not exist in the dataset.`
                });
            }
        } else {
            // 3. Type safety — metric should be numeric
            if (colDef.type === ColumnType.DIMENSION && query.aggregation !== AggregationType.COUNT && query.aggregation !== AggregationType.COUNT_DISTINCT) {
                checks.push({
                    name: 'Metric Type',
                    status: 'warn',
                    message: `"${query.metric}" is classified as DIMENSION but used as a metric. Consider using COUNT aggregation.`
                });
            } else {
                checks.push({ name: 'Metric Type', status: 'pass', message: `Metric "${query.metric}" type is valid.` });
            }
        }
    }

    // 4. Dimension existence
    if (query.dimension) {
        const dimExists = dataset.columns.find(c => c.name === query.dimension || c.name.toLowerCase() === query.dimension.toLowerCase());
        if (!dimExists) {
            checks.push({
                name: 'Dimension Column',
                status: 'fail',
                message: `Dimension column "${query.dimension}" does not exist in the dataset.`
            });
        } else {
            checks.push({ name: 'Dimension Column', status: 'pass', message: `Dimension "${query.dimension}" exists.` });
        }
    }

    // 5. Aggregation validity
    if (query.aggregation && !ALLOWED_AGGREGATIONS.has(query.aggregation)) {
        checks.push({
            name: 'Aggregation Function',
            status: 'fail',
            message: `Unknown aggregation "${query.aggregation}". Allowed: SUM, AVG, COUNT, MAX, MIN, COUNT_DISTINCT.`
        });
    } else if (query.aggregation) {
        checks.push({ name: 'Aggregation Function', status: 'pass', message: `Aggregation "${query.aggregation}" is valid.` });
    }

    // 6. AS OF date sanity
    if (query.asOfDate && dataset.timeContext) {
        const asOf = new Date(query.asOfDate);

        if (isNaN(asOf.getTime())) {
            checks.push({
                name: 'AS OF Date',
                status: 'fail',
                message: `AS OF date "${query.asOfDate}" is not a valid date.`
            });
        } else {
            checks.push({ name: 'AS OF Date', status: 'pass', message: `AS OF date set to ${query.asOfDate}.` });
        }
    }

    // 7. Filter validity — check that filter column names exist
    if (query.filters) {
        const colNames = new Set(dataset.columns.map(c => c.name));
        for (const [col, vals] of Object.entries(query.filters)) {
            if (!colNames.has(col)) {
                checks.push({
                    name: 'Filter Column',
                    status: 'warn',
                    message: `Filter column "${col}" not found in dataset schema.`
                });
            } else if (vals.length === 0) {
                checks.push({
                    name: 'Filter Values',
                    status: 'warn',
                    message: `Filter on "${col}" has no values selected — this may return empty results.`
                });
            }
        }
    }

    // 8. Limit sanity
    if (query.limit !== undefined && query.limit !== null) {
        if (query.limit < 1) {
            checks.push({ name: 'Row Limit', status: 'warn', message: `Limit of ${query.limit} is too low.` });
        } else if (query.limit > 10000) {
            checks.push({ name: 'Row Limit', status: 'warn', message: `Limit of ${query.limit} is very high — may impact performance.` });
        } else {
            checks.push({ name: 'Row Limit', status: 'pass', message: `Limit ${query.limit} is reasonable.` });
        }
    }

    return summarize(checks);
}

// ─── SQL Validation ────────────────────────────────────────────────

export function validateSQL(sql: string, dataset?: Dataset): ValidationResult {
    const checks: ValidationCheck[] = [];

    if (!sql || sql.trim().startsWith('--')) {
        checks.push({ name: 'SQL Present', status: 'pass', message: 'SQL is a comment/placeholder (display only).' });
        return summarize(checks);
    }

    // 1. Injection patterns
    for (const pattern of DANGEROUS_SQL_PATTERNS) {
        if (pattern.test(sql)) {
            checks.push({
                name: 'SQL Injection Check',
                status: 'fail',
                message: `Potentially dangerous SQL pattern detected: ${pattern.source}`
            });
        }
    }
    if (!checks.some(c => c.name === 'SQL Injection Check')) {
        checks.push({ name: 'SQL Injection Check', status: 'pass', message: 'No injection patterns detected.' });
    }

    // 2. Aggregation function validation
    const aggMatch = sql.match(/\b(SUM|AVG|COUNT|MAX|MIN|COUNT_DISTINCT)\s*\(/gi);
    if (aggMatch) {
        const allValid = aggMatch.every(m => ALLOWED_AGGREGATIONS.has(m.replace(/\s*\(/, '').toUpperCase()));
        if (allValid) {
            checks.push({ name: 'SQL Aggregation', status: 'pass', message: `Aggregation functions are valid: ${aggMatch.join(', ')}` });
        }
    }

    // 3. LIMIT check
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
        const limitVal = parseInt(limitMatch[1], 10);
        if (limitVal > 10000) {
            checks.push({ name: 'SQL Limit', status: 'warn', message: `LIMIT ${limitVal} is very high (max recommended: 10,000).` });
        } else {
            checks.push({ name: 'SQL Limit', status: 'pass', message: `LIMIT ${limitVal} is reasonable.` });
        }
    } else {
        checks.push({ name: 'SQL Limit', status: 'warn', message: 'No LIMIT clause — results may be unbounded.' });
    }

    // 4. Column names match schema (if dataset provided)
    if (dataset) {
        const colNames = new Set(dataset.columns.map(c => c.name.toLowerCase()));
        // Extract column references from SELECT and WHERE
        const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);
        if (selectMatch) {
            const selectPart = selectMatch[1];
            // Simple extraction — finds raw column names (not inside functions)
            const rawCols = selectPart.split(',').map(s => s.trim().replace(/.*\(([^)]+)\).*/, '$1').trim());
            for (const col of rawCols) {
                if (col !== '*' && !col.includes(' ') && !colNames.has(col.toLowerCase())) {
                    checks.push({
                        name: 'Column Reference',
                        status: 'warn',
                        message: `Column "${col}" in SQL may not match dataset schema.`
                    });
                }
            }
        }
    }

    return summarize(checks);
}

// ─── Post-Execution Validation ─────────────────────────────────────

export function validatePost(result: AnalysisResult, dataset?: Dataset): ValidationResult {
    const checks: ValidationCheck[] = [];

    // 1. Non-empty result
    if (!result.data || result.data.length === 0) {
        if (result.error) {
            checks.push({ name: 'Result Data', status: 'fail', message: `Analysis returned error: ${result.error}` });
        } else {
            checks.push({ name: 'Result Data', status: 'warn', message: 'Analysis returned no data. This may be correct or indicate a filter issue.' });
        }
        return summarize(checks);
    }
    checks.push({ name: 'Result Data', status: 'pass', message: `${result.data.length} result rows returned.` });

    // 2. Value range checks
    if (result.yKey) {
        const values = result.data.map(r => Number(r[result.yKey])).filter(v => !isNaN(v));
        if (values.length > 0) {
            const min = Math.min(...values);
            const max = Math.max(...values);

            // Check for negative counts
            if (result.config?.aggregation === AggregationType.COUNT && min < 0) {
                checks.push({
                    name: 'Value Range',
                    status: 'fail',
                    message: `COUNT produced negative values (min: ${min}). This indicates a calculation error.`
                });
            } else if (min < 0 && result.config?.aggregation === AggregationType.SUM) {
                checks.push({
                    name: 'Value Range',
                    status: 'warn',
                    message: `SUM contains negative values (min: ${min}). Verify this is expected.`
                });
            } else {
                checks.push({ name: 'Value Range', status: 'pass', message: `Values range from ${min.toLocaleString()} to ${max.toLocaleString()}.` });
            }

            // Check for NaN/Infinity
            const hasNaN = result.data.some(r => r[result.yKey] !== null && r[result.yKey] !== undefined && isNaN(Number(r[result.yKey])));
            if (hasNaN) {
                checks.push({
                    name: 'NaN Check',
                    status: 'warn',
                    message: 'Some result values are NaN. This may indicate a division by zero or missing data.'
                });
            }
        }
    }

    // 3. Key presence
    if (result.xKey && result.data.length > 0 && !(result.xKey in result.data[0])) {
        checks.push({
            name: 'X-Key Presence',
            status: 'fail',
            message: `X-axis key "${result.xKey}" is not present in result data.`
        });
    }

    if (result.yKey && result.data.length > 0 && !(result.yKey in result.data[0])) {
        checks.push({
            name: 'Y-Key Presence',
            status: 'fail',
            message: `Y-axis key "${result.yKey}" is not present in result data.`
        });
    }

    // 4. Result count sanity (compared to dataset)
    if (dataset && result.data.length > dataset.rows.length) {
        checks.push({
            name: 'Row Count',
            status: 'warn',
            message: `Result has more rows (${result.data.length}) than dataset (${dataset.rows.length}). Possible duplication from joins.`
        });
    }

    return summarize(checks);
}

// ─── Column/Table Name Sanitization ────────────────────────────────

export function sanitizeIdentifier(name: string): string {
    if (!name) return '';
    // Remove any characters that aren't alphanumeric, underscore, or space
    const sanitized = name.replace(/[^a-zA-Z0-9_ ]/g, '');
    // If name was completely stripped, return a safe fallback
    return sanitized || 'unnamed_column';
}

export function isIdentifierSafe(name: string): boolean {
    return SAFE_NAME_REGEX.test(name);
}

export function escapeStringValue(value: string): string {
    // Escape single quotes for SQL string literals
    return value.replace(/'/g, "''");
}

// ─── Summarizer ────────────────────────────────────────────────────

function summarize(checks: ValidationCheck[]): ValidationResult {
    const fails = checks.filter(c => c.status === 'fail');
    const warns = checks.filter(c => c.status === 'warn');
    const passes = checks.filter(c => c.status === 'pass');

    let status: 'valid' | 'warning' | 'error' = 'valid';
    let summary = '';

    if (fails.length > 0) {
        status = 'error';
        summary = `${fails.length} error(s): ${fails.map(f => f.message).join('; ')}`;
    } else if (warns.length > 0) {
        status = 'warning';
        summary = `${passes.length} passed, ${warns.length} warning(s): ${warns.map(w => w.message).join('; ')}`;
    } else {
        summary = `All ${passes.length} checks passed.`;
    }

    return { status, checks, summary };
}

// ─── Convenience Export ────────────────────────────────────────────

export const validateAnalysis = {
    pre: validatePre,
    sql: validateSQL,
    post: validatePost,
    sanitize: sanitizeIdentifier,
    isSafe: isIdentifierSafe,
    escape: escapeStringValue
};
