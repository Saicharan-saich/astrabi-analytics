/**
 * Confidence Scorer — Evaluates how confident the system is in the result
 *
 * Scores 0-100 based on:
 * - Semantic match quality (did the LLM use exact field names or fuzzy synonyms?)
 * - Filter clarity (explicit dates vs inferred time periods)
 * - Aggregation certainty (default agg used vs LLM-chosen)
 * - Plan complexity (single metric vs multi-join comparison)
 * - Repair attempts (0 = best, 2 = worst)
 */

import { AnalysisPlan, SemanticModel, ConfidenceScore, ValidationResult } from './types';
import { scoreSQLReadability } from '../sqlFormatter';

/**
 * Calculate a confidence score for the pipeline result.
 */
export function scoreConfidence(
    plan: AnalysisPlan,
    model: SemanticModel,
    validation: ValidationResult,
    sqlMethod: 'deterministic' | 'llm',
    repairAttempts: number,
    sql?: string,
    rawData?: any[]
): ConfidenceScore {
    let semanticMatch = 30;     // Start at max, subtract for issues
    let filterClarity = 20;
    let aggregationCertainty = 20;
    let planComplexity = 15;
    let repairScore = 15;

    const reasons: string[] = [];

    // ─── 1. Semantic Match Quality (max 30) ──────────────────────
    const fieldNames = new Set(model.fields.map(f => f.name.toLowerCase()));
    const compositeIds = new Set(model.compositeMetrics.map(m => m.id.toLowerCase()));

    // Check if all referenced fields exist in the model
    let unmatchedFields = 0;
    for (const dim of plan.dimensions) {
        if (!fieldNames.has(dim.field.toLowerCase())) {
            unmatchedFields++;
            reasons.push(`Dimension "${dim.field}" may be a synonym or inferred mapping`);
        }
    }
    for (const met of plan.metrics) {
        if (!fieldNames.has(met.field.toLowerCase()) && !compositeIds.has(met.field.toLowerCase())) {
            unmatchedFields++;
            reasons.push(`Metric "${met.field}" may be a synonym or inferred mapping`);
        }
    }
    // Subtract 8 points per unmatched field
    semanticMatch = Math.max(0, 30 - unmatchedFields * 8);

    // ─── 2. Filter Clarity (max 20) ──────────────────────────────
    if (plan.filters.length === 0) {
        // No filters could mean "all data" (fine) or "forgot to filter" (unknown)
        if (plan.intent === 'single_metric' || plan.intent === 'ranking') {
            filterClarity = 20; // All-data queries are fine without filters
        } else {
            filterClarity = 15; // Slight penalty for no filters on breakdown/trend
        }
    } else {
        // Check filter clarity
        const hasExplicitDateFilter = plan.filters.some(f => {
            const field = model.fields.find(fi => fi.name === f.field);
            return field?.semanticType === 'date' && (f.op === 'between' || f.op === '=' || f.op === '>=' || f.op === '<=');
        });

        // Check if any filter was a "this_" operator (normalized by our safeguard)
        const hasInferredDateFilter = plan.filters.some(f => {
            return f.op && typeof f.op === 'string' && f.op.startsWith('this_');
        });

        if (hasExplicitDateFilter && !hasInferredDateFilter) {
            filterClarity = 20;
        } else if (hasExplicitDateFilter && hasInferredDateFilter) {
            filterClarity = 12;
            reasons.push('Date filter was inferred from question context (this_month/this_week) — normalized by safeguard');
        } else {
            filterClarity = 12;
            reasons.push('Date filter may have been inferred rather than explicitly specified');
        }
    }

    // ─── 3. Aggregation Certainty (max 20) ───────────────────────
    for (const met of plan.metrics) {
        const field = model.fields.find(f => f.name.toLowerCase() === met.field.toLowerCase());
        if (field && field.defaultAgg !== 'none') {
            if (met.agg !== field.defaultAgg) {
                aggregationCertainty -= 5;
                reasons.push(`"${met.field}" uses ${met.agg} instead of default ${field.defaultAgg}`);
            }
        }
    }
    aggregationCertainty = Math.max(0, aggregationCertainty);

    // ─── 4. Plan Complexity (max 15) ─────────────────────────────
    if (plan.comparison) {
        planComplexity -= 3;
        reasons.push('Comparison query adds complexity');
    }
    if (plan.metrics.length > 2) {
        planComplexity -= 2;
        reasons.push(`${plan.metrics.length} metrics increases complexity`);
    }
    if (plan.ambiguous) {
        planComplexity -= 10;
        reasons.push('Plan marked as ambiguous by the intent planner');
    }
    planComplexity = Math.max(0, planComplexity);

    // ─── 5. Repair Attempts (max 15) ─────────────────────────────
    repairScore = Math.max(0, 15 - repairAttempts * 7);
    if (repairAttempts > 0) {
        reasons.push(`SQL required ${repairAttempts} repair attempt(s)`);
    }

    // Bonus for deterministic SQL generation
    if (sqlMethod === 'deterministic') {
        aggregationCertainty = Math.min(20, aggregationCertainty + 5);
    } else {
        reasons.push('SQL was generated by LLM (fallback), not deterministic code');
    }

    // Penalty for validation warnings/failures
    const failCount = validation.checks.filter(c => c.status === 'fail').length;
    const warnCount = validation.checks.filter(c => c.status === 'warn').length;
    if (failCount > 0) {
        semanticMatch = Math.max(0, semanticMatch - failCount * 10);
        reasons.push(`SQL validation had ${failCount} failure(s)`);
    }
    if (warnCount > 0) {
        semanticMatch = Math.max(0, semanticMatch - warnCount * 3);
    }

    // ─── 6. SQL Quality Signals (penalty up to -15) ────────────────
    let sqlQualityPenalty = 0;
    if (sql) {
        // Penalize SQL that doesn't quote identifiers (columns with spaces will break)
        const hasUnquotedSpacedCol = /\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY)\b[^"]*\b\w+ \w+\b/i.test(sql);
        if (hasUnquotedSpacedCol && !sql.includes('"')) {
            sqlQualityPenalty += 3;
            reasons.push('[SQL Quality] No quoted identifiers detected — may break on columns with spaces');
        }

        // Penalize missing aliases (SELECT SUM(x) without AS)
        const aggWithoutAlias = /\b(SUM|AVG|COUNT|MIN|MAX)\([^)]+\)(?!\s+AS\b)/i.test(sql);
        if (aggWithoutAlias) {
            sqlQualityPenalty += 3;
            reasons.push('[SQL Quality] Aggregation without alias — column name will be engine-dependent');
        }

        // Penalize very long single-line SQL (readability issue, potential comment corruption)
        const lines = sql.split('\n');
        const maxLineLen = Math.max(...lines.map(l => l.length));
        if (maxLineLen > 300) {
            sqlQualityPenalty += 3;
            reasons.push('[SQL Quality] SQL contains lines >300 chars — readability concern');
        }

        // Bonus for using CTEs (WITH clause) — indicates well-structured SQL
        if (/\bWITH\b/i.test(sql)) {
            sqlQualityPenalty -= 2; // negative penalty = bonus
        }

        // SQL readability score
        const readability = scoreSQLReadability(sql);
        if (readability.reasons.length > 0) {
            reasons.push(...readability.reasons.map(r => `[Readability] ${r}`));
        }
    }

    const totalScore = semanticMatch + filterClarity + aggregationCertainty + planComplexity + repairScore - sqlQualityPenalty;

    let score = Math.min(100, Math.max(0, totalScore));

    // Penalize empty results — 0 rows usually means a filter mismatch, not genuinely empty data
    if (!rawData || rawData.length === 0) {
        score = Math.max(0, score - 40);
        reasons.push('Query returned 0 rows — usually means a filter mismatch');
    }

    // Determine level
    let level: 'high' | 'medium' | 'low';
    if (score >= 75) level = 'high';
    else if (score >= 50) level = 'medium';
    else level = 'low';

    if (reasons.length === 0) {
        reasons.push('All fields matched exactly, filters clear, default aggregations used');
    }

    return {
        score,
        level,
        factors: {
            semanticMatch,
            filterClarity,
            aggregationCertainty,
            planComplexity,
            repairAttempts: repairScore,
        },
        reasons,
    };
}
