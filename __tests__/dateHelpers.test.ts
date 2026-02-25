import { describe, it, expect } from 'vitest';
import { getDates, excelDateToJSDate } from '../services/dateHelpers';

describe('getDates', () => {
    it('returns correct today and yesterday', () => {
        const dates = getDates('2025-03-15');
        expect(dates.today).toBe('2025-03-15');
        expect(dates.yesterday).toBe('2025-03-14');
    });

    it('calculates monday of the current week', () => {
        // 2025-03-15 is a Saturday
        const dates = getDates('2025-03-15');
        expect(dates.monday).toBe('2025-03-10');
    });

    it('calculates monday of a Monday input', () => {
        const dates = getDates('2025-03-10');
        expect(dates.monday).toBe('2025-03-10');
    });

    it('calculates this_month_start', () => {
        const dates = getDates('2025-06-22');
        expect(dates.this_month_start).toBe('2025-06-01');
    });

    it('calculates last_month_start', () => {
        const dates = getDates('2025-06-22');
        expect(dates.last_month_start).toBe('2025-05-01');
    });

    it('calculates year_start and last_year_start', () => {
        const dates = getDates('2025-08-10');
        expect(dates.year_start).toBe('2025-01-01');
        expect(dates.last_year_start).toBe('2024-01-01');
    });

    it('handles year boundary', () => {
        const dates = getDates('2025-01-01');
        expect(dates.yesterday).toBe('2024-12-31');
        expect(dates.year_start).toBe('2025-01-01');
        expect(dates.last_year_start).toBe('2024-01-01');
        expect(dates.last_month_start).toBe('2024-12-01');
    });

    it('strips time from ISO strings', () => {
        const dates = getDates('2025-05-20T14:30:00.000Z');
        expect(dates.today).toBe('2025-05-20');
    });

    it('calculates last_30_days correctly', () => {
        const dates = getDates('2025-04-10');
        expect(dates.last_30_days).toBe('2025-03-11');
    });
});

describe('excelDateToJSDate', () => {
    it('converts Excel serial 1 to 1900-01-01', () => {
        const d = excelDateToJSDate(1);
        expect(d.getFullYear()).toBe(1899);
        expect(d.getMonth()).toBe(11); // December (0-indexed)
        expect(d.getDate()).toBe(31);
    });

    it('converts Excel serial 44927 correctly (2023-01-01)', () => {
        const d = excelDateToJSDate(44927);
        // 44927 = Jan 1, 2023
        expect(d.getFullYear()).toBe(2023);
        expect(d.getMonth()).toBe(0); // Jan
        expect(d.getDate()).toBe(1);
    });
});
