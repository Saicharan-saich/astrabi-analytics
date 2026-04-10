/**
 * dimDateGenerator.ts — Dynamic Date Dimension Table Generator
 *
 * Generates a continuous date spine from minDate to maxDate with
 * pre-computed calendar attributes for use in time intelligence.
 */

import { DimDateRow } from '../types';

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

const MONTH_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

const DAY_NAMES = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

/**
 * Returns ISO week number (1-53) for a given date.
 * ISO 8601: weeks start on Monday; week 1 contains Jan 4.
 */
function getISOWeekNumber(d: Date): number {
    const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Returns ISO day-of-week: Mon=1, Tue=2, … Sun=7
 */
function getISODayOfWeek(d: Date): number {
    const dow = d.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
    return dow === 0 ? 7 : dow;
}

/**
 * Fiscal year (April start): Apr-Dec → same year + 1, Jan-Mar → same year
 */
function getFiscalYear(month: number, year: number): number {
    return month >= 4 ? year + 1 : year;
}

/**
 * Fiscal quarter (April start):
 *   Apr-Jun → Q1, Jul-Sep → Q2, Oct-Dec → Q3, Jan-Mar → Q4
 */
function getFiscalQuarter(month: number): number {
    if (month >= 4 && month <= 6) return 1;
    if (month >= 7 && month <= 9) return 2;
    if (month >= 10 && month <= 12) return 3;
    return 4; // Jan-Mar
}

/**
 * Generates a continuous DimDate table from minDate to maxDate (inclusive).
 *
 * @param minDate - ISO date string YYYY-MM-DD (start of range)
 * @param maxDate - ISO date string YYYY-MM-DD (end of range)
 * @returns Array of DimDateRow, one per day
 */
export function generateDimDate(minDate: string, maxDate: string): DimDateRow[] {
    if (!minDate || !maxDate || minDate > maxDate) {
        console.warn(`[DimDate] Invalid range: ${minDate} → ${maxDate}`);
        return [];
    }

    const rows: DimDateRow[] = [];
    const start = new Date(minDate + 'T00:00:00Z');
    const end = new Date(maxDate + 'T00:00:00Z');

    const current = new Date(start);

    while (current <= end) {
        const year = current.getUTCFullYear();
        const month = current.getUTCMonth() + 1; // 1-12
        const dayOfMonth = current.getUTCDate();
        const quarter = Math.ceil(month / 3);
        const isoDow = getISODayOfWeek(current);
        const jsDow = current.getUTCDay(); // 0-6 for day name lookup

        const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;

        rows.push({
            date_key: dateKey,
            year,
            quarter,
            quarter_label: `Q${quarter} ${year}`,
            month,
            month_name: MONTH_NAMES[month - 1],
            month_short: MONTH_SHORT[month - 1],
            week_of_year: getISOWeekNumber(current),
            day_of_month: dayOfMonth,
            day_of_week: isoDow,
            day_name: DAY_NAMES[jsDow],
            is_weekend: isoDow >= 6, // Sat=6, Sun=7
            fiscal_year: getFiscalYear(month, year),
            fiscal_quarter: getFiscalQuarter(month),
        });

        // Advance to next day
        current.setUTCDate(current.getUTCDate() + 1);
    }

    console.log(`[DimDate] Generated ${rows.length} date rows: ${minDate} → ${maxDate}`);
    return rows;
}
