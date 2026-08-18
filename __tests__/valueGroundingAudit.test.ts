import { describe, expect, it } from 'vitest';
import { auditSqlLiterals, buildValueCatalog } from '../services/ai-sql/valueGrounding';
import type { SemanticModel } from '../services/ai-sql/types';

const model: SemanticModel = {
    datasetName: 'data',
    rowCount: 3,
    grain: 'one row per account',
    compositeMetrics: [],
    derivedMetrics: [],
    fields: [
        {
            name: 'status', displayLabel: 'Status', physicalType: 'string', semanticType: 'category',
            role: 'dimension', defaultAgg: 'none', timeGrainSupport: [], synonyms: [],
            valueDescriptors: [], distinctCount: 2, hasNulls: false,
        },
    ],
};

describe('private local SQL literal audit', () => {
    const rows = [{ status: 'Running' }, { status: 'Closed' }, { status: 'Running' }];
    const relatedTables = [{
        name: 'addresses',
        rows: [{ country: 'Haiti' }, { country: 'France' }],
    }];
    const catalog = buildValueCatalog(rows, model, 60, relatedTables);

    it('accepts real values without exposing or rewriting them', () => {
        expect(auditSqlLiterals("SELECT * FROM data WHERE status = 'Running'", catalog)).toEqual([]);
        expect(auditSqlLiterals("SELECT * FROM addresses a WHERE a.country ILIKE '%Haiti%'", catalog)).toEqual([]);
    });

    it('flags absent literals only for completely catalogued fields', () => {
        expect(auditSqlLiterals("SELECT * FROM data WHERE status = 'Pending'", catalog)).toEqual([
            { field: 'status', literal: 'Pending', operator: '=' },
        ]);
        expect(auditSqlLiterals("SELECT * FROM addresses a WHERE a.country = 'Italy'", catalog)).toEqual([
            { field: 'addresses.country', literal: 'Italy', operator: '=' },
        ]);
    });

    it('ignores uncovered and ambiguous columns', () => {
        expect(auditSqlLiterals("SELECT * FROM data WHERE free_text = 'anything'", catalog)).toEqual([]);
    });
});
