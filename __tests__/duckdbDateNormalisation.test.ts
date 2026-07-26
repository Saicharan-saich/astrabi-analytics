/**
 * DuckDB hands DATE/TIMESTAMP columns back as epoch offsets, not dates. Left
 * raw they rendered as "1,751,241,600,000" in the table and were charted as a
 * giant numeric metric (the "first order per customer" gibberish). They must
 * normalise to the same 'YYYY-MM-DD' strings the rest of the app uses.
 */
import { describe, it, expect } from 'vitest';
import { epochToDateString } from '../services/duckdbEngine';

describe('epochToDateString', () => {
    it('converts epoch milliseconds to a plain date', () => {
        // The exact value seen in the live failure — 2025-06-30.
        expect(epochToDateString(1751241600000)).toBe('2025-06-30');
    });

    it('converts a BigInt millisecond value', () => {
        expect(epochToDateString(BigInt('1751241600000'))).toBe('2025-06-30');
    });

    it('converts Date32 (days since epoch)', () => {
        expect(epochToDateString(20269)).toBe('2025-06-30');
        expect(epochToDateString(0)).toBe('1970-01-01');
    });

    it('converts a JS Date', () => {
        expect(epochToDateString(new Date('2025-06-30T00:00:00Z'))).toBe('2025-06-30');
    });

    it('keeps a real time-of-day on timestamps', () => {
        expect(epochToDateString(1751283045000)).toBe('2025-06-30 11:30:45');
    });

    it('passes through an already-normalised string', () => {
        expect(epochToDateString('2025-06-30')).toBe('2025-06-30');
    });

    it('returns null for null/undefined/garbage rather than NaN', () => {
        expect(epochToDateString(null)).toBeNull();
        expect(epochToDateString(undefined)).toBeNull();
        expect(epochToDateString(Number.NaN)).toBeNull();
        expect(epochToDateString(Infinity)).toBeNull();
    });

    it('never returns a value that would be charted as a number', () => {
        const out = epochToDateString(1751241600000);
        expect(typeof out).toBe('string');
        expect(Number.isFinite(Number(out))).toBe(false);
    });
});
