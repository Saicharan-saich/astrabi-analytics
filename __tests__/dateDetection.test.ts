/**
 * Date detection must not be fooled by labels that contain a number.
 *
 * new Date("Employee 10") returns 2001-10-01 — JavaScript ignores the word and
 * reads "10" as a month. The old guard ("longer than 10 characters and contains
 * a letter") let that through, so employee_name and customer_name were
 * classified as DATE columns. Their fabricated 1950–2049 range then became the
 * dataset's time context, dim_date generated 36,161 rows, and charts drew
 * decades of empty quarters for a dataset containing only 2025.
 */
import { describe, it, expect } from 'vitest';
import { runAutomatedETL } from '../services/analysisEngine';

const rows = Array.from({ length: 60 }, (_, i) => ({
    order_id: i + 1,
    employee_name: `Employee ${i + 1}`,
    customer_name: `Customer ${i + 1}`,
    order_date: `2025-${String((i % 12) + 1).padStart(2, '0')}-15`,
    amount: 100 + i,
}));

describe('labels containing numbers are not dates', () => {
    const res: any = runAutomatedETL(rows, 'names.csv');
    const typeOf = (n: string) => res.columns.find((c: any) => c.name === n)?.type;

    it('classifies "Employee 10" style labels as dimensions, not dates', () => {
        expect(typeOf('employee_name')).not.toBe('DATE');
        expect(typeOf('customer_name')).not.toBe('DATE');
    });

    it('still detects the genuine date column', () => {
        expect(typeOf('order_date')).toBe('DATE');
    });

    it('derives the time context from real dates only', () => {
        // Not 1950..2049, which is what the fake date columns produced.
        expect(res.timeContext.minDate.slice(0, 4)).toBe('2025');
        expect(res.timeContext.maxDate.slice(0, 4)).toBe('2025');
        expect(Object.keys(res.timeContext.dateColumnMaxDates)).toEqual(['order_date']);
    });
});

describe('genuine written dates still parse', () => {
    it('accepts long-form date strings', () => {
        const written = Array.from({ length: 40 }, (_, i) => ({
            id: i + 1,
            logged_at: `Tue Nov 0${(i % 9) + 1} 2016 00:00:00 GMT+0000`,
            amount: i,
        }));
        const res: any = runAutomatedETL(written, 'written.csv');
        expect(res.columns.find((c: any) => c.name === 'logged_at')?.type).toBe('DATE');
        expect(res.timeContext.minDate.slice(0, 4)).toBe('2016');
    });

    it('accepts plain ISO dates', () => {
        const iso = Array.from({ length: 40 }, (_, i) => ({
            id: i + 1,
            d: `2023-0${(i % 9) + 1}-10`,
            amount: i,
        }));
        const res: any = runAutomatedETL(iso, 'iso.csv');
        expect(res.columns.find((c: any) => c.name === 'd')?.type).toBe('DATE');
    });
});
