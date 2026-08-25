/**
 * Value grounding: recover filters the plan dropped by matching question phrases
 * against the dataset's real dimension values. Deterministic, no LLM.
 */
import { describe, it, expect } from 'vitest';
import { buildValueCatalog, groundFilters, groundQuestionLiterals, groundSqlLiterals } from '../services/ai-sql/valueGrounding';
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

    it('grounds literal casing from a related table without sharing its rows', () => {
        const federated = buildValueCatalog(ROWS, model, 60, [{
            name: 'alignment',
            rows: [{ id: 1, alignment: 'Good' }, { id: 2, alignment: 'Neutral' }, { id: 3, alignment: 'Bad' }],
        }]);
        expect(groundSqlLiterals("SELECT * FROM alignment WHERE alignment = 'neutral'", federated).sql)
            .toContain("alignment = 'Neutral'");
        expect(groundFilters('neutral superheroes', federated, P({}), model).added).toEqual([]);
    });

    it('resolves a quoted literal across a high-cardinality related table locally', () => {
        const majors = Array.from({ length: 112 }, (_, index) => ({
            major_id: `major-${index}`,
            major_name: `Major ${index}`,
        }));
        majors.push({ major_id: 'physics', major_name: 'Physics Teaching' });
        const result = groundQuestionLiterals(
            "How many members have major in 'Physics Teaching'?",
            [{ member_id: 'm1', position: 'Member', link_to_major: 'physics' }],
            [
                { name: 'member', rows: [{ member_id: 'm1', position: 'Member', link_to_major: 'physics' }] },
                { name: 'major', rows: majors },
            ],
            P({ metrics: [{ field: '*', agg: 'count' }] }),
        );

        expect(result).toEqual({
            added: [{
                field: 'major_name',
                op: '=',
                value: 'Physics Teaching',
                grounding: {
                    kind: 'question_literal_exact',
                    table: 'major',
                    column: 'major_name',
                    confidence: 'exact',
                },
            }],
            ambiguous: [],
            unmatched: [],
        });
        // The result contains only the value already supplied by the user, not
        // any unseen value from the high-cardinality local domain.
        expect(JSON.stringify(result)).not.toContain('Major 42');
    });

    it('does not reinterpret an entity noun as an unrequested category filter', () => {
        const memberModel: any = {
            ...model,
            fields: [
                f('member_id', 'dimension', 'identifier', 33),
                f('position', 'dimension', 'category', 3),
            ],
        };
        const memberRows = [
            { member_id: 'm1', position: 'Member' },
            { member_id: 'm2', position: 'President' },
        ];
        const memberCatalog = buildValueCatalog(memberRows, memberModel);

        expect(groundFilters(
            'How many members are in the club?',
            memberCatalog,
            P({ metrics: [{ field: '*', agg: 'count' }] }),
            memberModel,
            { entityNames: ['member'] },
        ).added).toEqual([]);

        expect(groundFilters(
            'How many records have position Member?',
            memberCatalog,
            P({ metrics: [{ field: '*', agg: 'count' }] }),
            memberModel,
            { entityNames: ['member'] },
        ).added).toContainEqual({ field: 'position', op: '=', value: 'Member' });
    });
});
