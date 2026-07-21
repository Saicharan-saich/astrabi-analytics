/**
 * Anti-join knob: "which <entity> did A but never B" — the set-logic shape the
 * base builder can't express. Detection + NOT EXISTS SQL, verified end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { detectAntiJoin, buildAntiJoinSQL } from '../services/ai-sql/antiJoin';
import { buildValueCatalog } from '../services/ai-sql/valueGrounding';

const field = (name: string, role: 'metric' | 'dimension', semanticType: string, distinctCount = 8): any => ({
    name, role, semanticType, defaultAgg: role === 'metric' ? 'sum' : 'none',
    physicalType: role === 'metric' ? 'number' : 'string',
    synonyms: [], valueDescriptors: [], distinctCount, hasNulls: false, displayLabel: name, timeGrainSupport: [],
});

const model: any = {
    fields: [
        field('customer_id', 'dimension', 'identifier'),
        field('product', 'dimension', 'category'),
        field('total_price', 'metric', 'currency'),
    ],
    compositeMetrics: [], derivedMetrics: [], datasetName: 'o', rowCount: 6, grain: 'order',
};

// Coffee buyers: C1,C2,C3 ; Tea buyers: C1,C4 ; Coffee AND NOT Tea → C2,C3.
const ROWS = [
    { customer_id: 'C1', product: 'Coffee', total_price: 5 },
    { customer_id: 'C1', product: 'Tea', total_price: 4 },
    { customer_id: 'C2', product: 'Coffee', total_price: 5 },
    { customer_id: 'C3', product: 'Coffee', total_price: 5 },
    { customer_id: 'C3', product: 'Milk', total_price: 3 },
    { customer_id: 'C4', product: 'Tea', total_price: 4 },
];

let duck: DuckHandle;
const catalog = buildValueCatalog(ROWS, model);
beforeAll(async () => { duck = await createDuck(); duck.loadTable('data', ROWS); }, 60000);
afterAll(() => duck?.close());

describe('anti-join', () => {
    it('detects the set-logic shape and resolves the entity', () => {
        const spec = detectAntiJoin('which customers bought Coffee but never Tea?', catalog, model);
        expect(spec).not.toBeNull();
        expect(spec!.entity).toBe('customer_id');
        expect(spec!.filterField).toBe('product');
        expect(spec!.hasValues).toEqual(['Coffee']);
        expect(spec!.notValues).toEqual(['Tea']);
    });

    it('returns the correct customers end-to-end (C2, C3)', () => {
        const spec = detectAntiJoin('which customers bought Coffee but never Tea?', catalog, model)!;
        const rows = duck.query(buildAntiJoinSQL(spec, 'data'));
        expect(rows.map(r => String(r.customer_id))).toEqual(['C2', 'C3']);
    });

    it('is not triggered by a plain single-value question', () => {
        expect(detectAntiJoin('how many customers bought Coffee', catalog, model)).toBeNull();
    });

    it('is not triggered when both values are positive', () => {
        expect(detectAntiJoin('customers who bought Coffee and Tea', catalog, model)).toBeNull();
    });
});
