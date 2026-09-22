import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    AI_SQL_CONVERSATION_MAX_TOKENS,
    AI_SQL_CONVERSATION_MODEL,
    buildAIConversationMessages,
    extractJSONObject,
    normalizeAIConversationResponse,
    validateAIConversationRequest,
} = require('../backend/aiSqlConversation.js');

describe('server-owned AI SQL conversation resolver', () => {
    it('accepts only the current and previous business questions', () => {
        const result = validateAIConversationRequest({
            currentQuestion: '  Now   make it monthly  ',
            previousBusinessQuestion: 'Revenue by region',
        });

        expect(result).toEqual({
            valid: true,
            value: {
                currentQuestion: 'Now make it monthly',
                previousBusinessQuestion: 'Revenue by region',
            },
        });

        expect(validateAIConversationRequest({
            currentQuestion: 'Now make it monthly',
            previousBusinessQuestion: 'Revenue by region',
            schema: 'PRIVATE_SCHEMA',
        })).toMatchObject({ valid: false, error: expect.stringMatching(/unexpected request field/i) });
        expect(validateAIConversationRequest({
            currentQuestion: 'Now make it monthly',
            model: 'untrusted/model',
        })).toMatchObject({ valid: false, error: expect.stringMatching(/unexpected request field/i) });
    });

    it('keeps the prompt, model and small output budget server-owned', () => {
        const messages = buildAIConversationMessages('For 2025 show profit by product', 'Revenue by region');
        expect(AI_SQL_CONVERSATION_MODEL).toBe('openai/gpt-5.6-luna');
        expect(AI_SQL_CONVERSATION_MAX_TOKENS).toBe(220);
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain('sole conversational resolver');
        expect(messages[1].content).toBe(JSON.stringify({
            currentQuestion: 'For 2025 show profit by product',
            previousBusinessQuestion: 'Revenue by region',
        }));
        expect(JSON.stringify(messages)).not.toContain('PRIVATE_SCHEMA');
        expect(JSON.stringify(messages)).not.toContain('localEvidence');
    });

    it('normalizes a valid isolated-question decision', () => {
        expect(normalizeAIConversationResponse({
            route: 'analysis',
            turnType: 'new_question',
            usedPreviousQuestion: true,
            resolvedQuestion: 'Show profit by product for 2025',
            confidence: 1.2,
        }, 'Revenue by region')).toEqual({
            route: 'analysis',
            turnType: 'new_question',
            usedPreviousQuestion: false,
            resolvedQuestion: 'Show profit by product for 2025',
            confidence: 1,
        });
    });

    it('rejects follow-up inheritance without previous context', () => {
        expect(() => normalizeAIConversationResponse({
            route: 'analysis',
            turnType: 'follow_up',
            resolvedQuestion: 'Show revenue monthly',
            confidence: 0.8,
        }, null)).toThrow(/unavailable previous context/i);
    });

    it('extracts a fenced JSON response without accepting prose as fields', () => {
        expect(extractJSONObject('```json\n{"route":"analysis"}\n```')).toEqual({ route: 'analysis' });
        expect(extractJSONObject('not json')).toBeNull();
    });
});
