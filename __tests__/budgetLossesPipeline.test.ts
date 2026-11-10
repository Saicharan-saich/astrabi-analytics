/**
 * End to end with a stand-in AI: when it restates "which department is giving
 * me losses?" as spending below budget, the question is asked again with the
 * reason, and the second, correct reading is the one answered. If the AI
 * keeps reading it the other way round, the answer says so plainly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/ai-sql/modelConfig', async (importOriginal) => {
    const original = await importOriginal<typeof import('../services/ai-sql/modelConfig')>();
    return { ...original, fetchWithFallback: vi.fn() };
});
vi.mock('../services/duckdbEngine', async (importOriginal) => {
    const original = await importOriginal<typeof import('../services/duckdbEngine')>();
    return { ...original, executeSQLViaDuckDB: vi.fn() };
});

import { fetchWithFallback } from '../services/ai-sql/modelConfig';
import { executeSQLViaDuckDB } from '../services/duckdbEngine';
import { runLeanAISQL } from '../services/ai-sql/leanPipeline';
import { ColumnType, type Dataset } from '../types';

const rows = ['Operations', 'Marketing', 'IT'].flatMap((department, d) => Array.from({ length: 12 }, (_, m) => {
    const budget = 10000 + m * 100 + d * 50;
    const actual = budget + (department === 'IT' ? 900 : -300) + (m % 3) * 10;
    return { department, month: `2025-${String(m + 1).padStart(2, '0')}-01`, budgeted_amount: budget, actual_amount: actual, variance: budget - actual };
}));
const dataset = {
    id: 'budget', name: 'budget.csv', rows, totalRows: rows.length, etlLogs: [], version: 1,
    columns: [
        { name: 'department', type: ColumnType.DIMENSION }, { name: 'month', type: ColumnType.DATE },
        { name: 'budgeted_amount', type: ColumnType.METRIC, currency: 'GBP' }, { name: 'actual_amount', type: ColumnType.METRIC, currency: 'GBP' },
        { name: 'variance', type: ColumnType.METRIC },
    ],
} as unknown as Dataset;

const reply = (content: object) => ({ model: 'test', data: { choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } } });
const turnedAround = {
    action: 'answer', title: 'Departments with the largest budget losses',
    question: 'Which departments have negative total variance, meaning actual spending was below budgeted amount?',
    sql: 'SELECT "department", SUM("budgeted_amount") AS total_budget, SUM("variance") AS total_variance FROM "data" GROUP BY 1 HAVING SUM("variance") < 0',
    dimensions: ['department'], measures: ['total_budget', 'total_variance'],
};
const right = {
    action: 'answer', title: 'Departments over budget',
    question: 'Which departments spent more than their budget, and by how much?',
    sql: 'SELECT "department", SUM("budgeted_amount") AS total_budget, SUM("actual_amount") AS total_actual, SUM("actual_amount") - SUM("budgeted_amount") AS overspend FROM "data" GROUP BY 1 ORDER BY overspend DESC',
    dimensions: ['department'], measures: ['overspend', 'total_budget', 'total_actual'], answer: 'overspend',
};

describe('a loss question read the other way round', () => {
    beforeEach(() => {
        vi.mocked(fetchWithFallback).mockReset();
        vi.mocked(executeSQLViaDuckDB).mockReset();
    });

    it('asks again with the reason, tells the AI the variance formula, and answers the right reading', async () => {
        vi.mocked(fetchWithFallback).mockResolvedValueOnce(reply(turnedAround) as any).mockResolvedValueOnce(reply(right) as any);
        vi.mocked(executeSQLViaDuckDB).mockResolvedValue({
            data: [
                { department: 'IT', total_budget: 121_000, total_actual: 131_920, overspend: 10_920 },
                { department: 'Marketing', total_budget: 120_600, total_actual: 117_120, overspend: -3_480 },
                { department: 'Operations', total_budget: 120_000, total_actual: 116_520, overspend: -3_480 },
            ], columns: [], error: null,
        } as any);
        const result = await runLeanAISQL('Which department is giving me losses?', dataset);
        const calls = vi.mocked(fetchWithFallback).mock.calls;
        expect(calls).toHaveLength(2);
        const first = String(calls[0][0][1].content);
        expect(first).toContain('"variance" = "budgeted_amount" − "actual_amount", so "variance" below 0 means "actual_amount" is higher');
        expect(first).not.toMatch(/Operations|Marketing|10000/); // names of columns only, never values
        expect(String(calls[1][0][1].content)).toMatch(/saving, not a loss/);
        expect(result.sql).toContain('overspend');
        expect(result.narrative?.summary).toMatch(/^IT is 10,920 over budget \(9% of its budget\)\. Marketing is 3,480 under budget/);
        expect(result.narrative?.cautions || []).not.toContainEqual(expect.stringMatching(/other way round/));
    });

    it('says so plainly when the reading stays turned around', async () => {
        vi.mocked(fetchWithFallback).mockResolvedValueOnce(reply(turnedAround) as any).mockResolvedValueOnce(reply(turnedAround) as any);
        vi.mocked(executeSQLViaDuckDB).mockResolvedValue({ data: [{ department: 'Marketing', total_budget: 120_600, total_variance: 3_480 }], columns: [], error: null } as any);
        const result = await runLeanAISQL('Which department is giving me losses?', dataset);
        expect(result.narrative?.cautions?.[0]).toMatch(/^This answer may read your question the other way round/);
    });

    it('looks at every department when a new question follows a comparison of two', async () => {
        const earlier = { question: 'Compare the budget of Operations and Marketing', sql: `SELECT "department", SUM("budgeted_amount") AS total_budget FROM "data" WHERE "department" IN ('Operations', 'Marketing') GROUP BY 1` };
        const keptFilter = { ...right, follow_up: true, sql: `SELECT "department", SUM("budgeted_amount") AS total_budget, SUM("actual_amount") AS total_actual, SUM("actual_amount") - SUM("budgeted_amount") AS overspend FROM "data" WHERE "department" IN ('Operations', 'Marketing') GROUP BY 1 ORDER BY overspend DESC` };
        vi.mocked(fetchWithFallback).mockResolvedValueOnce(reply(keptFilter) as any).mockResolvedValueOnce(reply({ ...right, follow_up: false }) as any);
        vi.mocked(executeSQLViaDuckDB).mockResolvedValue({ data: [
            { department: 'IT', overspend: 10_920, total_budget: 121_000, total_actual: 131_920 },
            { department: 'Marketing', overspend: -3_480, total_budget: 120_600, total_actual: 117_120 },
            { department: 'Operations', overspend: -3_480, total_budget: 120_000, total_actual: 116_520 },
        ], columns: [], error: null } as any);
        const result = await runLeanAISQL('Which departments are causing losses through spending above budget?', dataset, { context: [earlier] } as any);
        const calls = vi.mocked(fetchWithFallback).mock.calls;
        expect(calls).toHaveLength(2);
        expect(String(calls[1][0][1].content)).toMatch(/keeps a filter from the earlier answer \(only rows where department is Operations or Marketing\)/);
        expect(result.sql).not.toMatch(/IN \('Operations'/);
        expect(result.narrative?.summary).toMatch(/^IT is .+ over budget/);
    });
});
