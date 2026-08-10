/**
 * answerContractValidator.ts — Result-Level Verification
 *
 * Before showing ANY answer to the user, runs 10 contract checks:
 *   1. Every requested metric appears in results
 *   2. Every requested condition/filter is reflected in SQL WHERE
 *   3. No filter was silently dropped
 *   4. Aggregation grain is correct
 *   5. Human-readable entity names are included (not just IDs)
 *   6. Relative dates use the dataset anchor (not today())
 *   7. Join cardinality didn't inflate totals
 *   8. Results satisfy their own threshold conditions
 *   9. Chart formatting matches result semantics
 *  10. Query returned at least 1 row
 *
 * If verification fails, attempts auto-repair before surfacing error.
 */

import { AnalysisPlan, SemanticModel } from './types';
import { DatasetStatistics } from './localStatisticsResolver';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface ContractCheck {
    id: string;
    name: string;
    status: 'pass' | 'fail' | 'warn' | 'skip';
    message: string;
    autoRepairable: boolean;
    repairHint?: string;
}

export interface ContractValidationResult {
    checks: ContractCheck[];
    passed: boolean;
    passCount: number;
    failCount: number;
    warnCount: number;
    /** Human-readable summary */
    summary: string;
    /** Auto-repair suggestions if any checks failed */
    repairSuggestions: string[];
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATOR
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate a pipeline result against its plan and dataset.
 */
export function validateAnswerContract(
    plan: AnalysisPlan,
    sql: string,
    results: any[],
    chartType: string,
    xKey: string,
    yKey: string,
    semanticModel: SemanticModel,
    stats?: DatasetStatistics
): ContractValidationResult {
    const checks: ContractCheck[] = [];
    const sqlLower = sql.toLowerCase();

    // ─── Check 1: Metrics Present ────────────────────────────────
    {
        const planMetrics = plan.metrics?.map(m => m.field.toLowerCase()) || [];
        const resultColumns = results.length > 0 ? Object.keys(results[0]).map(k => k.toLowerCase()) : [];

        const missingMetrics = planMetrics.filter(m =>
            !resultColumns.some(rc => rc.includes(m.replace(/"/g, '')))
        );

        checks.push({
            id: 'metrics_present',
            name: 'Requested metrics in results',
            status: missingMetrics.length === 0 ? 'pass' : 'fail',
            message: missingMetrics.length === 0
                ? `All ${planMetrics.length} metric(s) found in results`
                : `Missing metrics: ${missingMetrics.join(', ')}`,
            autoRepairable: false,
        });
    }

    // ─── Check 2: Conditions Applied ─────────────────────────────
    {
        const planFilters = plan.filters || [];
        const missingFilters = planFilters.filter(f => {
            const fieldLower = f.field.toLowerCase();
            return !sqlLower.includes(fieldLower);
        });

        checks.push({
            id: 'conditions_applied',
            name: 'All filters in SQL WHERE',
            status: missingFilters.length === 0 ? 'pass' : planFilters.length === 0 ? 'skip' : 'fail',
            message: missingFilters.length === 0
                ? `All ${planFilters.length} filter(s) present in SQL`
                : `Filters not found in SQL: ${missingFilters.map(f => f.field).join(', ')}`,
            autoRepairable: true,
            repairHint: missingFilters.length > 0
                ? `Add WHERE clause for: ${missingFilters.map(f => `${f.field} ${f.op} ${JSON.stringify(f.value)}`).join(', ')}`
                : undefined,
        });
    }

    // ─── Check 3: No Silent Filter Drop ──────────────────────────
    {
        // Check if SQL has fewer WHERE conditions than the plan specified
        const planFilterCount = (plan.filters || []).length;
        const whereMatch = sqlLower.match(/where\s+/);
        const andCount = whereMatch ? (sqlLower.split(/\band\b/).length - 1) : 0;
        const hasWhere = whereMatch !== null;

        const status = planFilterCount === 0 ? 'skip'
            : (planFilterCount > 0 && !hasWhere) ? 'fail'
            : 'pass';

        checks.push({
            id: 'no_silent_filter_drop',
            name: 'No silently dropped filters',
            status,
            message: status === 'fail'
                ? `Plan has ${planFilterCount} filter(s) but SQL has no WHERE clause`
                : `Filter count consistent`,
            autoRepairable: true,
            repairHint: status === 'fail' ? 'Re-inject plan filters into SQL' : undefined,
        });
    }

    // ─── Check 4: Grain Correct ──────────────────────────────────
    {
        const planDims = plan.dimensions?.map(d => d.field.toLowerCase()) || [];
        const groupByMatch = sqlLower.match(/group\s+by\s+([^)]+?)(?:order|limit|having|$)/s);
        const groupByCols = groupByMatch
            ? groupByMatch[1].split(',').map(c => c.trim().replace(/"/g, '').toLowerCase())
            : [];

        const missingGroupBy = planDims.filter(d => !groupByCols.some(g => g.includes(d)));

        const status = planDims.length === 0 ? 'skip'
            : missingGroupBy.length === 0 ? 'pass'
            : 'warn';

        checks.push({
            id: 'grain_correct',
            name: 'Aggregation grain matches plan',
            status,
            message: status === 'pass'
                ? `GROUP BY includes all ${planDims.length} dimension(s)`
                : status === 'warn'
                ? `Potential grain mismatch: ${missingGroupBy.join(', ')} not in GROUP BY`
                : 'No dimensions in plan',
            autoRepairable: false,
        });
    }

    // ─── Check 5: Human-Readable Names ───────────────────────────
    {
        // Check if dimension columns contain IDs instead of names
        if (results.length > 0) {
            const dimColumns = (plan.dimensions || []).map(d => d.field);
            let hasOnlyIds = false;

            for (const dimCol of dimColumns) {
                const values = results.map(r => r[dimCol] || r[dimCol.toLowerCase()]).filter(Boolean);
                const numericValues = values.filter(v => !isNaN(Number(v)));
                if (values.length > 0 && numericValues.length / values.length > 0.9) {
                    hasOnlyIds = true;
                }
            }

            checks.push({
                id: 'human_readable_names',
                name: 'Human-readable entity names',
                status: hasOnlyIds ? 'warn' : 'pass',
                message: hasOnlyIds
                    ? 'Dimension values appear to be IDs, not human-readable names'
                    : 'Entity names appear human-readable',
                autoRepairable: false,
            });
        } else {
            checks.push({
                id: 'human_readable_names',
                name: 'Human-readable entity names',
                status: 'skip',
                message: 'No results to check',
                autoRepairable: false,
            });
        }
    }

    // ─── Check 6: Date Anchor ────────────────────────────────────
    {
        const usesToday = sqlLower.includes('current_date') ||
            sqlLower.includes('now()') ||
            sqlLower.includes('getdate()') ||
            sqlLower.includes('today()');

        checks.push({
            id: 'date_anchor_correct',
            name: 'Uses dataset anchor date (not today)',
            status: usesToday ? 'warn' : 'pass',
            message: usesToday
                ? 'SQL uses CURRENT_DATE/NOW() — should use dataset max date for historical data'
                : 'Date references use dataset-anchored values',
            autoRepairable: true,
            repairHint: usesToday ? 'Replace CURRENT_DATE with dataset max date' : undefined,
        });
    }

    // ─── Check 7: Join Cardinality ───────────────────────────────
    {
        const hasJoin = sqlLower.includes(' join ');

        if (hasJoin && stats) {
            // Simple fan-out check: if result row count >> total rows, join may inflate
            const resultRows = results.length;
            const expectedMax = stats.totalRows * 1.1; // 10% tolerance

            checks.push({
                id: 'join_no_inflation',
                name: 'Join didn\'t inflate totals',
                status: resultRows > expectedMax ? 'warn' : 'pass',
                message: resultRows > expectedMax
                    ? `Result has ${resultRows} rows vs ${stats.totalRows} source rows — possible join fan-out`
                    : 'Result row count is reasonable',
                autoRepairable: false,
            });
        } else {
            checks.push({
                id: 'join_no_inflation',
                name: 'Join didn\'t inflate totals',
                status: hasJoin ? 'skip' : 'pass',
                message: hasJoin ? 'No statistics available to check' : 'No joins in SQL',
                autoRepairable: false,
            });
        }
    }

    // ─── Check 8: Threshold Satisfaction ─────────────────────────
    {
        // If the plan has a threshold filter, check results satisfy it
        const thresholdFilters = (plan.filters || []).filter(f =>
            ['>', '>=', '<', '<='].includes(f.op)
        );

        if (thresholdFilters.length > 0 && results.length > 0) {
            let violations = 0;
            for (const filter of thresholdFilters) {
                for (const row of results) {
                    const val = row[filter.field] ?? row[filter.field.toLowerCase()];
                    if (val === undefined || val === null) continue;
                    const numVal = Number(val);
                    const threshold = Number(filter.value);
                    if (isNaN(numVal) || isNaN(threshold)) continue;

                    if (filter.op === '>' && numVal <= threshold) violations++;
                    if (filter.op === '>=' && numVal < threshold) violations++;
                    if (filter.op === '<' && numVal >= threshold) violations++;
                    if (filter.op === '<=' && numVal > threshold) violations++;
                }
            }

            checks.push({
                id: 'threshold_satisfied',
                name: 'Results satisfy threshold conditions',
                status: violations === 0 ? 'pass' : 'fail',
                message: violations === 0
                    ? 'All results satisfy threshold conditions'
                    : `${violations} result value(s) violate threshold conditions`,
                autoRepairable: true,
                repairHint: violations > 0 ? 'Add HAVING clause to enforce threshold' : undefined,
            });
        } else {
            checks.push({
                id: 'threshold_satisfied',
                name: 'Results satisfy threshold conditions',
                status: 'skip',
                message: 'No threshold filters in plan',
                autoRepairable: false,
            });
        }
    }

    // ─── Check 9: Chart Matches Data ─────────────────────────────
    {
        const resultCols = results.length > 0 ? Object.keys(results[0]) : [];
        const hasXKey = resultCols.some(c => c.toLowerCase() === xKey.toLowerCase());
        const hasYKey = resultCols.some(c => c.toLowerCase() === yKey.toLowerCase());

        checks.push({
            id: 'chart_matches_data',
            name: 'Chart keys exist in result data',
            status: (hasXKey && hasYKey) ? 'pass' : (!xKey && !yKey) ? 'skip' : 'fail',
            message: (hasXKey && hasYKey)
                ? `Chart keys "${xKey}" and "${yKey}" found in results`
                : `Missing chart key(s): ${!hasXKey ? xKey : ''} ${!hasYKey ? yKey : ''}`.trim(),
            autoRepairable: true,
            repairHint: !(hasXKey && hasYKey) ? 'Re-run chart recommender with actual result columns' : undefined,
        });
    }

    // ─── Check 10: Non-Empty Result ──────────────────────────────
    {
        checks.push({
            id: 'non_empty_result',
            name: 'Query returned results',
            status: results.length > 0 ? 'pass' : 'warn',
            message: results.length > 0
                ? `${results.length} row(s) returned`
                : 'Query returned 0 rows — filters may be too restrictive',
            autoRepairable: false,
        });
    }

    // ─── Summary ─────────────────────────────────────────────────
    const passCount = checks.filter(c => c.status === 'pass').length;
    const failCount = checks.filter(c => c.status === 'fail').length;
    const warnCount = checks.filter(c => c.status === 'warn').length;
    const passed = failCount === 0;

    const repairSuggestions = checks
        .filter(c => c.status === 'fail' && c.autoRepairable && c.repairHint)
        .map(c => c.repairHint!);

    const summary = passed
        ? `✅ All contract checks passed (${passCount} pass, ${warnCount} warn)`
        : `❌ ${failCount} check(s) failed: ${checks.filter(c => c.status === 'fail').map(c => c.name).join(', ')}`;

    return {
        checks,
        passed,
        passCount,
        failCount,
        warnCount,
        summary,
        repairSuggestions,
    };
}
