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

    // ─── 0.5 Contextual labels for two-total period comparisons ──
    // SQL keeps stable Current/Previous roles for validation and downstream
    // calculations. The chart/table should show the periods the user actually
    // asked for (for example This Month and Last Month).
    if (plan.intent === 'total_comparison' && plan.comparison?.mode === 'total' && reshapedData.length === 2) {
        const periodKey = Object.keys(reshapedData[0] || {}).find(key => key.toLowerCase() === 'period');
        if (periodKey) {
            const grain = plan.comparison.grain;
            const title = grain ? grain.charAt(0).toUpperCase() + grain.slice(1) : 'Period';
            const currentLabel = grain ? `This ${title}` : 'Current Period';
            const previousLabel = plan.comparison.type === 'same_period_last_year'
                ? (grain === 'year' ? 'Last Year' : `Same ${title} Last Year`)
                : grain ? `Last ${title}` : 'Previous Period';
            reshapedData = reshapedData.map(row => {
                const role = String(row[periodKey] || '').toLowerCase();
                if (role === 'current') return { ...row, [periodKey]: currentLabel };
                if (role === 'previous') return { ...row, [periodKey]: previousLabel };
                return row;
            });
            if (updatedChart.growth) updatedChart.growth.label = `${currentLabel} vs ${previousLabel}`;
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
        const metricCol = updatedChart.yKey;
        const explicitPercentageColumns = profile.metricColumns.filter(column =>
            /(?:pct|percent|share|ratio)/i.test(column)
        );
        const hasCompoundAnalyticalOutput = profile.metricColumns.length > 1
            && explicitPercentageColumns.length > 0;

        // If SQL already computed a _pct column (e.g., sales_pct), don't re-append _pct
        const alreadyPct = /(?:pct|percent|share|ratio)/i.test(metricCol);

        // Preserve SQL-produced base and calculated measures. Derive-and-swap
        // only for the simple one-metric share case.
        if (!alreadyPct && !hasCompoundAnalyticalOutput) {
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
        // else: yKey already points to the correct pct column from SQL
    }

    // ─── 4. Sort Time Series Chronologically ─────────────────────
    if (profile.hasTimeDimension && profile.timeDimensionColumn) {
        const timeCol = profile.timeDimensionColumn;
        
        const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
        
        reshapedData.sort((a, b) => {
            const aVal = String(a[timeCol] || '');
            const bVal = String(b[timeCol] || '');
            
            if (/^\d{4}-/.test(aVal) && /^\d{4}-/.test(bVal)) {
                return aVal.localeCompare(bVal);
            }
            
            const aMonthIdx = months.findIndex(m => aVal.toLowerCase().startsWith(m));
            const bMonthIdx = months.findIndex(m => bVal.toLowerCase().startsWith(m));
            if (aMonthIdx !== -1 && bMonthIdx !== -1) {
                return aMonthIdx - bMonthIdx;
            }
            
            const aDate = new Date(aVal).getTime();
            const bDate = new Date(bVal).getTime();
            if (!isNaN(aDate) && !isNaN(bDate)) {
                return aDate - bDate;
            }
            
            return aVal.localeCompare(bVal);
        });

        // ─── 4.5 Time Spine Filling ──────────────────────────────────
        if (reshapedData.length >= 2) {
            const isMonthly = /^\d{4}-\d{2}$/.test(String(reshapedData[0][timeCol] || ''));
            const isDaily = /^\d{4}-\d{2}-\d{2}$/.test(String(reshapedData[0][timeCol] || ''));
            
            if (isMonthly || isDaily) {
                const filledData = [];
                for (let i = 0; i < reshapedData.length; i++) {
                    filledData.push(reshapedData[i]);
                    if (i < reshapedData.length - 1) {
                        const currDate = new Date(reshapedData[i][timeCol]);
                        const nextDate = new Date(reshapedData[i + 1][timeCol]);
                        
                        if (isMonthly) {
                            let curr = new Date(currDate.getFullYear(), currDate.getMonth() + 1, 1);
                            while (curr < new Date(nextDate.getFullYear(), nextDate.getMonth(), 1)) {
                                const padMonth = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}`;
                                const newRow: any = { [timeCol]: padMonth };
                                for (const col of profile.metricColumns) newRow[col] = 0;
                                filledData.push(newRow);
                                curr.setMonth(curr.getMonth() + 1);
                            }
                        } else if (isDaily) {
                            let curr = new Date(currDate.getTime() + 86400000);
                            while (curr < nextDate) {
                                const padDay = curr.toISOString().split('T')[0];
                                const newRow: any = { [timeCol]: padDay };
                                for (const col of profile.metricColumns) newRow[col] = 0;
                                filledData.push(newRow);
                                curr = new Date(curr.getTime() + 86400000);
                            }
                        }
                    }
                }
                reshapedData = filledData;
            }
        }
    }

    // A synthetic Current/Previous comparison is not an ordinary chronological
    // dimension. Keep the requested current period first instead of allowing
    // the generic time sorter to alphabetize "Last Month" before "This Month".
    if (plan.intent === 'total_comparison' && plan.comparison?.mode === 'total') {
        const periodKey = Object.keys(reshapedData[0] || {}).find(key => key.toLowerCase() === 'period');
        if (periodKey) {
            const periodOrder = (value: unknown) => /^(?:this|current)\b/i.test(String(value || '')) ? 0 : 1;
            reshapedData.sort((left, right) => periodOrder(left[periodKey]) - periodOrder(right[periodKey]));
        }
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
