/**
 * Data Reshaper — Post-execution data transformations
 *
 * Transforms raw SQL results into chart-ready data:
 * - Pivot: wide comparison data → tidy rows
 * - Top-N + "Other": bucket low-frequency categories
 * - Percent-of-total: convert for donut/pie
 * - Sort time series chronologically
 */

import { ResultProfile, ChartRecommendation, AnalysisPlan } from './types';

/**
 * Reshape data based on the chart recommendation and result profile.
 * Returns chart-ready data and optionally updated chart config.
 */
export function reshapeData(
    data: Record<string, any>[],
    profile: ResultProfile,
    chart: ChartRecommendation,
    plan: AnalysisPlan
): {
    data: Record<string, any>[];
    chart: ChartRecommendation;
} {
    let reshapedData = [...data];
    let updatedChart = { ...chart };

    // ─── 0. Null-coalesce metric values (Fix #14) ────────────────
    // Prevent NaN in chart tooltips and broken axis labels
    for (const row of reshapedData) {
        for (const col of profile.metricColumns) {
            if (row[col] === null || row[col] === undefined || Number.isNaN(row[col])) {
                row[col] = 0;
            }
        }
    }

    // ─── 1. Pivot Comparison Data ────────────────────────────────
    // If we have a single row with multiple numeric columns (comparison query),
    // pivot into rows for the grouped bar chart
    if (profile.isPivoted && profile.metricCount > 1) {
        const row = data[0];
        const pivotedRows: Record<string, any>[] = [];

        for (const col of profile.metricColumns) {
            pivotedRows.push({
                Metric: formatMetricName(col),
                Value: Number(row[col]) || 0,
                _originalKey: col,
            });
        }

        reshapedData = pivotedRows;
        updatedChart.xKey = 'Metric';
        updatedChart.yKey = 'Value';

        // Calculate growth between first two metrics
        if (profile.metricColumns.length >= 2) {
            const val0 = Number(row[profile.metricColumns[0]]) || 0;
            const val1 = Number(row[profile.metricColumns[1]]) || 0;
            const diff = val0 - val1;
            const pct = val1 !== 0 ? (diff / Math.abs(val1)) * 100 : 0;

            updatedChart.growth = {
                diff,
                pct,
                label: `${formatMetricName(profile.metricColumns[0])} vs ${formatMetricName(profile.metricColumns[1])}`,
            };
        }
    }

    // ─── 2. Top-N + "Other" Grouping ─────────────────────────────
    if (chart.topN && reshapedData.length > chart.topN) {
        const sortKey = chart.yKey;
        const sorted = [...reshapedData].sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));
        const topItems = sorted.slice(0, chart.topN);
        const otherItems = sorted.slice(chart.topN);

        if (otherItems.length > 0) {
            // Sum up the "Other" bucket
            const otherRow: Record<string, any> = { [chart.xKey]: 'Other' };
            for (const col of profile.metricColumns) {
                otherRow[col] = otherItems.reduce((sum, r) => sum + (Number(r[col]) || 0), 0);
            }
            topItems.push(otherRow);
        }

        reshapedData = topItems;
    }

    // ─── 3. Percent-of-Total ─────────────────────────────────────
    if (plan.intent === 'share_of_total' && profile.metricColumns.length >= 1) {
        const metricCol = chart.yKey;
        const total = reshapedData.reduce((sum, r) => sum + (Number(r[metricCol]) || 0), 0);

        if (total > 0) {
            reshapedData = reshapedData.map(r => ({
                ...r,
                [`${metricCol}_pct`]: ((Number(r[metricCol]) || 0) / total) * 100,
            }));
            // Update yKey to point to the percentage column
            updatedChart.yKey = `${metricCol}_pct`;
        }
    }

    // ─── 4. Sort Time Series Chronologically ─────────────────────
    if (profile.hasTimeDimension && profile.timeDimensionColumn) {
        const timeCol = profile.timeDimensionColumn;
        reshapedData.sort((a, b) => {
            const aVal = String(a[timeCol] || '');
            const bVal = String(b[timeCol] || '');
            return aVal.localeCompare(bVal);
        });
    }

    return { data: reshapedData, chart: updatedChart };
}

/**
 * Format a metric column name into a human-readable label
 * e.g., "this_week_sales" → "This Week Sales"
 */
function formatMetricName(name: string): string {
    return name
        .replace(/_sum$|_avg$|_count$|_min$|_max$/, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase())
        .trim();
}
