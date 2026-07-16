import { describe, it, expect } from 'vitest';
import { toTitleCase, roleConfidenceFor } from '../services/etlPipeline';
import { ColumnType } from '../types';

const P = (o: Partial<{ distinctCount: number; totalValues: number; numericParseRate: number; dateParseRate: number; booleanTokenRate: number }>) =>
    ({ distinctCount: 0, totalValues: 100, numericParseRate: 0, dateParseRate: 0, booleanTokenRate: 0, ...o });
const S = (o: Partial<{ isIdName: boolean; isDateName: boolean; isMetricName: boolean; effectiveNumericRate: number }>) =>
    ({ isIdName: false, isDateName: false, isMetricName: false, effectiveNumericRate: 0, ...o });

describe('roleConfidenceFor — advisory role confidence', () => {
    it('ID by name is high confidence', () => {
        expect(roleConfidenceFor(ColumnType.ID, P({}), S({ isIdName: true })).confidence).toBeGreaterThan(0.85);
    });
    it('low-cardinality numeric ID (no id-name) is flagged low', () => {
        const r = roleConfidenceFor(ColumnType.ID, P({ distinctCount: 5, totalValues: 500, numericParseRate: 1 }), S({}));
        expect(r.confidence).toBeLessThan(0.6);
        expect(r.reason).toMatch(/category|year/i);
    });
    it('date with high parse rate is high confidence', () => {
        expect(roleConfidenceFor(ColumnType.DATE, P({ dateParseRate: 0.95 }), S({})).confidence).toBeGreaterThan(0.9);
    });
    it('named numeric metric is high confidence', () => {
        expect(roleConfidenceFor(ColumnType.METRIC, P({ numericParseRate: 1 }), S({ isMetricName: true, effectiveNumericRate: 1 })).confidence).toBeGreaterThan(0.85);
    });
    it('numeric column treated as a dimension is flagged low', () => {
        expect(roleConfidenceFor(ColumnType.DIMENSION, P({}), S({ effectiveNumericRate: 0.9 })).confidence).toBeLessThan(0.6);
    });
    it('clearly-text dimension is confident', () => {
        expect(roleConfidenceFor(ColumnType.DIMENSION, P({ distinctCount: 5 }), S({ effectiveNumericRate: 0 })).confidence).toBeGreaterThan(0.8);
    });
});

describe('toTitleCase — preservation-aware casing', () => {
    // ── Normalizes plain words with inconsistent casing ──
    it('normalizes lower/upper plain words', () => {
        expect(toTitleCase('north america')).toBe('North America');
        expect(toTitleCase('NORTH AMERICA')).toBe('North America');
        expect(toTitleCase('retail store')).toBe('Retail Store');
        expect(toTitleCase('ONLINE')).toBe('Online');
    });

    // ── Preserves brand / camelCase names (the corruption bug) ──
    it('preserves brand names with internal capitals', () => {
        expect(toTitleCase('iPhone 15 Pro')).toBe('iPhone 15 Pro');
        expect(toTitleCase('MacBook Pro')).toBe('MacBook Pro');
        expect(toTitleCase('AirPods Pro')).toBe('AirPods Pro');
        expect(toTitleCase('eBay')).toBe('eBay');
        expect(toTitleCase('iPad Air')).toBe('iPad Air');
    });

    // ── Preserves alphanumeric codes / model numbers ──
    it('preserves alphanumeric codes and model numbers', () => {
        expect(toTitleCase('Sony WH-1000XM5')).toBe('Sony WH-1000XM5');
        expect(toTitleCase('Samsung Galaxy S24')).toBe('Samsung Galaxy S24');
        expect(toTitleCase('PS5')).toBe('PS5');
        expect(toTitleCase('LG UltraWide 34"')).toBe('LG UltraWide 34"');
    });

    // ── Preserves short acronyms ──
    it('preserves short acronyms', () => {
        expect(toTitleCase('USA')).toBe('USA');
        expect(toTitleCase('NYC')).toBe('NYC');
        expect(toTitleCase('IBM')).toBe('IBM');
        expect(toTitleCase('EU')).toBe('EU');
        // Multi-word all-caps that are really words still normalize:
        expect(toTitleCase('UNITED KINGDOM')).toBe('United Kingdom');
    });

    // ── Mixed real-world value ──
    it('handles mixed brand + plain words', () => {
        expect(toTitleCase('apple iPhone')).toBe('Apple iPhone');
        // 4-char all-caps is indistinguishable from an acronym (USA/IBM), so it is
        // preserved rather than risk corrupting a real acronym — a deliberate
        // preserve-over-corrupt tradeoff. Codes with digits are always preserved.
        expect(toTitleCase('SONY wh-1000xm5')).toBe('SONY wh-1000xm5');
    });

    it('leaves already-correct values unchanged', () => {
        expect(toTitleCase('Latin America')).toBe('Latin America');
        expect(toTitleCase('Enterprise')).toBe('Enterprise');
    });
});
