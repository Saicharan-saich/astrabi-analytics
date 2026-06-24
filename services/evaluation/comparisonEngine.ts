// ═══════════════════════════════════════════════════════════════════
// Comparison Engine — Post-Aggregate LAG & Period-over-Period
//
// Extracted from evaluateLocally.ts for architectural clarity.
// Handles three comparison modes:
//   1. previous_period  — LAG(1) within partitioned groups
//   2. same_period_last_n — LAG(N) with configurable offset
//   3. same_period_last_year — Self-join on grain-shifted keys
//
// Also handles non-time dimension comparison (categorical dims)
// by re-running the base plan on a shifted date range.
// ═══════════════════════════════════════════════════════════════════

import type { QueryPlan, Dimension } from '../queryPlan/types';
import { executeQueryPlan } from '../queryPlan';
import type { DateRange } from '../dateHelpers';
import type { DimDateRow } from '../../types';

interface ComparisonParams {
    data: any[];
    plan: QueryPlan;
    planDimKey: string;
    planMetricKey: string;
    comparison: string;
    comparisonGrain?: string;
    comparisonOffset?: number;
    isTimeDim: boolean;
    dateColKey: string;
    dateExtractor: (r: any) => string;
    dates: DateRange;
    allRows: any[];
    dimDate?: DimDateRow[];
}

/**
 * Apply post-aggregate comparison logic to grouped query results.
 * Mutates data rows in-place by adding `previous_value` and `growth_pct` fields.
 */
export function applyComparison(params: ComparisonParams): void {
    const {
        data, plan, planDimKey, planMetricKey,
        comparison, comparisonGrain, comparisonOffset,
        isTimeDim, dateColKey, dateExtractor, dates, allRows, dimDate
    } = params;

    // ═══════════════════════════════════════════════════════════════════
    // TIME-DIMENSION COMPARISON — Windowed LAG on sorted, grouped data
    // ═══════════════════════════════════════════════════════════════════
    if (isTimeDim && data.length > 1) {
        const partDims = plan.dimensions.filter(d => d.type === 'column');

        // Time-aware sort: PARTITION BY categorical dims, ORDER BY time dim
        data.sort((a: any, b: any) => {
            for (const pd of partDims) {
                const aVal = String(a[(pd as any).column] || '');
                const bVal = String(b[(pd as any).column] || '');
                if (aVal < bVal) return -1;
                if (aVal > bVal) return 1;
            }
            const aTime = String(a[planDimKey] || '');
            const bTime = String(b[planDimKey] || '');
            return aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
        });

        // Build partition key for each row
        const partKey = (row: any): string =>
            partDims.map(pd => String(row[(pd as any).column] || '')).join('||');

        if (comparison === 'previous_period') {
            applyLag1(data, planMetricKey, partKey);
        } else if (comparison === 'same_period_last_n') {
            // Convert grain + offset into actual row offset
            // e.g., "1 week ago" with daily data = LAG(7), not LAG(1)
            const actualRowOffset = computeRowOffset(data, planDimKey, comparisonGrain, comparisonOffset || 1);
            applyLagN(data, planMetricKey, partKey, actualRowOffset);
        } else if (comparison === 'same_period_last_year') {
            applySPLY(data, plan, planDimKey, planMetricKey, partKey, dateColKey, allRows, dimDate);
        }

        console.log(`[ComparisonEngine] ${comparison} applied to ${data.length} grouped rows (post-aggregate)`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // NON-TIME DIMENSION COMPARISON (categorical dim, e.g., type/region)
    // Re-run the base plan with shifted date filters, then merge results.
    // ═══════════════════════════════════════════════════════════════════
    if (!isTimeDim) {
        applyNonTimeComparison(data, plan, planDimKey, planMetricKey,
            comparison, comparisonGrain, comparisonOffset,
            dateColKey, dateExtractor, dates, allRows, dimDate);
    }
}

// ── Convert grain + offset into actual row offset ────────────────
// Analyzes the data's time dimension to determine how many rows
// correspond to the requested grain * offset. For example, daily data
// with grain='week' and offset=1 returns 7 rows.
function computeRowOffset(
    data: any[], dimKey: string, grain?: string, offset: number = 1
): number {
    if (!grain || data.length < 2) return offset;

    // Detect the data granularity by looking at the gap between first two sorted rows
    const sortedDates = data
        .map(r => String(r[dimKey] || ''))
        .filter(d => d && d !== '' && d !== '1970-01-01')
        .sort();

    if (sortedDates.length < 2) return offset;

    // Compute the median gap between consecutive data points (in days)
    const gaps: number[] = [];
    for (let i = 1; i < Math.min(sortedDates.length, 20); i++) {
        const d1 = new Date(sortedDates[i - 1]);
        const d2 = new Date(sortedDates[i]);
        if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
            gaps.push(Math.round((d2.getTime() - d1.getTime()) / 86400000));
        }
    }
    if (gaps.length === 0) return offset;

    const medianGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    
    // Convert the requested grain into days
    const grainDays: Record<string, number> = {
        day: 1, week: 7, month: 30, quarter: 91, year: 365,
    };
    const requestedDays = (grainDays[grain] || 1) * offset;

    // How many data rows correspond to the requested time span?
    const rowOffset = Math.max(1, Math.round(requestedDays / Math.max(1, medianGap)));

    console.log(`[ComparisonEngine] computeRowOffset: grain=${grain}, offset=${offset}, medianGap=${medianGap}d, requestedDays=${requestedDays}d → rowOffset=${rowOffset}`);
    return rowOffset;
}

// ── LAG(1): Previous period within partition ─────────────────────
function applyLag1(data: any[], metricKey: string, partKey: (row: any) => string): void {
    let prevPartKey = '';
    let prevValue: number | undefined = undefined;
    for (let i = 0; i < data.length; i++) {
        const pk = partKey(data[i]);
        if (pk !== prevPartKey) {
            prevPartKey = pk;
            prevValue = undefined;
        }
        const curr = Number(data[i][metricKey]) || 0;
        data[i].previous_value = prevValue;
        if (prevValue !== undefined && prevValue !== 0) {
            data[i].growth_pct = ((curr - prevValue) / Math.abs(prevValue)) * 100;
        } else if (prevValue !== undefined) {
            data[i].growth_pct = curr !== 0 ? 100 : 0;
        } else {
            data[i].growth_pct = undefined;
        }
        prevValue = curr;
    }
}

// ── LAG(N): N-offset within partition ────────────────────────────
function applyLagN(data: any[], metricKey: string, partKey: (row: any) => string, offset: number): void {
    const partitionGroups = new Map<string, any[]>();
    for (const row of data) {
        const pk = partKey(row);
        if (!partitionGroups.has(pk)) partitionGroups.set(pk, []);
        partitionGroups.get(pk)!.push(row);
    }
    for (const group of partitionGroups.values()) {
        for (let i = 0; i < group.length; i++) {
            const curr = Number(group[i][metricKey]) || 0;
            const prev = i >= offset ? Number(group[i - offset][metricKey]) || 0 : undefined;
            group[i].previous_value = prev;
            if (prev !== undefined && prev !== 0) {
                group[i].growth_pct = ((curr - prev) / Math.abs(prev)) * 100;
            } else if (prev !== undefined) {
                group[i].growth_pct = curr !== 0 ? 100 : 0;
            } else {
                group[i].growth_pct = undefined;
            }
        }
    }
}

// ── Same Period Last Year: Self-join on shifted grain key ────────
function applySPLY(
    data: any[], plan: QueryPlan,
    dimKey: string, metricKey: string,
    partKey: (row: any) => string,
    dateColKey: string,
    allRows: any[], dimDate?: DimDateRow[]
): void {
    // Re-run base plan WITHOUT time filter to get all periods
    const unfilteredPlan = {
        ...plan, filters: {
            ...plan.filters,
            range: plan.filters.range.filter(f => {
                const fCol = f.column.toLowerCase().replace(/[_\s]+/g, '');
                const dCol = dateColKey.toLowerCase().replace(/[_\s]+/g, '');
                return fCol !== dCol;
            }),
            date: [] // Remove date hierarchy filters too
        }
    };
    const allPeriodsResult = executeQueryPlan(unfilteredPlan, allRows, dimDate);

    // Build lookup map: grainKey|partKey → metric value
    const allPeriodsMap = new Map<string, number>();
    for (const row of allPeriodsResult.data) {
        const gk = String(row[dimKey] || '');
        const pk = partKey(row);
        const mapKey = pk ? `${pk}||${gk}` : gk;
        allPeriodsMap.set(mapKey, Number(row[metricKey]) || 0);
    }

    // Shift grain key by -1 year (handles leap year edge case)
    const shiftKey = (key: string): string => {
        // Day-level grain: YYYY-MM-DD — validate the shifted date exists
        const dayMatch = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (dayMatch) {
            const shiftedYear = parseInt(dayMatch[1]) - 1;
            const month = parseInt(dayMatch[2]);
            const day = parseInt(dayMatch[3]);
            // Check if the shifted date is valid (handles Feb 29 → Feb 28)
            const shiftedDate = new Date(Date.UTC(shiftedYear, month - 1, day));
            if (shiftedDate.getUTCMonth() !== month - 1) {
                // Date overflowed (e.g., Feb 29 → Mar 1) — use last valid day
                const lastDay = new Date(Date.UTC(shiftedYear, month, 0)).getUTCDate();
                return `${shiftedYear}-${dayMatch[2]}-${String(lastDay).padStart(2, '0')}`;
            }
            return `${shiftedYear}-${dayMatch[2]}-${dayMatch[3]}`;
        }
        // Week/month/quarter/year grains: simple year decrement
        const yearMatch = key.match(/^(\d{4})(.*)$/);
        if (yearMatch) {
            return `${parseInt(yearMatch[1]) - 1}${yearMatch[2]}`;
        }
        return key;
    };

    for (const row of data) {
        const gk = String(row[dimKey] || '');
        const pk = partKey(row);
        const shiftedGk = shiftKey(gk);
        const mapKey = pk ? `${pk}||${shiftedGk}` : shiftedGk;
        const prevVal = allPeriodsMap.get(mapKey);
        const curr = Number(row[metricKey]) || 0;
        row.previous_value = prevVal ?? undefined;
        row.previous_label = prevVal !== undefined ? shiftedGk : undefined;
        if (prevVal !== undefined && prevVal !== 0) {
            row.growth_pct = ((curr - prevVal) / Math.abs(prevVal)) * 100;
        } else if (prevVal !== undefined) {
            row.growth_pct = curr !== 0 ? 100 : 0;
        } else {
            row.growth_pct = undefined;
        }
    }
}

// ── Non-time dimension comparison (categorical) ──────────────────
function applyNonTimeComparison(
    data: any[], plan: QueryPlan,
    dimKey: string, metricKey: string,
    comparison: string, comparisonGrain?: string, comparisonOffset?: number,
    dateColKey?: string, dateExtractor?: (r: any) => string,
    dates?: DateRange, allRows?: any[], dimDate?: DimDateRow[]
): void {
    if (!dateExtractor || !dates || !allRows) return;

    // Extract the resolved time filter boundaries from the plan
    let timeFilterStart = '1970-01-01';
    let timeFilterEnd = dates.today;
    const timeRangeFilter = plan.filters.range.find(f => {
        const fCol = f.column.toLowerCase().replace(/[_\s]+/g, '');
        const dCol = (dateColKey || '').toLowerCase().replace(/[_\s]+/g, '');
        return fCol === dCol;
    });
    if (timeRangeFilter) {
        timeFilterStart = timeRangeFilter.start || '1970-01-01';
        timeFilterEnd = timeRangeFilter.end || dates.today;
    }
    // Derive from actual data if no explicit range filter
    if (timeFilterStart === '1970-01-01') {
        let minD = '9999-12-31', maxD = '0000-01-01';
        for (const r of allRows) {
            const d = dateExtractor(r);
            if (d > '1970-01-01' && d < '9999-01-01') {
                if (d < minD) minD = d;
                if (d > maxD) maxD = d;
            }
        }
        if (minD < '9999-12-31') { timeFilterStart = minD; timeFilterEnd = maxD; }
    }

    const startD = new Date(`${timeFilterStart}T00:00:00Z`);
    const endD = new Date(`${timeFilterEnd}T00:00:00Z`);
    const periodMs = endD.getTime() - startD.getTime();
    const periodDays = Math.max(1, Math.round(periodMs / 86400000));

    // Build comparison period boundaries
    let prevStart: string, prevEnd: string;
    if (comparison === 'previous_period') {
        const prevEndD = new Date(startD.getTime() - 86400000);
        const prevStartD = new Date(prevEndD.getTime() - (periodDays - 1) * 86400000);
        prevStart = prevStartD.toISOString().split('T')[0];
        prevEnd = prevEndD.toISOString().split('T')[0];
    } else if (comparison === 'same_period_last_year') {
        const lyStart = new Date(startD);
        lyStart.setUTCFullYear(lyStart.getUTCFullYear() - 1);
        const lyEnd = new Date(endD);
        lyEnd.setUTCFullYear(lyEnd.getUTCFullYear() - 1);
        prevStart = lyStart.toISOString().split('T')[0];
        prevEnd = lyEnd.toISOString().split('T')[0];
    } else {
        // same_period_last_n
        const compGrain2 = comparisonGrain || 'month';
        const compOffset2 = comparisonOffset || 1;
        const asOf = new Date(`${dates.today}T00:00:00Z`);
        const fmt = (d: Date) => d.toISOString().split('T')[0];
        if (compGrain2 === 'day') {
            const end = new Date(asOf); end.setUTCDate(end.getUTCDate() - 1);
            const start = new Date(asOf); start.setUTCDate(start.getUTCDate() - compOffset2);
            prevStart = fmt(start); prevEnd = fmt(end);
        } else if (compGrain2 === 'week') {
            const dow = asOf.getUTCDay();
            const monday = new Date(asOf); monday.setUTCDate(monday.getUTCDate() - ((dow + 6) % 7));
            const end = new Date(monday); end.setUTCDate(end.getUTCDate() - 1);
            const start = new Date(end); start.setUTCDate(start.getUTCDate() - (compOffset2 * 7) + 1);
            prevStart = fmt(start); prevEnd = fmt(end);
        } else if (compGrain2 === 'month') {
            const endD2 = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 0));
            const startD2 = new Date(Date.UTC(endD2.getUTCFullYear(), endD2.getUTCMonth() - (compOffset2 - 1), 1));
            prevStart = fmt(startD2); prevEnd = fmt(endD2);
        } else if (compGrain2 === 'quarter') {
            const curQ = Math.floor(asOf.getUTCMonth() / 3);
            const endD2 = new Date(Date.UTC(asOf.getUTCFullYear(), curQ * 3, 0));
            const startD2 = new Date(Date.UTC(endD2.getUTCFullYear(), endD2.getUTCMonth() + 1 - (compOffset2 * 3), 1));
            prevStart = fmt(startD2); prevEnd = fmt(endD2);
        } else {
            const endD2 = new Date(Date.UTC(asOf.getUTCFullYear() - 1, 11, 31));
            const startD2 = new Date(Date.UTC(asOf.getUTCFullYear() - compOffset2, 0, 1));
            prevStart = fmt(startD2); prevEnd = fmt(endD2);
        }
    }

    // Filter raw rows for the comparison period and re-aggregate
    const prevRows = allRows.filter(r => {
        const d = dateExtractor(r);
        return d >= prevStart && d <= prevEnd;
    });

    // Re-run the base plan on comparison-period rows
    // CRITICAL: Strip date filters from plan — the prevRows are already date-filtered,
    // and the original plan's date range (e.g., 2017-10-01 to 2017-12-30) would
    // exclude the comparison-period rows (e.g., 2016-10-01 to 2016-12-30).
    const compPlan = {
        ...plan,
        filters: {
            ...plan.filters,
            range: plan.filters.range.filter(f => {
                // Prefer the explicit _isTimeFilter tag set by buildQueryPlan
                if ((f as any)._isTimeFilter) return false;
                // Fallback: fuzzy column name match for plans built without the tag
                const fCol = f.column.toLowerCase().replace(/[_\s]+/g, '');
                const dCol = (dateColKey || '').toLowerCase().replace(/[_\s]+/g, '');
                return fCol !== dCol;
            }),
            date: (plan.filters.date || []).filter((f: any) => {
                const fCol = (f.column || '').toLowerCase().replace(/[_\s]+/g, '');
                const dCol = (dateColKey || '').toLowerCase().replace(/[_\s]+/g, '');
                return fCol !== dCol;
            }),
        }
    };
    const compResult = executeQueryPlan(compPlan, prevRows, dimDate);
    const compMap = new Map<string, number>();
    for (const row of compResult.data) {
        const key = String(row[dimKey] || '');
        compMap.set(key, Number(row[metricKey]) || 0);
    }

    // Merge comparison data into current result
    for (const row of data) {
        const key = String(row[dimKey] || '');
        const prevVal = compMap.get(key);
        const curr = Number(row[metricKey]) || 0;
        row.previous_value = prevVal ?? undefined;
        if (prevVal !== undefined && prevVal !== 0) {
            row.growth_pct = ((curr - prevVal) / Math.abs(prevVal)) * 100;
        } else if (prevVal !== undefined) {
            row.growth_pct = curr !== 0 ? 100 : 0;
        } else {
            row.growth_pct = undefined;
        }
    }

    const dimCol = plan.dimensions.find(d => d.type === 'column');
    console.log(`[ComparisonEngine] ${comparison} applied on non-time dim (${dimCol ? (dimCol as any).column : '?'}): ${data.length} rows, prevRange=${prevStart} → ${prevEnd}, matched=${compMap.size}`);
}
