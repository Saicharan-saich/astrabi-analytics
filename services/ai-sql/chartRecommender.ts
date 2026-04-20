/**
 * Chart Recommender — Deterministic rules-based chart selection
 *
 * Zero LLM involvement. Uses the ResultProfile to choose the
 * optimal chart type, axis configuration, and dual-axis settings.
 *
 * Rules are based on:
 * - Number of metrics and dimensions
 * - Dimension cardinality
 * - Time dimension presence
 * - Scale mismatch between metrics
 * - Semantic type differences (currency vs percentage)
 * - Analysis intent from the plan
 */

import { ResultProfile, ChartRecommendation, AnalysisPlan, SemanticModel, RecommendedChart } from './types';

const DUAL_AXIS_SCALE_THRESHOLD = 10; // 10x scale difference triggers dual axis
const HIGH_CARDINALITY_THRESHOLD = 15; // More than 15 categories = horizontal bar
const DONUT_MAX_CATEGORIES = 6; // Donut only for small category counts

/**
 * Derive the axis/label format for the primary metric based on its semantic type.
 * Used to ensure data labels always show '%' for discounts, '$' for revenue, etc.
 */
function deriveAxisFormat(
    primaryMetricCol: string,
    metricSemanticTypes: Record<string, import('./types').SemanticType>
): ChartRecommendation['leftAxisFormat'] {
    const stype = metricSemanticTypes[primaryMetricCol];
    if (stype === 'percentage') return 'percent';
    if (stype === 'currency') return 'currency_usd';
    return 'compact';
}

/**
 * Recommend the best chart type and configuration based on the result profile.
 * This is 100% deterministic — no LLM involved.
 */
export function recommendChart(
    profile: ResultProfile,
    plan: AnalysisPlan,
    model: SemanticModel
): ChartRecommendation {
    const {
        rowCount, metricCount, dimensionCount,
        dimensionColumns, metricColumns,
        dimensionCardinality, hasTimeDimension, timeDimensionColumn,
        metricsScaleMismatch, metricSemanticTypes,
        isPivoted, isSingleValue
    } = profile;

    // Default configuration
    let chartType: RecommendedChart = 'bar';
    let xKey = dimensionColumns[0] || metricColumns[0] || '';
    let yKey = metricColumns[0] || '';
    let secondaryYKeys: string[] | undefined;
    let useDualAxis = false;
    let leftAxisFormat: ChartRecommendation['leftAxisFormat'];
    let rightAxisFormat: ChartRecommendation['rightAxisFormat'];
    let reason = '';
    let topN: number | undefined;
    let growth: ChartRecommendation['growth'];

    // ─── Rule 1: Single Value → KPI Card ─────────────────────────
    if (isSingleValue || (rowCount === 1 && metricCount === 1 && dimensionCount === 0)) {
        chartType = 'kpiCard';
        xKey = metricColumns[0] || Object.keys(profile.metricSemanticTypes)[0] || '';
        yKey = xKey;
        leftAxisFormat = deriveAxisFormat(xKey, metricSemanticTypes);
        reason = 'Single scalar value → KPI Card';

        return { chartType, xKey, yKey, useDualAxis, leftAxisFormat, reason };
    }

    // ─── Rule 2: Pivoted Comparison → Grouped Bar + Growth ───────
    if (isPivoted && metricCount > 1) {
        chartType = 'groupedBar';
        xKey = 'Metric';
        yKey = 'Value';
        reason = `Comparison query: ${metricCount} numeric columns in single row → Grouped Bar with growth badge`;

        return { chartType, xKey, yKey, useDualAxis, reason, growth };
    }

    // ─── Rule 3: Total Period Comparison → Grouped Bar with Growth Badge ──
    // Detects "Current" vs "Previous" UNION ALL result from comparison queries
    const hasPeriodDim = dimensionColumns.some(c => c.toLowerCase() === 'period');
    const computedGrowth = (plan as any)._computedGrowth;
    if (hasPeriodDim && rowCount === 2 && metricCount >= 1) {
        chartType = 'groupedBar';
        xKey = dimensionColumns.find(c => c.toLowerCase() === 'period') || dimensionColumns[0];
        yKey = metricColumns[0];
        reason = 'Period-over-period total comparison → Grouped Bar with growth badge';
        if (computedGrowth) {
            growth = {
                diff: computedGrowth.diff,
                pct: computedGrowth.pct,
                label: `${computedGrowth.currentLabel} vs ${computedGrowth.previousLabel}`,
            };
        }
        return { chartType, xKey, yKey, useDualAxis, reason, growth };
    }
    if (plan.intent === 'total_comparison' && rowCount <= 2) {
        chartType = 'groupedBar';
        reason = 'Period-over-period total comparison → Grouped Bar';
        if (computedGrowth) {
            growth = {
                diff: computedGrowth.diff,
                pct: computedGrowth.pct,
                label: `${computedGrowth.currentLabel} vs ${computedGrowth.previousLabel}`,
            };
        }
        return { chartType, xKey, yKey, useDualAxis, reason, growth };
    }

    // ─── Rule 4: Share of Total → Donut or Bar ──────────────────
    if (plan.intent === 'share_of_total') {
        const cardinality = dimensionCardinality[dimensionColumns[0]] || 0;
        if (cardinality <= DONUT_MAX_CATEGORIES) {
            chartType = 'donut';
            reason = `Share of total with ${cardinality} categories (≤${DONUT_MAX_CATEGORIES}) → Donut`;
        } else {
            chartType = 'horizontalBar';
            reason = `Share of total with ${cardinality} categories (>${DONUT_MAX_CATEGORIES}) → Horizontal Bar`;
        }
        return { chartType, xKey, yKey, useDualAxis, reason };
    }

    // ─── Rule 4b: Growth/Comparison → Dual-Axis Combo (bars + growth line) ──
    // When plan has comparison, pipeline Step 5c guarantees growth_pct columns exist
    if (plan.comparison && hasTimeDimension && timeDimensionColumn && metricColumns.length >= 1) {
        chartType = 'dualAxisCombo';
        xKey = timeDimensionColumn;
        yKey = metricColumns[0] || '';
        secondaryYKeys = ['growth_pct'];
        useDualAxis = true;
        leftAxisFormat = metricSemanticTypes[metricColumns[0]] === 'currency' ? 'currency_usd' : 'compact';
        rightAxisFormat = 'percent';
        reason = `${plan.comparison.type} comparison → Dual-Axis Combo (${metricColumns[0]} bars + growth % line)`;
        return { chartType, xKey, yKey, secondaryYKeys, useDualAxis, leftAxisFormat, rightAxisFormat, reason };
    }

    // ─── Rule 5: Time Dimension Present ──────────────────────────
    if (hasTimeDimension && timeDimensionColumn) {
        xKey = timeDimensionColumn;

        if (metricCount === 1) {
            // Single metric over time → Line
            chartType = 'line';
            leftAxisFormat = deriveAxisFormat(metricColumns[0], metricSemanticTypes);
            reason = 'One time dimension + one metric → Line chart';
        } else if (metricCount >= 2) {
            // Multiple metrics over time
            yKey = metricColumns[0];
            secondaryYKeys = metricColumns.slice(1);

            // Check for scale mismatch and semantic type difference
            const semanticTypes = new Set(Object.values(metricSemanticTypes));
            const hasMixedSemantics = semanticTypes.size > 1
                && (semanticTypes.has('currency') && semanticTypes.has('percentage')
                    || semanticTypes.has('quantity') && semanticTypes.has('percentage'));

            if (metricsScaleMismatch > DUAL_AXIS_SCALE_THRESHOLD && hasMixedSemantics) {
                // Dual-axis combo: bars for volume, line for rate
                chartType = 'dualAxisCombo';
                useDualAxis = true;

                // Assign formats: currency/quantity on left, percentage on right
                const primaryType = metricSemanticTypes[metricColumns[0]];
                if (primaryType === 'percentage') {
                    // Swap: put the non-percentage on left, percentage on right
                    const nonPctIdx = metricColumns.findIndex(c => metricSemanticTypes[c] !== 'percentage');
                    if (nonPctIdx >= 0) {
                        yKey = metricColumns[nonPctIdx];
                        secondaryYKeys = metricColumns.filter((_, i) => i !== nonPctIdx);
                    }
                    leftAxisFormat = 'currency_usd';
                    rightAxisFormat = 'percent';
                } else {
                    leftAxisFormat = primaryType === 'currency' ? 'currency_usd' : 'compact';
                    rightAxisFormat = 'percent';
                }

                reason = `Time series + ${metricCount} metrics with ${metricsScaleMismatch.toFixed(0)}x scale mismatch and mixed semantic types → Dual-Axis Combo (${leftAxisFormat} left, ${rightAxisFormat} right)`;
            } else if (metricsScaleMismatch > DUAL_AXIS_SCALE_THRESHOLD) {
                // Scale mismatch without mixed semantics → still use dual axis
                chartType = 'dualAxisCombo';
                useDualAxis = true;
                leftAxisFormat = 'compact';
                rightAxisFormat = 'compact';
                reason = `Time series + ${metricCount} metrics with ${metricsScaleMismatch.toFixed(0)}x scale mismatch → Dual-Axis Combo`;
            } else {
                // Same scale → Multi-line
                chartType = 'multiLine';
                reason = `Time series + ${metricCount} metrics, similar scale → Multi-Line`;
            }
        }

        return { chartType, xKey, yKey, secondaryYKeys, useDualAxis, leftAxisFormat, rightAxisFormat, reason };
    }

    // ─── Rule 6: Category Dimension ──────────────────────────────
    if (dimensionCount >= 1 && metricCount >= 1) {
        const primaryDim = dimensionColumns[0];
        const cardinality = dimensionCardinality[primaryDim] || 0;

        if (cardinality > HIGH_CARDINALITY_THRESHOLD) {
            // Too many categories → horizontal bar with top-N
            chartType = 'horizontalBar';
            topN = 15;
            leftAxisFormat = deriveAxisFormat(metricColumns[0], metricSemanticTypes);
            reason = `${cardinality} categories (>${HIGH_CARDINALITY_THRESHOLD}) → Horizontal Bar (top ${topN})`;
        } else if (metricCount === 1) {
            chartType = 'bar';
            leftAxisFormat = deriveAxisFormat(metricColumns[0], metricSemanticTypes);
            reason = `${cardinality} categories + 1 metric → Bar`;
        } else if (metricCount >= 2) {
            // Multiple metrics by category
            secondaryYKeys = metricColumns.slice(1);

            const semanticTypes = new Set(Object.values(metricSemanticTypes));
            const hasMixedSemantics = semanticTypes.size > 1
                && (semanticTypes.has('currency') && semanticTypes.has('percentage'));

            if (metricsScaleMismatch > DUAL_AXIS_SCALE_THRESHOLD && hasMixedSemantics) {
                chartType = 'dualAxisCombo';
                useDualAxis = true;
                leftAxisFormat = 'currency_usd';
                rightAxisFormat = 'percent';
                reason = `${cardinality} categories + ${metricCount} metrics with scale mismatch → Dual-Axis Combo`;
            } else {
                chartType = 'groupedBar';
                reason = `${cardinality} categories + ${metricCount} metrics → Grouped Bar`;
            }
        }

        return { chartType, xKey, yKey, secondaryYKeys, useDualAxis, leftAxisFormat, rightAxisFormat, reason, topN };
    }

    // ─── Rule 7: Two dimensions + one metric → Stacked Bar ──────
    if (dimensionCount >= 2 && metricCount >= 1) {
        chartType = 'stackedBar';
        reason = `${dimensionCount} dimensions + ${metricCount} metric(s) → Stacked Bar`;
        return { chartType, xKey, yKey, useDualAxis, reason };
    }

    // ─── Rule 8: Table fallback ──────────────────────────────────
    if (metricCount === 0) {
        chartType = 'table';
        reason = 'No numeric metrics detected → Table view';
        return { chartType, xKey, yKey, useDualAxis, reason };
    }

    // Default
    reason = 'Default chart selection → Bar';
    return { chartType, xKey, yKey, secondaryYKeys, useDualAxis, reason };
}
