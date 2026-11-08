import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ColumnType, type Dataset } from '../types';

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
import {
    AISQLClarificationError, AISQLOverviewRequest, buildInsights, describeColumnsOnly, extremesNarrative, normaliseExtremes, parseLeanReply, periodLabel, planFromResult, rerunSavedAnswer, resultCurrency, runLeanAISQL, scrubErrorForModel,
} from '../services/ai-sql/leanPipeline';
import { profileResult } from '../services/ai-sql/resultProfiler';
import { resolveAISQLSemanticModel } from '../services/ai-sql/semanticLayer';
import { fillTimeSpine, inferSpineStep } from '../services/ai-sql/dataReshaper';

const rows = Array.from({ length: 40 }, (_, i) => ({
    manufacturer: ['Ford', 'Toyota', 'BMW', 'Honda'][i % 4],
    model: `M${i % 6}`,
    year_of_manufacture: 2010 + (i % 10),
    mileage: 20000 + i * 1000,
    price: 9000 + i * 500,
}));
const dataset = {
    id: 'cars', name: 'second_hand_car_sales.csv', rows, totalRows: rows.length, etlLogs: [], version: 1,
    columns: [
        { name: 'manufacturer', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'model', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'year_of_manufacture', type: ColumnType.DIMENSION, originalType: 'number' },
        { name: 'mileage', type: ColumnType.METRIC, originalType: 'number' },
        { name: 'price', type: ColumnType.METRIC, originalType: 'number', currency: 'GBP' },
    ],
} as unknown as Dataset;

const aiReplies = (...contents: object[]) => {
    for (const content of contents) {
        vi.mocked(fetchWithFallback).mockResolvedValueOnce({
            model: 'openai/gpt-5.6-terra',
            data: { choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } },
        });
    }
};

describe('lean AI SQL — reading the AI reply', () => {
    it('reads a follow-up with its choices', () => {
        const reply = parseLeanReply('```json\n{"action":"clarify","question":"What does best performing mean here?","options":[{"label":"Total sales","question":"Top 10 models by total price"},{"label":"Cars sold","question":"Top 10 models by number of cars sold"}]}\n```');
        expect(reply).toEqual({
            action: 'clarify',
            question: 'What does best performing mean here?',
            options: [
                { label: 'Total sales', question: 'Top 10 models by total price' },
                { label: 'Cars sold', question: 'Top 10 models by number of cars sold' },
            ],
        });
    });

    it('reads an answer, and accepts a bare SQL reply', () => {
        expect(parseLeanReply('{"action":"answer","sql":"SELECT 1","measures":["x"]}')).toMatchObject({ action: 'answer', sql: 'SELECT 1', measures: ['x'] });
        expect(parseLeanReply('SELECT "make", SUM("price") FROM "data" GROUP BY 1')).toMatchObject({ action: 'answer' });
    });
});

describe('lean AI SQL — privacy of repair requests', () => {
    it('removes values from a database error before it is sent back', () => {
        const scrubbed = scrubErrorForModel("Conversion Error: Could not convert string 'Jane Smith' to INT32 in column \"customer\" at 2024-03-01 value 1234567");
        expect(scrubbed).not.toContain('Jane Smith');
        expect(scrubbed).not.toContain('2024-03-01');
        expect(scrubbed).not.toContain('1234567');
        expect(scrubbed).toContain('INT32');
        expect(scrubbed).toContain('"customer"');
    });
});

describe('lean AI SQL — what the AI is sent', () => {
    it('describes columns by name, type and role only', () => {
        const { model } = resolveAISQLSemanticModel(dataset);
        const text = describeColumnsOnly(model);
        expect(text).toContain('"price": NUMBER; measure (money)');
        expect(text).toContain('"manufacturer": TEXT; category');
        expect(text).not.toMatch(/\d{3,}/);   // no numbers from the data at all
    });
});

describe('lean AI SQL — chart shape and insights', () => {
    it('treats a numeric year as a grouping and spots a trend', () => {
        const plan = planFromResult('Total price by year', [{ year: 2020, total_price: 10 }, { year: 2021, total_price: 12 }]);
        expect(plan.dimensions.map(d => d.field)).toEqual(['year']);
        expect(plan.metrics.map(m => m.field)).toEqual(['total_price']);
        expect(plan.intent).toBe('trend');
    });

    it('names periods the way people say them', () => {
        expect(periodLabel('2024-01-01', 'month')).toBe('Jan 2024');
        expect(periodLabel('2024-03-05', 'day')).toBe('5 Mar 2024');
        expect(periodLabel('2024-04-01', 'quarter')).toBe('Q2 2024');
        expect(periodLabel('Ford')).toBe('Ford');
    });

    it('writes ranking insights from the returned numbers', () => {
        const result = [
            { manufacturer: 'Ford', total_price: 400 },
            { manufacturer: 'BMW', total_price: 300 },
            { manufacturer: 'Honda', total_price: 200 },
            { manufacturer: 'Toyota', total_price: 100 },
        ];
        const plan = planFromResult('Top manufacturers by total price', result);
        const { model } = resolveAISQLSemanticModel(dataset);
        const insights = buildInsights(result, profileResult(result, plan, model), plan);
        expect(insights[0]).toBe('Ford is 33.3% ahead of BMW (400 vs 300).');
        expect(insights[1]).toBe('The top 3 make up 90% of the total price shown.');
        expect(insights[2]).toContain('Toyota is lowest at 100');
    });
});

describe('lean AI SQL — money and periods', () => {
    it('shows money in the currency of the file', () => {
        const sql = 'SELECT "manufacturer", SUM("price") AS total_price FROM "data" GROUP BY 1';
        expect(resultCurrency(sql, 'total_price', dataset.columns)).toBe('GBP');
        expect(resultCurrency('SELECT COUNT(*) AS cars_sold FROM "data" WHERE price > 0', 'cars_sold', dataset.columns)).toBeUndefined();
        const result = [{ manufacturer: 'Ford', total_price: 40000 }, { manufacturer: 'BMW', total_price: 30000 }];
        const plan = planFromResult('Total price by manufacturer', result);
        const { model } = resolveAISQLSemanticModel(dataset);
        expect(buildInsights(result, profileResult(result, plan, model), plan, 'GBP')[0]).toBe('Ford is 33.3% ahead of BMW (£40.0K vs £30.0K).');
    });

    it('fills missing months month by month, not day by day', () => {
        const rows = [{ month: '2024-01-01', v: 1 }, { month: '2024-04-01', v: 2 }, { month: '2024-10-01', v: 2 }];
        expect(inferSpineStep(rows.map(row => row.month))).toBe('quarter');
        expect(fillTimeSpine([{ month: '2024-01-01', v: 1 }, { month: '2024-02-01', v: 3 }, { month: '2024-05-01', v: 2 }], 'month', ['v']).map(row => row.month))
            .toEqual(['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01', '2024-05-01']);
        expect(inferSpineStep(['2024-01-01', '2025-01-01'])).toBe('year');
        expect(inferSpineStep(['2024-01-01', '2024-01-08', '2024-01-22'])).toBe('week');
        // A gap far larger than the data is left alone rather than drawn as spikes.
        expect(fillTimeSpine([{ d: '2020-01-03', v: 1 }, { d: '2024-04-01', v: 2 }], 'd', ['v'])).toHaveLength(2);
    });
});

describe('lean AI SQL — highest and lowest per group', () => {
    const months = ['2025-01-01', '2025-02-01', '2025-03-01'];
    const long = months.flatMap((month, i) => [
        { month, sales_type: 'Highest', product: ['Mug', 'Lamp', 'Mug'][i], total_sales: 9000 + i },
        { month, sales_type: 'Lowest', product: ['Bottle', 'Yoga Mat', 'Bottle'][i], total_sales: 500 + i },
    ]);

    it('keeps every product name, one row per month (long form with a type column)', () => {
        const shape = normaliseExtremes(long, 'show me month wise highest and lowest sales for products')!;
        expect(shape.group).toBe('month');
        expect(shape.rows).toEqual([
            { month: '2025-01-01', highest_product: 'Mug', highest_total_sales: 9000, lowest_product: 'Bottle', lowest_total_sales: 500 },
            { month: '2025-02-01', highest_product: 'Lamp', highest_total_sales: 9001, lowest_product: 'Yoga Mat', lowest_total_sales: 501 },
            { month: '2025-03-01', highest_product: 'Mug', highest_total_sales: 9002, lowest_product: 'Bottle', lowest_total_sales: 502 },
        ]);
    });

    it('works out which is highest when the query did not label them', () => {
        const unlabelled = long.map(({ sales_type, ...row }) => row);
        const shape = normaliseExtremes(unlabelled, 'highest and lowest product sales by month')!;
        expect(shape.rows[1]).toMatchObject({ highest_product: 'Lamp', lowest_product: 'Yoga Mat' });
    });

    it('reads the wide form the AI is asked for, and leaves ordinary answers alone', () => {
        const wide = normaliseExtremes([
            { month: '2025-01-01', highest_product: 'Mug', highest_sales: 10, lowest_product: 'Bottle', lowest_sales: 1 },
            { month: '2025-02-01', highest_product: 'Lamp', highest_sales: 12, lowest_product: 'Bottle', lowest_sales: 2 },
        ], 'x')!;
        expect(wide.roles).toEqual([
            { role: 'highest', item: 'highest_product', value: 'highest_sales' },
            { role: 'lowest', item: 'lowest_product', value: 'lowest_sales' },
        ]);
        expect(normaliseExtremes([{ region: 'North', total: 1 }, { region: 'South', total: 2 }], 'total by region')).toBeNull();
        expect(normaliseExtremes([{ month: '2025-01-01', total: 1 }, { month: '2025-02-01', total: 2 }], 'highest and lowest month')).toBeNull();
    });

    it('describes the answer with the names in it', () => {
        const shape = normaliseExtremes(long, 'month wise highest and lowest sales for products')!;
        const { summary, insights } = extremesNarrative(shape, 'GBP');
        expect(summary).toBe('For each period, the product with the highest and lowest total sales — 3 periods in all.');
        expect(insights[0]).toBe('Highest overall: Mug with £9,002 in Mar 2025.');
        expect(insights[1]).toBe('Lowest overall: Bottle with £500 in Jan 2025.');
        expect(insights).toContain('Mug was the highest product in 2 of 3 periods.');
    });

    it('charts it as one line per role with names for the tooltip, on one axis', async () => {
        vi.mocked(fetchWithFallback).mockReset();
        vi.mocked(executeSQLViaDuckDB).mockReset();
        aiReplies({ action: 'answer', title: 'Highest and lowest product sales by month', sql: 'SELECT 1', dimensions: ['month', 'sales_type', 'product'], measures: ['total_sales'] });
        vi.mocked(executeSQLViaDuckDB).mockResolvedValueOnce({ data: long, columns: [], error: null } as any);
        const result = await runLeanAISQL('show me month wise highest and lowest sales for products', dataset);
        expect(result.chart).toMatchObject({
            chartType: 'multiLine', xKey: 'month', yKey: 'highest_total_sales', secondaryYKeys: ['lowest_total_sales'], useDualAxis: false,
            pointLabelKeys: { highest_total_sales: 'highest_product', lowest_total_sales: 'lowest_product' },
        });
        expect(result.chartData).toHaveLength(3);
        expect(result.narrative?.summary).toContain('the product with the highest and lowest total sales');
    });
});

describe('lean AI SQL — end to end with the AI and DuckDB stubbed', () => {
    beforeEach(() => {
        vi.mocked(fetchWithFallback).mockReset();
        vi.mocked(executeSQLViaDuckDB).mockReset();
    });

    it('asks a follow-up with choices for a vague question, and sends no rows', async () => {
        aiReplies({
            action: 'clarify',
            question: 'What does "best performing" mean for you?',
            options: [
                { label: 'Total sales', question: 'Top 10 models by total price' },
                { label: 'Cars sold', question: 'Top 10 models by number of cars sold' },
                { label: 'Average price', question: 'Top 10 models by average price' },
            ],
        });
        const run = runLeanAISQL('What is my best performing product?', dataset);
        await expect(run).rejects.toBeInstanceOf(AISQLClarificationError);
        await run.catch((error: AISQLClarificationError) => {
            expect(error.options.map(option => option.label)).toEqual(['Total sales', 'Cars sold', 'Average price']);
        });
        const sent = JSON.stringify(vi.mocked(fetchWithFallback).mock.calls[0][0]);
        expect(sent).toContain('price');
        // Only names and types: no values, ranges, counts or dates from the data.
        for (const leaked of ['M5', 'Ford', '9000', '28500', '2019', 'distinct', 'range', 'rows']) {
            expect(String(vi.mocked(fetchWithFallback).mock.calls[0][0][1].content)).not.toContain(leaked);
        }
        expect(executeSQLViaDuckDB).not.toHaveBeenCalled();
    });

    it('answers a clear question: runs locally, picks a chart, writes insights', async () => {
        aiReplies({
            action: 'answer',
            title: 'Total price by manufacturer',
            sql: 'SELECT "manufacturer", ROUND(SUM("price"), 2) AS total_price FROM "data" GROUP BY 1 ORDER BY 2 DESC LIMIT 10',
            dimensions: ['manufacturer'],
            measures: ['total_price'],
            explanation: 'Added up price for each manufacturer.',
        });
        vi.mocked(executeSQLViaDuckDB).mockResolvedValueOnce({
            data: [
                { manufacturer: 'Ford', total_price: 400 },
                { manufacturer: 'BMW', total_price: 300 },
                { manufacturer: 'Honda', total_price: 200 },
            ],
            columns: ['manufacturer', 'total_price'],
            error: null,
        } as any);
        const result = await runLeanAISQL('Total price by manufacturer', dataset);
        expect(result.rawData).toHaveLength(3);
        expect(result.chart.xKey).toBe('manufacturer');
        expect(result.chart.yKey).toBe('total_price');
        expect(result.narrative?.headline).toBe('Total price by manufacturer');
        expect(result.narrative?.insights?.length).toBeGreaterThan(0);
        expect(result.explanation).toBe('Added up price for each manufacturer.');
    });

    it('lists several rates as bars and keeps the count off the % axis', async () => {
        aiReplies({
            action: 'answer', title: 'Appointments involving patients with these health conditions',
            sql: 'SELECT ROUND(100.0 * COUNT_IF("hipertension") / COUNT(*), 1) AS hypertension_rate_pct, ROUND(100.0 * COUNT_IF("diabetes") / COUNT(*), 1) AS diabetes_rate_pct, ROUND(100.0 * COUNT_IF("alcoholism") / COUNT(*), 1) AS alcoholism_rate_pct, COUNT(*) AS appointments FROM "data"',
            dimensions: [], measures: ['hypertension_rate_pct', 'diabetes_rate_pct', 'alcoholism_rate_pct', 'appointments'],
        });
        vi.mocked(executeSQLViaDuckDB).mockResolvedValue({
            data: [{ hypertension_rate_pct: 19.7, diabetes_rate_pct: 7.2, alcoholism_rate_pct: 3, appointments: 106987 }], columns: [], error: null,
        } as any);
        const result = await runLeanAISQL('What percentage of appointments involve patients with hypertension, diabetes or alcoholism?', dataset);
        vi.mocked(executeSQLViaDuckDB).mockReset();
        const shown = JSON.stringify(result.chartData || result.rawData);
        expect(shown).not.toContain('106987');
        expect(shown).not.toMatch(/originalKey/i);
        expect(result.rawData).toEqual([{ measure: 'Hypertension', share_pct: 19.7 }, { measure: 'Diabetes', share_pct: 7.2 }, { measure: 'Alcoholism', share_pct: 3 }]);
        expect(result.chart.xKey).toBe('measure');
        expect(result.chart.yKey).toBe('share_pct');
        expect(result.narrative?.summary).toBe('Hypertension 19.7%, diabetes 7.2% and alcoholism 3% — out of 106,987 appointments.');
        expect(JSON.stringify(result.narrative)).not.toMatch(/originalKey|Metric, Value/);
    });

    it('answers one rate with the count behind it as a single figure', async () => {
        aiReplies({ action: 'answer', sql: 'SELECT ROUND(100.0 * COUNT_IF(NOT "showed_up") / COUNT(*), 1) AS no_show_rate_pct, COUNT(*) AS appointments FROM "data"', dimensions: [], measures: ['no_show_rate_pct', 'appointments'] });
        vi.mocked(executeSQLViaDuckDB).mockResolvedValue({ data: [{ no_show_rate_pct: 20.2, appointments: 106987 }], columns: [], error: null } as any);
        const result = await runLeanAISQL('What is the no-show rate?', dataset);
        vi.mocked(executeSQLViaDuckDB).mockReset();
        expect(result.rawData).toEqual([{ no_show_rate_pct: 20.2 }]);
        expect(result.narrative?.summary).toBe('No show rate: 20.2% — out of 106,987 appointments.');
    });

    it('repairs a failed query once, without sending values', async () => {
        aiReplies(
            { action: 'answer', sql: 'SELECT "make", SUM("price") AS total_price FROM "data" GROUP BY 1' },
            { action: 'answer', sql: 'SELECT "manufacturer", SUM("price") AS total_price FROM "data" GROUP BY 1', dimensions: ['manufacturer'], measures: ['total_price'] },
        );
        vi.mocked(executeSQLViaDuckDB)
            .mockResolvedValueOnce({ data: [], columns: [], error: "Binder Error: Referenced column \"make\" not found; candidates 'manufacturer'" } as any)
            .mockResolvedValueOnce({ data: [{ manufacturer: 'Ford', total_price: 10 }, { manufacturer: 'BMW', total_price: 5 }], columns: [], error: null } as any);
        const result = await runLeanAISQL('Total price by make', dataset);
        expect(result.repairAttempts).toBe(1);
        expect(result.rawData).toHaveLength(2);
        const repairPrompt = JSON.stringify(vi.mocked(fetchWithFallback).mock.calls[1][0]);
        expect(repairPrompt).not.toContain("'manufacturer'");
    });

    it('never stops to ask on automatic runs; it takes the most likely choice', async () => {
        aiReplies(
            { action: 'clarify', question: 'Which measure?', options: [{ label: 'Total sales', question: 'Top 10 models by total price' }] },
            { action: 'answer', sql: 'SELECT "model", SUM("price") AS total_price FROM "data" GROUP BY 1', dimensions: ['model'], measures: ['total_price'] },
        );
        vi.mocked(executeSQLViaDuckDB).mockResolvedValueOnce({ data: [{ model: 'M1', total_price: 3 }, { model: 'M2', total_price: 2 }], columns: [], error: null } as any);
        const result = await runLeanAISQL('Best models', dataset, { autoChoose: true });
        expect(result.rawData).toHaveLength(2);
        expect(String(vi.mocked(fetchWithFallback).mock.calls[1][0][1].content)).toContain('Top 10 models by total price');
    });

    it('sends a new question with no chat history', async () => {
        aiReplies({ action: 'answer', question: 'Total price by manufacturer', sql: 'SELECT "manufacturer", SUM("price") AS total_price FROM "data" GROUP BY 1', dimensions: ['manufacturer'], measures: ['total_price'] });
        vi.mocked(executeSQLViaDuckDB).mockResolvedValueOnce({ data: [{ manufacturer: 'Ford', total_price: 3 }, { manufacturer: 'BMW', total_price: 2 }], columns: [], error: null } as any);
        const result = await runLeanAISQL('Total price by manufacturer', dataset);
        const [system, user] = vi.mocked(fetchWithFallback).mock.calls[0][0] as any[];
        expect(String(user.content)).not.toContain('EARLIER IN THIS CHAT');
        expect(String(system.content)).not.toContain('CONVERSATION');
        expect(result.conversation).toEqual({ standaloneQuestion: 'Total price by manufacturer', contextTurns: 0, usedContext: false });
    });

    it('sends a follow-up with the earlier question and SQL only, and keeps the standalone question', async () => {
        aiReplies({ action: 'answer', question: 'Total price by manufacturer for 2018 cars', follow_up: true, sql: 'SELECT "manufacturer", SUM("price") AS total_price FROM "data" WHERE "year_of_manufacture" = 2018 GROUP BY 1', dimensions: ['manufacturer'], measures: ['total_price'] });
        vi.mocked(executeSQLViaDuckDB).mockResolvedValueOnce({ data: [{ manufacturer: 'Ford', total_price: 3 }, { manufacturer: 'BMW', total_price: 2 }], columns: [], error: null } as any);
        const context = [{ question: 'Total price by manufacturer', sql: 'SELECT "manufacturer", SUM("price") AS total_price FROM "data" GROUP BY 1' }];
        const result = await runLeanAISQL('only 2018 cars', dataset, { context });
        const [system, user] = vi.mocked(fetchWithFallback).mock.calls[0][0] as any[];
        expect(String(system.content)).toContain('CONVERSATION');
        expect(String(user.content)).toContain('EARLIER IN THIS CHAT\n1. Asked: "Total price by manufacturer"');
        expect(String(user.content)).toContain('NEW MESSAGE\nonly 2018 cars');
        for (const leaked of ['Ford', 'BMW', '9000']) expect(String(user.content)).not.toContain(leaked);
        expect(result.conversation).toEqual({ standaloneQuestion: 'Total price by manufacturer for 2018 cars', contextTurns: 1, usedContext: true });
        expect(result.narrative?.headline).toBeTruthy();
    });

    it('reopens a saved answer by re-running its SQL, with no AI call', async () => {
        vi.mocked(executeSQLViaDuckDB).mockResolvedValueOnce({ data: [{ manufacturer: 'Ford', total_price: 3 }, { manufacturer: 'BMW', total_price: 2 }], columns: [], error: null } as any);
        const result = await rerunSavedAnswer({ question: 'Total price by manufacturer', sql: 'SELECT "manufacturer", SUM("price") AS total_price FROM "data" GROUP BY 1', dimensions: ['manufacturer'], measures: ['total_price'] }, dataset);
        expect(fetchWithFallback).not.toHaveBeenCalled();
        expect(result.rawData).toHaveLength(2);
        expect(result.tokenUsage?.total).toBe(0);
        await expect(rerunSavedAnswer({ question: 'x', sql: 'DROP TABLE "data"' }, dataset)).rejects.toMatchObject({ kind: 'sql_validation_failed' });
    });

    it('refuses anything that is not a read-only query', async () => {
        aiReplies({ action: 'answer', sql: 'DELETE FROM "data"' });
        await expect(runLeanAISQL('Remove everything', dataset)).rejects.toMatchObject({ kind: 'sql_validation_failed' });
        expect(executeSQLViaDuckDB).not.toHaveBeenCalled();
    });
});

describe('lean AI SQL — conversation', () => {
    it('reads a reply in words from the analysis AI', () => {
        expect(parseLeanReply('{"action":"chat","message":"I check the wording first.","suggestions":["Total sales by region"]}'))
            .toEqual({ action: 'chat', message: 'I check the wording first.', suggestions: ['Total sales by region'] });
    });

    it('reads a request for a dataset overview', () => {
        expect(parseLeanReply('{"action":"overview"}')).toEqual({ action: 'overview' });
    });
});

describe('lean AI SQL — the AI decides what a message is', () => {
    beforeEach(() => {
        vi.mocked(fetchWithFallback).mockReset();
        vi.mocked(executeSQLViaDuckDB).mockReset();
    });

    it('hands a summary request back to the app, with no query run', async () => {
        aiReplies({ action: 'overview' });
        await expect(runLeanAISQL('Can you generate a summary of my dataset uploaded?', dataset)).rejects.toBeInstanceOf(AISQLOverviewRequest);
        expect(executeSQLViaDuckDB).not.toHaveBeenCalled();
    });

    it('tells the AI to analyse when the user switched the message to analysis', async () => {
        aiReplies({ action: 'answer', sql: 'SELECT "manufacturer", SUM("price") AS total_price FROM "data" GROUP BY 1', dimensions: ['manufacturer'], measures: ['total_price'] });
        vi.mocked(executeSQLViaDuckDB).mockResolvedValueOnce({ data: [{ manufacturer: 'Ford', total_price: 3 }, { manufacturer: 'BMW', total_price: 2 }], columns: [], error: null } as any);
        await runLeanAISQL('how are the makers doing', dataset, { requireAnalysis: true });
        const [, user] = vi.mocked(fetchWithFallback).mock.calls[0][0] as any[];
        expect(String(user.content)).toContain('Do not reply with action "chat"');
    });

    it('offers the last answer but only counts it as a follow-up when the AI says so', async () => {
        aiReplies({ action: 'answer', question: 'Average mileage by model', follow_up: false, sql: 'SELECT "model", AVG("mileage") AS avg_mileage FROM "data" GROUP BY 1', dimensions: ['model'], measures: ['avg_mileage'] });
        vi.mocked(executeSQLViaDuckDB).mockResolvedValueOnce({ data: [{ model: 'M1', avg_mileage: 3 }, { model: 'M2', avg_mileage: 2 }], columns: [], error: null } as any);
        const context = [{ question: 'Total price by manufacturer', sql: 'SELECT "manufacturer", SUM("price") AS total_price FROM "data" GROUP BY 1' }];
        const result = await runLeanAISQL('Average mileage by fuel type', dataset, { context });
        expect(result.conversation?.usedContext).toBe(false);
    });
});
