import { describe, it, expect } from 'vitest';
import { classifyMeasure, computeMeasureProfile } from '../services/metricRegistry';
import { AggregationType } from '../types';

describe('computeMeasureProfile — stats only, no raw values', () => {
    it('captures numeric range and ignores nulls/blanks', () => {
        const p = computeMeasureProfile([0.1, 0.5, '0.8', null, '', 0.2]);
        expect(p.min).toBeCloseTo(0.1);
        expect(p.max).toBeCloseTo(0.8);
        expect(p.totalValues).toBe(4);
        expect(p.percentSignPresent).toBe(false);
        expect(p.currencyGlyphPresent).toBe(false);
    });
    it('detects % and currency glyphs in raw values', () => {
        expect(computeMeasureProfile(['45%', '12%']).percentSignPresent).toBe(true);
        expect(computeMeasureProfile(['$1,200', '$300']).currencyGlyphPresent).toBe(true);
        expect(computeMeasureProfile(['€99', '€5']).currencyGlyphPresent).toBe(true);
    });
});

describe('classifyMeasure — data disambiguates the name', () => {
    it('discount stored as a 0–1 rate → AVG percent (not summed dollars)', () => {
        const m = classifyMeasure('discount', { min: 0, max: 0.8, totalValues: 100 });
        expect(m.aggregation).toBe(AggregationType.AVG);
        expect(m.format).toBe('percent');
        expect(m.behavior).toBe('non_additive');
    });

    it('sales (large amounts) → SUM currency', () => {
        const m = classifyMeasure('sales', { min: 5, max: 12000, totalValues: 100 });
        expect(m.aggregation).toBe(AggregationType.SUM);
        expect(m.format).toBe('currency_usd');
    });

    it('a literal "%" in the values forces percent regardless of name', () => {
        const m = classifyMeasure('whatever_col', { percentSignPresent: true });
        expect(m.format).toBe('percent');
        expect(m.aggregation).toBe(AggregationType.AVG);
        expect(m.confidence).toBeGreaterThan(0.9);
    });

    it('currency glyph forces currency even for a foreign/unknown name', () => {
        const m = classifyMeasure('montant', { currencyGlyphPresent: true, min: 10, max: 9000 });
        expect(m.format).toBe('currency_usd');
        expect(m.aggregation).toBe(AggregationType.SUM);
    });

    it('unknown name with values in 0–1 → inferred rate', () => {
        const m = classifyMeasure('col_7', { min: 0.02, max: 0.95, totalValues: 50 });
        expect(m.format).toBe('percent');
        expect(m.aggregation).toBe(AggregationType.AVG);
    });

    it('unknown name with large numbers → SUM raw fallback, low confidence', () => {
        const m = classifyMeasure('col_8', { min: 100, max: 99999, totalValues: 50 });
        expect(m.aggregation).toBe(AggregationType.SUM);
        expect(m.format).toBe('raw');
        expect(m.confidence).toBeLessThan(0.6);
    });

    it('a strong currency name stays currency even if values look fractional', () => {
        const m = classifyMeasure('revenue', { min: 0.2, max: 0.9, totalValues: 20 });
        expect(m.format).toBe('currency_usd');
        expect(m.aggregation).toBe(AggregationType.SUM);
    });

    it('margin stored as a ratio → AVG percent (data overrides the currency-ish name)', () => {
        const m = classifyMeasure('margin', { min: 0.05, max: 0.42, totalValues: 200 });
        expect(m.aggregation).toBe(AggregationType.AVG);
        expect(m.format).toBe('percent');
    });
});
