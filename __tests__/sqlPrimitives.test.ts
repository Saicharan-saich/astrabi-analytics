/**
 * Shared SQL primitives — one source of truth for both deterministic engines.
 * Locks the date-range contract that both compileSQL and correctSQL now share.
 */
import { describe, it, expect } from 'vitest';
import { dateRangePredicate, numericCast, escapeSqlString } from '../services/queryPlan/sqlPrimitives';

describe('dateRangePredicate', () => {
    it('casts the column to DATE (safe on text-loaded date columns) and is inclusive', () => {
        expect(dateRangePredicate('"order_date"', '2024-05-01', '2024-05-31'))
            .toBe(`CAST("order_date" AS DATE) BETWEEN DATE '2024-05-01' AND DATE '2024-05-31'`);
    });
    it('supports open-ended ranges', () => {
        expect(dateRangePredicate('"d"', '2024-01-01', undefined)).toBe(`CAST("d" AS DATE) >= DATE '2024-01-01'`);
        expect(dateRangePredicate('"d"', undefined, '2024-12-31')).toBe(`CAST("d" AS DATE) <= DATE '2024-12-31'`);
    });
    it('never emits a bare column vs DATE literal (the VARCHAR-vs-DATE crash)', () => {
        const sql = dateRangePredicate('"order_date"', '2024-05-01', '2024-05-31');
        expect(sql).toContain('CAST(');
        expect(sql).not.toMatch(/"order_date"\s+BETWEEN/);
    });
});

describe('numericCast', () => {
    it('uses TRY_CAST so text-loaded numbers do not throw', () => {
        expect(numericCast('"total_price"')).toBe('TRY_CAST("total_price" AS DOUBLE)');
    });
});

describe('escapeSqlString', () => {
    it('doubles single quotes', () => {
        expect(escapeSqlString("O'Brien")).toBe("O''Brien");
    });
});
