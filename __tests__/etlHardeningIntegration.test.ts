/**
 * ETL hardening — INTEGRATION: proves the new passes are actually wired into
 * runETLPipeline (not just unit-correct in isolation), and that number
 * correctness improves end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';

const flagText = (logs: any[]) => logs.map(l => `${l.step}: ${l.details}`).join('\n');

describe('runETLPipeline — correctness hardening wired end-to-end', () => {
    it('recovers EU-format and accountant numbers instead of nulling them', () => {
        const rows = [
            { id: 1, region: 'North', amount: '1.234,56' },   // EU decimal
            { id: 2, region: 'North', amount: '2.000,00' },   // EU decimal
            { id: 3, region: 'North', amount: '(500)' },      // accountant negative
            { id: 4, region: 'North', amount: '1.2K' },       // magnitude suffix
        ];
        const etl = runETLPipeline(rows, 'eu.csv');
        const amounts = etl.rows.map(r => r.amount);
        // Old pipeline would have produced null / NaN for these; now they're real numbers.
        expect(amounts).toEqual([1234.56, 2000, -500, 1200]);
        const total = amounts.reduce((a, b) => a + Number(b), 0);
        expect(total).toBeCloseTo(1234.56 + 2000 - 500 + 1200, 2);
    });

    it('canonicalizes spelling variants of a category (safe auto-merge)', () => {
        const rows = Array.from({ length: 12 }, (_, i) => ({
            id: i, country: ['United States', 'united states', 'UNITED STATES', 'United  States'][i % 4], sales: 100 + i,
        }));
        const etl = runETLPipeline(rows, 'c.csv');
        const distinct = new Set(etl.rows.map(r => r.country));
        // All four spellings collapse to a single canonical value.
        expect(distinct.size).toBe(1);
    });

    it('repairs mojibake in text', () => {
        const rows = Array.from({ length: 6 }, (_, i) => ({ id: i, name: 'Café', v: i }));
        const etl = runETLPipeline(rows, 'm.csv');
        expect(etl.rows.every(r => r.name === 'Café')).toBe(true);
    });

    it('FLAGS an outlier without deleting it', () => {
        const rows = [
            ...Array.from({ length: 30 }, (_, i) => ({ id: i, salary: 50000 + (i % 5) * 1000 })),
            { id: 99, salary: 99999999 }, // fat-fingered
        ];
        const etl = runETLPipeline(rows, 'o.csv');
        // The value is still present (not removed) …
        expect(etl.rows.some(r => Number(r.salary) === 99999999)).toBe(true);
        // … but it's flagged for review.
        expect(flagText(etl.logs)).toMatch(/Outlier Flag[\s\S]*salary/i);
    });

    it('FLAGS negative values in a non-negative column', () => {
        const rows = Array.from({ length: 15 }, (_, i) => ({ id: i, quantity: i === 3 ? -4 : (i + 1) }));
        const etl = runETLPipeline(rows, 's.csv');
        expect(flagText(etl.logs)).toMatch(/Sign Anomaly Flag[\s\S]*quantity/i);
    });

    it('FLAGS high missingness so silent partial-averages are visible', () => {
        const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, score: i < 6 ? 10 + i : null }));
        const etl = runETLPipeline(rows, 'miss.csv');
        expect(flagText(etl.logs)).toMatch(/Missing Data Flag[\s\S]*score/i);
    });
});
