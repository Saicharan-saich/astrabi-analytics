import { beforeEach, describe, expect, it } from 'vitest';
import {
    compactPlanForPrompt,
    compactPromptJSON,
    isPlanReliableForPrompt,
} from '../services/ai-sql/promptCompaction';
import {
    buildAnswerCacheKey,
    clearAnswerCache,
    rememberAnswer,
    resetAnswerCacheMemoryForTests,
    takeCachedAnswer,
} from '../services/ai-sql/answerCache';
import { serializeSemanticModelSchema } from '../services/ai-sql/schemaSerializer';
import type { SemanticModel } from '../services/ai-sql/types';

describe('compactPromptJSON — lossless prompt compaction', () => {
    it('removes whitespace and empty placeholders but keeps every value', () => {
        const text = compactPromptJSON({
            outputEntity: { table: 'data', field: 'region' },
            requiredTables: [],
            relationshipPath: [],
            threshold: undefined,
            ratio: null,
            nested: { empty: {}, list: [[], {}] },
            requirements: ['Group at the requested grain "region".'],
        });
        expect(text).toBe('{"outputEntity":{"table":"data","field":"region"},"requirements":["Group at the requested grain \\"region\\"."]}');
        expect(text).not.toMatch(/\n|  /);
    });

    it('keeps false, zero, empty strings and "none", which can be real filter literals', () => {
        const parsed = JSON.parse(compactPromptJSON({
            predicates: [
                { field: 'is_active', op: '=', value: false },
                { field: 'discount', op: '=', value: 0 },
                { field: 'status', op: '=', value: 'none' },
                { field: 'note', op: '=', value: '' },
            ],
        }));
        expect(parsed.predicates.map((p: any) => p.value)).toEqual([false, 0, 'none', '']);
    });

    it('returns an empty object for fully empty input', () => {
        expect(compactPromptJSON({ a: [], b: null })).toBe('{}');
        expect(compactPromptJSON(undefined)).toBe('{}');
    });
});

describe('local plan in prompts', () => {
    const plan = {
        intent: 'ranking',
        dimensions: [{ field: 'product_name' }],
        metrics: [{ field: 'profit', agg: 'sum' }],
        filters: [],
        limit: 5,
        originalQuestion: 'Top 5 products by profit',
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        _smartDefaultApplied: false,
    };

    it('drops bookkeeping fields but keeps the analytical plan', () => {
        const parsed = JSON.parse(compactPlanForPrompt(plan));
        expect(parsed).toEqual({
            intent: 'ranking',
            dimensions: [{ field: 'product_name' }],
            metrics: [{ field: 'profit', agg: 'sum' }],
            limit: 5,
        });
    });

    it('withholds guessed or ambiguous plans and keeps reliable ones', () => {
        expect(isPlanReliableForPrompt(plan)).toBe(true);
        expect(isPlanReliableForPrompt({ ...plan, _smartDefaultApplied: true })).toBe(false);
        expect(isPlanReliableForPrompt({ ...plan, ambiguous: true })).toBe(false);
        expect(isPlanReliableForPrompt(undefined)).toBe(false);
    });
});

describe('verified answer reuse', () => {
    beforeEach(() => {
        clearAnswerCache();
        resetAnswerCacheMemoryForTests();
    });

    const key = (question: string, schema = 'Table data(region VARCHAR, sales DOUBLE)') =>
        buildAnswerCacheKey([question, schema, 'strict']);

    it('is keyed on exact inputs — different wording or schema never share an answer', () => {
        expect(key('Total sales by region')).toBe(key('Total sales by region'));
        expect(key('Total sales by region')).not.toBe(key('Total sales by region in 2025'));
        expect(key('sales this month')).not.toBe(key('sales month'));
        expect(key('Total sales by region')).not.toBe(key('Total sales by region', 'Table data(region VARCHAR, sales DOUBLE, profit DOUBLE)'));
        // Length-prefixing stops adjacent parts running together.
        expect(buildAnswerCacheKey(['ab', 'c'])).not.toBe(buildAnswerCacheKey(['a', 'bc']));
    });

    it('returns a remembered answer once (consumed until the run succeeds again)', () => {
        const k = key('Total sales by region');
        rememberAnswer(k, { sql: 'SELECT region, SUM(sales) FROM data GROUP BY region', model: 'luna' });
        const hit = takeCachedAnswer(k);
        expect(hit?.sql).toContain('GROUP BY region');
        expect(takeCachedAnswer(k)).toBeNull();
    });

    it('ignores empty SQL and misses on unknown keys', () => {
        const k = key('Top 5 products by profit');
        rememberAnswer(k, { sql: '' });
        expect(takeCachedAnswer(k)).toBeNull();
        expect(takeCachedAnswer(key('never asked'))).toBeNull();
    });
});

describe('column notes are compact but keep every rule', () => {
    const model = {
        rowCount: 400,
        fields: [
            { name: 'order_id', role: 'dimension', semanticType: 'identifier', distinctCount: 400, nativeGrain: 'one row per order line', unit: 'identifier', businessMeaning: 'Order Id is a identifier descriptive field.' },
            { name: 'region', role: 'dimension', semanticType: 'geography', distinctCount: 4, nativeGrain: 'one row per order line', unit: 'text', businessMeaning: 'Region is a geography descriptive field.' },
            { name: 'channel', role: 'dimension', semanticType: 'category', distinctCount: 3, nativeGrain: 'one row per order line', unit: 'text', businessMeaning: 'Channel through which the customer placed the order.' },
            { name: 'sales', role: 'metric', semanticType: 'currency', distinctCount: 390, nativeGrain: 'one row per order line', unit: 'currency', defaultAgg: 'sum', additivity: 'additive', businessMeaning: 'Sales is a currency measure.' },
        ],
        compositeMetrics: [],
    } as unknown as SemanticModel;

    it('states a shared native grain once instead of per column', () => {
        const s = serializeSemanticModelSchema(model);
        expect(s).toContain('Native grain of every column: one row per order line');
        expect(s).not.toMatch(/native grain: one row per order line/);
    });

    it('drops generated tautologies but keeps real business meanings and specific types', () => {
        const s = serializeSemanticModelSchema(model);
        expect(s).not.toContain('is a geography descriptive field');
        expect(s).not.toContain('Sales is a currency measure');
        expect(s).toMatch(/region:.*type: geography/);
        expect(s).toContain('Channel through which the customer placed the order.');
        expect(s).toMatch(/order_id:.*row identifier/);
        expect(s).toMatch(/sales:.*unit: currency.*additive — aggregate with SUM/);
    });

    it('keeps per-column grain when tables differ', () => {
        const mixed = {
            ...model,
            fields: [
                ...model.fields,
                { name: 'target', role: 'metric', semanticType: 'currency', distinctCount: 4, nativeGrain: 'one row per region per month', unit: 'currency', defaultAgg: 'sum' },
            ],
        } as unknown as SemanticModel;
        const s = serializeSemanticModelSchema(mixed);
        expect(s).not.toContain('Native grain of every column');
        expect(s).toMatch(/target:.*native grain: one row per region per month/);
    });
});
