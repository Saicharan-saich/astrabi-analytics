/**
 * Value grounding: recover filters the plan dropped by matching question phrases
 * against the dataset's real dimension values. Deterministic, no LLM.
 */
import { describe, it, expect } from 'vitest';
import { buildValueCatalog, groundFilters } from '../services/ai-sql/valueGrounding';
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
        f('product', 'dimension', 'category'),
        f('total_price', 'metric', 'currency'),
        f('order_date', 'dimension', 'date'),
    ],
    compositeMetrics: [], derivedMetrics: [], datasetName: 'orders', rowCount: 6, grain: 'order',
};

const ROWS = [
    { order_id: 1, channel: 'Delivery', category: 'Beverage', product: 'Coffee', total_price: 10, order_date: '2025-01-01' },
    { order_id: 2, channel: 'Dine-In', category: 'Food', product: 'Burger', total_price: 20, order_date: '2025-01-02' },
    { order_id: 3, channel: 'Online', category: 'Beverage', product: 'Tea', total_price: 5, order_date: '2025-01-03' },
    { order_id: 4, channel: 'Delivery', category: 'Retail', product: 'Mug', total_price: 8, order_date: '2025-01-04' },
];

const P = (o: Partial<AnalysisPlan>): AnalysisPlan => ({
    intent: 'single_metric', dimensions: [], metrics: [{ field: 'total_price', agg: 'sum' }],
    filters: [], sort: [], limit: null, ambiguous: false, resultGrain: '', originalQuestion: '', ...o,
});

const catalog = buildValueCatalog(ROWS, model);

describe('value grounding', () => {
    it('recovers a dropped positive filter: "revenue from Delivery" → channel = Delivery', () => {
        const g = groundFilters('total revenue from Delivery orders', catalog, P({}), model);
        expect(g.added).toEqual([{ field: 'channel', op: '=', value: 'Delivery' }]);
    });

    it('recovers a category filter: "% from Beverages" → category = Beverage', () => {
        const g = groundFilters('what percentage of revenue comes from Beverage', catalog, P({}), model);
        expect(g.added).toContainEqual({ field: 'category', op: '=', value: 'Beverage' });
    });

    it('does not re-add a filter the plan already has', () => {
        const g = groundFilters('revenue from Delivery', catalog, P({ filters: [{ field: 'channel', op: '=', value: 'Delivery' }] }), model);
        expect(g.added).toHaveLength(0);
    });

    it('handles negation: "excluding Online" → channel != Online', () => {
        const g = groundFilters('total revenue excluding Online orders', catalog, P({}), model);
        expect(g.added).toContainEqual({ field: 'channel', op: '!=', value: 'Online' });
    });

    it('refuses set logic: "bought Coffee but never Tea" is not grounded as filters', () => {
        const g = groundFilters('customers who bought Coffee but never Tea', catalog, P({}), model);
        expect(g.added).toHaveLength(0);
        expect(g.setLogicFields).toContain('product');
    });

    it('ignores numeric and short tokens (no spurious filters)', () => {
        const g = groundFilters('total revenue', catalog, P({}), model);
        expect(g.added).toHaveLength(0);
    });

    it('groups two positive values on one field into an IN filter', () => {
        const g = groundFilters('revenue from Coffee and Tea', catalog, P({}), model);
        expect(g.added).toHaveLength(1);
        expect(g.added[0].field).toBe('product');
        expect(g.added[0].op).toBe('in');
        expect((g.added[0].value as string[]).sort()).toEqual(['Coffee', 'Tea']);
    });
});
