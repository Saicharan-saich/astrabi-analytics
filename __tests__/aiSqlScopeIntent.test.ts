import { describe, expect, it } from 'vitest';
import {
    buildFocusedQuestionSuggestion,
    buildQuestionExamples,
    buildSummaryStoryQuestions,
    detectBroadScopeQuestion,
    detectSummaryRequest,
} from '../services/ai-sql/scopeIntent';
import { runAISQLPipeline } from '../services/ai-sql/pipeline';
import type { Dataset } from '../types';

describe('AI SQL broad-scope clarification', () => {
    it.each([
        'Give me a complete analysis of the entire dataset',
    ])('clarifies an unbounded dataset-wide request: %s', question => {
        expect(detectBroadScopeQuestion(question).needsClarification).toBe(true);
    });

    it.each([
        'Show all orders in 2025',
        'give me full data summary, every data point summary',
        'Summarize the entire dataset',
        'Give me a summary of sales by region',
        'Count every customer with no orders',
        'Show the top 10 products by total revenue',
    ])('preserves a materially scoped analytical request: %s', question => {
        expect(detectBroadScopeQuestion(question).needsClarification).toBe(false);
    });

    it.each([
        'give me full data summary, every data point summary',
        "Give me this month's summary",
        'Show an FY2025 overview by flow direction',
        'Create a sales summary for India',
        'Tell me everything about this workbook',
        'Analyze this data',
    ])('recognizes a summary as a multi-visual analytical intent: %s', question => {
        expect(detectSummaryRequest(question).isSummary).toBe(true);
    });

    it('does not hijack a physical summary-name field projection', () => {
        expect(detectSummaryRequest('Show degree summary name').isSummary).toBe(false);
    });

    it('builds a focused example from metadata without reading row values', () => {
        const dataset = {
            id: 'trade', name: 'trade.xlsx', rows: [], columns: [], totalRows: 0, etlLogs: [],
            aiSqlSemanticModel: {
                datasetName: 'trade', rowCount: 0, grain: 'trade summary', compositeMetrics: [], derivedMetrics: [],
                fields: [
                    { name: 'value_usd_bn', displayLabel: 'Trade Value', role: 'metric', semanticType: 'currency' },
                    { name: 'flow_direction', displayLabel: 'Flow Direction', role: 'dimension', semanticType: 'category' },
                ],
            },
        } as Dataset;

        expect(buildFocusedQuestionSuggestion(dataset)).toBe('Show total Trade Value by Flow Direction');
        expect(buildQuestionExamples(dataset)).toEqual([
            'Show total Trade Value by Flow Direction',
            'Compare Trade Value by Flow Direction',
            'Show the top 10 Flow Direction by Trade Value',
            'Show average Trade Value by Flow Direction',
            'Count records by Flow Direction',
        ]);
    });

    it('routes summaries away from the single-result pipeline before SQL generation', async () => {
        const dataset = {
            id: 'minimal', name: 'minimal.csv', rows: [{ category: 'A', amount: 1 }],
            columns: [], totalRows: 1, etlLogs: [],
        } as Dataset;

        await expect(runAISQLPipeline('Give me a complete summary of the entire dataset', dataset))
            .rejects.toMatchObject({ kind: 'summary_story_required' });
    });

    it('builds a filtered multi-visual story from the current semantic model', () => {
        const dataset = {
            id: 'trade', name: 'trade.xlsx', rows: [], columns: [], totalRows: 0, etlLogs: [],
            aiSqlSemanticModel: {
                datasetName: 'trade', rowCount: 0, grain: 'trade summary', compositeMetrics: [], derivedMetrics: [],
                fields: [
                    { name: 'value_usd_bn', displayLabel: 'Trade Value', role: 'metric', semanticType: 'currency' },
                    { name: 'profit_usd_bn', displayLabel: 'Profit', role: 'metric', semanticType: 'currency' },
                    { name: 'flow_direction', displayLabel: 'Flow Direction', role: 'dimension', semanticType: 'category' },
                    { name: 'trade_scope', displayLabel: 'Trade Scope', role: 'dimension', semanticType: 'category' },
                    { name: 'period_date', displayLabel: 'Period Date', role: 'dimension', semanticType: 'date' },
                ],
            },
        } as Dataset;

        const story = buildSummaryStoryQuestions(dataset, "Give me this month's dataset summary by flow direction");
        expect(story).toHaveLength(6);
        expect(story.map(item => item.question)).toEqual([
            'Count records by Flow Direction for this month',
            'Show total Trade Value by Flow Direction for this month',
            'Show average Trade Value by Flow Direction for this month',
            'Show Trade Value trend by Period Date for this month',
            'Show total Profit by Flow Direction for this month',
            'Show total Trade Value by Trade Scope for this month',
        ]);
        expect(new Set(story.map(item => item.question)).size).toBe(story.length);

        const fiscalProfitStory = buildSummaryStoryQuestions(dataset, 'Profit summary for FY2025 by trade scope');
        expect(fiscalProfitStory[0].question).toBe('Count records by Trade Scope for FY2025');
        expect(fiscalProfitStory[1].question).toBe('Show total Profit by Trade Scope for FY2025');

        const shorthandStory = buildSummaryStoryQuestions(dataset, 'India trade value summary');
        expect(shorthandStory[1].question).toBe('Show total Trade Value for India');
    });
});
