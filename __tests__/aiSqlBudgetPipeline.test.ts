/**
 * End to end with a stand-in AI on a budget file where some Marketing rows
 * have a budget and no actual: the query the AI writes keeps only the
 * departments over budget and subtracts totals. The app asks again for every
 * department, works the difference out row by row, says which rows were left
 * out, and offers the other readings the AI named.
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

const rows: Record<string, any>[] = [];
for (let m = 0; m < 12; m++) for (const department of ['Marketing', 'Operations', 'IT']) for (const category of ['Payroll', 'Travel', 'Software']) {
    const budgeted = 10000 + m * 100;
    const missing = department === 'Marketing' && category === 'Software' && m < 8;
    const actual = missing ? null : budgeted + (department === 'Marketing' ? 1500 : department === 'Operations' ? 100 : -800);
    rows.push({ month: `2025-${String(m + 1).padStart(2, '0')}-01`, department, expense_category: category, budgeted_amount: budgeted, actual_spending: actual, variance: actual === null ? null : budgeted - actual });
}
const dataset = {
    id: 'budget', name: 'department_budget.xlsx', rows, totalRows: rows.length, etlLogs: [], version: 1,
    columns: [
        { name: 'month', type: ColumnType.DATE }, { name: 'department', type: ColumnType.DIMENSION }, { name: 'expense_category', type: ColumnType.DIMENSION },
        { name: 'budgeted_amount', type: ColumnType.METRIC }, { name: 'actual_spending', type: ColumnType.METRIC }, { name: 'variance', type: ColumnType.METRIC },
    ],
} as unknown as Dataset;

const reply = (content: object) => ({ model: 'test', data: { choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } } });
const base = { action: 'answer', title: 'Departments over budget', question: 'Which departments spent more than their budget?', dimensions: ['department'], measures: ['overspend', 'total_budget'], answer: 'overspend', judged_by: { column: 'actual_spending', worse: 'higher' } };
const onlyOver = { ...base, sql: 'SELECT "department", SUM("actual_spending") - SUM("budgeted_amount") AS overspend, SUM("budgeted_amount") AS total_budget FROM "data" GROUP BY 1 HAVING SUM("actual_spending") - SUM("budgeted_amount") > 0 ORDER BY overspend DESC' };
const everyone = { ...base, sql: 'SELECT "department", SUM("actual_spending") - SUM("budgeted_amount") AS overspend, SUM("budgeted_amount") AS total_budget FROM "data" GROUP BY 1 ORDER BY overspend DESC', alternatives: ['Which departments have the largest budgets?'] };
const result = [
    { department: 'Marketing', overspend: 42000, total_budget: 379800 },
    { department: 'Operations', overspend: 3600, total_budget: 379800 },
    { department: 'IT', overspend: -28800, total_budget: 379800 },
];

describe('"Which departments are overspending?" on a file with missing actuals', () => {
    beforeEach(() => { vi.mocked(fetchWithFallback).mockReset(); vi.mocked(executeSQLViaDuckDB).mockReset(); });

    it('asks again for every department, works the gap out row by row and says which rows were left out', async () => {
        vi.mocked(fetchWithFallback).mockResolvedValueOnce(reply(onlyOver) as any).mockResolvedValueOnce(reply(everyone) as any);
        vi.mocked(executeSQLViaDuckDB).mockResolvedValue({ data: result, columns: ['department', 'overspend', 'total_budget'] } as any);
        const answer = await runLeanAISQL('Which departments are overspending?', dataset);

        expect(fetchWithFallback).toHaveBeenCalledTimes(2);
        const second = vi.mocked(fetchWithFallback).mock.calls[1][0].map(m => String(m.content)).join('\n');
        expect(second).toMatch(/Return EVERY group/);
        // The data description told the AI about the uneven rows, by name only.
        expect(second).toMatch(/Some rows have one of .*and not the other/);

        const ran = String(vi.mocked(executeSQLViaDuckDB).mock.calls[0][1]);
        expect(ran).toMatch(/SUM\("actual_spending" - "budgeted_amount"\) AS overspend/);
        expect(ran).not.toMatch(/SUM\("actual_spending"\)\s*-\s*SUM\("budgeted_amount"\)/);
        expect(ran).not.toMatch(/HAVING/i);

        expect(answer.narrative?.summary).toMatch(/^Marketing is 42,000 over budget .* and Operations is 3,600 over budget .*\. IT is 28,800 under budget/);
        expect((answer.narrative?.cautions || []).join(' ')).toMatch(/8 rows have a budgeted amount but no actual spending\. Those rows are left out of the difference/);
        expect(answer.conversation?.alternatives).toEqual(['Which departments have the largest budgets?']);
    });

    it('keeps the first answer, still row by row, if the AI will not drop the filter', async () => {
        vi.mocked(fetchWithFallback).mockResolvedValue(reply(onlyOver) as any);
        vi.mocked(executeSQLViaDuckDB).mockResolvedValue({ data: result.slice(0, 2), columns: ['department', 'overspend', 'total_budget'] } as any);
        const answer = await runLeanAISQL('Which departments are overspending?', dataset);
        expect(fetchWithFallback).toHaveBeenCalledTimes(2);
        const ran = String(vi.mocked(executeSQLViaDuckDB).mock.calls[0][1]);
        expect(ran).toMatch(/HAVING SUM\("actual_spending" - "budgeted_amount"\) > 0/);
        expect(answer.narrative?.summary).toMatch(/Marketing is 42,000 over budget/);
    });

    it('a count question keeps its filter and is asked once', async () => {
        vi.mocked(fetchWithFallback).mockResolvedValue(reply({ action: 'answer', title: 'Departments over budget', question: 'How many departments are over budget?', sql: 'SELECT COUNT(*) AS departments_over_budget FROM (SELECT "department" FROM "data" GROUP BY 1 HAVING SUM("actual_spending" - "budgeted_amount") > 0)', dimensions: [], measures: ['departments_over_budget'] }) as any);
        vi.mocked(executeSQLViaDuckDB).mockResolvedValue({ data: [{ departments_over_budget: 2 }], columns: ['departments_over_budget'] } as any);
        await runLeanAISQL('How many departments are overspending?', dataset);
        expect(fetchWithFallback).toHaveBeenCalledTimes(1);
    });
});
