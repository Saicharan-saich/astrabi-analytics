/**
 * Direct SQL-semantics engine — testable core (schema serialization, SQL safety
 * gate, and SQL extraction). The LLM call itself runs live in the browser.
 */
import { describe, it, expect } from 'vitest';
import { serializeSchema, serializeSemanticModelSchema, collectSafeDomains, isSensitiveColumn } from '../services/ai-sql/schemaSerializer';
import { validateReadOnlySQL } from '../services/ai-sql/sqlSafety';
import { extractSQL } from '../services/ai-sql/directSqlEngine';
import { buildValueCatalog, groundSqlLiterals } from '../services/ai-sql/valueGrounding';

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
    it('marks date columns as TEXT and tells the model to CAST before date functions', () => {
        // DuckDB loads CSV dates as VARCHAR, so DATE_TRUNC(order_date) fails unless cast.
        const s = serializeSemanticModelSchema(model);
        // The column type in the table definition must be VARCHAR, not DATE.
        expect(s).toMatch(/order_date VARCHAR/);
        expect(s).not.toMatch(/order_date DATE\b/);
        // And the notes must instruct casting.
        expect(s).toMatch(/order_date:.*CAST\(col AS DATE\)/i);
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

describe('collectSafeDomains — send category values, never PII', () => {
    const fld = (name: string, semanticType: string, distinctCount: number): any => ({
        name, role: 'dimension', semanticType, physicalType: 'string',
        defaultAgg: 'none', synonyms: [], valueDescriptors: [], distinctCount,
        hasNulls: false, displayLabel: name, timeGrainSupport: [],
    });
    const model: any = {
        fields: [
            fld('item_name', 'category', 5),
            fld('menu_category', 'category', 3),
            fld('customer_name', 'category', 200),   // person PII — must be excluded
            fld('customer_email', 'text', 200),       // PII — excluded
            fld('region', 'geography', 4),
            fld('order_id', 'identifier', 550),        // identifier — excluded
        ],
        compositeMetrics: [], derivedMetrics: [], datasetName: 'data', rowCount: 550, grain: 'order',
    };
    const rows = [
        { item_name: 'Cappuccino', menu_category: 'Coffee', customer_name: 'Jane Doe', customer_email: 'jane@x.com', region: 'North', order_id: 1 },
        { item_name: 'Green Tea', menu_category: 'Tea', customer_name: 'John Roe', customer_email: 'john@x.com', region: 'South', order_id: 2 },
    ];

    it('includes low-cardinality category / geography domains', () => {
        const d = collectSafeDomains(rows, model);
        expect(d.get('item_name')?.values).toContain('Cappuccino');
        expect(d.get('menu_category')?.values).toEqual(expect.arrayContaining(['Coffee', 'Tea']));
        expect(d.get('region')?.values).toContain('North');
    });
    it('NEVER includes person names, emails, or identifiers', () => {
        const d = collectSafeDomains(rows, model);
        expect(d.has('customer_name')).toBe(false);
        expect(d.has('customer_email')).toBe(false);
        expect(d.has('order_id')).toBe(false);
        expect(isSensitiveColumn(model.fields.find((f: any) => f.name === 'customer_name'))).toBe(true);
        expect(isSensitiveColumn(model.fields.find((f: any) => f.name === 'item_name'))).toBe(false);
    });
    it('the serialized schema shows category values but no customer PII', () => {
        const d = collectSafeDomains(rows, model);
        const s = serializeSemanticModelSchema(model, 'data', d);
        expect(s).toMatch(/menu_category:.*'Coffee'.*'Tea'/);
        expect(s).not.toContain('Jane Doe');
        expect(s).not.toContain('jane@x.com');
    });
    it('respects the cardinality cap (does not send high-cardinality columns)', () => {
        const d = collectSafeDomains(rows, model, { maxCardinality: 10 });
        expect(d.has('customer_name')).toBe(false); // also PII, but cap alone would drop it too
    });

    it('NEVER sends sensitive categoricals (health / demographics / financial)', () => {
        const cat = (name: string): any => ({
            name, role: 'dimension', semanticType: 'category', physicalType: 'string',
            defaultAgg: 'none', synonyms: [], valueDescriptors: [], distinctCount: 4,
            hasNulls: false, displayLabel: name, timeGrainSupport: [],
        });
        const sensitiveModel: any = {
            fields: [cat('diagnosis'), cat('medication_name'), cat('ethnicity'), cat('religion'), cat('gender'), cat('salary_band'), cat('menu_category')],
            compositeMetrics: [], derivedMetrics: [], datasetName: 'data', rowCount: 4, grain: 'row',
        };
        const sensitiveRows = [{ diagnosis: 'Diabetes', medication_name: 'Metformin', ethnicity: 'Asian', religion: 'Hindu', gender: 'Female', salary_band: '50-60k', menu_category: 'Coffee' }];
        const d = collectSafeDomains(sensitiveRows, sensitiveModel);
        for (const col of ['diagnosis', 'medication_name', 'ethnicity', 'religion', 'gender', 'salary_band']) {
            expect(d.has(col), col).toBe(false);
        }
        // A benign category is still shared.
        expect(d.has('menu_category')).toBe(true);
    });
});

describe('groundSqlLiterals — fix literal casing/plural, never fabricate', () => {
    const fld = (name: string, distinctCount: number): any => ({
        name, role: 'dimension', semanticType: 'category', physicalType: 'string',
        defaultAgg: 'none', synonyms: [], valueDescriptors: [], distinctCount,
        hasNulls: false, displayLabel: name, timeGrainSupport: [],
    });
    const model: any = { fields: [fld('menu_category', 3)], compositeMetrics: [], derivedMetrics: [], datasetName: 'data', rowCount: 3, grain: 'row' };
    const catalog = buildValueCatalog([{ menu_category: 'Beverage' }, { menu_category: 'Food' }, { menu_category: 'Retail' }], model);

    it('corrects a lowercased literal to the real stored value', () => {
        const r = groundSqlLiterals("SELECT * FROM data WHERE menu_category = 'beverage'", catalog);
        expect(r.sql).toContain("'Beverage'");
        expect(r.changed).toContain('beverage→Beverage');
    });
    it('corrects a plural literal to the singular stored value', () => {
        const r = groundSqlLiterals("SELECT * FROM data WHERE menu_category = 'Beverages'", catalog);
        expect(r.sql).toContain("'Beverage'");
    });
    it('leaves an unknown literal untouched (never fabricates)', () => {
        const r = groundSqlLiterals("SELECT * FROM data WHERE menu_category = 'Coffee'", catalog);
        expect(r.sql).toContain("'Coffee'");
        expect(r.changed).toHaveLength(0);
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
