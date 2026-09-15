import { describe, expect, it } from 'vitest';
import { resolveConversationTurn } from '../services/ai-sql/conversationIntent';
import { runAISQLPipeline } from '../services/ai-sql/pipeline';
import type { Dataset } from '../types';

const dataset = {
    id: 'trade', name: 'trade.xlsx', rows: [], columns: [], totalRows: 0, etlLogs: [],
    aiSqlSemanticModel: {
        datasetName: 'trade', rowCount: 0, grain: 'trade record', compositeMetrics: [], derivedMetrics: [],
        fields: [
            { name: 'value_usd_bn', displayLabel: 'Trade Value', synonyms: ['sales'], role: 'metric', semanticType: 'currency' },
            { name: 'flow_direction', displayLabel: 'Flow Direction', synonyms: ['imports exports'], role: 'dimension', semanticType: 'category' },
        ],
    },
} as Dataset;

describe('AI SQL conversational intent gate', () => {
    it.each(['Hello', 'helo', 'hello there', 'hi!', 'Good morning', 'How are you?'])('handles greetings locally: %s', question => {
        expect(resolveConversationTurn(question, dataset).kind).toBe('greeting');
    });

    it.each(['Help', 'What can you do?', 'Who are you?', 'How do I ask?'])('handles help locally: %s', question => {
        expect(resolveConversationTurn(question, dataset).kind).toBe('help');
    });

    it('does not mistake a real dataset question for small talk', () => {
        expect(resolveConversationTurn('Show trade value by flow direction', dataset).kind).toBe('analysis');
    });

    it('uses exactly one prior business question for an explicit follow-up', () => {
        const result = resolveConversationTurn('Now for FY2025', dataset, 'Compare imports and exports');
        expect(result.kind).toBe('follow_up');
        expect(result.resolvedQuestion).toBe('Compare imports and exports; Now for FY2025');
    });

    it('does not invent context when no previous business question exists', () => {
        expect(resolveConversationTurn('Now for FY2025', dataset).kind).toBe('analysis');
    });

    it('stops greetings at the pipeline boundary before SQL planning', async () => {
        await expect(runAISQLPipeline('hello', dataset)).rejects.toMatchObject({
            kind: 'conversation_only',
        });
    });
});
