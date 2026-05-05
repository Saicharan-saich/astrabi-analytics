import { CanonicalMapping, Dataset, DimDateRow, QuestionTemplate, QueryConfig } from "../types";
import { buildQueryPlan, compileSQL, compileEnrichedSQL, executeQueryPlan, validatePlan, dimensionId } from './queryPlan';
import type { EnrichedQuery, ComparisonConfig, TableCalculation } from './queryPlan';
import { DateRange, pad, getISOWeek } from './dateHelpers';
import { applyComparison } from './evaluation/comparisonEngine';
import { executeViaDuckDB, isDuckDBReady, type DuckDBResult } from './duckdbEngine';

// ── DuckDB Verification Cache (async, non-blocking) ──────────────
// Since evaluateLocally is synchronous, DuckDB execution runs in the
// background. The UI polls this cache to display verification badges.
let _lastDuckDBVerification: {
    sql: string;
    result: DuckDBResult | null;
    pending: boolean;
    timestamp: number;
} = { sql: '', result: null, pending: false, timestamp: 0 };

export function getLastDuckDBVerification() { return _lastDuckDBVerification; }

// --- VALIDATION & SAFETY LAYERS ---
export const validateRequirements = (q: QuestionTemplate, mapping: CanonicalMapping): { valid: boolean; error?: string } => {
    const missing = q.req.filter(role => !mapping.fields[role]);
    if (missing.length > 0) {
        return {
            valid: false,
            error: `Missing columns: ${missing.join(', ')}`
        };
    }
    return { valid: true };
};

export const validateGrainSafety = (q: QuestionTemplate, dataset: Dataset, mapping: CanonicalMapping): { safe: boolean; error?: string } => {
    // Validate that the dataset has enough data for the requested grain
    if (!dataset || !dataset.rows || dataset.rows.length === 0) {
        return { safe: false, error: 'Dataset is empty â€” cannot analyze.' };
    }

    // Check grain compatibility
    const grain = q.grain;
    const rowCount = dataset.rows.length;

    // Daily grain with very few rows is suspicious
    if (grain === 'day' && rowCount < 7) {
        return { safe: false, error: `Daily grain requires at least 7 data points, but dataset only has ${rowCount} rows.` };
    }

    // Weekly grain with < 4 rows
    if (grain === 'week' && rowCount < 4) {
        return { safe: false, error: `Weekly grain requires at least 4 data points.` };
    }

    // If the question requires specific columns, verify they have enough distinct values
    if (grain === 'customer' && mapping.fields['customer_id']) {
        const col = mapping.fields['customer_id'];
        const sample = new Set(dataset.rows.slice(0, 1000).map(r => r[col]));
        if (sample.size < 2) {
            return { safe: false, error: 'Customer grain requires at least 2 distinct customers.' };
        }
    }

    return { safe: true };
};

// --- LOCAL EVALUATION ENGINE ---
export const evaluateLocally = (dq: QuestionTemplate, rows: any[], mapping: CanonicalMapping, dates: DateRange, query: QueryConfig, datasetName?: string, dimDate?: DimDateRow[]): any => {
    // â”€â”€ DEFENSIVE GUARD: Normalize comparison â”€â”€
    // Strip invalid/stale comparison values so the comparison blocks never fire accidentally.
    const validComparisons = ['previous_period', 'same_period_last_year', 'same_period_last_n'];
    if ((query as any).comparison && !validComparisons.includes((query as any).comparison)) {
        console.log(`[evaluateLocally] STRIPPING invalid comparison value: "${(query as any).comparison}"`);
        (query as any).comparison = undefined;
        (query as any).comparisonGrain = undefined;
        (query as any).comparisonOffset = undefined;
    }
    if (!(query as any).comparison) {
        (query as any).comparison = undefined; // Normalize falsy ("", null, false) to undefined
    }
    console.log(`[evaluateLocally] comparison=${(query as any).comparison}`);

    const cols = mapping.fields;
    // --- OPTIMIZED HELPERS ---
    // Pre-calculate column keys once
    const sampleRow = rows.length > 0 ? rows[0] : {};
    const dateColKey = cols['order_date'] || Object.keys(sampleRow).find(k => k.toLowerCase().includes('date') && !k.toLowerCase().includes('updated')) || 'order_date';

    // Memoize column lookups for other roles if needed, though they usually use direct mapping
    const val = (r: any, role: string) => { const k = cols[role]; return k ? (Number(String(r[k] || 0).replace(/[$,]/g, '')) || 0) : 0; };
    const str = (r: any, role: string) => { const k = cols[role]; return k ? String(r[k] || 'Unknown') : 'Unknown'; };

    // Optimized Date Extractor (No per-row generic lookup)
    const date = (r: any) => {
        // Use pre-determined key
        let raw = String(r[dateColKey]);
        if (!raw || raw === 'undefined' || raw === 'null') return '1970-01-01';

        // Fast path for ISO
        if (raw.length === 10 && raw[4] === '-') return raw;

        // Handle YYYY-MM-DD start
        if (raw.match(/^\d{4}-\d{2}-\d{2}/)) {
            return raw.split('T')[0];
        }

        // Handle MM/DD/YYYY or M/D/YYYY
        if (raw.indexOf('/') > -1) {
            const parts = raw.split('/');
            if (parts.length === 3) {
                const m = parts[0].padStart(2, '0');
                const d = parts[1].padStart(2, '0');
                const y = parts[2].split(' ')[0];
                return `${y}-${m}-${d}`;
            }
        }

        // Fallback: try Date parse
        const d = new Date(raw);
        if (!isNaN(d.getTime())) {
            return d.toISOString().split('T')[0];
        }

        return '1970-01-01';
    };

    // --- GENERIC DATE HELPERS ---
    const isToday = (r: any) => date(r) === dates.today;
    const isYesterday = (r: any) => date(r) === dates.yesterday;
    const isThisWeek = (r: any) => date(r) >= dates.monday && date(r) <= dates.today;
    const isLastWeek = (r: any) => date(r) >= dates.last_week_monday && date(r) < dates.monday;
    const isThisMonth = (r: any) => date(r) >= dates.this_month_start && date(r) <= dates.today;
    const isLastMonth = (r: any) => date(r) >= dates.last_month_start && date(r) < dates.this_month_start;
    const isThisQuarter = (r: any) => date(r) >= dates.this_quarter_start && date(r) <= dates.today;
    const isLastQuarter = (r: any) => date(r) >= dates.last_quarter_start && date(r) <= dates.last_quarter_end;
    const isYTD = (r: any) => date(r) >= dates.year_start && date(r) <= dates.today;
    const isLastYearYTD = (r: any) => date(r) >= dates.last_year_start && date(r) <= dates.last_year_today;
    // Prior Year same period helpers (for time intelligence)
    const isPYMonth = (r: any) => date(r) >= dates.py_month_start && date(r) <= dates.py_month_end;
    const isPYQuarter = (r: any) => date(r) >= dates.py_quarter_start && date(r) <= dates.py_quarter_end;

    let data: any[] = [];
    let kpi = undefined;
    let growth: { diff: number; pct: number; } | undefined = undefined;
    let sql = '';

    try {
        if (dq.id === 'custom_builder') {
            // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
            // QUERYPLAN-BASED EXECUTION â€” Single Source of Truth
            // The QueryPlan AST drives both the JS engine and SQL output.
            // Comparison logic is applied as post-processing on the result.
            // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

            const metricCol = query.metric;
            const dimCol = query.dimension;
            const timeGrains = ['day', 'week', 'month', 'quarter', 'year'];
            const isTimeDim = dimCol && timeGrains.includes(dimCol);

            // 1. BUILD QUERY PLAN from UI config
            const plan = buildQueryPlan(
                {
                    metric: query.metric,
                    aggregation: query.aggregation,
                    dimension: query.dimension,
                    timeFilter: query.timeFilter,
                    filters: query.filters as Record<string, string[]>,
                    measureFilters: query.measureFilters,
                    dateFilters: query.dateFilters,
                    sort: query.sort,
                    limit: query.limit,
                    secondaryMetrics: query.secondaryMetrics,
                    secondaryMetricAggregations: query.secondaryMetricAggregations,
                    secondaryDimensions: query.secondaryDimensions,
                },
                dateColKey,
                dates,
                datasetName || 'dataset'
            );

            // 2. VALIDATE PLAN
            const validation = validatePlan(plan);
            if (validation.warnings.length > 0) {
                console.warn(`[QueryPlan] Validation warnings:`, validation.warnings);
            }

            // 3. EXECUTE QUERY PLAN (WHERE → GROUP → AGG → HAVING → ORDER → LIMIT)
            const result = executeQueryPlan(plan, rows, dimDate);

            // 4. BUILD ENRICHED QUERY and COMPILE SQL
            // The enriched query wraps the base plan with comparison + table calc config.
            // compileEnrichedSQL produces CTEs + window functions that match JS logic.
            const enrichedComparison: ComparisonConfig | undefined = query.comparison ? {
                type: query.comparison as 'previous_period' | 'same_period_last_year' | 'same_period_last_n',
                offset: query.comparisonOffset,
                grain: query.comparisonGrain,
            } : undefined;

            // Map UI table calculation names → queryPlan TableCalculation type
            const uiToSqlCalcMap: Record<string, import('./queryPlan').TableCalculation> = {
                'percent_of_total': 'pct_of_total',
                'rank_desc': 'rank',
                'rank_asc': 'rank',
                'running_total': 'running_total',
                'moving_avg': 'moving_avg',
                'pct_diff_from_prev': 'pct_change',
                'diff_from_prev': 'difference',
            };
            const uiCalcs: string[] = (query.tableCalculations || []).filter((c: string) => c !== 'none');
            const enrichedCalcs: import('./queryPlan').TableCalculation[] = uiCalcs
                .map(c => uiToSqlCalcMap[c])
                .filter((c): c is import('./queryPlan').TableCalculation => !!c);

            // Base enriched query (comparison only, no table calcs) → base SQL
            const baseEnriched: EnrichedQuery = {
                basePlan: plan,
                comparison: enrichedComparison,
            };
            const sql = compileEnrichedSQL(baseEnriched);

            // ─── DuckDB-WASM Verification (fire-and-forget, non-blocking) ───
            // Execute the same SQL against DuckDB-WASM in the background to
            // verify SQL parity with the JS engine. Results are stored in
            // _lastDuckDBVerification so the UI can display a "Verified" badge.
            _lastDuckDBVerification = { sql, result: null, pending: true, timestamp: Date.now() };
            executeViaDuckDB(sql, datasetName || 'dataset', rows)
                .then(duckRes => {
                    _lastDuckDBVerification = {
                        sql,
                        result: duckRes,
                        pending: false,
                        timestamp: Date.now(),
                    };
                    if (duckRes.success) {
                        console.log(`[QueryPlan] DuckDB verification: ${duckRes.rowCount} rows in ${duckRes.executionTimeMs}ms ✓`);
                    } else {
                        console.warn(`[QueryPlan] DuckDB execution failed (non-fatal): ${duckRes.error}`);
                    }
                })
                .catch(err => {
                    _lastDuckDBVerification = { sql, result: null, pending: false, timestamp: Date.now() };
                    console.warn(`[QueryPlan] DuckDB unavailable (non-fatal):`, err);
                });

            // Calculated enriched query (comparison + table calcs) → calculatedSql
            let calculatedSql: string | undefined;
            if (enrichedCalcs.length > 0) {
                const calcEnriched: EnrichedQuery = {
                    basePlan: plan,
                    comparison: enrichedComparison,
                    calculations: enrichedCalcs,
                    movingAvgWindow: 3,
                };
                calculatedSql = compileEnrichedSQL(calcEnriched);
            }

            // Bridge variables: map plan aliases back to names used by comparison code
            const planDimKey = result.xKey;            // dimension output key (alias or column name)
            const planMetricKey = result.yKey;         // primary metric alias
            const secMetrics = result.secondaryYKeys || [];

            // Use the executed data (already sorted and limited by the plan engine)
            data = result.data;

            // ═══════════════════════════════════════════════════════════════════
            // POST-AGGREGATE COMPARISON — Delegated to comparisonEngine module
            // Handles: previous_period, same_period_last_n, same_period_last_year
            // Works for both time and non-time (categorical) dimensions.
            // ═══════════════════════════════════════════════════════════════════
            if (query.comparison) {
                applyComparison({
                    data,
                    plan,
                    planDimKey,
                    planMetricKey,
                    comparison: query.comparison,
                    comparisonGrain: query.comparisonGrain,
                    comparisonOffset: query.comparisonOffset,
                    isTimeDim: !!isTimeDim,
                    dateColKey,
                    dateExtractor: date,
                    dates,
                    allRows: rows,
                    dimDate,
                });
            }

            // ─── Auto-axis detection for multi-metric ───
            let detectedAxisMode: 'single' | 'dual' | 'blended' = 'single';
            if (secMetrics.length > 0 && data.length > 0) {
                const primaryMax = Math.max(...data.map((d: any) => Math.abs(d[planMetricKey] || 0)));
                const secondaryMaxes = secMetrics.map(sm => Math.max(...data.map((d: any) => Math.abs(d[sm] || 0))));
                const overallSecMax = Math.max(...secondaryMaxes);
                const ratio = primaryMax > 0 && overallSecMax > 0
                    ? Math.max(primaryMax / overallSecMax, overallSecMax / primaryMax)
                    : 1;
                detectedAxisMode = ratio > 5 ? 'dual' : 'blended';
            }
            const userAxisMode = query.axisMode;
            const finalAxisMode = userAxisMode && userAxisMode !== 'auto' ? userAxisMode as 'single' | 'dual' | 'blended' : detectedAxisMode;

            const allMetricNames = [metricCol, ...(query.secondaryMetrics || [])];
            const yLabelStr = (query.secondaryMetrics || []).length > 0
                ? `${allMetricNames.join(' & ')} by ${dimCol || 'Total'}`
                : `${metricCol} by ${dimCol || 'Total'}`;

            return {
                data, xKey: planDimKey || 'metric', yKey: planMetricKey,
                yLabel: yLabelStr, sql,
                ...(calculatedSql ? { calculatedSql } : {}),
                ...(secMetrics.length > 0 ? { secondaryYKeys: secMetrics, axisMode: finalAxisMode } : {})
            };

        } else {
            // --- DETERMINISTIC LOGIC ---

            // â”€â”€ USER OVERRIDE: METRIC â”€â”€
            // If the customizer changed the metric, override the question's default
            let metricName = 'revenue';
            if (query.metric && query.metric !== '' && dq.id !== 'custom_builder') {
                // User explicitly chose a metric in the customizer â€” try to find its canonical role
                const userMetricLower = query.metric.toLowerCase();
                const metricRoles = ['revenue', 'quantity', 'order_id', 'customer_id', 'discount', 'profit', 'sales', 'cost', 'price'];
                const matchedRole = metricRoles.find(role => {
                    const colName = cols[role];
                    return colName && colName.toLowerCase() === userMetricLower;
                });
                if (matchedRole) {
                    metricName = matchedRole;
                } else {
                    // Non-canonical metric: register the raw column name directly
                    // so that val() can look it up via cols[metricName]
                    metricName = query.metric;
                    if (!cols[metricName]) {
                        cols[metricName] = query.metric; // self-referencing registration
                    }
                }
            } else {
                // Default: infer from question definition
                if (dq.req.includes('quantity')) metricName = 'quantity';
                if (dq.id.includes('orders') || dq.req.includes('order_id')) metricName = 'order_id';
                if (dq.id.includes('cust') || dq.req.includes('customer_id')) metricName = 'customer_id';
            }

            // Helper for Aggregation
            const aggregate = (dataset: any[]) => {
                if (metricName === 'order_id' || metricName === 'customer_id') {
                    const unique = new Set(dataset.map(r => str(r, metricName)));
                    return unique.size;
                }
                return dataset.reduce((a, r) => a + val(r, metricName), 0);
            };

            // â”€â”€ CENTRALIZED DIMENSION RESOLVER â”€â”€
            // User's Group By override takes priority over question default
            const timeGrains = ['day', 'week', 'month', 'quarter', 'year'];
            const userDimOverride = query.dimension && query.dimension !== '' && !timeGrains.includes(query.dimension) ? query.dimension : null;
            const defaultDimRole = dq.req.find(r => r !== 'revenue' && r !== 'quantity' && r !== 'order_id' && r !== 'order_date' && r !== 'customer_id') || 'product_name';
            const resolvedDim = userDimOverride || defaultDimRole;
            const isUserDimOverride = !!userDimOverride;

            // Helper to access a dimension value from a row â€” handles both canonical roles and direct column names
            const dimAccessor = (r: any): string => {
                if (isUserDimOverride) {
                    // Direct column access for user-chosen dimensions
                    return String(r[resolvedDim] || 'Unknown');
                }
                return str(r, resolvedDim);
            };

            // â”€â”€ UNIVERSAL TIME FILTER OVERRIDE â”€â”€
            // When the user customizes the time period in the QuestionCustomizer,
            // query.timeFilter contains their choice. We pre-filter rows so ALL
            // downstream eval branches (ranking, comparison, trend, KPI, etc.)
            // automatically use the user's chosen time window.
            const hasTimeOverride = query.timeFilter && query.timeFilter !== '';
            const allOrigRows = [...rows]; // Save pre-filter snapshot for previous period lookups
            if (hasTimeOverride) {
                const today = new Date(`${dates.today}T00:00:00Z`);
                const formatDate = (d: Date) => d.toISOString().split('T')[0];
                const lastNMatch = query.timeFilter!.match(/^last_(\d+)_(c?[a-z]+)$/);

                let startStr = '1970-01-01';
                let endStr = dates.today;

                if (query.timeFilter === 'all_time') {
                    // All Time = use all rows, no additional filtering needed
                    // startStr stays '1970-01-01', endStr stays today
                } else if (query.timeFilter === 'today') {
                    startStr = dates.today;
                    endStr = dates.today;
                } else if (query.timeFilter === 'yesterday') {
                    startStr = dates.yesterday;
                    endStr = dates.yesterday;
                } else if (query.timeFilter === 'this_week') {
                    startStr = dates.monday;
                } else if (query.timeFilter === 'last_7_days') {
                    startStr = dates.last_7_days || formatDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 7)));
                } else if (query.timeFilter === 'this_month') {
                    startStr = dates.this_month_start;
                } else if (query.timeFilter === 'last_30_days') {
                    startStr = dates.last_30_days || formatDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 30)));
                } else if (query.timeFilter === 'last_90_days') {
                    const d = new Date(today);
                    d.setUTCDate(d.getUTCDate() - 90);
                    startStr = formatDate(d);
                } else if (query.timeFilter === 'this_quarter') {
                    const qMonth = Math.floor(today.getUTCMonth() / 3) * 3;
                    const d = new Date(Date.UTC(today.getUTCFullYear(), qMonth, 1));
                    startStr = formatDate(d);
                } else if (query.timeFilter === 'this_year') {
                    startStr = dates.year_start;
                } else if (query.timeFilter === 'last_year') {
                    startStr = dates.last_year_start;
                    endStr = formatDate(new Date(Date.UTC(today.getUTCFullYear() - 1, 11, 31)));
                } else if (lastNMatch) {
                    const n = parseInt(lastNMatch[1], 10);
                    const unit = lastNMatch[2];
                    if (unit === 'cyears') {
                        // CALENDAR YEAR MODE: "Last 1 Calendar Year" = previous full calendar year
                        // e.g. if As-Of = 2017-12-30, Last 1 = 2016-01-01 to 2016-12-31
                        //                              Last 2 = 2015-01-01 to 2016-12-31
                        const asOfYear = today.getUTCFullYear();
                        startStr = formatDate(new Date(Date.UTC(asOfYear - n, 0, 1)));
                        endStr = formatDate(new Date(Date.UTC(asOfYear - 1, 11, 31)));
                    } else {
                        // TRAILING MODE (default): rolling window from As-Of date
                        const targetDate = new Date(today);
                        if (unit === 'days') targetDate.setUTCDate(today.getUTCDate() - n);
                        else if (unit === 'weeks') targetDate.setUTCDate(today.getUTCDate() - (n * 7));
                        else if (unit === 'months') targetDate.setUTCMonth(today.getUTCMonth() - n);
                        else if (unit === 'years') targetDate.setUTCFullYear(today.getUTCFullYear() - n);
                        startStr = formatDate(targetDate);
                    }
                }

                console.log(`[Engine] deterministic time filter: ${query.timeFilter} â†’ range [${startStr}, ${endStr}], rows before: ${rows.length}`);
                rows = rows.filter(r => {
                    const dStr = date(r);
                    return dStr >= startStr && dStr <= endStr;
                });
                console.log(`[Engine] rows after time filter: ${rows.length}`);
            }

            // â”€â”€ USER OVERRIDE: PERIOD SCOPE (WTD / MTD / QTD / YTD) â”€â”€
            // When both timeFilter AND periodScope are active, we need to compute
            // the period scope relative to the SHIFTED reference date (start of time range).
            // E.g., "Last 1 Year" shifts reference from 2017-12-30 â†’ 2016-12-30,
            // so MTD becomes Dec 2016 (2016-12-01 to 2016-12-30).
            const periodScope = (query as any).periodScope;
            if (periodScope) {
                const beforePS = rows.length;

                if (hasTimeOverride) {
                    // Compute the shifted reference date from the time filter
                    const today = new Date(`${dates.today}T00:00:00Z`);
                    const fmt = (d: Date) => d.toISOString().split('T')[0];
                    const tf = query.timeFilter!;
                    const lastNMatch = tf.match(/^last_(\d+)_(c?[a-z]+)$/);

                    let shiftedRef: Date;
                    if (lastNMatch) {
                        const n = parseInt(lastNMatch[1], 10);
                        const unit = lastNMatch[2];
                        shiftedRef = new Date(today);
                        if (unit === 'cyears') {
                            // Calendar year: go to Dec 31 of (year - n)'s year
                            shiftedRef = new Date(Date.UTC(today.getUTCFullYear() - n, today.getUTCMonth(), today.getUTCDate()));
                        } else if (unit === 'days') shiftedRef.setUTCDate(today.getUTCDate() - n);
                        else if (unit === 'weeks') shiftedRef.setUTCDate(today.getUTCDate() - (n * 7));
                        else if (unit === 'months') shiftedRef.setUTCMonth(today.getUTCMonth() - n);
                        else if (unit === 'years') shiftedRef.setUTCFullYear(today.getUTCFullYear() - n);
                    } else {
                        // For non-lastN time filters, use the current as-of date
                        shiftedRef = today;
                    }

                    // Compute period boundaries relative to shiftedRef
                    const sMonday = new Date(shiftedRef);
                    const dow = sMonday.getUTCDay() || 7;
                    sMonday.setUTCDate(sMonday.getUTCDate() - (dow - 1));

                    const sMonthStart = new Date(Date.UTC(shiftedRef.getUTCFullYear(), shiftedRef.getUTCMonth(), 1));
                    const sQuarterMonth = Math.floor(shiftedRef.getUTCMonth() / 3) * 3;
                    const sQuarterStart = new Date(Date.UTC(shiftedRef.getUTCFullYear(), sQuarterMonth, 1));
                    const sYearStart = new Date(Date.UTC(shiftedRef.getUTCFullYear(), 0, 1));
                    const sRefStr = fmt(shiftedRef);

                    console.log(`[Engine] periodScope ${periodScope} with shifted ref: ${sRefStr}`);

                    if (periodScope === 'WTD') {
                        rows = rows.filter(r => date(r) >= fmt(sMonday) && date(r) <= sRefStr);
                    } else if (periodScope === 'MTD') {
                        rows = rows.filter(r => date(r) >= fmt(sMonthStart) && date(r) <= sRefStr);
                    } else if (periodScope === 'QTD') {
                        rows = rows.filter(r => date(r) >= fmt(sQuarterStart) && date(r) <= sRefStr);
                    } else if (periodScope === 'YTD') {
                        rows = rows.filter(r => date(r) >= fmt(sYearStart) && date(r) <= sRefStr);
                    }
                } else {
                    // No time override â€” use current as-of date boundaries
                    if (periodScope === 'WTD') {
                        rows = rows.filter(r => date(r) >= dates.monday && date(r) <= dates.today);
                    } else if (periodScope === 'MTD') {
                        rows = rows.filter(r => date(r) >= dates.this_month_start && date(r) <= dates.today);
                    } else if (periodScope === 'QTD') {
                        rows = rows.filter(r => date(r) >= dates.this_quarter_start && date(r) <= dates.today);
                    } else if (periodScope === 'YTD') {
                        rows = rows.filter(r => date(r) >= dates.year_start && date(r) <= dates.today);
                    }
                }
                console.log(`[Engine] periodScope ${periodScope}: rows ${beforePS} â†’ ${rows.length}`);
            }

            // â”€â”€ USER OVERRIDE: DIMENSION FILTERS â”€â”€
            // Apply any dimension filters from the customizer
            if (query.filters && Object.keys(query.filters).length > 0) {
                const sampleRow = rows[0] || {};
                Object.entries(query.filters).forEach(([col, allowedValues]) => {
                    if (!allowedValues || (allowedValues as string[]).length === 0) return;
                    // Robust key lookup (handle case mismatches)
                    let effectiveCol = col;
                    if (rows.length > 0 && !(col in rows[0])) {
                        const keys = Object.keys(rows[0]);
                        const normalize = (s: string) => s.toLowerCase().replace(/[_\s]+/g, '');
                        const target = normalize(col);
                        const match = keys.find(k => normalize(k) === target);
                        if (match) effectiveCol = match;
                    }
                    const valSet = new Set((allowedValues as string[]).map(v => String(v).toLowerCase()));
                    rows = rows.filter(r => valSet.has(String(r[effectiveCol] || '').toLowerCase()));
                });
            }

            // â”€â”€ USER OVERRIDE: DATE FILTERS (Hierarchy + Range) â”€â”€
            if (query.dateFilters && (query.dateFilters as any[]).length > 0) {
                (query.dateFilters as any[]).forEach((df: any) => {
                    if (!df.values || df.values.length === 0) return;

                    // Range mode: value contains "start__end"
                    if (df.values.length === 1 && df.values[0].includes('__')) {
                        const [rangeStart, rangeEnd] = df.values[0].split('__');
                        rows = rows.filter(r => {
                            const d = date(r);
                            return d >= rangeStart && d <= rangeEnd;
                        });
                        return;
                    }

                    // Hierarchy mode
                    const valSet = new Set(df.values);
                    rows = rows.filter(r => {
                        const d = date(r);
                        if (df.timeGrain === 'year') return valSet.has(d.substring(0, 4));
                        if (df.timeGrain === 'quarter') {
                            const parts = d.split('-').map(Number);
                            const q = Math.ceil(parts[1] / 3);
                            return valSet.has(`${parts[0]}-Q${q}`);
                        }
                        if (df.timeGrain === 'month') return valSet.has(d.substring(0, 7));
                        if (df.timeGrain === 'day') return valSet.has(d);
                        return true;
                    });
                });
            }
            // â”€â”€ EVAL-TYPE ROUTING â”€â”€
            // Questions with explicit evalType use that to determine the logic branch
            // This lets new categories (diagnostics, growth, etc.) reuse existing patterns
            const evalType = dq.evalType;
            const useRanking = evalType === 'ranking' || (!evalType && (dq.id.includes('top') || dq.id.includes('best')));
            const useComparison = evalType === 'comparison' || (!evalType && dq.id.includes('_vs_'));
            const useMovingAvgOrRunning = evalType === 'movingAvg' || evalType === 'runningTotal' || (!evalType && (dq.id.includes('_ma_') || dq.id.includes('_run_')));
            const usePctOrGrowth = evalType === 'percentOfTotal' || (!evalType && (dq.id.includes('_pct_') || dq.id.includes('_growth_')));
            const useTrend = evalType === 'trend' || (!evalType && (dq.id.includes('trend') || dq.id === 'rev_30d'));
            const useAov = !evalType && dq.id.endsWith('_aov');
            const useOperational = !evalType && dq.id.startsWith('op_');
            const useKpi = evalType === 'kpi';

            // 1. TOP N / RANKING
            if (useRanking) {
                let dim = resolvedDim;

                // â”€â”€ PREFER NAME COLUMNS OVER IDs (only when using default dimension) â”€â”€
                if (!isUserDimOverride) {
                    const dimCol = cols[dim];
                    if (dimCol) {
                        const lowerDimCol = dimCol.toLowerCase();
                        if (lowerDimCol.endsWith('_id') || lowerDimCol.endsWith(' id') || lowerDimCol === 'id') {
                            const entityBase = lowerDimCol.replace(/_?id$/i, '').replace(/ ?id$/i, '');
                            const allColNames = Object.keys(rows[0] || {});
                            const nameCol = allColNames.find(c => {
                                const lc = c.toLowerCase();
                                return (lc.includes(entityBase) && (lc.includes('name') || lc.includes('title') || lc.includes('label'))) ||
                                    (lc === entityBase && !lc.endsWith('id'));
                            });
                            if (nameCol) {
                                cols[dim] = nameCol;
                            }
                        }
                    }
                }

                let subset = rows;
                if (hasTimeOverride) {
                    subset = rows; // Already pre-filtered
                } else if (dq.id.includes('today')) subset = rows.filter(isToday);
                else if (dq.id.includes('week')) subset = rows.filter(isThisWeek);
                else if (dq.id.includes('month') || dq.id.startsWith('m_')) subset = rows.filter(isThisMonth);
                else if (dq.id.includes('quarter') || dq.id.startsWith('q_')) subset = rows.filter(isThisQuarter);

                const groups: any = {};
                subset.forEach(r => {
                    const k = dimAccessor(r);
                    groups[k] = (groups[k] || 0) + val(r, metricName);
                });

                // Extract limit from query override, question text, or ID (e.g., "Top 5", "top_5")
                const overrideLimit = query.limit;
                const limitMatch = dq.question.match(/(?:Top|Bottom)\s+(\d+)/i) || dq.id.match(/(?:top|bottom)_(\d+)/i);
                const limit = (overrideLimit && overrideLimit > 0) ? overrideLimit : (limitMatch ? parseInt(limitMatch[1]) : 10);

                // Support Bottom N via sort override OR auto-detect from question intent
                const isBottomN = dq.id.includes('worst') || dq.id.includes('bottom') ||
                    dq.id.includes('lowest') || dq.id.includes('least') ||
                    /\b(worst|bottom|lowest|least|weakest|poorest)\b/i.test(dq.question);
                const sortDir = query.sort || (isBottomN ? 'asc' : 'desc');
                const sorted = Object.entries(groups).map(([x, value]) => ({ x, value }));
                if (sortDir === 'asc') {
                    sorted.sort((a: any, b: any) => a.value - b.value);
                } else {
                    sorted.sort((a: any, b: any) => b.value - a.value);
                }
                data = sorted.slice(0, limit);
            }
            // 2. COMPARISONS (VS)
            else if (useComparison) {
                let currSet: any[] = [], prevSet: any[] = [], currLabel = '', prevLabel = '';

                // If the user has overridden the time filter (e.g., "This Week" on a daily question),
                // use the time-filtered rows as the current period and compute the previous period
                // based on the filter's date range. This ensures the user's time selection is respected.
                const timeGrains = ['day', 'week', 'month', 'quarter', 'year'];
                const trendDim = query.dimension;
                const isTrendMode = trendDim && timeGrains.includes(trendDim);

                if (hasTimeOverride && query.timeFilter && query.timeFilter !== 'all_time') {
                    // rows are already pre-filtered to the user's time selection
                    currSet = rows;
                    currLabel = 'Current Period';

                    // Compute the previous period of the same length
                    const usableDates = rows.map((r: any) => date(r)).filter((d: string) => d && d !== '1970-01-01').sort();
                    const minDate = usableDates[0] || '';
                    const maxDate = usableDates[usableDates.length - 1] || '';

                    if (minDate && maxDate) {
                        const spanMs = new Date(maxDate).getTime() - new Date(minDate).getTime();
                        const spanDays = Math.round(spanMs / 86400000) + 1;
                        const prevEnd = new Date(new Date(minDate).getTime() - 86400000);
                        const prevStart = new Date(prevEnd.getTime() - (spanDays - 1) * 86400000);
                        const prevStartStr = prevStart.toISOString().split('T')[0];
                        const prevEndStr = prevEnd.toISOString().split('T')[0];

                        // Get previous period rows from the ORIGINAL unfiltered dataset
                        const origRows = allOrigRows;
                        prevSet = origRows.filter((r: any) => {
                            const d = date(r);
                            return d >= prevStartStr && d <= prevEndStr;
                        });
                        prevLabel = 'Previous Period';
                    }
                } else {
                    // Default comparison logic â€” use question ID prefix to decide periods
                    if (dq.id.startsWith('d_')) { currSet = rows.filter(isToday); prevSet = rows.filter(isYesterday); currLabel = 'Today'; prevLabel = 'Yesterday'; }
                    else if (dq.id.startsWith('w_')) { currSet = rows.filter(isThisWeek); prevSet = rows.filter(isLastWeek); currLabel = 'This Week'; prevLabel = 'Last Week'; }
                    else if (dq.id.startsWith('m_')) {
                        if (dq.id.includes('_py_')) { currSet = rows.filter(isThisMonth); prevSet = rows.filter(isPYMonth); currLabel = 'MTD'; prevLabel = 'PY MTD'; }
                        else { currSet = rows.filter(isThisMonth); prevSet = rows.filter(isLastMonth); currLabel = 'This Month'; prevLabel = 'Last Month'; }
                    }
                    else if (dq.id.startsWith('q_')) {
                        if (dq.id.includes('_py_')) { currSet = rows.filter(isThisQuarter); prevSet = rows.filter(isPYQuarter); currLabel = 'QTD'; prevLabel = 'PY QTD'; }
                        else { currSet = rows.filter(isThisQuarter); prevSet = rows.filter(isLastQuarter); currLabel = 'This Quarter'; prevLabel = 'Last Quarter'; }
                    }
                    else if (dq.id.startsWith('y_') || dq.id.startsWith('ytd_')) {
                        if (dq.id.includes('_py_')) { currSet = rows.filter(isYTD); prevSet = rows.filter(isLastYearYTD); currLabel = 'YTD'; prevLabel = 'PY YTD'; }
                        else { currSet = rows.filter(isYTD); prevSet = rows.filter(isLastYearYTD); currLabel = 'This Year'; prevLabel = 'Last Year'; }
                    }
                    // Grain-based fallback
                    else if (dq.grain === 'day') { currSet = rows.filter(isToday); prevSet = rows.filter(isYesterday); currLabel = 'Today'; prevLabel = 'Yesterday'; }
                    else if (dq.grain === 'week') { currSet = rows.filter(isThisWeek); prevSet = rows.filter(isLastWeek); currLabel = 'This Week'; prevLabel = 'Last Week'; }
                    else if (dq.grain === 'month') { currSet = rows.filter(isThisMonth); prevSet = rows.filter(isLastMonth); currLabel = 'This Month'; prevLabel = 'Last Month'; }
                    else if (dq.grain === 'quarter') { currSet = rows.filter(isThisQuarter); prevSet = rows.filter(isLastQuarter); currLabel = 'This Quarter'; prevLabel = 'Last Quarter'; }
                    else if (dq.grain === 'year') { currSet = rows.filter(isYTD); prevSet = rows.filter(isLastYearYTD); currLabel = 'This Year'; prevLabel = 'Last Year'; }
                    else { currSet = rows.filter(isThisMonth); prevSet = rows.filter(isLastMonth); currLabel = 'Current'; prevLabel = 'Previous'; }
                }

                // â”€â”€ TREND MODE: Dual-line time series â”€â”€
                if (isTrendMode && currSet.length > 0) {
                    // Bucket function matching the same format as custom_builder
                    const trendBucket = (dateStr: string): string => {
                        const parts = dateStr.split('-').map(Number);
                        const d = new Date(parts[0], parts[1] - 1, parts[2] || 1, 12);
                        const y = d.getFullYear();
                        const m = d.getMonth() + 1;
                        const dy = d.getDate();

                        if (trendDim === 'day') return `${y}-${pad(m)}-${pad(dy)}`;
                        if (trendDim === 'week') {
                            const week = getISOWeek(d);
                            return `${y}-W${pad(week)}`;
                        }
                        if (trendDim === 'month') return `${y}-${pad(m)}`;
                        if (trendDim === 'quarter') {
                            const q = Math.ceil(m / 3);
                            return `${y}-Q${q}`;
                        }
                        if (trendDim === 'year') return `${y}`;
                        return dateStr;
                    };

                    // Bucket current period
                    const currGroups: Record<string, number> = {};
                    // Also aggregate secondary metrics for the specialized handler
                    const specSecMetrics = query.secondaryMetrics || [];
                    // Track sum AND count for smart aggregation (AVG for discount/rate metrics)
                    const currSecGroups: Record<string, Record<string, { sum: number; count: number }>> = {};

                    // Case-insensitive column value resolver
                    const getSecVal = (r: any, colName: string): number => {
                        // Try exact match first
                        if (r[colName] !== undefined) return Number(String(r[colName] || 0).replace(/[$,]/g, '')) || 0;
                        // Case-insensitive fallback
                        const lower = colName.toLowerCase();
                        const matchKey = Object.keys(r).find(k => k.toLowerCase() === lower);
                        if (matchKey) return Number(String(r[matchKey] || 0).replace(/[$,]/g, '')) || 0;
                        return 0;
                    };

                    // Diagnostic: log secondary metric value distribution
                    if (specSecMetrics.length > 0 && currSet.length > 0) {
                        for (const sm of specSecMetrics) {
                            const allVals = currSet.map((r: any) => getSecVal(r, sm));
                            const nonZero = allVals.filter((v: number) => v !== 0);
                            console.log(`[Engine SEC] metric='${sm}': ${nonZero.length}/${allVals.length} non-zero, unique:`, [...new Set(allVals)].sort(), 'first5:', allVals.slice(0, 5));
                        }
                    }

                    currSet.forEach((r: any) => {
                        const d = date(r);
                        if (d && d !== '1970-01-01') {
                            const bucket = trendBucket(d);
                            currGroups[bucket] = (currGroups[bucket] || 0) + val(r, metricName);
                            // Aggregate secondary metrics with sum+count
                            for (const sm of specSecMetrics) {
                                if (!currSecGroups[bucket]) currSecGroups[bucket] = {};
                                const smVal = getSecVal(r, sm);
                                if (!currSecGroups[bucket][sm]) {
                                    currSecGroups[bucket][sm] = { sum: smVal, count: 1 };
                                } else {
                                    currSecGroups[bucket][sm].sum += smVal;
                                    currSecGroups[bucket][sm].count += 1;
                                }
                            }
                        }
                    });

                    // Bucket previous period
                    const prevGroups: Record<string, number> = {};
                    prevSet.forEach((r: any) => {
                        const d = date(r);
                        if (d && d !== '1970-01-01') {
                            const bucket = trendBucket(d);
                            prevGroups[bucket] = (prevGroups[bucket] || 0) + val(r, metricName);
                        }
                    });

                    // Map previous period buckets positionally to current period buckets
                    const compGroups: Record<string, number> = {};
                    const prevLabelMap2: Record<string, string> = {};
                    const prevKeys = Object.keys(prevGroups).sort();
                    const currKeys = Object.keys(currGroups).sort();
                    prevKeys.forEach((pk, i) => {
                        if (i < currKeys.length) {
                            compGroups[currKeys[i]] = prevGroups[pk];
                            prevLabelMap2[currKeys[i]] = pk;
                        }
                    });

                    // Build dual-line data with secondary metrics
                    const allKeys = [...new Set([...currKeys, ...Object.keys(compGroups)])].sort();
                    data = allKeys.map(key => {
                        const row: any = {
                            [trendDim!]: key,
                            value: currGroups[key] || 0,
                            previous_value: compGroups[key] !== undefined ? compGroups[key] : undefined,
                            previous_period_label: prevLabelMap2[key] || undefined,
                            growth_pct: compGroups[key] && compGroups[key] !== 0
                                ? (((currGroups[key] || 0) - compGroups[key]) / Math.abs(compGroups[key])) * 100
                                : undefined
                        };
                        // Add secondary metric values with smart aggregation
                        for (const sm of specSecMetrics) {
                            if (currSecGroups[key] && currSecGroups[key][sm]) {
                                const stats = currSecGroups[key][sm];
                                const smLower = sm.toLowerCase();
                                // Use AVG for rate/discount/percentage metrics, SUM for others
                                const isAvgMetric = smLower.includes('discount') || smLower.includes('rate')
                                    || smLower.includes('ratio') || smLower.includes('avg')
                                    || smLower.includes('average') || smLower.includes('margin')
                                    || smLower.includes('percent') || smLower.includes('pct')
                                    || smLower.includes('score') || smLower.includes('rating');
                                row[sm] = isAvgMetric ? (stats.sum / (stats.count || 1)) : stats.sum;
                                console.log(`[Engine SEC RESULT] bucket='${key}' metric='${sm}' sum=${stats.sum} count=${stats.count} isAvg=${isAvgMetric} final=${row[sm]}`);
                            }
                        }
                        return row;
                    });

                    kpi = aggregate(currSet) - aggregate(prevSet);
                    growth = {
                        diff: aggregate(currSet) - aggregate(prevSet),
                        pct: aggregate(prevSet) !== 0
                            ? ((aggregate(currSet) - aggregate(prevSet)) / aggregate(prevSet)) * 100
                            : (aggregate(currSet) > 0 ? 100 : 0)
                    };

                    console.log(`[Engine] Trend comparison: ${currKeys.length} current buckets, ${prevKeys.length} prev buckets, ${allKeys.length} merged`);
                } else {
                    // â”€â”€ TOTAL MODE: Simple 2-bar comparison â”€â”€
                    const currVal = aggregate(currSet);
                    const prevVal = aggregate(prevSet);
                    const growthPct = prevVal !== 0 ? ((currVal - prevVal) / prevVal) * 100 : (currVal > 0 ? 100 : 0);

                    data = [
                        { metric: currLabel, value: currVal, growth_pct: growthPct },
                        { metric: prevLabel, value: prevVal }
                    ];
                    kpi = currVal - prevVal;

                    growth = {
                        diff: currVal - prevVal,
                        pct: growthPct
                    };
                }
            }
            // 5. MOVING AVERAGES & RUNNING TOTALS
            else if (useMovingAvgOrRunning) {
                // â”€â”€ DETERMINE TIME GRAIN â”€â”€
                // Use explicit periodGrain from the UI if available, otherwise infer from question ID
                const explicitGrain = (query as any).periodGrain;
                const isWeekly = explicitGrain === 'week' || (!explicitGrain && dq.id.startsWith('w_'));
                const isMonthly = explicitGrain === 'month' || (!explicitGrain && (dq.id.startsWith('m_') || dq.id.startsWith('all_')));
                const isQuarterly = explicitGrain === 'quarter';
                const isYearly = explicitGrain === 'year';

                // Bucket function: group by proper grain
                const bucket = (r: any): string => {
                    const d = date(r);
                    if (isYearly) {
                        return d.substring(0, 4); // "YYYY"
                    }
                    if (isQuarterly) {
                        const parts = d.split('-').map(Number);
                        const q = Math.ceil(parts[1] / 3);
                        return `${parts[0]}-Q${q}`;
                    }
                    if (isMonthly) return d.substring(0, 7); // "YYYY-MM"
                    if (isWeekly) {
                        // Get Monday of the week for proper week bucketing
                        const dt = new Date(d + 'T00:00:00Z');
                        const dayOfWeek = dt.getUTCDay() || 7; // 1=Mon..7=Sun
                        dt.setUTCDate(dt.getUTCDate() - (dayOfWeek - 1));
                        return dt.toISOString().split('T')[0];
                    }
                    return d; // daily â€” no bucketing needed
                };

                // â”€â”€ SCOPE DATA TO CORRECT PERIOD â”€â”€
                let subset = rows;
                const periodScope = (query as any).periodScope; // WTD/MTD/QTD/YTD override
                const hasUserDateFilters = query.dateFilters && (query.dateFilters as any[]).length > 0;

                // When user has dateFilters, compute local scope functions relative
                // to the filtered data's max date (not the global anchor)
                let localIsThisMonth = isThisMonth;
                let localIsThisWeek = isThisWeek;
                let localIsThisQuarter = isThisQuarter;
                let localIsYTD = isYTD;

                if (hasUserDateFilters && rows.length > 0) {
                    // Find max date in filtered rows as local anchor
                    let maxDateStr = '1970-01-01';
                    rows.forEach(r => {
                        const d = date(r);
                        if (d > maxDateStr && d !== '1970-01-01') maxDateStr = d;
                    });

                    if (maxDateStr !== '1970-01-01') {
                        const localAnchor = new Date(maxDateStr + 'T12:00:00');
                        const ly = localAnchor.getFullYear();
                        const lm = localAnchor.getMonth(); // 0-indexed
                        const lq = Math.floor(lm / 3);
                        const pad2 = (n: number) => String(n).padStart(2, '0');

                        const localMonthStart = `${ly}-${pad2(lm + 1)}-01`;
                        const localQuarterStart = `${ly}-${pad2(lq * 3 + 1)}-01`;
                        const localYearStart = `${ly}-01-01`;

                        // Compute local week start (Monday)
                        const localWeekAnchor = new Date(localAnchor);
                        const dow = localWeekAnchor.getDay() || 7; // 1=Mon..7=Sun
                        localWeekAnchor.setDate(localWeekAnchor.getDate() - (dow - 1));
                        const localMondayStr = `${localWeekAnchor.getFullYear()}-${pad2(localWeekAnchor.getMonth() + 1)}-${pad2(localWeekAnchor.getDate())}`;

                        localIsThisMonth = (r: any) => date(r) >= localMonthStart && date(r) <= maxDateStr;
                        localIsThisWeek = (r: any) => date(r) >= localMondayStr && date(r) <= maxDateStr;
                        localIsThisQuarter = (r: any) => date(r) >= localQuarterStart && date(r) <= maxDateStr;
                        localIsYTD = (r: any) => date(r) >= localYearStart && date(r) <= maxDateStr;
                    }
                }

                // A specific time range override (not 'all_time') means the universal
                // period scope block has already filtered rows with shifted boundaries
                const hasSpecificTimeRange = hasTimeOverride && query.timeFilter !== 'all_time';

                if (hasSpecificTimeRange && periodScope) {
                    // Universal period scope already applied shifted MTD/WTD/etc â€” use rows directly
                    subset = rows;
                }
                // Period scope buttons take priority over question default
                else if (periodScope === 'WTD') {
                    subset = rows.filter(localIsThisWeek);
                } else if (periodScope === 'MTD') {
                    subset = rows.filter(localIsThisMonth);
                } else if (periodScope === 'QTD') {
                    subset = rows.filter(localIsThisQuarter);
                } else if (periodScope === 'YTD') {
                    subset = rows.filter(localIsYTD);
                }
                // Question's default scope (applies when no time override or all_time)
                else if (dq.id.includes('run_total_month') || dq.id.includes('_mtd')) {
                    subset = rows.filter(localIsThisMonth);
                } else if (dq.id.includes('run_total_ytd') || dq.id.includes('ytd')) {
                    subset = rows.filter(localIsYTD);
                }

                const groups: Record<string, number> = {};
                subset.forEach(r => {
                    const k = bucket(r);
                    groups[k] = (groups[k] || 0) + val(r, metricName);
                });

                const sortedSeries = Object.entries(groups)
                    .map(([x, value]) => ({ x, value }))
                    .sort((a, b) => a.x.localeCompare(b.x));

                // A. MOVING AVERAGE (Tumbling N-day windows)
                if (dq.id.includes('_ma_')) {
                    const windowMatch = dq.id.match(/_ma_(\d+)_/);
                    const idWindow = windowMatch ? parseInt(windowMatch[1]) : 7;
                    // Prefer user-configured window from customizer, fall back to question ID
                    const N = (query as any).maWindow && (query as any).maWindow > 0 ? (query as any).maWindow : idWindow;
                    console.log(`[Engine MA] âœ… ENTERED MA branch. Window=${N}, totalBuckets=${sortedSeries.length}`);

                    // When user has explicitly set a time filter, use ALL the filtered data.
                    // Only apply the trailing-days slice as a default when no time filter is active.
                    let tail: typeof sortedSeries;
                    if (hasTimeOverride) {
                        // User selected a time period (e.g., "This Quarter") â€” use all filtered data
                        tail = sortedSeries;
                    } else {
                        // Default: show trailing portion based on question prefix
                        const displayDays = dq.id.startsWith('d_') ? 35 : isWeekly ? 16 * 7 : isMonthly ? 24 * 30 : 35;
                        tail = sortedSeries.slice(-displayDays);
                    }

                    // Group into non-overlapping N-day buckets
                    // Each bucket: sum all daily values, divide by N â†’ one data point
                    const buckets: { x: string, value: number, raw_values: number[] }[] = [];
                    for (let i = 0; i < tail.length; i += N) {
                        const chunk = tail.slice(i, i + N);
                        const total = chunk.reduce((sum, pt) => sum + pt.value, 0);
                        const avg = Math.round((total / N) * 100) / 100;
                        // Label is the date range: "Dec 1 - Dec 7" using first and last date
                        const startDate = chunk[0].x;
                        const endDate = chunk[chunk.length - 1].x;
                        buckets.push({
                            x: `${startDate} to ${endDate}`,
                            value: avg,
                            raw_values: chunk.map(c => c.value)
                        });
                    }

                    data = buckets;

                    // KPI = latest bucket average
                    if (data.length > 0) {
                        kpi = data[data.length - 1].value;
                    }

                    console.log(`[Engine MA] Tumbling windows: ${data.length} buckets of ${N} days. Latest MA: ${kpi}`);
                }
                // B. RUNNING TOTAL
                else {
                    let accum = 0;
                    data = sortedSeries.map(pt => {
                        accum += pt.value;
                        return { x: pt.x, value: accum };
                    });

                    // --- COMPARISON for Running Total ---
                    if (query.comparison === 'previous_period' && data.length > 1) {
                        // Compare each running total to the previous day's running total
                        for (let i = data.length - 1; i >= 0; i--) {
                            if (i === 0) {
                                data[i].previous_value = undefined;
                                data[i].growth_pct = undefined;
                            } else {
                                const current = data[i].value;
                                const prev = data[i - 1].value;
                                data[i].previous_value = prev;
                                if (prev !== 0) {
                                    data[i].growth_pct = ((current - prev) / Math.abs(prev)) * 100;
                                } else {
                                    data[i].growth_pct = current !== 0 ? 100 : 0;
                                }
                            }
                        }
                    }
                    else if (query.comparison === 'same_period_last_year' && data.length > 0) {
                        // Build last year's running total for the same date range
                        const shiftYear = (dateStr: string, delta: number) => {
                            const d = new Date(`${dateStr}T00:00:00Z`);
                            d.setUTCFullYear(d.getUTCFullYear() + delta);
                            return d.toISOString().split('T')[0];
                        };
                        const lyStart = shiftYear(data[0].x, -1);
                        const lyEnd = shiftYear(data[data.length - 1].x, -1);

                        // Aggregate last year's daily data
                        const lyDailyGroups: Record<string, number> = {};
                        allOrigRows.forEach(r => {
                            const d = date(r);
                            if (d >= lyStart && d <= lyEnd) {
                                const bk = bucket(r);
                                // Shift back to get the matching date in current-year terms
                                const key = shiftYear(bk, 1);
                                lyDailyGroups[key] = (lyDailyGroups[key] || 0) + val(r, metricName);
                            }
                        });

                        // Build running total for last year
                        let lyAccum = 0;
                        const lyRunning: Record<string, number> = {};
                        data.forEach(pt => {
                            lyAccum += lyDailyGroups[pt.x] || 0;
                            lyRunning[pt.x] = lyAccum;
                        });

                        // Attach comparison values
                        data.forEach(pt => {
                            const lyVal = lyRunning[pt.x];
                            pt.previous_value = lyVal !== undefined ? lyVal : undefined;
                            if (lyVal !== undefined && lyVal !== 0) {
                                pt.growth_pct = ((pt.value - lyVal) / Math.abs(lyVal)) * 100;
                            } else if (pt.value !== 0 && lyVal !== undefined) {
                                pt.growth_pct = 100;
                            } else {
                                pt.growth_pct = undefined;
                            }
                        });
                    }
                }
            }
            // 6. PERCENT DIFFERENCE / GROWTH
            else if (usePctOrGrowth) {
                let currSet: any[] = [], prevSet: any[] = [];
                if (hasTimeOverride) {
                    // User overrode time period â€” rows are already pre-filtered as currSet
                    currSet = rows;
                    // Compute an equivalent previous period from allOrigRows
                    // by shifting the current time range backward by the same duration
                    const today = new Date(`${dates.today}T00:00:00Z`);
                    const fmtD = (d: Date) => d.toISOString().split('T')[0];
                    let currStart = '1970-01-01', currEnd = dates.today;
                    let prevStart = '1970-01-01', prevEnd = dates.today;

                    if (query.timeFilter === 'today') {
                        currStart = dates.today; currEnd = dates.today;
                        prevStart = dates.yesterday; prevEnd = dates.yesterday;
                    } else if (query.timeFilter === 'yesterday') {
                        currStart = dates.yesterday; currEnd = dates.yesterday;
                        const d = new Date(today); d.setUTCDate(d.getUTCDate() - 2);
                        prevStart = fmtD(d); prevEnd = fmtD(d);
                    } else if (query.timeFilter === 'this_week') {
                        currStart = dates.monday; currEnd = dates.today;
                        const d = new Date(`${dates.monday}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 7);
                        prevStart = fmtD(d);
                        const d2 = new Date(`${dates.monday}T00:00:00Z`); d2.setUTCDate(d2.getUTCDate() - 1);
                        prevEnd = fmtD(d2);
                    } else if (query.timeFilter === 'last_7_days') {
                        const s = new Date(today); s.setUTCDate(s.getUTCDate() - 7);
                        currStart = fmtD(s); currEnd = dates.today;
                        const ps = new Date(today); ps.setUTCDate(ps.getUTCDate() - 14);
                        prevStart = fmtD(ps);
                        const pe = new Date(today); pe.setUTCDate(pe.getUTCDate() - 8);
                        prevEnd = fmtD(pe);
                    } else if (query.timeFilter === 'this_month') {
                        currStart = dates.this_month_start; currEnd = dates.today;
                        const ps = new Date(`${dates.this_month_start}T00:00:00Z`); ps.setUTCMonth(ps.getUTCMonth() - 1);
                        prevStart = fmtD(ps);
                        const pe = new Date(`${dates.this_month_start}T00:00:00Z`); pe.setUTCDate(pe.getUTCDate() - 1);
                        prevEnd = fmtD(pe);
                    } else if (query.timeFilter === 'last_30_days') {
                        const s = new Date(today); s.setUTCDate(s.getUTCDate() - 30);
                        currStart = fmtD(s); currEnd = dates.today;
                        const ps = new Date(today); ps.setUTCDate(ps.getUTCDate() - 60);
                        prevStart = fmtD(ps);
                        const pe = new Date(today); pe.setUTCDate(pe.getUTCDate() - 31);
                        prevEnd = fmtD(pe);
                    } else if (query.timeFilter === 'last_90_days') {
                        const s = new Date(today); s.setUTCDate(s.getUTCDate() - 90);
                        currStart = fmtD(s); currEnd = dates.today;
                        const ps = new Date(today); ps.setUTCDate(ps.getUTCDate() - 180);
                        prevStart = fmtD(ps);
                        const pe = new Date(today); pe.setUTCDate(pe.getUTCDate() - 91);
                        prevEnd = fmtD(pe);
                    } else if (query.timeFilter === 'this_quarter') {
                        const qMonth = Math.floor(today.getUTCMonth() / 3) * 3;
                        currStart = fmtD(new Date(Date.UTC(today.getUTCFullYear(), qMonth, 1))); currEnd = dates.today;
                        prevStart = fmtD(new Date(Date.UTC(today.getUTCFullYear(), qMonth - 3, 1)));
                        prevEnd = fmtD(new Date(Date.UTC(today.getUTCFullYear(), qMonth, 0)));
                    } else if (query.timeFilter === 'this_year') {
                        currStart = dates.year_start; currEnd = dates.today;
                        prevStart = dates.last_year_start;
                        prevEnd = fmtD(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate())));
                    } else {
                        // For custom "last_N_units" or unknown, use all rows as curr, no prev
                        const lastNMatch = (query.timeFilter || '').match(/^last_(\d+)_([a-z]+)$/);
                        if (lastNMatch) {
                            const n = parseInt(lastNMatch[1], 10);
                            const unit = lastNMatch[2];
                            const s = new Date(today);
                            const ps = new Date(today);
                            if (unit === 'days') { s.setUTCDate(s.getUTCDate() - n); ps.setUTCDate(ps.getUTCDate() - n * 2); }
                            else if (unit === 'weeks') { s.setUTCDate(s.getUTCDate() - n * 7); ps.setUTCDate(ps.getUTCDate() - n * 14); }
                            else if (unit === 'months') { s.setUTCMonth(s.getUTCMonth() - n); ps.setUTCMonth(ps.getUTCMonth() - n * 2); }
                            else if (unit === 'years') { s.setUTCFullYear(s.getUTCFullYear() - n); ps.setUTCFullYear(ps.getUTCFullYear() - n * 2); }
                            currStart = fmtD(s); currEnd = dates.today;
                            prevStart = fmtD(ps);
                            const pe = new Date(s); pe.setUTCDate(pe.getUTCDate() - 1);
                            prevEnd = fmtD(pe);
                        }
                    }

                    prevSet = allOrigRows.filter(r => {
                        const dStr = date(r);
                        return dStr >= prevStart && dStr <= prevEnd;
                    });
                } else if (dq.id.startsWith('d_')) { currSet = rows.filter(isToday); prevSet = rows.filter(isYesterday); }
                else if (dq.id.startsWith('w_')) { currSet = rows.filter(isThisWeek); prevSet = rows.filter(isLastWeek); }
                else if (dq.id.startsWith('m_')) { currSet = rows.filter(isThisMonth); prevSet = rows.filter(isLastMonth); }
                else if (dq.id.startsWith('q_')) { currSet = rows.filter(isThisQuarter); prevSet = rows.filter(isLastQuarter); }
                else if (dq.id.startsWith('y_') || dq.id.startsWith('ytd_')) { currSet = rows.filter(isYTD); prevSet = rows.filter(isLastYearYTD); }

                // Percent of Total Handling
                if (dq.id.includes('_total_')) {
                    let subset = rows;
                    if (hasTimeOverride) {
                        subset = rows;
                    } else if (dq.id.startsWith('d_')) subset = rows.filter(isToday);
                    else if (dq.id.startsWith('w_')) subset = rows.filter(isThisWeek);
                    else if (dq.id.startsWith('m_')) subset = rows.filter(isThisMonth);
                    else if (dq.id.startsWith('q_')) subset = rows.filter(isThisQuarter);
                    else if (dq.id.startsWith('all_')) subset = rows;

                    const total = aggregate(subset);
                    const groups: any = {};
                    subset.forEach(r => {
                        const k = dimAccessor(r);
                        groups[k] = (groups[k] || 0) + val(r, metricName);
                    });

                    // Apply user limit (Top N) or default to 10
                    const pctLimit = (query.limit && query.limit > 0) ? query.limit : 10;
                    const pctSortDir = query.sort || 'desc';

                    let items = Object.entries(groups)
                        .map(([x, rawVal]) => ({
                            x,
                            value: total ? Math.round(((rawVal as number) / total) * 10000) / 100 : 0,
                            rawValue: rawVal as number
                        }))
                        .sort((a, b) => pctSortDir === 'asc' ? a.value - b.value : b.value - a.value)
                        .slice(0, pctLimit);

                    const topPct = items.reduce((s, i) => s + i.value, 0);
                    if (total > 0 && topPct < 100) {
                        items.push({ x: 'Other', value: Math.round((100 - topPct) * 100) / 100, rawValue: total - items.reduce((s, i) => s + i.rawValue, 0) });
                    }

                    data = items;
                }
                else {
                    const curr = aggregate(currSet);
                    const prev = aggregate(prevSet);
                    let pct = 0;
                    if (prev !== 0) pct = ((curr - prev) / prev) * 100;

                    // Determine period labels â€” prioritize user's time override, fall back to question prefix
                    let currLabel = 'Current', prevLabel = 'Previous';
                    if (hasTimeOverride && query.timeFilter) {
                        const tlMap: Record<string, [string, string]> = {
                            'today': ['Today', 'Yesterday'],
                            'yesterday': ['Yesterday', 'Day Before'],
                            'this_week': ['This Week', 'Last Week'],
                            'last_7_days': ['Last 7 Days', 'Prior 7 Days'],
                            'this_month': ['This Month', 'Last Month'],
                            'last_30_days': ['Last 30 Days', 'Prior 30 Days'],
                            'last_90_days': ['Last 90 Days', 'Prior 90 Days'],
                            'this_quarter': ['This Quarter', 'Last Quarter'],
                            'this_year': ['This Year', 'Last Year'],
                        };
                        const labels = tlMap[query.timeFilter];
                        if (labels) { currLabel = labels[0]; prevLabel = labels[1]; }
                        else { currLabel = 'Selected Period'; prevLabel = 'Prior Period'; }
                    }
                    else if (dq.id.startsWith('d_')) { currLabel = 'Today'; prevLabel = 'Yesterday'; }
                    else if (dq.id.startsWith('w_')) { currLabel = 'This Week'; prevLabel = 'Last Week'; }
                    else if (dq.id.startsWith('m_')) { currLabel = 'This Month'; prevLabel = 'Last Month'; }
                    else if (dq.id.startsWith('q_')) { currLabel = 'This Quarter'; prevLabel = 'Last Quarter'; }
                    else if (dq.id.startsWith('y_') || dq.id.startsWith('ytd_')) { currLabel = 'This Year (YTD)'; prevLabel = 'Last Year (YTD)'; }

                    // Show both periods so the bar chart is meaningful
                    // Attach growth_pct to the "current" bar so the chart
                    // growthLabelsPlugin renders a colored %-change badge above it
                    data = [
                        { metric: currLabel, value: curr, growth_pct: pct },
                        { metric: prevLabel, value: prev }
                    ];
                    kpi = pct;
                    growth = {
                        diff: curr - prev,
                        pct: pct
                    };
                }
            }
            // (Section 7 merged into section 6's _total_ handler above)
            // 8. CUSTOM AOV LOGIC
            else if (useAov) {
                let subset = rows;
                if (hasTimeOverride) {
                    subset = rows; // Already pre-filtered
                } else if (dq.id.startsWith('d_')) subset = rows.filter(isToday);
                else if (dq.id.startsWith('w_')) subset = rows.filter(isThisWeek);
                else if (dq.id.startsWith('m_')) subset = rows.filter(isThisMonth);
                else if (dq.id.startsWith('q_')) subset = rows.filter(isThisQuarter);
                else if (dq.id.startsWith('y_') || dq.id.startsWith('ytd_')) subset = rows.filter(isYTD);

                const totalRev = subset.reduce((sum, r) => sum + val(r, 'revenue'), 0);
                const uniqueOrders = new Set(subset.map(r => String(r[cols['order_id'] || 'Unknown']))).size;

                const aov = uniqueOrders > 0 ? totalRev / uniqueOrders : 0;
                // Descriptive label for AOV
                let aovLabel = 'AOV';
                if (dq.id.startsWith('d_')) aovLabel = "Today's AOV";
                else if (dq.id.startsWith('w_')) aovLabel = "This Week's AOV";
                else if (dq.id.startsWith('m_')) aovLabel = "This Month's AOV";
                else if (dq.id.startsWith('q_')) aovLabel = "This Quarter's AOV";
                else if (dq.id.startsWith('y_') || dq.id.startsWith('ytd_')) aovLabel = 'YTD AOV';

                data = [{ metric: aovLabel, value: aov }];
                kpi = aov;
            }
            // KPI (explicit evalType)
            else if (useKpi) {
                let subset = rows;
                if (hasTimeOverride) {
                    subset = rows; // Already pre-filtered
                } else if (dq.id.startsWith('d_') || dq.grain === 'day') subset = rows.filter(isToday);
                else if (dq.id.startsWith('w_') || dq.grain === 'week') subset = rows.filter(isThisWeek);
                else if (dq.id.startsWith('m_') || dq.grain === 'month') subset = rows.filter(isThisMonth);
                else if (dq.id.startsWith('q_') || dq.grain === 'quarter') subset = rows.filter(isThisQuarter);
                else if (dq.id.startsWith('y_') || dq.id.startsWith('ytd_') || dq.grain === 'year') subset = rows.filter(isYTD);

                const total = aggregate(subset);
                data = [{ metric: dq.question, value: total }];
                kpi = total;
            }
            // 3. SINGLE VALUE OR CATCH-ALL
            else if (!useTrend) {
                let subset = rows;
                if (hasTimeOverride) {
                    subset = rows; // Already pre-filtered
                } else if (dq.id.startsWith('d_')) subset = rows.filter(isToday);
                else if (dq.id.startsWith('w_')) subset = rows.filter(isThisWeek);
                else if (dq.id.startsWith('m_')) {
                    if (dq.id.includes('_py_mtd')) subset = rows.filter(isPYMonth);
                    else subset = rows.filter(isThisMonth);
                }
                else if (dq.id.startsWith('q_')) {
                    if (dq.id.includes('_py_qtd')) subset = rows.filter(isPYQuarter);
                    else subset = rows.filter(isThisQuarter);
                }
                else if (dq.id.startsWith('y_') || dq.id.startsWith('ytd_')) {
                    if (dq.id.includes('_py_ytd')) subset = rows.filter(isLastYearYTD);
                    else subset = rows.filter(isYTD);
                }

                if (dq.grain === 'day' && subset.length > 1 && dq.vis === 'line') {
                    const groups: any = {};
                    subset.forEach(r => {
                        const k = date(r);
                        groups[k] = (groups[k] || 0) + val(r, metricName);
                    });
                    data = Object.entries(groups).map(([x, value]) => ({ x, value }))
                        .sort((a: any, b: any) => a.x.localeCompare(b.x));
                } else {
                    const total = aggregate(subset);
                    // Descriptive label for single-value results
                    let label = 'Total Revenue';
                    if (metricName === 'order_id') label = 'Total Orders';
                    else if (metricName === 'customer_id') label = 'Total Customers';
                    else if (metricName === 'quantity') label = 'Total Units';
                    else label = 'Total Revenue';

                    // Add period context
                    if (dq.id.startsWith('d_')) label = label.replace('Total', "Today's");
                    else if (dq.id.startsWith('w_')) label = label.replace('Total', 'This Week');
                    else if (dq.id.startsWith('m_')) {
                        if (dq.id.includes('_py_')) label = 'PY MTD ' + label.replace('Total ', '');
                        else label = label.replace('Total', 'This Month');
                    }
                    else if (dq.id.startsWith('q_')) {
                        if (dq.id.includes('_py_')) label = 'PY QTD ' + label.replace('Total ', '');
                        else label = label.replace('Total', 'This Quarter');
                    }
                    else if (dq.id.startsWith('y_') || dq.id.startsWith('ytd_')) {
                        if (dq.id.includes('_py_')) label = 'PY YTD ' + label.replace('Total ', '');
                        else label = 'YTD ' + label.replace('Total ', '');
                    }

                    data = [{ metric: label, value: total }];
                    kpi = total;
                }
            }
            // 4. TRENDS (Revenue Trend Last 12 Months, rev_30d, etc.)
            else if (useTrend) {
                const groups: any = {};
                rows.forEach(r => {
                    let k = '';
                    if (dq.id === 'rev_30d') {
                        if (date(r) >= dates.last_30_days) k = date(r);
                    } else {
                        k = date(r).substring(0, 7); // Month bucket "YYYY-MM"
                    }
                    if (k) groups[k] = (groups[k] || 0) + val(r, metricName);
                });
                let trendData = Object.entries(groups).map(([x, value]) => ({ x, value })).sort((a: any, b: any) => a.x.localeCompare(b.x));

                // Limit to last 12 months for monthly trend questions
                if (dq.id.includes('trend') && dq.id !== 'rev_30d') {
                    trendData = trendData.slice(-12);
                }
                data = trendData;
            }
            // 8. OPERATIONAL QUESTIONS
            else if (useOperational) {
                if (dq.id === 'op_track_vs_y') {
                    const todayRev = aggregate(rows.filter(isToday));
                    const yestRev = aggregate(rows.filter(isYesterday));
                    const diff = todayRev - yestRev;
                    const pct = yestRev !== 0 ? (diff / yestRev) * 100 : 0;
                    data = [
                        { metric: 'Today', value: todayRev },
                        { metric: 'Yesterday', value: yestRev }
                    ];
                    kpi = todayRev;
                    growth = { diff, pct };
                }
                else if (dq.id === 'op_target') {
                    const last30 = rows.filter(isThisMonth);
                    const avg = last30.length > 0 ? aggregate(last30) / 30 : 1000;
                    const today = aggregate(rows.filter(isToday));
                    const pct = (today / avg) * 100;

                    data = [
                        { metric: 'Today Actual', value: today },
                        { metric: 'Daily Target (Avg)', value: avg }
                    ];
                    kpi = pct;
                }
                else if (dq.id === 'op_losing_mo' || dq.id === 'op_gaining_share') {
                    const thisWeek = rows.filter(isThisWeek);
                    const lastWeek = rows.filter(isLastWeek);

                    const dim = dq.id === 'op_losing_mo' ? 'product_name' : 'source';
                    const metricCol = 'revenue';

                    const getGroups = (set: any[]) => {
                        const g: Record<string, number> = {};
                        set.forEach(r => {
                            const k = dimAccessor(r);
                            g[k] = (g[k] || 0) + val(r, metricName);
                        });
                        return g;
                    };

                    const g1 = getGroups(thisWeek);
                    const g2 = getGroups(lastWeek);

                    const diffs: any[] = [];
                    const allKeys = new Set([...Object.keys(g1), ...Object.keys(g2)]);

                    allKeys.forEach(k => {
                        const v1 = g1[k] || 0;
                        const v2 = g2[k] || 0;
                        diffs.push({ x: k, value: v1 - v2, v1, v2 });
                    });

                    if (dq.id === 'op_losing_mo') {
                        data = diffs.sort((a, b) => a.value - b.value).slice(0, 10);
                    } else {
                        data = diffs.sort((a, b) => b.value - a.value).slice(0, 10);
                    }
                }
            }

            // --- GENERATE ACCURATE SQL ---
            if (!sql) {
                // Resolve actual column names from mapping
                const tbl = datasetName || 'dataset'; // Use actual dataset name
                const dateCol = dateColKey;
                const metricCol = cols[metricName] || metricName;
                // Detect ID columns by: canonical role name, column name pattern
                const metricColLower = metricCol.toLowerCase();
                const isCountMetric = metricName === 'order_id' || metricName === 'customer_id' ||
                    metricColLower.endsWith('_id') || metricColLower.endsWith('_key') || metricColLower === 'id';
                const aggExpr = isCountMetric ? `COUNT(DISTINCT ${metricCol})` : `SUM(${metricCol})`;
                const aggLabel = isCountMetric ? `total_${metricName.replace('_id', 's')}` : `total_${metricName}`;

                // Resolve period WHERE clauses
                const periodWhere = (prefix: string): { curr: string; prev: string; currLabel: string; prevLabel: string } => {
                    if (prefix === 'd') return {
                        curr: `${dateCol} = '${dates.today}'`,
                        prev: `${dateCol} = '${dates.yesterday}'`,
                        currLabel: 'Today', prevLabel: 'Yesterday'
                    };
                    if (prefix === 'w') {
                        // Compute last week end = day before this monday
                        const sundayDate = new Date(dates.monday);
                        sundayDate.setUTCDate(sundayDate.getUTCDate() - 1);
                        const lastWeekEnd = sundayDate.toISOString().split('T')[0];
                        return {
                            curr: `${dateCol} BETWEEN '${dates.monday}' AND '${dates.today}'`,
                            prev: `${dateCol} BETWEEN '${dates.prev_monday}' AND '${lastWeekEnd}'`,
                            currLabel: 'This Week', prevLabel: 'Last Week'
                        };
                    }
                    if (prefix === 'm') {
                        // Compute last month end = day before this month start
                        const lastMonthEndDate = new Date(dates.this_month_start);
                        lastMonthEndDate.setUTCDate(lastMonthEndDate.getUTCDate() - 1);
                        const lastMonthEnd = lastMonthEndDate.toISOString().split('T')[0];
                        return {
                            curr: `${dateCol} BETWEEN '${dates.this_month_start}' AND '${dates.today}'`,
                            prev: `${dateCol} BETWEEN '${dates.last_month_start}' AND '${lastMonthEnd}'`,
                            currLabel: 'This Month', prevLabel: 'Last Month'
                        };
                    }
                    if (prefix === 'q') return {
                        curr: `${dateCol} BETWEEN '${dates.this_quarter_start}' AND '${dates.today}'`,
                        prev: `${dateCol} BETWEEN '${dates.last_quarter_start}' AND '${dates.last_quarter_end}'`,
                        currLabel: 'This Quarter', prevLabel: 'Last Quarter'
                    };
                    // yearly / YTD
                    return {
                        curr: `${dateCol} BETWEEN '${dates.year_start}' AND '${dates.today}'`,
                        prev: `${dateCol} BETWEEN '${dates.last_year_start}' AND '${dates.last_year_today}'`,
                        currLabel: 'YTD', prevLabel: 'Prior Year YTD'
                    };
                };

                // Map query.timeFilter to a period WHERE clause when user has overridden
                const timeFilterToWhere = (): { curr: string; prev: string; currLabel: string; prevLabel: string } | null => {
                    if (!hasTimeOverride || !query.timeFilter) return null;
                    const tf = query.timeFilter;
                    const today = new Date(`${dates.today}T00:00:00Z`);
                    const fmt = (d: Date) => d.toISOString().split('T')[0];

                    if (tf === 'today') return { curr: `${dateCol} = '${dates.today}'`, prev: `${dateCol} = '${dates.yesterday}'`, currLabel: 'Today', prevLabel: 'Yesterday' };
                    if (tf === 'yesterday') return { curr: `${dateCol} = '${dates.yesterday}'`, prev: `${dateCol} = '${fmt(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 2)))}'`, currLabel: 'Yesterday', prevLabel: 'Day Before' };
                    if (tf === 'this_week') return { curr: `${dateCol} BETWEEN '${dates.monday}' AND '${dates.today}'`, prev: '', currLabel: 'This Week', prevLabel: '' };
                    if (tf === 'this_month') return { curr: `${dateCol} BETWEEN '${dates.this_month_start}' AND '${dates.today}'`, prev: '', currLabel: 'This Month', prevLabel: '' };
                    if (tf === 'this_quarter') {
                        const qMonth = Math.floor(today.getUTCMonth() / 3) * 3;
                        return { curr: `${dateCol} BETWEEN '${fmt(new Date(Date.UTC(today.getUTCFullYear(), qMonth, 1)))}' AND '${dates.today}'`, prev: '', currLabel: 'This Quarter', prevLabel: '' };
                    }
                    if (tf === 'this_year') return { curr: `${dateCol} BETWEEN '${dates.year_start}' AND '${dates.today}'`, prev: '', currLabel: 'This Year', prevLabel: '' };
                    if (tf === 'last_7_days') {
                        const start = fmt(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 7)));
                        return { curr: `${dateCol} BETWEEN '${start}' AND '${dates.today}'`, prev: '', currLabel: 'Last 7 Days', prevLabel: '' };
                    }
                    if (tf === 'last_30_days') {
                        const start = fmt(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 30)));
                        return { curr: `${dateCol} BETWEEN '${start}' AND '${dates.today}'`, prev: '', currLabel: 'Last 30 Days', prevLabel: '' };
                    }
                    if (tf === 'last_90_days') {
                        const start = fmt(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 90)));
                        return { curr: `${dateCol} BETWEEN '${start}' AND '${dates.today}'`, prev: '', currLabel: 'Last 90 Days', prevLabel: '' };
                    }
                    // Custom last_N_unit
                    const lastNMatch = tf.match(/^last_(\d+)_(c?[a-z]+)$/);
                    if (lastNMatch) {
                        const n = parseInt(lastNMatch[1], 10);
                        const unit = lastNMatch[2];
                        let startDate = new Date(today);
                        if (unit === 'cyears') {
                            return { curr: `${dateCol} BETWEEN '${fmt(new Date(Date.UTC(today.getUTCFullYear() - n, 0, 1)))}' AND '${fmt(new Date(Date.UTC(today.getUTCFullYear() - 1, 11, 31)))}'`, prev: '', currLabel: `Last ${n} Calendar Year(s)`, prevLabel: '' };
                        }
                        if (unit === 'days') startDate.setUTCDate(today.getUTCDate() - n);
                        else if (unit === 'weeks') startDate.setUTCDate(today.getUTCDate() - (n * 7));
                        else if (unit === 'months') startDate.setUTCMonth(today.getUTCMonth() - n);
                        else if (unit === 'years') startDate.setUTCFullYear(today.getUTCFullYear() - n);
                        return { curr: `${dateCol} BETWEEN '${fmt(startDate)}' AND '${dates.today}'`, prev: '', currLabel: `Last ${n} ${unit}`, prevLabel: '' };
                    }
                    return null;
                };

                const prefix = dq.id.split('_')[0]; // d, w, m, q, y, ytd, all
                const pw = timeFilterToWhere() || periodWhere(prefix);

                // Find dimension column for breakdown questions (respects user override)
                const dimCol = isUserDimOverride ? resolvedDim : (cols[defaultDimRole] || cols['product_name'] || defaultDimRole);

                // â”€â”€â”€ VS (Comparison) â”€â”€â”€
                if (dq.id.includes('_vs_')) {
                    sql = `-- ${dq.question}\nSELECT\n  '${pw.currLabel}' AS period,\n  ${aggExpr} AS ${aggLabel}\nFROM ${tbl}\nWHERE ${pw.curr}\n\nUNION ALL\n\nSELECT\n  '${pw.prevLabel}' AS period,\n  ${aggExpr} AS ${aggLabel}\nFROM ${tbl}\nWHERE ${pw.prev}`;
                }
                // â”€â”€â”€ % Change â”€â”€â”€
                else if (dq.id.includes('_pct_chg_') || (dq.id.includes('_pct_') && !dq.id.includes('_total_') && !dq.id.includes('_growth_'))) {
                    sql = `-- ${dq.question}\nWITH curr AS (\n  SELECT ${aggExpr} AS val\n  FROM ${tbl}\n  WHERE ${pw.curr}\n),\nprev AS (\n  SELECT ${aggExpr} AS val\n  FROM ${tbl}\n  WHERE ${pw.prev}\n)\nSELECT\n  curr.val AS "${pw.currLabel}",\n  prev.val AS "${pw.prevLabel}",\n  ROUND((curr.val - prev.val) * 100.0 / NULLIF(prev.val, 0), 2) AS pct_change\nFROM curr, prev`;
                }
                // â”€â”€â”€ Growth % â”€â”€â”€
                else if (dq.id.includes('_growth_')) {
                    sql = `-- ${dq.question}\nWITH curr AS (\n  SELECT ${aggExpr} AS val\n  FROM ${tbl}\n  WHERE ${pw.curr}\n),\nprev AS (\n  SELECT ${aggExpr} AS val\n  FROM ${tbl}\n  WHERE ${pw.prev}\n)\nSELECT\n  curr.val AS "${pw.currLabel}",\n  prev.val AS "${pw.prevLabel}",\n  ROUND((curr.val - prev.val) * 100.0 / NULLIF(prev.val, 0), 2) AS growth_pct\nFROM curr, prev`;
                }
                // â”€â”€â”€ % of Total (breakdown) â”€â”€â”€
                else if (dq.id.includes('_total_')) {
                    const dim = dimCol || cols['product_name'] || 'product_name';
                    sql = `-- ${dq.question}\nSELECT\n  ${dim},\n  ${aggExpr} AS ${aggLabel},\n  ROUND(${aggExpr} * 100.0 / SUM(${aggExpr}) OVER(), 2) AS pct_of_total\nFROM ${tbl}\nWHERE ${pw.curr}\nGROUP BY ${dim}\nORDER BY ${aggLabel} DESC`;
                }
                // â”€â”€â”€ Trend â”€â”€â”€
                else if (dq.id.includes('trend') || dq.id === 'rev_30d') {
                    const grain = dq.grain === 'month' || dq.id.includes('month') ? 'month' : dq.grain === 'week' ? 'week' : 'day';
                    sql = `-- ${dq.question}\nSELECT\n  DATE_TRUNC('${grain}', ${dateCol}) AS date,\n  ${aggExpr} AS ${aggLabel}\nFROM ${tbl}\nGROUP BY 1\nORDER BY 1 ASC`;
                }
                // â”€â”€â”€ Moving Average â”€â”€â”€
                else if (dq.id.includes('_ma_')) {
                    const windowMatch = dq.id.match(/_ma_(\d+)_/);
                    const N = windowMatch ? parseInt(windowMatch[1]) : 7;
                    const grain = dq.grain === 'week' ? 'week' : dq.grain === 'month' ? 'month' : 'day';
                    sql = `-- ${dq.question} (${N}-${grain} Moving Average)\nSELECT\n  DATE_TRUNC('${grain}', ${dateCol}) AS date,\n  ${aggExpr} AS period_${metricName},\n  AVG(${aggExpr}) OVER (\n    ORDER BY DATE_TRUNC('${grain}', ${dateCol})\n    ROWS BETWEEN ${N - 1} PRECEDING AND CURRENT ROW\n  ) AS ma_${N}\nFROM ${tbl}\nGROUP BY 1\nORDER BY 1 ASC`;
                }
                // â”€â”€â”€ Running Total â”€â”€â”€
                else if (dq.id.includes('_run_')) {
                    const grain = dq.grain === 'week' ? 'week' : dq.grain === 'month' ? 'month' : 'day';
                    const scope = dq.id.includes('ytd') ? `WHERE ${dateCol} BETWEEN '${dates.year_start}' AND '${dates.today}'` :
                        dq.id.includes('month') ? `WHERE ${dateCol} BETWEEN '${dates.this_month_start}' AND '${dates.today}'` : '';
                    sql = `-- ${dq.question}\nSELECT\n  DATE_TRUNC('${grain}', ${dateCol}) AS date,\n  ${aggExpr} AS period_${metricName},\n  SUM(${aggExpr}) OVER (\n    ORDER BY DATE_TRUNC('${grain}', ${dateCol})\n  ) AS running_total\nFROM ${tbl}\n${scope}\nGROUP BY 1\nORDER BY 1 ASC`;
                }
                // â”€â”€â”€ Top N / Ranking â”€â”€â”€
                else if (dq.id.includes('top') || dq.id.includes('best') || dq.id.includes('worst')) {
                    const dim = dimCol || cols['product_name'] || 'product_name';
                    const limitMatch = dq.question.match(/(?:Top|Bottom)\s+(\d+)/i) || dq.id.match(/(?:top|bottom)_(\d+)/i);
                    const limit = limitMatch ? parseInt(limitMatch[1]) : 10;
                    const dir = dq.id.includes('worst') || dq.id.includes('bottom') || dq.id.includes('least') ? 'ASC' : 'DESC';
                    sql = `-- ${dq.question}\nSELECT\n  ${dim},\n  ${aggExpr} AS ${aggLabel}\nFROM ${tbl}\nWHERE ${pw.curr}\nGROUP BY ${dim}\nORDER BY ${aggLabel} ${dir}\nLIMIT ${limit}`;
                }
                // â”€â”€â”€ AOV â”€â”€â”€
                else if (dq.id.endsWith('_aov')) {
                    const revCol = cols['revenue'] || 'revenue';
                    const orderCol = cols['order_id'] || 'order_id';
                    sql = `-- ${dq.question}\nSELECT\n  SUM(${revCol}) / NULLIF(COUNT(DISTINCT ${orderCol}), 0) AS aov\nFROM ${tbl}\nWHERE ${pw.curr}`;
                }
                // â”€â”€â”€ KPI (simple aggregation) â”€â”€â”€
                else if (dq.vis === 'kpiCard' || useKpi) {
                    sql = `-- ${dq.question}\nSELECT\n  ${aggExpr} AS ${aggLabel}\nFROM ${tbl}\nWHERE ${pw.curr}`;
                }
                // â”€â”€â”€ Operational â”€â”€â”€
                else if (dq.id.startsWith('op_')) {
                    if (dq.id === 'op_track_vs_y') {
                        sql = `-- ${dq.question}\nSELECT\n  '${pw.currLabel}' AS period,\n  ${aggExpr} AS ${aggLabel}\nFROM ${tbl}\nWHERE ${pw.curr}\n\nUNION ALL\n\nSELECT\n  '${pw.prevLabel}' AS period,\n  ${aggExpr} AS ${aggLabel}\nFROM ${tbl}\nWHERE ${pw.prev}`;
                    } else {
                        const dim = dimCol || cols['product_name'] || 'product_name';
                        sql = `-- ${dq.question}\nSELECT\n  ${dim},\n  ${aggExpr} AS ${aggLabel}\nFROM ${tbl}\nWHERE ${pw.curr}\nGROUP BY ${dim}\nORDER BY ${aggLabel} DESC\nLIMIT 10`;
                    }
                }
                // â”€â”€â”€ Default: period aggregation â”€â”€â”€
                else {
                    sql = `-- ${dq.question}\nSELECT\n  ${aggExpr} AS ${aggLabel}\nFROM ${tbl}\nWHERE ${pw.curr}`;
                }
            }

        } // End else (Deterministic)
    } catch (e) {
        console.error("Eval Error", e);
    }

    // Detect xKey: first check for time grain dims from trend mode, then x, then metric
    const trendGrains = ['day', 'week', 'month', 'quarter', 'year'];
    const detectedXKey = data[0] ? (trendGrains.find(g => data[0][g] !== undefined) || (data[0].x !== undefined ? 'x' : 'metric')) : 'metric';
    return { data, xKey: detectedXKey, yKey: 'value', kpi, growth, sql };
};
