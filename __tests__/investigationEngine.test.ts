/**
 * Investigation Engine — analyst reasoning paths + deterministic root-cause.
 *  1. PURE: role→column mapping, domain-aware step ordering, graceful fallback.
 *  2. END-TO-END: buildContributionSQL runs in real DuckDB and rankContributors
 *     correctly attributes a metric drop to the category that caused it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import { AggregationType } from '../types';
import type { SemanticModel } from '../services/semanticModel';
import {
    mapRole, buildInvestigation, buildContributionSQL, rankContributors, summarizeContributors,
} from '../services/investigationEngine';
import type { Finding } from '../services/insightDiscoveryEngine';

function model(dimCols: string[], measureCol = 'revenue'): SemanticModel {
    return {
        dimensions: dimCols.map(c => ({ name: c, column: c, dataType: 'string' as const, isHidden: false })),
        measures: [{ name: measureCol, column: measureCol, aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false, isHidden: false }],
        derivedMeasures: [], relationships: [], primaryDateColumn: 'order_date', dateColumns: ['order_date'],
        grain: null, version: 1, builtAt: 0, source: 'etl', warnings: [],
    };
}

const periodDrop: Finding = {
    id: 'period_change:revenue', type: 'period_change', severity: 'critical',
    headline: 'Revenue fell 50%', detail: '', metric: 'revenue', dimension: 'order_date',
    score: 100, evidence: { changePct: -0.5, previousPeriod: '2024-03', latestPeriod: '2024-04' },
};

describe('mapRole — abstract angle → real column', () => {
    it('matches by name pattern', () => {
        const m = model(['product_category', 'customer_name', 'sales_region']);
        expect(mapRole('category', m)).toBe('product_category');
        expect(mapRole('customer', m)).toBe('customer_name');
        expect(mapRole('region', m)).toBe('sales_region');
    });
    it('returns null when no column fits the role', () => {
        expect(mapRole('insurance', model(['product', 'region']))).toBeNull();
    });
});

describe('buildInvestigation — domain-aware reasoning path', () => {
    it('sales: orders Category → Product → Customer → Region, skipping absent angles', () => {
        const m = model(['category', 'region', 'product']); // no customer/channel
        const inv = buildInvestigation(periodDrop, m, 'Sales');
        expect(inv.steps.map(s => s.dimension)).toEqual(['category', 'product', 'region']);
        // temporal finding → "which X drove the drop" phrasing
        expect(inv.steps[0].question).toMatch(/drove the drop/i);
    });

    it('healthcare uses the clinical path (Facility → Doctor → Condition → Insurance)', () => {
        const m = model(['hospital', 'doctor', 'medical_condition', 'insurance_provider']);
        const inv = buildInvestigation({ ...periodDrop, metric: 'billing_amount' }, m, 'Healthcare');
        expect(inv.steps.map(s => s.dimension)).toEqual(['hospital', 'doctor', 'medical_condition', 'insurance_provider']);
    });

    it('never returns an empty investigation — falls back to top dimensions', () => {
        const m = model(['weird_col_a', 'weird_col_b']); // match no role
        const inv = buildInvestigation(periodDrop, m, 'Mystery');
        expect(inv.steps.length).toBeGreaterThan(0);
    });

    it('each step carries a runnable drill config for the metric', () => {
        const inv = buildInvestigation(periodDrop, model(['region']), 'Sales');
        expect(inv.steps[0].drill.metric).toBe('revenue');
        expect(inv.steps[0].drill.dimension).toBe('region');
        expect(inv.steps[0].drill.aggregation).toBe(AggregationType.SUM);
    });
});

describe('rankContributors + summarize (pure)', () => {
    it('ranks by absolute delta and computes share of the change', () => {
        const ranked = rankContributors([
            { label: 'A', current_v: 100, previous_v: 400 },  // −300
            { label: 'B', current_v: 90, previous_v: 100 },   // −10
            { label: 'C', current_v: 210, previous_v: 200 },  // +10
        ]);
        expect(ranked[0].label).toBe('A');
        expect(ranked[0].delta).toBe(-300);
        expect(ranked[0].share).toBeCloseTo(300 / 320, 3);
    });
    it('summary names the top driver(s)', () => {
        const s = summarizeContributors(rankContributors([
            { label: 'East', current_v: 100, previous_v: 5100 },
            { label: 'West', current_v: 300, previous_v: 400 },
        ]), 'revenue');
        expect(s).toMatch(/East/);
        expect(s).toMatch(/−5\.0K|−5000/);
    });
});

describe('contribution SQL runs in DuckDB and attributes the drop correctly', () => {
    let duck: DuckHandle;
    const rows: any[] = [];
    beforeAll(async () => {
        duck = await createDuck();
        // March: East=5000, West=1000. April: East=0 (collapsed), West=1000.
        // The drop is entirely East → the analyzer must attribute it to East.
        const push = (month: string, region: string, n: number, each: number) => {
            for (let i = 0; i < n; i++) rows.push({ id: rows.length, order_date: `2024-${month}-1${i}`, region, revenue: each });
        };
        push('03', 'East', 5, 1000); push('03', 'West', 5, 200);
        push('04', 'East', 5, 0);    push('04', 'West', 5, 200);
        duck.loadTable('data', rows);
    }, 60000);
    afterAll(() => duck?.close());

    it('names East as the dominant contributor to the revenue drop', () => {
        const sql = buildContributionSQL('revenue', AggregationType.SUM, 'order_date', 'region', '2024-03', '2024-04');
        const data = duck.query(normalizeSQLForDuckDB(sql));
        const ranked = rankContributors(data as any);
        expect(ranked[0].label).toBe('East');
        expect(ranked[0].delta).toBe(-5000);        // 0 − 5000
        expect(ranked[0].share).toBeCloseTo(1, 2);  // West contributed ~0
    });
});
