/**
 * Plan verification (faithfulness gate): catch plans that don't represent the
 * question — dropped filter, wrong metric, missing count/avg/ranking/dimension —
 * so a mismatch becomes a flagged answer, not a silent wrong one.
 */
import { describe, it, expect } from 'vitest';
import { verifyPlan } from '../services/ai-sql/planVerification';
import { buildValueCatalog } from '../services/ai-sql/valueGrounding';
import type { AnalysisPlan } from '../services/ai-sql/types';

const f = (name: string, role: 'metric' | 'dimension', semanticType: string, distinctCount = 5): any => ({
    name, role, semanticType, defaultAgg: role === 'metric' ? 'sum' : 'none',
    physicalType: role === 'metric' ? 'number' : semanticType === 'date' ? 'date' : 'string',
    synonyms: [], valueDescriptors: [], distinctCount, hasNulls: false, displayLabel: name, timeGrainSupport: [],
});

const model: any = {
    fields: [
        f('order_id', 'dimension', 'identifier'),
        f('channel', 'dimension', 'category'),
        f('category', 'dimension', 'category'),
        f('quantity', 'metric', 'quantity'),
        f('total_price', 'metric', 'currency'),
    ],
    compositeMetrics: [], derivedMetrics: [], datasetName: 'o', rowCount: 4, grain: 'order',
};
const ROWS = [
    { order_id: 1, channel: 'Delivery', category: 'Beverage', quantity: 1, total_price: 10 },
    { order_id: 2, channel: 'Dine-In', category: 'Food', quantity: 2, total_price: 20 },
    { order_id: 3, channel: 'Online', category: 'Retail', quantity: 1, total_price: 5 },
];
const catalog = buildValueCatalog(ROWS, model);

const P = (o: Partial<AnalysisPlan>): AnalysisPlan => ({
    intent: 'single_metric', dimensions: [], metrics: [{ field: 'total_price', agg: 'sum' }],
    filters: [], sort: [], limit: null, ambiguous: false, resultGrain: '', originalQuestion: '', ...o,
});
const codes = (q: string, p: AnalysisPlan) => verifyPlan(q, p, model, catalog).issues.map(i => i.code);

describe('plan verification', () => {
    it('passes a faithful plan', () => {
        const r = verifyPlan('total revenue from Delivery', P({ filters: [{ field: 'channel', op: '=', value: 'Delivery' }] }), model, catalog);
        expect(r.ok).toBe(true);
        expect(r.issues).toHaveLength(0);
    });

    it('ERRORS on a dropped filter (Delivery mentioned, not filtered)', () => {
        const r = verifyPlan('total revenue from Delivery', P({}), model, catalog);
        expect(r.ok).toBe(false);
        expect(r.issues.some(i => i.code === 'dropped_filter' && i.severity === 'error')).toBe(true);
    });

    it('does not error when the mentioned value is the group-by dimension', () => {
        // "revenue by channel" — channel is a dimension, values need no filter.
        const r = verifyPlan('revenue by channel', P({ intent: 'breakdown', dimensions: [{ field: 'channel' }] }), model, catalog);
        expect(r.issues.some(i => i.code === 'dropped_filter')).toBe(false);
    });

    it('warns when a money question aggregates a non-currency metric', () => {
        expect(codes('total revenue', P({ metrics: [{ field: 'quantity', agg: 'sum' }] }))).toContain('possible_wrong_metric');
    });

    it('warns on a count question with no COUNT', () => {
        expect(codes('how many orders are there', P({ metrics: [{ field: 'total_price', agg: 'sum' }] }))).toContain('missing_count');
    });

    it('warns on an average question with no AVG', () => {
        expect(codes('average order value', P({ metrics: [{ field: 'total_price', agg: 'sum' }] }))).toContain('missing_avg');
    });

    it('warns on a superlative with no ranking', () => {
        expect(codes('highest revenue channel', P({ intent: 'breakdown', dimensions: [{ field: 'channel' }], metrics: [{ field: 'total_price', agg: 'sum' }] }))).toContain('missing_ranking');
    });

    it('warns on a breakdown cue with no dimension', () => {
        expect(codes('revenue by category', P({ intent: 'breakdown' }))).toContain('missing_dimension');
    });
});
