/**
 * End to end with a stand-in AI, on data the app was not built around: asked
 * for the worst clinic, it first judges by the SHORTEST wait. The column
 * dictionary says a longer wait is worse, so the question is asked again with
 * that reason and the second reading is answered. No budget or loss words are
 * involved: the check comes from what the column means.
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

const rows = Array.from({ length: 90 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + (i % 30))).toISOString().slice(0, 10), clinic: ['North', 'South', 'East'][i % 3], wait_minutes: 10 + (i % 3) * 15 + (i % 7), satisfaction: 1 + (i % 5) }));
const dataset = {
    id: 'clinic', name: 'appointments.csv', rows, totalRows: rows.length, etlLogs: [], version: 1,
    columns: [{ name: 'date', type: ColumnType.DATE }, { name: 'clinic', type: ColumnType.DIMENSION }, { name: 'wait_minutes', type: ColumnType.METRIC }, { name: 'satisfaction', type: ColumnType.METRIC }],
} as unknown as Dataset;
const reply = (content: object) => ({ model: 'test', data: { choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } } });
const shortestWait = {
    action: 'answer', title: 'Worst clinic', question: 'Which clinic has the worst waiting times?',
    sql: 'SELECT "clinic", AVG("wait_minutes") AS average_wait FROM "data" GROUP BY 1 ORDER BY average_wait ASC',
    dimensions: ['clinic'], measures: ['average_wait'], answer: 'average_wait', judged_by: { column: 'wait_minutes', worse: 'lower' },
};
const longestWait = { ...shortestWait, sql: 'SELECT "clinic", AVG("wait_minutes") AS average_wait FROM "data" GROUP BY 1 ORDER BY average_wait DESC', judged_by: { column: 'wait_minutes', worse: 'higher' } };

describe('"which clinic is the worst?" judged by what the columns mean', () => {
    beforeEach(() => { vi.mocked(fetchWithFallback).mockReset(); vi.mocked(executeSQLViaDuckDB).mockReset(); });

    it('re-asks when the judgement goes against the column meaning, and answers the right reading', async () => {
        vi.mocked(fetchWithFallback).mockResolvedValueOnce(reply(shortestWait) as any).mockResolvedValueOnce(reply(longestWait) as any);
        vi.mocked(executeSQLViaDuckDB).mockResolvedValue({ data: [{ clinic: 'East', average_wait: 43 }, { clinic: 'South', average_wait: 28 }, { clinic: 'North', average_wait: 13 }], columns: [], error: null } as any);
        const result = await runLeanAISQL('Which clinic is the worst?', dataset);
        const calls = vi.mocked(fetchWithFallback).mock.calls;
        expect(calls).toHaveLength(2);
        expect(String(calls[0][0][1].content)).toMatch(/"wait_minutes": .*higher is worse/);
        expect(String(calls[1][0][1].content)).toMatch(/takes a lower wait minutes as worse, but that goes against the column meanings, which say a higher wait minutes is worse/);
        expect(result.sql).toContain('DESC');
        expect(result.narrative?.cautions || []).not.toContainEqual(expect.stringMatching(/other way round/));
    });

    it('says so when the AI keeps judging the wrong way', async () => {
        vi.mocked(fetchWithFallback).mockResolvedValueOnce(reply(shortestWait) as any).mockResolvedValueOnce(reply(shortestWait) as any);
        vi.mocked(executeSQLViaDuckDB).mockResolvedValue({ data: [{ clinic: 'North', average_wait: 13 }], columns: [], error: null } as any);
        const result = await runLeanAISQL('Which clinic is the worst?', dataset);
        expect(result.narrative?.cautions?.[0]).toMatch(/^This answer may read your question the other way round: it takes a lower wait minutes as worse/);
    });
});
