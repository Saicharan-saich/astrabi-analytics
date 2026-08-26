export type ComparisonPeriodGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface ComparisonPeriodRange {
    start: string;
    end: string;
}

const DAY_MS = 86_400_000;

function parseISO(value: string): Date {
    return new Date(`${value}T00:00:00Z`);
}

function formatISO(value: Date): string {
    return value.toISOString().slice(0, 10);
}

/** Shift a UTC date by calendar months while clamping month-end safely. */
function shiftCalendarMonths(value: Date, months: number): Date {
    const targetMonth = value.getUTCMonth() + months;
    const first = new Date(Date.UTC(value.getUTCFullYear(), targetMonth, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(value.getUTCDate(), lastDay)));
}

/**
 * Resolve the previous comparison window without restricting the source rows to
 * the current filter first.
 *
 * Calendar filters retain their calendar meaning (month-to-date compares with
 * the same days of the prior month, quarter-to-date with the prior quarter,
 * etc.). Rolling/custom day windows use the immediately preceding equally sized
 * range. This makes the helper valid for both Question Builder and AI SQL.
 */
export function previousComparisonPeriod(
    start: string,
    end: string,
    grain?: string,
    offset = 1,
): ComparisonPeriodRange {
    const currentStart = parseISO(start);
    const currentEnd = parseISO(end);
    if (Number.isNaN(currentStart.getTime()) || Number.isNaN(currentEnd.getTime())) {
        return { start, end };
    }

    const safeOffset = Math.max(1, Math.floor(offset || 1));
    const normalizedGrain = String(grain || '').toLowerCase() as ComparisonPeriodGrain;
    let previousStart: Date;
    let previousEnd: Date;

    if (normalizedGrain === 'year') {
        previousStart = shiftCalendarMonths(currentStart, -12 * safeOffset);
        previousEnd = shiftCalendarMonths(currentEnd, -12 * safeOffset);
    } else if (normalizedGrain === 'quarter') {
        previousStart = shiftCalendarMonths(currentStart, -3 * safeOffset);
        previousEnd = shiftCalendarMonths(currentEnd, -3 * safeOffset);
    } else if (normalizedGrain === 'month') {
        previousStart = shiftCalendarMonths(currentStart, -safeOffset);
        previousEnd = shiftCalendarMonths(currentEnd, -safeOffset);
    } else if (normalizedGrain === 'week') {
        previousStart = new Date(currentStart.getTime() - 7 * safeOffset * DAY_MS);
        previousEnd = new Date(currentEnd.getTime() - 7 * safeOffset * DAY_MS);
    } else if (normalizedGrain === 'day') {
        previousStart = new Date(currentStart.getTime() - safeOffset * DAY_MS);
        previousEnd = new Date(currentEnd.getTime() - safeOffset * DAY_MS);
    } else {
        const inclusiveDays = Math.max(1, Math.round((currentEnd.getTime() - currentStart.getTime()) / DAY_MS) + 1);
        const shiftDays = inclusiveDays * safeOffset;
        previousStart = new Date(currentStart.getTime() - shiftDays * DAY_MS);
        previousEnd = new Date(currentEnd.getTime() - shiftDays * DAY_MS);
    }

    return { start: formatISO(previousStart), end: formatISO(previousEnd) };
}
