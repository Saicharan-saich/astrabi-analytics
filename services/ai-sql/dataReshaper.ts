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
        // Missing periods are added as zero so a trend is evenly spaced. The
        // step follows the data: monthly rows written as dates ("2024-03-01")
        // are filled month by month, never day by day.
        const spineGrain = (plan.dimensions.find(d => d.field === timeCol)?.timeGrain || undefined) as string | undefined;
        reshapedData = fillTimeSpine(reshapedData, timeCol, profile.metricColumns, spineGrain);
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

// ── Time spine ───────────────────────────────────────────────────────

type SpineStep = 'day' | 'week' | 'month' | 'quarter' | 'year';
const MAX_SPINE_POINTS = 400;

/** The step between periods, read from the values themselves. */
export function inferSpineStep(values: string[], grainHint?: string): SpineStep | null {
    if (values.length < 2) return null;
    if (values.every(value => /^\d{4}-\d{2}$/.test(value))) return grainHint === 'quarter' ? 'quarter' : 'month';
    if (!values.every(value => /^\d{4}-\d{2}-\d{2}$/.test(value))) return null;
    if (grainHint && ['day', 'week', 'month', 'quarter', 'year'].includes(grainHint)) return grainHint as SpineStep;
    const dates = values.map(value => new Date(`${value}T00:00:00Z`));
    if (dates.some(date => Number.isNaN(date.getTime()))) return null;
    if (dates.every(date => date.getUTCDate() === 1)) {
        if (dates.every(date => date.getUTCMonth() === 0)) return 'year';
        const quarterly = dates.every(date => date.getUTCMonth() % 3 === 0)
            && dates.slice(1).every((date, i) => {
                const months = (date.getUTCFullYear() - dates[i].getUTCFullYear()) * 12 + date.getUTCMonth() - dates[i].getUTCMonth();
                return months % 3 === 0;
            });
        return quarterly && values.length >= 3 ? 'quarter' : 'month';
    }
    const gaps = dates.slice(1).map((date, i) => Math.round((date.getTime() - dates[i].getTime()) / 86400000));
    if (gaps.every(gap => gap > 0 && gap % 7 === 0)) return 'week';
    return 'day';
}

function nextPeriod(date: Date, step: SpineStep): Date {
    const next = new Date(date.getTime());
    if (step === 'day') next.setUTCDate(next.getUTCDate() + 1);
    else if (step === 'week') next.setUTCDate(next.getUTCDate() + 7);
    else if (step === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
    else if (step === 'quarter') next.setUTCMonth(next.getUTCMonth() + 3);
    else next.setUTCFullYear(next.getUTCFullYear() + 1);
    return next;
}

/**
 * Add zero rows for periods missing between the first and last row, in the
 * same text format as the existing values. Leaves the rows unchanged when the
 * step cannot be read or filling would swamp the real points.
 */
export function fillTimeSpine(rows: any[], timeCol: string, metricColumns: string[], grainHint?: string): any[] {
    if (rows.length < 2) return rows;
    const values = rows.map(row => String(row[timeCol] ?? ''));
    const step = inferSpineStep(values, grainHint);
    if (!step) return rows;
    const monthText = /^\d{4}-\d{2}$/.test(values[0]);
    const toDate = (value: string) => new Date(`${monthText ? `${value}-01` : value}T00:00:00Z`);
    const toText = (date: Date) => monthText ? date.toISOString().slice(0, 7) : date.toISOString().slice(0, 10);

    const filled: any[] = [];
    for (let i = 0; i < rows.length; i++) {
        filled.push(rows[i]);
        if (i === rows.length - 1) continue;
        const end = toDate(values[i + 1]).getTime();
        let current = nextPeriod(toDate(values[i]), step);
        while (current.getTime() < end) {
            if (filled.length > MAX_SPINE_POINTS) return rows;
            const row: any = { [timeCol]: toText(current) };
            for (const column of metricColumns) row[column] = 0;
            filled.push(row);
            current = nextPeriod(current, step);
        }
    }
    return filled.length > Math.max(rows.length * 3, 24) ? rows : filled;
}
