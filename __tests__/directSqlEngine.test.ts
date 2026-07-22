/**
 * Direct SQL-semantics engine — testable core (schema serialization, SQL safety
 * gate, and SQL extraction). The LLM call itself runs live in the browser.
 */
import { describe, it, expect } from 'vitest';
import { serializeSchema, serializeSemanticModelSchema } from '../services/ai-sql/schemaSerializer';
import { validateReadOnlySQL } from '../services/ai-sql/sqlSafety';
import { extractSQL } from '../services/ai-sql/directSqlEngine';

describe('serializeSchema — metadata only, never rows', () => {
    const tables = [
        { name: 'schools', rows: [{ CDSCode: 'A', School: 'Alpha', Virtual: 'F' }] },
        { name: 'satscores', rows: [{ cds: 'A', AvgScrMath: 450, NumTstTakr: 12 }] },
        { name: 'frpm', rows: [{ CDSCode: 'A', 'Free Meal Count (K-12)': 100 }] },
    ];
    const edges = [{ leftTable: 'satscores', rightTable: 'schools', leftColumn: 'cds', rightColumn: 'CDSCode' }];

    it('lists tables, columns and inferred types', () => {
        const s = serializeSchema(tables, edges);
        expect(s).toContain('Table schools(CDSCode TEXT, School TEXT, Virtual TEXT)');
        expect(s).toContain('AvgScrMath NUMBER');
        expect(s).toContain('Foreign keys:');
        expect(s).toContain('satscores.cds = schools.CDSCode');
    });
    it('quotes identifiers with spaces/parens', () => {
        expect(serializeSchema(tables)).toContain('"Free Meal Count (K-12)" NUMBER');
    });
    it('contains no row VALUES (privacy)', () => {
        const s = serializeSchema(tables, edges);
        expect(s).not.toContain('Alpha');
        expect(s).not.toContain('450');
        expect(s).not.toMatch(/\bA\b/); // the 'A' code value never appears
    });
});

describe('serializeSemanticModelSchema — rich metadata, never rows', () => {
    const fld = (name: string, role: 'metric' | 'dimension', semanticType: string, physicalType: string, distinctCount: number, extra: any = {}): any => ({
        name, role, semanticType, physicalType,
        defaultAgg: role === 'metric' ? 'sum' : 'none',
        synonyms: [], valueDescriptors: [], distinctCount, hasNulls: false,
        displayLabel: name, timeGrainSupport: [], ...extra,
    });
    const model: any = {
        fields: [
            fld('order_id', 'dimension', 'identifier', 'number', 550),
            fld('order_date', 'dimension', 'date', 'date', 90),
            fld('menu_category', 'dimension', 'category', 'string', 4),
            fld('unit_price', 'metric', 'currency', 'number', 30),
            fld('total_price', 'metric', 'currency', 'number', 300, { range: { min: 1, max: 500 } }),
        ],
        compositeMetrics: [], derivedMetrics: [], datasetName: 'data', rowCount: 550, grain: 'order',
        timeContext: { anchorDate: '2025-06-30', minDate: '2025-01-01', maxDate: '2025-06-30', primaryDateColumn: 'order_date' },
    };

    it('marks a row-identifier so the LLM never groups by it', () => {
        const s = serializeSemanticModelSchema(model);
        expect(s).toMatch(/order_id:.*row identifier/i);
        expect(s).toMatch(/never GROUP BY/i);
    });
    it('flags a per-unit price as non-additive and the line total as additive', () => {
        const s = serializeSemanticModelSchema(model);
        expect(s).toMatch(/unit_price:.*do NOT SUM/i);
        expect(s).toMatch(/total_price:.*additive/i);
    });
    it('surfaces the date column and its range for time filters', () => {
        const s = serializeSemanticModelSchema(model);
        expect(s).toMatch(/order_date:.*date/i);
        expect(s).toContain('2025-01-01..2025-06-30');
    });
    it('reports low-cardinality dimension distinct counts', () => {
        const s = serializeSemanticModelSchema(model);
        expect(s).toMatch(/menu_category:.*4 distinct/i);
    });
    it('emits no raw row values (privacy)', () => {
        const s = serializeSemanticModelSchema(model);
        expect(s).not.toMatch(/Beverage|Food|Retail/);
    });
});

describe('validateReadOnlySQL — read-only gate', () => {
    it('accepts a plain SELECT and a CTE', () => {
        expect(validateReadOnlySQL('SELECT a FROM t WHERE x > 1').ok).toBe(true);
        expect(validateReadOnlySQL('WITH c AS (SELECT 1 AS a) SELECT a FROM c').ok).toBe(true);
    });
    it('rejects DML/DDL', () => {
        for (const bad of ['DROP TABLE t', 'DELETE FROM t', 'UPDATE t SET a=1', 'INSERT INTO t VALUES (1)', 'ATTACH \'x.db\'', 'PRAGMA foreign_keys']) {
            expect(validateReadOnlySQL(bad).ok, bad).toBe(false);
        }
    });
    it('rejects multiple statements', () => {
        expect(validateReadOnlySQL('SELECT 1; DROP TABLE t').ok).toBe(false);
    });
    it('ignores keywords that appear inside string literals', () => {
        expect(validateReadOnlySQL("SELECT a FROM t WHERE name = 'please update me'").ok).toBe(true);
    });
    it('strips a single trailing semicolon', () => {
        const r = validateReadOnlySQL('SELECT 1;');
        expect(r.ok).toBe(true);
        expect(r.sql).toBe('SELECT 1');
    });
});

describe('extractSQL — pull SQL out of a model reply', () => {
    it('strips markdown code fences', () => {
        expect(extractSQL('```sql\nSELECT 1\n```')).toBe('SELECT 1');
    });
    it('trims prose-free plain SQL and trailing semicolons', () => {
        expect(extractSQL('SELECT a FROM t;')).toBe('SELECT a FROM t');
    });
});
