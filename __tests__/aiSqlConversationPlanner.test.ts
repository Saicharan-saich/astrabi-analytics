import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dataset } from '../types';

vi.mock('../services/ai-sql/conversationClient', () => ({
    requestAIConversationTurn: vi.fn(),
}));

import { requestAIConversationTurn } from '../services/ai-sql/conversationClient';
import {
    normalizeAIConversationResolution,
    resolveConversationTurnWithAI,
} from '../services/ai-sql/conversationIntent';

const dataset = {
    id: 'trade', name: 'trade.xlsx', totalRows: 1, etlLogs: [],
    rows: [{ value_usd_bn: 10, flow_direction: 'SECRET_ROW_VALUE' }],
    columns: [],
    aiSqlSemanticModel: {
        datasetName: 'trade', rowCount: 1, grain: 'trade record', compositeMetrics: [], derivedMetrics: [],
        fields: [
            { name: 'value_usd_bn', displayLabel: 'Trade Value', synonyms: ['trade amount'], role: 'metric', semanticType: 'currency', physicalType: 'number', defaultAgg: 'sum', timeGrainSupport: [], valueDescriptors: [], distinctCount: 1, hasNulls: false },
            { name: 'flow_direction', displayLabel: 'Flow Direction', synonyms: ['imports exports'], role: 'dimension', semanticType: 'category', physicalType: 'string', defaultAgg: 'none', timeGrainSupport: [], valueDescriptors: [], distinctCount: 1, hasNulls: false },
        ],
    },
} as Dataset;

describe('AI SQL LLM conversation planner', () => {
    beforeEach(() => vi.mocked(requestAIConversationTurn).mockReset());

    it('lets the model keep a complete new question independent from a previous summary', async () => {
        vi.mocked(requestAIConversationTurn).mockResolvedValue({
            model: 'openai/gpt-5.6-luna',
            resolution: {
                route: 'analysis',
                turnType: 'new_question',
                resolvedQuestion: 'Which country has the highest exports?',
                confidence: 0.98,
            },
            usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        });

        const result = await resolveConversationTurnWithAI(
            'Which country has the highest exports?',
            dataset,
            'Give me a full data summary',
        );

        expect(result).toMatchObject({
            route: 'analysis',
            turnType: 'new_question',
            resolvedQuestion: 'Which country has the highest exports?',
            confidence: 0.98,
            tokens: 150,
        });
        expect(requestAIConversationTurn).toHaveBeenCalledWith({
            currentQuestion: 'Which country has the highest exports?',
            previousBusinessQuestion: 'Give me a full data summary',
        });
        const sharedPayload = JSON.stringify(vi.mocked(requestAIConversationTurn).mock.calls[0][0]);
        expect(sharedPayload).not.toContain('localEvidence');
        expect(sharedPayload).not.toContain('analysisPlan');
        expect(sharedPayload).not.toContain('value_usd_bn');
        expect(sharedPayload).not.toContain('SECRET_ROW_VALUE');
    });

    it('accepts explicit model-owned summary routing', () => {
        expect(normalizeAIConversationResolution({
            route: 'summary_story',
            turnType: 'multi_intent',
            resolvedQuestion: 'Build a trade summary and include country export ranking',
            confidence: 0.9,
        }, 'Build a trade summary and include country export ranking', null, 'luna', 42)).toMatchObject({
            route: 'summary_story',
            turnType: 'multi_intent',
            tokens: 42,
        });
    });

    it('fails closed when the model returns an invalid conversation route', () => {
        expect(() => normalizeAIConversationResolution({
            route: 'execute_anything',
            turnType: 'new_question',
            resolvedQuestion: 'Show sales',
        }, 'Show sales', null, 'luna', 0)).toThrow(/invalid routing decision/i);
    });
});
