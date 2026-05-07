// ═══════════════════════════════════════════════════════════════════
// resolveTimeRange — Single Source of Truth for Time Filter Resolution
//
// Converts symbolic time filters (e.g. "this_month", "last_90_days",
// "last_2_cyears") into concrete { start, end } date strings.
//
// Used by:
//   1. buildQueryPlan.ts → QueryPlan range filters
//   2. evaluateLocally.ts → legacy deterministic engine
//   3. comparisonEngine.ts → comparison period calculation
//
// Having one canonical implementation eliminates drift between the
// three consumers and prevents off-by-one bugs.
// ═══════════════════════════════════════════════════════════════════

import { DateRange } from './dateHelpers';

export interface TimeRange {
    start: string;
    end: string;
}

/**
 * Resolve a symbolic time filter into a concrete date range.
 *
 * @param timeFilter - Symbolic filter string (e.g. "this_month", "last_7_days", "last_2_cyears")
 * @param dates - The DateRange object containing reference dates (today, monday, etc.)
 * @returns { start, end } date strings, or null if the filter is "all_time" or empty
 */
export function resolveTimeRange(
    timeFilter: string | undefined,
    dates: DateRange,
): TimeRange | null {
    if (!timeFilter || timeFilter === '' || timeFilter === 'all_time') return null;

    const today = new Date(`${dates.today}T00:00:00Z`);
    const fmt = (d: Date) => d.toISOString().split('T')[0];

    let start: string | undefined;
    let end: string = dates.today;

    switch (timeFilter) {
        case 'today':
            start = dates.today;
            end = dates.today;
            break;

        case 'yesterday':
            start = dates.yesterday;
            end = dates.yesterday;
            break;

        case 'this_week':
            start = dates.monday;
            break;

        case 'last_7_days':
            start = dates.last_7_days || fmt(new Date(Date.UTC(
                today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 7
            )));
            break;

        case 'this_month':
            start = dates.this_month_start;
            break;

        case 'last_30_days':
            start = dates.last_30_days || fmt(new Date(Date.UTC(
                today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 30
            )));
            break;

        case 'last_90_days': {
            const d = new Date(today);
            d.setUTCDate(d.getUTCDate() - 90);
            start = fmt(d);
            break;
        }

        case 'this_quarter': {
            const qMonth = Math.floor(today.getUTCMonth() / 3) * 3;
            start = fmt(new Date(Date.UTC(today.getUTCFullYear(), qMonth, 1)));
            break;
        }

        case 'this_year':
            start = dates.year_start;
            break;

        case 'last_year':
            start = dates.last_year_start;
            end = fmt(new Date(Date.UTC(today.getUTCFullYear() - 1, 11, 31)));
            break;

        default: {
            // Dynamic: last_N_unit (e.g. last_5_days, last_2_weeks, last_3_months, last_1_cyears)
            const match = timeFilter.match(/^last_(\d+)_(c?[a-z]+)$/);
            if (match) {
                const n = Math.min(parseInt(match[1], 10), 3650); // Safety cap
                const unit = match[2];

                if (unit === 'cyears') {
                    // CALENDAR YEAR MODE: "Last 1 Calendar Year" = previous full calendar year
                    const asOfYear = today.getUTCFullYear();
                    start = fmt(new Date(Date.UTC(asOfYear - n, 0, 1)));
                    end = fmt(new Date(Date.UTC(asOfYear - 1, 11, 31)));
                } else {
                    // TRAILING MODE: rolling window from today
                    const target = new Date(today);
                    if (unit === 'days') target.setUTCDate(today.getUTCDate() - n);
                    else if (unit === 'weeks') target.setUTCDate(today.getUTCDate() - n * 7);
                    else if (unit === 'months') target.setUTCMonth(today.getUTCMonth() - n);
                    else if (unit === 'years') target.setUTCFullYear(today.getUTCFullYear() - n);
                    start = fmt(target);
                }
            }
            break;
        }
    }

    if (!start) return null;
    return { start, end };
}
