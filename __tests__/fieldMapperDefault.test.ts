/**
 * Field-mapper default-metric selection: a money question must fall back to the
 * currency metric (total_price), not whatever sum-metric (quantity) comes first
 * in column order. Regression for "total revenue" → SUM(quantity).
 */
import { describe, it, expect } from 'vitest';
import { mapFieldsFromQuestion } from '../services/ai-sql/fieldMapper';

const f = (name: string, role: 'metric' | 'dimension', semanticType: string, defaultAgg = 'sum'): any => ({
    name, role, semanticType, defaultAgg, physicalType: role === 'metric' ? 'number' : 'string',
    synonyms: [], valueDescriptors: [], distinctCount: 5, hasNulls: false, displayLabel: name,
    timeGrainSupport: [],
});

// quantity comes BEFORE total_price on purpose — the old code picked it by order.
const model: any = {
    fields: [
        f('order_id', 'dimension', 'identifier', 'none'),
        f('quantity', 'metric', 'quantity', 'sum'),
        f('total_price', 'metric', 'currency', 'sum'),
        f('restaurant_type', 'dimension', 'category', 'none'),
    ],
    compositeMetrics: [], derivedMetrics: [], datasetName: 'orders', rowCount: 100, grain: 'order',
};

describe('field mapper default metric', () => {
    it('"total revenue" falls back to the currency metric, not quantity', () => {
        const res = mapFieldsFromQuestion('total revenue from Delivery orders', model);
        expect(res.metrics.map((m: any) => m.name)).toContain('total_price');
        expect(res.metrics.map((m: any) => m.name)).not.toContain('quantity');
    });

    it('"total sales" also maps to the currency metric', () => {
        const res = mapFieldsFromQuestion('what were total sales', model);
        expect(res.metrics[0]?.name).toBe('total_price');
    });

    it('maps plural dimension words to singular schema fields', () => {
        const categoryModel = {
            ...model,
            fields: [...model.fields, f('category', 'dimension', 'category', 'none')],
        };
        const res = mapFieldsFromQuestion('Which categories have total profit below 2000?', categoryModel);
        expect(res.dimensions.map((dimension: any) => dimension.name)).toContain('category');
    });
});
