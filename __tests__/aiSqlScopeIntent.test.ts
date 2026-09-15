import { describe, expect, it } from 'vitest';
import { buildFocusedQuestionSuggestion, detectBroadScopeQuestion } from '../services/ai-sql/scopeIntent';
import { runAISQLPipeline } from '../services/ai-sql/pipeline';
import type { Dataset } from '../types';

describe('AI SQL broad-scope clarification', () => {
    it.each([
        'give me full data summary, every data point summary',
        'Summarize the entire dataset',
        'Tell me everything about this workbook',
        'Analyze this data',
    ])('clarifies an unbounded dataset-wide request: %s', question => {
        expect(detectBroadScopeQuestion(question).needsClarification).toBe(true);
    });

    it.each([
        'Show all orders in 2025',
        'Give me a summary of sales by region',
        'Count every customer with no orders',
        'Show the top 10 products by total revenue',
    ])('preserves a materially scoped analytical request: %s', question => {
        expect(detectBroadScopeQuestion(question).needsClarification).toBe(false);
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
    });

    it('enforces clarification at the pipeline boundary before SQL generation', async () => {
        const dataset = {
            id: 'minimal', name: 'minimal.csv', rows: [{ category: 'A', amount: 1 }],
            columns: [], totalRows: 1, etlLogs: [],
        } as Dataset;

        await expect(runAISQLPipeline('Give me a complete summary of the entire dataset', dataset))
            .rejects.toMatchObject({ kind: 'clarification_required' });
    });
});
