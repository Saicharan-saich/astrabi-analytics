// ═══════════════════════════════════════════════════════════════════
// validatePlan — Pre-execution validation of a QueryPlan AST
// Catches invalid queries before they hit the engine.
// ═══════════════════════════════════════════════════════════════════

import { QueryPlan, dimensionId } from './types';

export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

export function validatePlan(plan: QueryPlan): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // ── 1. Must have at least one metric ─────────────────────────
    if (plan.metrics.length === 0) {
        errors.push('QueryPlan must have at least one metric.');
    }

    // ── 2. Metric ID uniqueness ─────────────────────────────────
    const metricIds = new Set<string>();
    for (const m of plan.metrics) {
        if (metricIds.has(m.id)) {
            errors.push(`Duplicate metric ID: "${m.id}".`);
        }
        metricIds.add(m.id);
    }

    // ── 3. Metric alias uniqueness ──────────────────────────────
    const metricAliases = new Set<string>();
    for (const m of plan.metrics) {
        if (!m.alias) {
            errors.push(`Metric "${m.id}" is missing an alias.`);
            continue;
        }
        if (metricAliases.has(m.alias)) {
            errors.push(`Duplicate metric alias: "${m.alias}".`);
        }
        metricAliases.add(m.alias);
    }

    // ── 4. Dimension ID uniqueness ──────────────────────────────
    const dimIds = new Set<string>();
    for (const d of plan.dimensions) {
        const id = dimensionId(d);
        if (dimIds.has(id)) {
            errors.push(`Duplicate dimension ID: "${id}".`);
        }
        dimIds.add(id);
    }

    // ── 5. Alias collision between dimensions and metrics ────────
    for (const d of plan.dimensions) {
        const id = dimensionId(d);
        if (metricAliases.has(id)) {
            errors.push(`Dimension "${id}" collides with a metric alias.`);
        }
    }

    // ── 6. GroupFilter references valid metric ───────────────────
    for (const gf of plan.filters.group) {
        if (!metricIds.has(gf.metricId)) {
            errors.push(`HAVING filter references unknown metric ID: "${gf.metricId}".`);
        }
    }

    // ── 7. OrderBy references valid metric/dimension ─────────────
    for (const ob of plan.orderBy) {
        if (ob.type === 'metric' && !metricIds.has(ob.metricId)) {
            errors.push(`ORDER BY references unknown metric ID: "${ob.metricId}".`);
        }
        if (ob.type === 'dimension' && !dimIds.has(ob.dimensionId)) {
            errors.push(`ORDER BY references unknown dimension ID: "${ob.dimensionId}".`);
        }
    }

    // ── 8. Aggregation type validation ──────────────────────────
    for (const m of plan.metrics) {
        if (m.expression.type === 'column') {
            const colLower = m.expression.column.toLowerCase();
            // Warn on SUM/AVG for ID-like columns
            if ((m.aggregation === 'SUM' || m.aggregation === 'AVG') &&
                (colLower.endsWith('_id') || colLower === 'id' || colLower.endsWith('_key'))) {
                warnings.push(`"${m.aggregation}" on ID column "${m.expression.column}" — did you mean COUNT_DISTINCT?`);
            }
        }
    }

    // ── 9. GROUP BY consistency ──────────────────────────────────
    // If we have dimensions AND metrics with aggregation, GROUP BY is required (implicit).
    // If we have dimensions but no aggregation, that's a raw select (valid but warn).
    if (plan.dimensions.length === 0 && plan.metrics.length > 0) {
        // Scalar query — single row result. Valid.
    }

    // ── 10. RangeFilter must have at least start or end ─────────
    for (const rf of plan.filters.range) {
        if (!rf.start && !rf.end) {
            errors.push(`Range filter on "${rf.column}" has neither start nor end.`);
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}
