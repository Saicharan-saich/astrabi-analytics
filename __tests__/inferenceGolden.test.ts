/**
 * Golden inference harness — proves the app infers roles + measure semantics
 * correctly across diverse, differently-shaped datasets ("no matter what they
 * upload"). Runs the REAL ETL pipeline for roles, and the semantic measure
 * classifier for aggregation/format. Pure/local — no DuckDB, no AI.
 */
import { describe, it, expect } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { ColumnType, AggregationType } from '../types';
import { classifyMeasure, computeMeasureProfile } from '../services/metricRegistry';

function roleOf(rows: any[], name: string): ColumnType | undefined {
    const { columns } = runETLPipeline(rows, 'golden.csv');
    return columns.find(c => c.name === name)?.type;
}
function measureOf(rows: any[], name: string) {
    return classifyMeasure(name, computeMeasureProfile(rows.map(r => r[name])));
}

// ── Deterministic dataset generators (index-based, no randomness) ──
function retail(n = 80) {
    const seg = ['Consumer', 'Corporate', 'Home Office'], reg = ['East', 'West', 'Central', 'South'];
    return Array.from({ length: n }, (_, i) => ({
        order_id: 10000 + i,
        order_date: `2024-${String((i % 12) + 1).padStart(2, '0')}-15`,
        product_name: `Product ${i % 12}`,
        segment: seg[i % 3], region: reg[i % 4],
        sales: 100 + (i * 37) % 4000, quantity: 1 + (i % 12),
        discount: (i % 80) / 100,                       // 0–0.79 rate
        profit: -50 + (i * 13) % 900,
    }));
}
function marketing(n = 80) {
    const ch = ['Search', 'Social', 'Email', 'Display'];
    return Array.from({ length: n }, (_, i) => ({
        campaign_id: `C${1000 + i}`,
        date: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
        channel: ch[i % 4],
        impressions: 5000 + (i * 311) % 90000,
        clicks: 20 + (i * 7) % 900,
        conversion_rate: ((i * 3) % 60) / 100,          // 0–0.59 rate
        spend: 200 + (i * 53) % 8000,
    }));
}
function hr(n = 80) {
    const dep = ['Engineering', 'Sales', 'HR', 'Finance', 'Ops'];
    return Array.from({ length: n }, (_, i) => ({
        employee_id: 5000 + i,
        hire_date: `20${18 + (i % 6)}-06-01`,
        department: dep[i % 5],
        salary: 40000 + (i * 971) % 90000,
        performance_rating: 1 + (i % 5),                // 1–5
    }));
}
// Currency written with glyphs, and a foreign column name.
function foreign(n = 60) {
    return Array.from({ length: n }, (_, i) => ({
        id: `TX${i}`,
        montant: `$${(100 + i * 7).toLocaleString()}`,  // currency glyph, non-English name
        taux: (i % 100) / 100,                            // "rate" in French, 0–0.99
    }));
}

describe('Golden inference — ETL roles', () => {
    it('retail: ids/dates/dims/metrics land in the right roles', () => {
        const r = retail();
        expect(roleOf(r, 'order_id')).toBe(ColumnType.ID);
        expect(roleOf(r, 'order_date')).toBe(ColumnType.DATE);
        expect(roleOf(r, 'segment')).toBe(ColumnType.DIMENSION);
        expect(roleOf(r, 'region')).toBe(ColumnType.DIMENSION);
        expect(roleOf(r, 'sales')).toBe(ColumnType.METRIC);
        expect(roleOf(r, 'profit')).toBe(ColumnType.METRIC);
    });
    it('marketing: id/date/dimension detected', () => {
        const r = marketing();
        expect(roleOf(r, 'campaign_id')).toBe(ColumnType.ID);
        expect(roleOf(r, 'date')).toBe(ColumnType.DATE);
        expect(roleOf(r, 'channel')).toBe(ColumnType.DIMENSION);
        expect(roleOf(r, 'spend')).toBe(ColumnType.METRIC);
    });
    it('hr: id/date/dimension detected', () => {
        const r = hr();
        expect(roleOf(r, 'employee_id')).toBe(ColumnType.ID);
        expect(roleOf(r, 'hire_date')).toBe(ColumnType.DATE);
        expect(roleOf(r, 'department')).toBe(ColumnType.DIMENSION);
        expect(roleOf(r, 'salary')).toBe(ColumnType.METRIC);
    });
});

describe('Golden inference — measure semantics (aggregation + format)', () => {
    it('retail measures', () => {
        const r = retail();
        expect(measureOf(r, 'sales')).toMatchObject({ aggregation: AggregationType.SUM, format: 'currency_usd' });
        expect(measureOf(r, 'quantity')).toMatchObject({ aggregation: AggregationType.SUM });
        expect(measureOf(r, 'discount')).toMatchObject({ aggregation: AggregationType.AVG, format: 'percent' });
        expect(measureOf(r, 'profit')).toMatchObject({ aggregation: AggregationType.SUM, format: 'currency_usd' });
    });
    it('marketing: conversion_rate → avg %, spend → currency', () => {
        const r = marketing();
        expect(measureOf(r, 'conversion_rate')).toMatchObject({ aggregation: AggregationType.AVG, format: 'percent' });
        expect(measureOf(r, 'spend')).toMatchObject({ aggregation: AggregationType.SUM, format: 'currency_usd' });
    });
    it('hr: salary → currency SUM, rating → avg', () => {
        const r = hr();
        expect(measureOf(r, 'salary')).toMatchObject({ aggregation: AggregationType.SUM, format: 'currency_usd' });
        expect(measureOf(r, 'performance_rating')).toMatchObject({ aggregation: AggregationType.AVG });
    });
    it('foreign/adversarial: currency glyph + foreign rate name', () => {
        const r = foreign();
        // "montant" has $ glyphs in the values → currency, regardless of the name
        expect(measureOf(r, 'montant')).toMatchObject({ aggregation: AggregationType.SUM, format: 'currency_usd' });
        // "taux" (rate) values in 0–1 → inferred rate even with an unknown name
        expect(measureOf(r, 'taux')).toMatchObject({ aggregation: AggregationType.AVG, format: 'percent' });
    });
});
