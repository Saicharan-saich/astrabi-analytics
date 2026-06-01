/**
 * Plan Validator — Validates AnalysisPlan against hard constraints before SQL generation.
 *
 * Catches invalid plans early, preventing bad SQL from ever reaching DuckDB.
 * Returns validation errors that can trigger LLM retry or user clarification.
 */

import { SemanticModel, SemanticField, AnalysisPlan } from './types';

export interface ValidationError {
    field: string;
    rule: string;
    message: string;
    severity: 'error' | 'warning';
    autoFix?: () => void;  // Optional auto-fix function
}

export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    warnings: ValidationError[];
    autoFixed: number;  // Count of auto-fixed issues
}

const VALID_TIME_GRAINS = ['year', 'quarter', 'month', 'week', 'day', 'day_of_week', 'month_of_year', 'hour'];
const VALID_AGGS = ['sum', 'avg', 'count', 'count_distinct', 'min', 'max', 'none'];
const VALID_INTENTS = [
    'single_metric', 'derived_metric', 'breakdown', 'trend', 'trend_comparison',
    'total_comparison', 'ranking', 'share_of_total', 'correlation', 'distribution',
    'aggregate_filter',
];

export function validatePlan(plan: AnalysisPlan, model: SemanticModel): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];
    let autoFixed = 0;

    const fieldMap = new Map(model.fields.map(f => [f.name.toLowerCase(), f]));

    // ── Rule 1: Intent must be valid ──
    if (!VALID_INTENTS.includes(plan.intent)) {
        errors.push({
            field: 'intent',
            rule: 'valid_intent',
            message: `Invalid intent "${plan.intent}". Valid: ${VALID_INTENTS.join(', ')}`,
            severity: 'error',
            autoFix: () => { plan.intent = 'breakdown'; },
        });
    }

    // ── Rule 2: All dimension fields must exist in the model ──
    for (const dim of plan.dimensions) {
        const field = fieldMap.get(dim.field.toLowerCase());
        if (!field) {
            // Try fuzzy match
            const fuzzyMatch = findClosestField(dim.field, model.fields);
            if (fuzzyMatch) {
                warnings.push({
                    field: dim.field,
                    rule: 'field_exists',
                    message: `Dimension "${dim.field}" not found. Auto-corrected to "${fuzzyMatch.name}".`,
                    severity: 'warning',
                    autoFix: () => { dim.field = fuzzyMatch.name; },
                });
            } else {
                errors.push({
                    field: dim.field,
                    rule: 'field_exists',
                    message: `Dimension "${dim.field}" does not exist in the dataset.`,
                    severity: 'error',
                });
            }
        }
    }

    // ── Rule 3: All metric fields must exist in the model ──
    for (const met of plan.metrics) {
        if (met.compositeId) continue; // Composite metrics are handled separately

        const field = fieldMap.get(met.field.toLowerCase());
        if (!field) {
            const fuzzyMatch = findClosestField(met.field, model.fields);
            if (fuzzyMatch) {
                warnings.push({
                    field: met.field,
                    rule: 'field_exists',
                    message: `Metric "${met.field}" not found. Auto-corrected to "${fuzzyMatch.name}".`,
                    severity: 'warning',
                    autoFix: () => { met.field = fuzzyMatch.name; },
                });
            } else {
                errors.push({
                    field: met.field,
                    rule: 'field_exists',
                    message: `Metric "${met.field}" does not exist in the dataset.`,
                    severity: 'error',
                });
            }
        }

        // Rule 3b: Metric aggregation must be valid
        if (!VALID_AGGS.includes(met.agg)) {
            warnings.push({
                field: met.field,
                rule: 'valid_agg',
                message: `Invalid aggregation "${met.agg}" for "${met.field}". Using "sum".`,
                severity: 'warning',
                autoFix: () => { met.agg = 'sum'; },
            });
        }
    }

    // ── Rule 4: No AVG/SUM on identifier fields ──
    for (const met of plan.metrics) {
        if (met.compositeId) continue;
        const field = fieldMap.get(met.field.toLowerCase());
        if (field && field.semanticType === 'identifier' && ['avg', 'sum'].includes(met.agg)) {
            warnings.push({
                field: met.field,
                rule: 'no_agg_on_id',
                message: `"${field.displayLabel}" is an identifier — ${met.agg.toUpperCase()} is meaningless. Changed to COUNT_DISTINCT.`,
                severity: 'warning',
                autoFix: () => { met.agg = 'count_distinct'; },
            });
        }
    }

    // ── Rule 5: No AVG/SUM on date fields ──
    for (const met of plan.metrics) {
        if (met.compositeId) continue;
        const field = fieldMap.get(met.field.toLowerCase());
        if (field && field.semanticType === 'date' && ['avg', 'sum'].includes(met.agg)) {
            errors.push({
                field: met.field,
                rule: 'no_agg_on_date',
                message: `Cannot ${met.agg.toUpperCase()} a date column "${field.name}". This likely needs a DATEDIFF.`,
                severity: 'error',
            });
        }
    }

    // ── Rule 6: Time grain must be valid ──
    for (const dim of plan.dimensions) {
        const grain = (dim as any).timeGrain;
        if (grain && !VALID_TIME_GRAINS.includes(grain)) {
            warnings.push({
                field: dim.field,
                rule: 'valid_time_grain',
                message: `Invalid time grain "${grain}". Changed to "month".`,
                severity: 'warning',
                autoFix: () => { (dim as any).timeGrain = 'month'; },
            });
        }
    }

    // ── Rule 7: Must have at least one metric (except distribution) ──
    if (plan.metrics.length === 0 && plan.intent !== 'distribution') {
        // Auto-fix: use the first measure field with its default aggregation
        const defaultMeasure = model.fields.find(f => f.role === 'metric');
        if (defaultMeasure) {
            warnings.push({
                field: 'metrics',
                rule: 'has_metric',
                message: `No metrics specified. Auto-added "${defaultMeasure.name}" with ${defaultMeasure.defaultAgg}.`,
                severity: 'warning',
                autoFix: () => {
                    plan.metrics.push({ field: defaultMeasure.name, agg: (defaultMeasure.defaultAgg === 'none' ? 'sum' : defaultMeasure.defaultAgg) || 'sum' });
                },
            });
        } else {
            errors.push({
                field: 'metrics',
                rule: 'has_metric',
                message: 'No metrics specified and no measure fields found in the dataset.',
                severity: 'error',
            });
        }
    }

    // ── Rule 8: Trend intent must have a time dimension ──
    if (['trend', 'trend_comparison'].includes(plan.intent)) {
        const hasTimeDim = plan.dimensions.some(d => (d as any).timeGrain);
        if (!hasTimeDim) {
            const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension');
            if (dateField) {
                warnings.push({
                    field: 'dimensions',
                    rule: 'trend_needs_time',
                    message: `Trend query needs a time dimension. Auto-added "${dateField.name}" with monthly grain.`,
                    severity: 'warning',
                    autoFix: () => {
                        plan.dimensions.push({ field: dateField.name, timeGrain: 'month' } as any);
                    },
                });
            }
        }
    }

    // ── Rule 9: Same field as both dimension and metric is invalid ──
    const dimFields = new Set(plan.dimensions.map(d => d.field.toLowerCase()));
    for (const met of plan.metrics) {
        if (met.compositeId) continue;
        if (dimFields.has(met.field.toLowerCase())) {
            const field = fieldMap.get(met.field.toLowerCase());
            if (field && field.semanticType !== 'ordinal') { // Ordinal is OK as both
                errors.push({
                    field: met.field,
                    rule: 'no_dual_role',
                    message: `"${met.field}" is used as both dimension and metric. This produces incorrect results.`,
                    severity: 'error',
                });
            }
        }
    }

    // ── Rule 10: Filter fields must exist (skip HAVING filters — they use compositeRefs) ──
    for (const filter of plan.filters) {
        if (filter.isHaving || ['above_avg', 'below_avg'].includes(filter.op)) continue;
        const field = fieldMap.get(filter.field.toLowerCase());
        if (!field) {
            const fuzzyMatch = findClosestField(filter.field, model.fields);
            if (fuzzyMatch) {
                warnings.push({
                    field: filter.field,
                    rule: 'filter_field_exists',
                    message: `Filter field "${filter.field}" not found. Auto-corrected to "${fuzzyMatch.name}".`,
                    severity: 'warning',
                    autoFix: () => { filter.field = fuzzyMatch.name; },
                });
            }
        }
    }

    // ── Apply auto-fixes ──
    const allIssues = [...errors, ...warnings];
    for (const issue of allIssues) {
        if (issue.autoFix) {
            issue.autoFix();
            autoFixed++;
        }
    }

    if (autoFixed > 0) {
        console.log(`[Plan Validator] Auto-fixed ${autoFixed} issue(s)`);
    }

    const realErrors = errors.filter(e => !e.autoFix);

    if (realErrors.length > 0) {
        console.warn(`[Plan Validator] ❌ ${realErrors.length} validation error(s):`,
            realErrors.map(e => e.message).join('; '));
    }

    return {
        valid: realErrors.length === 0,
        errors: realErrors,
        warnings,
        autoFixed,
    };
}

/**
 * Fuzzy field name matching — finds the closest field using edit distance + synonym match.
 */
function findClosestField(name: string, fields: SemanticField[]): SemanticField | null {
    const lower = name.toLowerCase().replace(/[_\s]/g, '');

    // 1. Exact synonym match
    for (const f of fields) {
        if (f.synonyms.some(s => s.toLowerCase().replace(/[_\s]/g, '') === lower)) {
            return f;
        }
    }

    // 2. Substring match (field name contains search or vice versa)
    for (const f of fields) {
        const fLower = f.name.toLowerCase().replace(/[_\s]/g, '');
        if (fLower.includes(lower) || lower.includes(fLower)) {
            return f;
        }
    }

    // 3. Levenshtein distance (for typos)
    let bestMatch: SemanticField | null = null;
    let bestDistance = Infinity;

    for (const f of fields) {
        const fLower = f.name.toLowerCase().replace(/[_\s]/g, '');
        const dist = levenshtein(lower, fLower);
        if (dist < bestDistance && dist <= Math.max(2, lower.length * 0.3)) {
            bestDistance = dist;
            bestMatch = f;
        }
    }

    return bestMatch;
}

/**
 * Simple Levenshtein distance implementation.
 */
function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }

    return dp[m][n];
}
