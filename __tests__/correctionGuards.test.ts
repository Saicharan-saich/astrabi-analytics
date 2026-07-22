/**
 * Correction-engine safety guards (fixes for the live crash run):
 *  - a text filter mis-flagged as HAVING must NOT become SUM(text_column) — that
 *    crashed DuckDB with "sum(VARCHAR)";
 *  - a row-identifier dimension (order_id) must be dropped, not grouped by.
 */
import { describe, it, expect } from 'vitest';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import type { AnalysisPlan } from '../services/ai-sql/types';

const fld = (name: string, role: 'metric' | 'dimension', semanticType: string, physicalType: string, distinctCount: number): any => ({
    name, role, semanticType, physicalType, defaultAgg: role === 'metric' ? 'sum' : 'none',
    synonyms: [], valueDescriptors: [], distinctCount, hasNulls: false, displayLabel: name, timeGrainSupport: [],
});

const model: any = {
    fields: [
        fld('order_id', 'dimension', 'identifier', 'number', 550),
        fld('customer_name', 'dimension', 'category', 'string', 200),
        fld('item_name', 'dimension', 'category', 'string', 120),
        fld('quantity', 'metric', 'quantity', 'number', 10),
        fld('total_price', 'metric', 'currency', 'number', 300),
    ],
    compositeMetrics: [], derivedMetrics: [], datasetName: 'data', rowCount: 550, grain: 'order',
};

const P = (o: Partial<AnalysisPlan>): AnalysisPlan => ({
    intent: 'breakdown', dimensions: [], metrics: [{ field: 'total_price', agg: 'sum' }],
    filters: [], sort: [], limit: null, ambiguous: false, resultGrain: '', originalQuestion: '', ...o,
});

describe('correction-engine guards', () => {
    it('never emits SUM of a text column from a mis-flagged text HAVING filter', () => {
        const sql = correctSQL(P({
            intent: 'aggregate_filter',
            dimensions: [{ field: 'customer_name' }],
            metrics: [{ field: 'quantity', agg: 'sum' }],
            filters: [
                { field: 'item_name', op: 'contains' as any, value: 'Coffee', isHaving: true },
                { field: 'item_name', op: 'does_not_contain' as any, value: 'Tea', isHaving: true },
            ],
        }), model);
        expect(sql).not.toMatch(/SUM\(\s*"?item_name"?\s*\)/i);
    });

    it('drops a row-identifier dimension (order_id) — no GROUP BY order_id', () => {
        const sql = correctSQL(P({
            intent: 'breakdown',
            dimensions: [{ field: 'order_id' }],
            metrics: [{ field: 'total_price', agg: 'sum' }],
        }), model);
        expect(sql).not.toMatch(/GROUP BY[^\n]*order_id/i);
    });
});
