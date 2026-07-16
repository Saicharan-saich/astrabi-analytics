import { describe, it, expect } from 'vitest';
import { toTitleCase, roleConfidenceFor, keySignalFor, classifyColumnRole } from '../services/etlPipeline';
import { ColumnType } from '../types';

// Minimal profile builder for direct rule testing.
const prof = (o: any) => ({
    name: 'col', nullRate: 0, distinctCount: 10, totalValues: 100, numericParseRate: 0,
    dateParseRate: 0, booleanTokenRate: 0, dateFormatCandidate: null, currencyDetected: false,
    percentageDetected: false, wordNumberRate: 0, integerRate: 0, looksSequential: false, ...o,
});

describe('classifyColumnRole — ordered named rules, first match wins', () => {
    it('R1: ID by name pattern wins over everything', () => {
        expect(classifyColumnRole(prof({ name: 'order_id', numericParseRate: 1, integerRate: 1 })).type).toBe(ColumnType.ID);
    });
    it('R2: date by parse rate', () => {
        expect(classifyColumnRole(prof({ name: 'when', dateParseRate: 0.8 })).type).toBe(ColumnType.DATE);
    });
    it('R3: date by name', () => {
        expect(classifyColumnRole(prof({ name: 'created_at', dateParseRate: 0.1 })).type).toBe(ColumnType.DATE);
    });
    it('R4: metric by name + numeric beats boolean tokens', () => {
        // mostly 1/0 tokens but named "quantity" → METRIC, not BOOLEAN
        expect(classifyColumnRole(prof({ name: 'quantity', numericParseRate: 1, integerRate: 1, booleanTokenRate: 0.9 })).type).toBe(ColumnType.METRIC);
    });
    it('R5: boolean tokens', () => {
        expect(classifyColumnRole(prof({ name: 'is_active', booleanTokenRate: 0.8 })).type).toBe(ColumnType.BOOLEAN);
    });
    it('R6: data-driven key (near-unique integers) with a note', () => {
        const d = classifyColumnRole(prof({ name: 'reference', numericParseRate: 1, integerRate: 1, distinctCount: 100, totalValues: 100 }));
        expect(d.type).toBe(ColumnType.ID);
        expect(d.note?.label).toBe('Key Detection');
    });
    it('R7: numeric business metric', () => {
        expect(classifyColumnRole(prof({ name: 'sales', numericParseRate: 1, distinctCount: 90, totalValues: 100, min: 100, max: 9000 })).type).toBe(ColumnType.METRIC);
    });
    it('R7: numeric attribute → dimension with a note', () => {
        const d = classifyColumnRole(prof({ name: 'age', numericParseRate: 1, integerRate: 1, distinctCount: 40, totalValues: 100, min: 18, max: 65 }));
        expect(d.type).toBe(ColumnType.DIMENSION);
        expect(d.note?.label).toBe('Attribute Detection');
    });
    it('R9: default is dimension', () => {
        expect(classifyColumnRole(prof({ name: 'category', distinctCount: 5 })).type).toBe(ColumnType.DIMENSION);
    });
});

const K = (o: Partial<{ distinctCount: number; totalValues: number; numericParseRate: number; currencyDetected: boolean; percentageDetected: boolean; integerRate: number; looksSequential: boolean }>) =>
    ({ distinctCount: 0, totalValues: 100, numericParseRate: 1, currencyDetected: false, percentageDetected: false, integerRate: 1, looksSequential: false, ...o });

describe('keySignalFor — data-driven key detection', () => {
    it('near-unique integer column is a key', () => {
        const r = keySignalFor(K({ distinctCount: 100, totalValues: 100 }), false);
        expect(r.isKey).toBe(true);
        expect(r.reason).toMatch(/near-unique/i);
    });
    it('sequential integer run is a serial key', () => {
        const r = keySignalFor(K({ distinctCount: 500, totalValues: 500, looksSequential: true }), false);
        expect(r.isKey).toBe(true);
        expect(r.reason).toMatch(/sequential|serial/i);
    });
    it('strong metric name is never a key', () => {
        expect(keySignalFor(K({ distinctCount: 100, totalValues: 100 }), true).isKey).toBe(false);
    });
    it('currency-formatted column is never a key', () => {
        expect(keySignalFor(K({ distinctCount: 100, totalValues: 100, currencyDetected: true }), false).isKey).toBe(false);
    });
    it('decimal (non-integer) numeric is not a key', () => {
        expect(keySignalFor(K({ distinctCount: 100, totalValues: 100, integerRate: 0.4 }), false).isKey).toBe(false);
    });
    it('repeating low-cardinality integers (e.g. quantity) are not a key', () => {
        expect(keySignalFor(K({ distinctCount: 8, totalValues: 500 }), false).isKey).toBe(false);
    });
    it('non-numeric column is not a key', () => {
        expect(keySignalFor(K({ distinctCount: 100, totalValues: 100, numericParseRate: 0.1, integerRate: 0 }), false).isKey).toBe(false);
    });
});

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
