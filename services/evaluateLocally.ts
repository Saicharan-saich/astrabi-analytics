import { CanonicalMapping, Dataset, QuestionTemplate, QueryConfig } from "../types";
import { SqlGenerator, SqlQueryConfig } from './SqlGenerator';
import { DateRange, pad, getISOWeek } from './dateHelpers';

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
        return { safe: false, error: 'Dataset is empty — cannot analyze.' };
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
export const evaluateLocally = (dq: QuestionTemplate, rows: any[], mapping: CanonicalMapping, dates: DateRange, query: QueryConfig): any => {
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
            // DYNAMIC BUILDER LOGIC
            const metricCol = query.metric;
            const dimCol = query.dimension;

            // Apply Filters
            let filteredRows = rows;

            // TIME FILTER
            if (query.timeFilter && query.timeFilter !== 'all_time') {
                const today = new Date(`${dates.today}T00:00:00Z`); // UTC anchor
                const lastNMatch = query.timeFilter.match(/^last_(\d+)_(c?[a-z]+)$/);

                // UTC Formatter
                const formatDate = (d: Date) => d.toISOString().split('T')[0];

                let startStr = '1970-01-01';
                let endStr = dates.today;

                if (query.timeFilter === 'today') {
                    startStr = dates.today;
                    endStr = dates.today;
                } else if (query.timeFilter === 'yesterday') {
                    startStr = dates.yesterday;
                    endStr = dates.yesterday;
                } else if (query.timeFilter === 'this_week') {
                    startStr = dates.monday;
                } else if (query.timeFilter === 'this_month') {
                    startStr = dates.this_month_start;
                } else if (query.timeFilter === 'this_quarter') {
                    const d = new Date(today);
                    const currentMonth = d.getUTCMonth();
                    const qMonth = Math.floor(currentMonth / 3) * 3;
                    d.setUTCMonth(qMonth, 1);
                    startStr = formatDate(d);
                } else if (query.timeFilter === 'this_year') {
                    startStr = dates.year_start;
                } else if (query.timeFilter === 'last_year') {
                    startStr = dates.last_year_start;
                    endStr = new Date(Date.UTC(today.getUTCFullYear() - 1, 11, 31)).toISOString().split('T')[0];
                } else if (lastNMatch) {
                    const n = parseInt(lastNMatch[1], 10);
                    const unit = lastNMatch[2];
                    if (unit === 'cyears') {
                        // CALENDAR YEAR MODE
                        const asOfYear = today.getUTCFullYear();
                        startStr = formatDate(new Date(Date.UTC(asOfYear - n, 0, 1)));
                        endStr = formatDate(new Date(Date.UTC(asOfYear - 1, 11, 31)));
                    } else {
                        const targetDate = new Date(today);
                        if (unit === 'days') {
                            targetDate.setUTCDate(today.getUTCDate() - n);
                        } else if (unit === 'weeks') {
                            targetDate.setUTCDate(today.getUTCDate() - (n * 7));
                        } else if (unit === 'months') {
                            targetDate.setUTCMonth(today.getUTCMonth() - n);
                        } else if (unit === 'years') {
                            targetDate.setUTCFullYear(today.getUTCFullYear() - n);
                        }
                        startStr = formatDate(targetDate);
                    }
                } else if (query.timeFilter === 'last_7_days') {
                    startStr = dates.last_7_days;
                } else if (query.timeFilter === 'last_30_days') {
                    startStr = dates.last_30_days;
                } else if (query.timeFilter === 'last_90_days') {
                    const d = new Date(today);
                    d.setUTCDate(d.getUTCDate() - 90);
                    startStr = formatDate(d);
                }

                console.log(`[Engine] custom_builder time filter: ${query.timeFilter} → range [${startStr}, ${endStr}], rows before: ${filteredRows.length}`);
                filteredRows = filteredRows.filter(r => {
                    const dStr = date(r);
                    return dStr >= startStr && dStr <= endStr;
                });
                console.log(`[Engine] rows after time filter: ${filteredRows.length}`);
            }

            // DIMENSION FILTERS
            if (query.filters) {
                const sampleRow = filteredRows[0] || {};

                Object.entries(query.filters).forEach(([col, allowedValues]) => {
                    // Robust Key Lookup (Handle 'segment' vs 'Segment' mismatch)
                    let effectiveCol = col;
                    if (filteredRows.length > 0 && !(col in filteredRows[0])) {
                        const keys = Object.keys(filteredRows[0]);
                        const normalize = (s: string) => s.toLowerCase().replace(/[_\s]+/g, '');
                        const target = normalize(col);
                        const match = keys.find(k => normalize(k) === target);
                        if (match) {
                            effectiveCol = match;
                        }
                    }

                    filteredRows = filteredRows.filter(r => {
                        const val = String(r[effectiveCol] || '').trim();
                        return allowedValues.some(allowed => val.toLowerCase() === String(allowed).toLowerCase());
                    });
                });
            }

            // MEASURE FILTERS
            if (query.measureFilters) {
                query.measureFilters.forEach((mf: any) => {
                    filteredRows = filteredRows.filter(r => {
                        const numVal = Number(String(r[mf.column] || 0).replace(/[$,]/g, '')) || 0;
                        const filterVal = Number(mf.value) || 0;
                        switch (mf.operator) {
                            case '>=': return numVal >= filterVal;
                            case '<=': return numVal <= filterVal;
                            case '>': return numVal > filterVal;
                            case '<': return numVal < filterVal;
                            case '=': return numVal === filterVal;
                            case '!=': return numVal !== filterVal;
                            default: return true;
                        }
                    });
                });
            }

            // DATE FILTERS
            if (query.dateFilters && query.dateFilters.length > 0) {
                query.dateFilters.forEach((df: any) => {
                    const sampleRow = filteredRows[0] || {};
                    const actualKey = Object.keys(sampleRow).find(k => k.toLowerCase() === df.column.toLowerCase()) || df.column;

                    filteredRows = filteredRows.filter(r => {
                        const dateVal = r[actualKey];
                        if (!dateVal || dateVal === 'null' || dateVal === 'undefined' || dateVal === '1970-01-01') return false;

                        const dateStr = String(dateVal);
                        let d: Date | null = null;

                        if (dateStr.match(/^\d{4}-\d{2}-\d{2}/)) {
                            const parts = dateStr.split('-').map(Number);
                            d = new Date(parts[0], parts[1] - 1, parts[2], 12);
                        } else if (dateStr.indexOf('/') > -1) {
                            const parts = dateStr.split('/');
                            if (parts.length === 3) {
                                d = new Date(Number(parts[2]), Number(parts[0]) - 1, Number(parts[1]), 12);
                            }
                        } else {
                            d = new Date(dateStr);
                        }

                        if (!d || isNaN(d.getTime())) return false;

                        const year = d.getFullYear();
                        const month = d.getMonth() + 1;
                        const day = d.getDate();
                        const pad2 = pad;

                        let formattedValue = '';
                        if (df.timeGrain === 'year') {
                            formattedValue = `${year}`;
                        } else if (df.timeGrain === 'quarter') {
                            const q = Math.ceil(month / 3);
                            formattedValue = `${year}-Q${q}`;
                        } else if (df.timeGrain === 'month') {
                            formattedValue = `${year}-${pad2(month)}`;
                        } else if (df.timeGrain === 'week') {
                            const week = getISOWeek(d);
                            formattedValue = `${year}-W${pad2(week)}`;
                        } else if (df.timeGrain === 'day') {
                            formattedValue = `${year}-${pad2(month)}-${pad2(day)}`;
                        }

                        return df.values.includes(formattedValue);
                    });
                });
            }

            // Aggregation
            const groups: any = {};
            const timeGrains = ['day', 'week', 'month', 'quarter', 'year'];
            const isTimeDim = dimCol && timeGrains.includes(dimCol);

            filteredRows.forEach(r => {
                let k = dimCol ? String(r[dimCol] || 'Unknown') : 'Total';
                if (isTimeDim) {
                    const dStr = date(r);
                    if (dStr && dStr !== '1970-01-01') {
                        const parts = dStr.split('-').map(Number);
                        const d = new Date(parts[0], parts[1] - 1, parts[2], 12);
                        const y = d.getFullYear();
                        const m = d.getMonth() + 1;
                        const day = d.getDate();
                        const pad2 = pad;

                        if (dimCol === 'day') {
                            k = `${y}-${pad2(m)}-${pad2(day)}`;
                        } else if (dimCol === 'week') {
                            const week = getISOWeek(d);
                            k = `${y}-W${pad2(week)}`;
                        } else if (dimCol === 'month') {
                            k = `${y}-${pad(m)}`;
                        } else if (dimCol === 'quarter') {
                            const q = Math.ceil(m / 3);
                            k = `${y}-Q${q}`;
                        } else if (dimCol === 'year') {
                            k = `${y}`;
                        }
                    }
                }
                const rawV = r[metricCol];
                const v = Number(String(rawV || 0).replace(/[$,]/g, '')) || 0;

                if (!groups[k]) {
                    groups[k] = { sum: 0, count: 0, min: v, max: v, distinct: new Set() };
                }

                groups[k].sum += v;
                groups[k].count += 1;
                groups[k].min = Math.min(groups[k].min, v);
                groups[k].max = Math.max(groups[k].max, v);
                if (rawV !== undefined && rawV !== null) groups[k].distinct.add(String(rawV));
            });

            // Convert groups to array based on Aggregation Type
            const aggType = query.aggregation || 'SUM';

            data = Object.entries(groups).map(([key, stats]: [string, any]) => {
                let finalValue = 0;
                switch (aggType) {
                    case 'AVG': finalValue = stats.sum / (stats.count || 1); break;
                    case 'COUNT': finalValue = stats.count; break;
                    case 'COUNT_DISTINCT': finalValue = stats.distinct.size; break;
                    case 'MAX': finalValue = stats.max; break;
                    case 'MIN': finalValue = stats.min; break;
                    case 'SUM': default: finalValue = stats.sum; break;
                }

                return {
                    [dimCol || 'metric']: key,
                    [metricCol]: finalValue
                };
            });

            // --- COMPARISON LOGIC (Previous Row — Sequential) ---
            // When comparison is enabled, each data point is compared to the PREVIOUS
            // row in the sorted result. E.g., Dec 26 compares to Dec 25, not to Dec 19.
            // Data MUST be sorted chronologically before this step for time-based dims.
            if (query.comparison === 'previous_period') {

                // Ensure chronological sort for time dimensions before comparison
                if (isTimeDim) {
                    data.sort((a, b) => {
                        const aKey = String(a[dimCol] || '');
                        const bKey = String(b[dimCol] || '');
                        return aKey.localeCompare(bKey);
                    });
                }

                for (let i = 0; i < data.length; i++) {
                    if (i === 0) {
                        // First row has no previous — leave previous_value undefined
                        data[i].previous_value = undefined;
                        data[i].growth_pct = undefined;
                    } else {
                        const current = Number(data[i][metricCol]) || 0;
                        const prev = Number(data[i - 1][metricCol]) || 0;

                        data[i].previous_value = prev;

                        // Growth % = (current - previous) / |previous| × 100
                        if (prev !== 0) {
                            data[i].growth_pct = ((current - prev) / Math.abs(prev)) * 100;
                        } else if (current !== 0) {
                            data[i].growth_pct = 100; // Growth from zero
                        } else {
                            data[i].growth_pct = 0;
                        }
                    }
                }
            }


            // POST-AGGREGATION SORT & LIMIT
            // 3. Sorting
            const sortMode = query.sort || 'desc';

            if (sortMode === 'oldest') {
                data.sort((a, b) => a[dimCol].localeCompare(b[dimCol]));
            } else if (sortMode === 'newest') {
                data.sort((a, b) => b[dimCol].localeCompare(a[dimCol]));
            } else {
                const isAsc = sortMode === 'asc';
                data.sort((a, b) => {
                    const valA = Number(a[metricCol]) || 0;
                    const valB = Number(b[metricCol]) || 0;
                    return isAsc ? valA - valB : valB - valA;
                });
            }

            // 2. Apply Limit (if any)
            if (query.limit && query.limit > 0) {
                data = data.slice(0, query.limit);
            }

            // 4. Generate SQL (Robust Engine)
            const sqlConfig: SqlQueryConfig = {
                table: 'orders',
                metric: metricCol,
                aggregation: aggType,
                dimension: dimCol,
                timeFilter: query.timeFilter,
                filters: query.filters as Record<string, string[]>,
                measureFilters: query.measureFilters,
                sort: query.sort,
                limit: query.limit,
                dates: {
                    today: dates.today,
                    yesterday: dates.yesterday,
                    this_week_start: dates.monday,
                    this_month_start: dates.this_month_start,
                    this_quarter_start: (() => {
                        const d = new Date(`${dates.today}T00:00:00Z`);
                        const qMonth = Math.floor(d.getUTCMonth() / 3) * 3;
                        d.setUTCMonth(qMonth, 1);
                        return d.toISOString().split('T')[0];
                    })(),
                    year_start: dates.year_start,
                    last_30_days: dates.last_30_days,
                    last_90_days: dates.last_90_days || '',
                }
            };

            const sql = new SqlGenerator(sqlConfig).build();

            return { data, xKey: dimCol || 'metric', yKey: metricCol, yLabel: `${metricCol} by ${dimCol || 'Total'}`, sql };
        } else {
            // --- DETERMINISTIC LOGIC ---

            // ── USER OVERRIDE: METRIC ──
            // If the customizer changed the metric, override the question's default
            let metricName = 'revenue';
            if (query.metric && query.metric !== '' && dq.id !== 'custom_builder') {
                // User explicitly chose a metric in the customizer — try to find its canonical role
                const userMetricLower = query.metric.toLowerCase();
                const metricRoles = ['revenue', 'quantity', 'order_id', 'customer_id'];
                const matchedRole = metricRoles.find(role => {
                    const colName = cols[role];
                    return colName && colName.toLowerCase() === userMetricLower;
                });
                if (matchedRole) {
                    metricName = matchedRole;
                } else {
                    // Fallback: use the raw column name as-is (for non-canonical metrics)
                    metricName = 'revenue'; // Stick with default if no match
                    if (dq.req.includes('quantity')) metricName = 'quantity';
                    if (dq.id.includes('orders') || dq.req.includes('order_id')) metricName = 'order_id';
                    if (dq.id.includes('cust') || dq.req.includes('customer_id')) metricName = 'customer_id';
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

            // ── UNIVERSAL TIME FILTER OVERRIDE ──
            // When the user customizes the time period in the QuestionCustomizer,
            // query.timeFilter contains their choice. We pre-filter rows so ALL
            // downstream eval branches (ranking, comparison, trend, KPI, etc.)
            // automatically use the user's chosen time window.
            const hasTimeOverride = query.timeFilter && query.timeFilter !== '' && query.timeFilter !== 'all_time';
            if (hasTimeOverride) {
                const today = new Date(`${dates.today}T00:00:00Z`);
                const formatDate = (d: Date) => d.toISOString().split('T')[0];
                const lastNMatch = query.timeFilter!.match(/^last_(\d+)_(c?[a-z]+)$/);

                let startStr = '1970-01-01';
                let endStr = dates.today;

                if (query.timeFilter === 'today') {
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

                console.log(`[Engine] deterministic time filter: ${query.timeFilter} → range [${startStr}, ${endStr}], rows before: ${rows.length}`);
                rows = rows.filter(r => {
                    const dStr = date(r);
                    return dStr >= startStr && dStr <= endStr;
                });
                console.log(`[Engine] rows after time filter: ${rows.length}`);
            }

            // ── USER OVERRIDE: PERIOD SCOPE (WTD / MTD / QTD / YTD) ──
            // These buttons scope the data to week/month/quarter/year-to-date
            const periodScope = (query as any).periodScope;
            if (periodScope) {
                const beforePS = rows.length;
                if (periodScope === 'WTD') {
                    rows = rows.filter(r => date(r) >= dates.monday && date(r) <= dates.today);
                } else if (periodScope === 'MTD') {
                    rows = rows.filter(r => date(r) >= dates.this_month_start && date(r) <= dates.today);
                } else if (periodScope === 'QTD') {
                    rows = rows.filter(r => date(r) >= dates.this_quarter_start && date(r) <= dates.today);
                } else if (periodScope === 'YTD') {
                    rows = rows.filter(r => date(r) >= dates.year_start && date(r) <= dates.today);
                }
                console.log(`[Engine] periodScope ${periodScope}: rows ${beforePS} → ${rows.length}`);
            }

            // ── USER OVERRIDE: DIMENSION FILTERS ──
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

            // ── USER OVERRIDE: DATE FILTERS (Hierarchical) ──
            if (query.dateFilters && (query.dateFilters as any[]).length > 0) {
                (query.dateFilters as any[]).forEach((df: any) => {
                    if (!df.values || df.values.length === 0) return;
                    const valSet = new Set(df.values);
                    rows = rows.filter(r => {
                        const d = date(r);
                        if (df.timeGrain === 'year') return valSet.has(d.substring(0, 4));
                        if (df.timeGrain === 'month') return valSet.has(d.substring(0, 7));
                        if (df.timeGrain === 'day') return valSet.has(d);
                        return true;
                    });
                });
            }
            // ── EVAL-TYPE ROUTING ──
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
                let dim = dq.req.find(r => r !== 'revenue' && r !== 'quantity' && r !== 'order_id' && r !== 'order_date') || 'product_name';

                // ── PREFER NAME COLUMNS OVER IDs ──
                // If dim resolves to an ID column, try to find the corresponding name column instead
                const dimCol = cols[dim];
                if (dimCol) {
                    const lowerDimCol = dimCol.toLowerCase();
                    if (lowerDimCol.endsWith('_id') || lowerDimCol.endsWith(' id') || lowerDimCol === 'id') {
                        // Try to find a name column for the same entity
                        const entityBase = lowerDimCol.replace(/_?id$/i, '').replace(/ ?id$/i, '');
                        const allColNames = Object.keys(rows[0] || {});
                        const nameCol = allColNames.find(c => {
                            const lc = c.toLowerCase();
                            return (lc.includes(entityBase) && (lc.includes('name') || lc.includes('title') || lc.includes('label'))) ||
                                (lc === entityBase && !lc.endsWith('id'));
                        });
                        if (nameCol) {
                            // Override: use the name column directly (bypass canonical mapping)
                            cols[dim] = nameCol;
                        }
                    }
                }

                let subset = rows;
                if (dq.id.includes('today')) subset = rows.filter(isToday);
                else if (dq.id.includes('week')) subset = rows.filter(isThisWeek);
                else if (dq.id.includes('month') || dq.id.startsWith('m_')) subset = rows.filter(isThisMonth);
                else if (dq.id.includes('quarter') || dq.id.startsWith('q_')) subset = rows.filter(isThisQuarter);

                const groups: any = {};
                subset.forEach(r => {
                    const k = str(r, dim);
                    groups[k] = (groups[k] || 0) + val(r, 'revenue');
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
                // Grain-based fallback for new question IDs (diag_, time_, grow_, etc.)
                else if (dq.grain === 'day') { currSet = rows.filter(isToday); prevSet = rows.filter(isYesterday); currLabel = 'Today'; prevLabel = 'Yesterday'; }
                else if (dq.grain === 'week') { currSet = rows.filter(isThisWeek); prevSet = rows.filter(isLastWeek); currLabel = 'This Week'; prevLabel = 'Last Week'; }
                else if (dq.grain === 'month') { currSet = rows.filter(isThisMonth); prevSet = rows.filter(isLastMonth); currLabel = 'This Month'; prevLabel = 'Last Month'; }
                else if (dq.grain === 'quarter') { currSet = rows.filter(isThisQuarter); prevSet = rows.filter(isLastQuarter); currLabel = 'This Quarter'; prevLabel = 'Last Quarter'; }
                else if (dq.grain === 'year') { currSet = rows.filter(isYTD); prevSet = rows.filter(isLastYearYTD); currLabel = 'This Year'; prevLabel = 'Last Year'; }
                else { currSet = rows.filter(isThisMonth); prevSet = rows.filter(isLastMonth); currLabel = 'Current'; prevLabel = 'Previous'; }

                const currVal = aggregate(currSet);
                const prevVal = aggregate(prevSet);

                data = [{ metric: currLabel, value: currVal }, { metric: prevLabel, value: prevVal }];
                kpi = currVal - prevVal;

                growth = {
                    diff: currVal - prevVal,
                    pct: prevVal !== 0 ? ((currVal - prevVal) / prevVal) * 100 : (currVal > 0 ? 100 : 0)
                };
            }
            // 5. MOVING AVERAGES & RUNNING TOTALS
            else if (useMovingAvgOrRunning) {
                // ── DETERMINE TIME GRAIN ──
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
                    return d; // daily — no bucketing needed
                };

                // ── SCOPE DATA TO CORRECT PERIOD ──
                let subset = rows;
                const periodScope = (query as any).periodScope; // WTD/MTD/QTD/YTD override

                // IMPORTANT: periodScope MUST be checked FIRST — it overrides the
                // question's default scope. Otherwise dq.id.includes('run_total_month')
                // always wins and QTD/YTD never take effect.
                if (periodScope === 'WTD') {
                    subset = rows.filter(isThisWeek);
                } else if (periodScope === 'MTD') {
                    subset = rows.filter(isThisMonth);
                } else if (periodScope === 'QTD') {
                    subset = rows.filter(isThisQuarter);
                } else if (periodScope === 'YTD') {
                    subset = rows.filter(isYTD);
                } else if (dq.id.includes('run_total_month') || dq.id.includes('_mtd')) {
                    subset = rows.filter(isThisMonth);
                } else if (dq.id.includes('run_total_ytd') || dq.id.includes('ytd')) {
                    subset = rows.filter(isYTD);
                }

                const groups: Record<string, number> = {};
                subset.forEach(r => {
                    const k = bucket(r);
                    groups[k] = (groups[k] || 0) + val(r, metricName);
                });

                const sortedSeries = Object.entries(groups)
                    .map(([x, value]) => ({ x, value }))
                    .sort((a, b) => a.x.localeCompare(b.x));

                // A. MOVING AVERAGE
                if (dq.id.includes('_ma_')) {
                    const windowMatch = dq.id.match(/_ma_(\d+)_/);
                    const N = windowMatch ? parseInt(windowMatch[1]) : 7;
                    data = sortedSeries.map((pt, i, arr) => {
                        const start = Math.max(0, i - N + 1);
                        const windowSlice = arr.slice(start, i + 1);
                        const avg = windowSlice.reduce((sum, item) => sum + item.value, 0) / windowSlice.length;
                        return { x: pt.x, value: avg };
                    });
                    // Show only a reasonable trailing window
                    if (dq.id.startsWith('d_')) data = data.slice(-30);
                    else if (isWeekly) data = data.slice(-16); // show ~4 months of weekly data
                    else if (isMonthly) data = data.slice(-24);
                }
                // B. RUNNING TOTAL
                else {
                    let accum = 0;
                    data = sortedSeries.map(pt => {
                        accum += pt.value;
                        return { x: pt.x, value: accum };
                    });
                }
            }
            // 6. PERCENT DIFFERENCE / GROWTH
            else if (usePctOrGrowth) {
                let currSet: any[] = [], prevSet: any[] = [];
                if (dq.id.startsWith('d_')) { currSet = rows.filter(isToday); prevSet = rows.filter(isYesterday); }
                else if (dq.id.startsWith('w_')) { currSet = rows.filter(isThisWeek); prevSet = rows.filter(isLastWeek); }
                else if (dq.id.startsWith('m_')) { currSet = rows.filter(isThisMonth); prevSet = rows.filter(isLastMonth); }
                else if (dq.id.startsWith('q_')) { currSet = rows.filter(isThisQuarter); prevSet = rows.filter(isLastQuarter); }
                else if (dq.id.startsWith('y_') || dq.id.startsWith('ytd_')) { currSet = rows.filter(isYTD); prevSet = rows.filter(isLastYearYTD); }

                // Percent of Total Handling
                if (dq.id.includes('_total_')) {
                    const dim = dq.req.find(r => r !== 'revenue' && r !== 'order_date') || 'product_name';
                    let subset = rows;
                    if (dq.id.startsWith('d_')) subset = rows.filter(isToday);
                    else if (dq.id.startsWith('w_')) subset = rows.filter(isThisWeek);
                    else if (dq.id.startsWith('m_')) subset = rows.filter(isThisMonth);
                    else if (dq.id.startsWith('q_')) subset = rows.filter(isThisQuarter);
                    else if (dq.id.startsWith('all_')) subset = rows;

                    const total = aggregate(subset);
                    const groups: any = {};
                    subset.forEach(r => {
                        const k = str(r, dim);
                        groups[k] = (groups[k] || 0) + val(r, 'revenue');
                    });

                    let items = Object.entries(groups)
                        .map(([x, rawVal]) => ({
                            x,
                            value: total ? Math.round(((rawVal as number) / total) * 10000) / 100 : 0,
                            rawValue: rawVal as number
                        }))
                        .sort((a, b) => b.value - a.value)
                        .slice(0, 10);

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

                    // Determine period labels based on question prefix
                    let currLabel = 'Current', prevLabel = 'Previous';
                    if (dq.id.startsWith('d_')) { currLabel = 'Today'; prevLabel = 'Yesterday'; }
                    else if (dq.id.startsWith('w_')) { currLabel = 'This Week'; prevLabel = 'Last Week'; }
                    else if (dq.id.startsWith('m_')) { currLabel = 'This Month'; prevLabel = 'Last Month'; }
                    else if (dq.id.startsWith('q_')) { currLabel = 'This Quarter'; prevLabel = 'Last Quarter'; }
                    else if (dq.id.startsWith('y_') || dq.id.startsWith('ytd_')) { currLabel = 'This Year (YTD)'; prevLabel = 'Last Year (YTD)'; }

                    // Show both periods so the bar chart is meaningful
                    data = [
                        { metric: currLabel, value: curr },
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
                if (dq.id.startsWith('d_')) subset = rows.filter(isToday);
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
                if (dq.id.startsWith('d_') || dq.grain === 'day') subset = rows.filter(isToday);
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
                if (dq.id.startsWith('d_')) subset = rows.filter(isToday);
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
                            const k = str(r, dim);
                            g[k] = (g[k] || 0) + val(r, metricCol);
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

            // --- GENERATE DET-SQL (Simulation) ---
            if (!sql) {
                const dMetric = metricName;
                let dDim = 'date';
                if (dq.id.includes('top')) dDim = 'product_name';
                else if (dq.id.includes('source')) dDim = 'source';

                if (dq.id.includes('_vs_')) {
                    const timeframe = dq.id.split('_')[0];
                    const tfMap: any = { d: 'Today', w: 'This Week', m: 'This Month', ytd: 'YTD' };
                    const tfPrevMap: any = { d: 'Yesterday', w: 'Last Week', m: 'Last Month', ytd: 'Previous YTD' };
                    sql = `SELECT \n  SUM(CASE WHEN period = '${tfMap[timeframe] || 'Current'}' THEN ${dMetric} ELSE 0 END) as "Current",\n  SUM(CASE WHEN period = '${tfPrevMap[timeframe] || 'Previous'}' THEN ${dMetric} ELSE 0 END) as "Previous"\nFROM orders\nWHERE date >= '${tfPrevMap[timeframe] || 'Start Date'}'`;
                }
                else if (dq.id.includes('trend') || dq.id === 'rev_30d') {
                    const grain = dq.id === 'rev_30d' ? 'day' : 'month';
                    sql = `SELECT DATE_TRUNC('${grain}', order_date) as date, SUM(${dMetric})\nFROM orders\nGROUP BY 1\nORDER BY 1 ASC`;
                }
                else if (dq.id.includes('top')) {
                    const limitMatch = dq.question.match(/Top (\d+)/i) || dq.id.match(/top_(\d+)/i);
                    const limit = limitMatch ? parseInt(limitMatch[1]) : 10;
                    sql = `SELECT ${dDim}, SUM(${dMetric})\nFROM orders\nWHERE order_date = 'Today'\nGROUP BY 1\nORDER BY 2 DESC\nLIMIT ${limit}`;
                }
                else if (dq.id.startsWith('op_')) {
                    if (dq.id === 'op_track_vs_y') {
                        sql = `SELECT \n  SUM(CASE WHEN date = 'Today' THEN revenue ELSE 0 END) as "Today",\n  SUM(CASE WHEN date = 'Yesterday' AND time <= NOW() THEN revenue ELSE 0 END) as "Yesterday (Same Time)"\nFROM orders`;
                    } else {
                        sql = `SELECT ${dDim}, (SUM(this_week) - SUM(last_week)) as diff\nFROM orders\nGROUP BY 1\nORDER BY 2 DESC\nLIMIT 10`;
                    }
                }
                else {
                    sql = `SELECT SUM(${dMetric})\nFROM orders\nWHERE order_date = 'Current Period'`;
                }
            }

        } // End else (Deterministic)
    } catch (e) {
        console.error("Eval Error", e);
    }

    return { data, xKey: (data[0]?.x ? 'x' : 'metric'), yKey: 'value', kpi, growth, sql };
};
