// --- DATE HELPERS ---

/** Zero-pad a number to 2 digits */
export const pad = (n: number): string => n.toString().padStart(2, '0');

/** Get ISO week number for a date */
export const getISOWeek = (date: Date): number => {
    const target = new Date(date.valueOf());
    const dayNr = (date.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = target.valueOf();
    target.setMonth(0, 1);
    if (target.getDay() !== 4) {
        target.setMonth(0, 1 + ((4 - target.getDay() + 7) % 7));
    }
    return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
};

export const excelDateToJSDate = (serial: number) => {
    // Excel base date is Dec 30, 1899. 
    const utc_days = Math.floor(serial - 25569);
    const utc_value = utc_days * 86400;
    const date_info = new Date(utc_value * 1000);
    return new Date(date_info.getUTCFullYear(), date_info.getUTCMonth(), date_info.getUTCDate());
};

export interface DateRange {
    today: string;
    yesterday: string;
    monday: string;
    last_week_today: string;
    last_week_monday: string;
    prev_monday: string;
    this_month_start: string;
    last_month_start: string;
    this_quarter_start: string;
    last_quarter_start: string;
    last_quarter_end: string;
    py_quarter_start: string;
    py_quarter_end: string;
    py_month_start: string;
    py_month_end: string;
    year_start: string;
    last_year_start: string;
    last_year_today: string;
    last_7_days: string;
    last_30_days: string;
    last_90_days?: string;
}

export const getDates = (asOf: string): DateRange => {
    // Robust Date Math using UTC to avoid timezone shifts
    // 1. Anchor to UTC Midnight of the given date string
    const asOfString = asOf.includes('T') ? asOf.split('T')[0] : asOf;
    const today = new Date(`${asOfString}T00:00:00Z`); // Explicit UTC Midnight

    // Helper: Subtract days in UTC
    const subDays = (d: Date, n: number) => {
        const copy = new Date(d);
        copy.setUTCDate(copy.getUTCDate() - n);
        return copy;
    };

    const yesterday = subDays(today, 1);

    // Day of week (0=Sun, 1=Mon... in UTC)
    const day = today.getUTCDay() || 7; // 1=Mon, ..., 7=Sun
    // Monday of this week: Subtract (day - 1) days
    const monday = subDays(today, day - 1);

    const prevMonday = subDays(monday, 7);
    const lastWeekToday = subDays(today, 7);
    const lastWeekMonday = subDays(monday, 7);

    const thisMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const lastMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));

    // Quarter calculations
    const currentQuarterMonth = Math.floor(today.getUTCMonth() / 3) * 3;
    const thisQuarterStart = new Date(Date.UTC(today.getUTCFullYear(), currentQuarterMonth, 1));
    const lastQuarterStart = new Date(Date.UTC(today.getUTCFullYear(), currentQuarterMonth - 3, 1));
    const lastQuarterEnd = new Date(Date.UTC(today.getUTCFullYear(), currentQuarterMonth, 0)); // last day of prev quarter

    // Prior Year same quarter (PY QTD)
    const pyQuarterStart = new Date(Date.UTC(today.getUTCFullYear() - 1, currentQuarterMonth, 1));
    const pyQuarterEnd = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()));

    // Prior Year same month (PY MTD)
    const pyMonthStart = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), 1));
    const pyMonthEnd = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()));

    const yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    const lastYearStart = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1));
    const lastYearToday = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()));

    const fmt = (d: Date) => d.toISOString().split('T')[0];

    return {
        today: fmt(today),
        yesterday: fmt(yesterday),
        monday: fmt(monday),
        last_week_today: fmt(lastWeekToday),
        last_week_monday: fmt(lastWeekMonday),
        prev_monday: fmt(prevMonday),
        this_month_start: fmt(thisMonthStart),
        last_month_start: fmt(lastMonthStart),
        this_quarter_start: fmt(thisQuarterStart),
        last_quarter_start: fmt(lastQuarterStart),
        last_quarter_end: fmt(lastQuarterEnd),
        py_quarter_start: fmt(pyQuarterStart),
        py_quarter_end: fmt(pyQuarterEnd),
        py_month_start: fmt(pyMonthStart),
        py_month_end: fmt(pyMonthEnd),
        year_start: fmt(yearStart),
        last_year_start: fmt(lastYearStart),
        last_year_today: fmt(lastYearToday),
        // Aliases for SQL generation
        last_7_days: fmt(lastWeekToday),
        last_30_days: fmt(subDays(today, 30))
    };
};
