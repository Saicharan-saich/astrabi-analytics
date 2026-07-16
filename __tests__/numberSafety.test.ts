import { describe, it, expect } from 'vitest';
import { finiteOrNull, roundTo, round2, sanitizeRow, sanitizeRows } from '../utils/numberSafety';

describe('finiteOrNull', () => {
    it('passes finite numbers through', () => {
        expect(finiteOrNull(0)).toBe(0);
        expect(finiteOrNull(-42.5)).toBe(-42.5);
        expect(finiteOrNull(1e9)).toBe(1e9);
    });
    it('converts non-finite numbers to null', () => {
        expect(finiteOrNull(NaN)).toBe(null);
        expect(finiteOrNull(Infinity)).toBe(null);
        expect(finiteOrNull(-Infinity)).toBe(null);
        expect(finiteOrNull(1 / 0)).toBe(null);
        expect(finiteOrNull(0 / 0)).toBe(null);
    });
    it('leaves non-numbers untouched', () => {
        expect(finiteOrNull('North')).toBe('North');
        expect(finiteOrNull(null)).toBe(null);
        expect(finiteOrNull(undefined)).toBe(undefined);
    });
});

describe('roundTo / round2', () => {
    it('strips float precision noise', () => {
        expect(round2(33.33333333333336)).toBe(33.33);
        expect(round2(0.1 + 0.2)).toBe(0.3);
        expect(roundTo(1.005, 2)).toBe(1.01);
        expect(roundTo(123.456, 1)).toBe(123.5);
    });
    it('leaves non-finite values for finiteOrNull to catch', () => {
        expect(round2(Infinity)).toBe(Infinity);
        expect(Number.isNaN(round2(NaN))).toBe(true);
    });
});

describe('sanitizeRow / sanitizeRows', () => {
    it('cleans non-finite numeric fields to null, keeps the rest', () => {
        const row = { region: 'West', sales: 1200, growth_pct: Infinity, margin: NaN };
        expect(sanitizeRow(row)).toEqual({ region: 'West', sales: 1200, growth_pct: null, margin: null });
    });
    it('sanitizes an array of rows', () => {
        const rows = [
            { x: 'A', v: 10 },
            { x: 'B', v: 1 / 0 },
            { x: 'C', v: 0 / 0 },
        ];
        expect(sanitizeRows(rows)).toEqual([
            { x: 'A', v: 10 },
            { x: 'B', v: null },
            { x: 'C', v: null },
        ]);
    });
    it('handles primitives and non-arrays safely', () => {
        expect(sanitizeRows([Infinity, 5, NaN] as any)).toEqual([null, 5, null]);
        expect(sanitizeRows(null as any)).toBe(null);
    });
});
