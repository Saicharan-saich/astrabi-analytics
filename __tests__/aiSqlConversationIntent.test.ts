import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dataset } from '../types';

vi.mock('../services/ai-sql/conversationClient', () => ({
    requestAIConversationTurn: vi.fn(),
}));

import { requestAIConversationTurn } from '../services/ai-sql/conversationClient';
import { resolveConversationTurnWithAI } from '../services/ai-sql/conversationIntent';

const dataset = {
    id: 'trade', name: 'trade.xlsx', rows: [], columns: [], totalRows: 0, etlLogs: [],
} as Dataset;

function mockResolution(resolution: Record<string, unknown>) {
    vi.mocked(requestAIConversationTurn).mockResolvedValue({
        model: 'openai/gpt-5.6-luna',
        resolution,
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    });
}

describe('AI SQL LLM-only conversational intent', () => {
    beforeEach(() => vi.mocked(requestAIConversationTurn).mockReset());

    it('asks the LLM to classify greetings instead of handling them locally', async () => {
        mockResolution({
            route: 'conversation',
            turnType: 'greeting',
            resolvedQuestion: 'Hello',
            confidence: 0.99,
            replyTitle: 'Hello',
            replyMessage: 'Ask me a question about your data.',
        });

        const result = await resolveConversationTurnWithAI('Hello', dataset);

        expect(requestAIConversationTurn).toHaveBeenCalledOnce();
        expect(result).toMatchObject({ route: 'conversation', turnType: 'greeting', tokens: 60 });
    });

    it('accepts an LLM-resolved follow-up using exactly one previous business question', async () => {
        mockResolution({
            route: 'analysis',
            turnType: 'follow_up',
            usedPreviousQuestion: true,
            resolvedQuestion: 'Compare imports and exports for FY2025',
            confidence: 0.97,
        });

        const result = await resolveConversationTurnWithAI(
            'Now for FY2025',
            dataset,
            'Compare imports and exports',
        );

        expect(result).toMatchObject({
            turnType: 'follow_up',
            usedPreviousQuestion: true,
            resolvedQuestion: 'Compare imports and exports for FY2025',
        });
        expect(requestAIConversationTurn).toHaveBeenCalledWith({
            currentQuestion: 'Now for FY2025',
            previousBusinessQuestion: 'Compare imports and exports',
        });
    });

    it('lets the LLM keep a complete question isolated from prior context', async () => {
        mockResolution({
            route: 'analysis',
            turnType: 'new_question',
            usedPreviousQuestion: false,
            resolvedQuestion: 'Which country has the highest exports?',
            confidence: 0.98,
        });

        const result = await resolveConversationTurnWithAI(
            'Which country has the highest exports?',
            dataset,
            'Give me a full data summary',
        );

        expect(result.turnType).toBe('new_question');
        expect(result.usedPreviousQuestion).toBe(false);
        expect(result.resolvedQuestion).toBe('Which country has the highest exports?');
    });

    it('rejects an LLM follow-up decision when no previous question exists', async () => {
        mockResolution({
            route: 'analysis',
            turnType: 'follow_up',
            resolvedQuestion: 'Show FY2025 results',
            confidence: 0.7,
        });

        await expect(resolveConversationTurnWithAI('Now for FY2025', dataset))
            .rejects.toThrow(/context.*not available/i);
    });
});
