/**
 * AI SQL runs on Claude through OpenRouter. The website asks for a job and the
 * server picks the model and how hard it thinks (backend/aiModels.json).
 */
import { describe, expect, it } from 'vitest';
import { LUNA_MODEL, MODEL_LADDER_LABEL, PLANNER_MODEL, SOL_MODEL, VISION_MODEL, modelLabel, selectAISQLRoute } from '../services/ai-sql/modelConfig';

const { jobConfig, providerBody, resolveModel, catalogue } = require('../backend/aiModels.js');

describe('AI model jobs', () => {
    it('use Claude for every job', () => {
        expect(jobConfig('qi:balanced', {})).toMatchObject({ model: 'anthropic/claude-opus-5.5', effort: 'medium' });
        expect(jobConfig('qi:deep', {})).toMatchObject({ model: 'anthropic/claude-opus-5.5', effort: 'high' });
        expect(jobConfig('qi:fast', {})).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', effort: 'low' });
        expect(jobConfig('qi:vision', {})).toMatchObject({ model: 'anthropic/claude-haiku-5.5', effort: 'low' });
        for (const job of Object.values(catalogue.jobs) as { model: string }[]) expect(job.model).toMatch(/^anthropic\/claude-/);
    });

    it('can be switched on the server without a code change', () => {
        expect(jobConfig('qi:deep', { AI_MODEL_DEEP: 'anthropic/claude-sonnet-5.5', AI_EFFORT_DEEP: 'medium' }))
            .toMatchObject({ model: 'anthropic/claude-sonnet-5.5', effort: 'medium' });
        expect(jobConfig('qi:deep', { AI_EFFORT_DEEP: 'nonsense' }).effort).toBe('high');
    });

    it('send no temperature to Claude 5.5, and keep the reply budget on top of the thinking', () => {
        const body = providerBody({ ...resolveModel('qi:balanced', undefined, {}), messages: [{ role: 'user', content: 'q' }], max_tokens: 1600, temperature: 0 });
        expect(body).toEqual({
            model: 'anthropic/claude-opus-5.5',
            messages: [{ role: 'user', content: 'q' }],
            max_tokens: 1600 + catalogue.thinkingTokens.medium,
            reasoning: { effort: 'medium', exclude: true },
        });
        expect(providerBody({ ...resolveModel('qi:deep', undefined, {}), messages: [], max_tokens: 2400 }).max_tokens).toBe(2400 + catalogue.thinkingTokens.high);
        expect(resolveModel('qi:fast', 'high', {})).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', effort: 'high' });
    });

    it('match what the website asks for', () => {
        expect([LUNA_MODEL, PLANNER_MODEL, SOL_MODEL, VISION_MODEL]).toEqual(['qi:fast', 'qi:balanced', 'qi:deep', 'qi:vision']);
        expect(selectAISQLRoute('Retention by signup cohort', 'sql').model).toBe('qi:deep');
        expect(modelLabel('qi:balanced')).toBe('Claude Opus 5.5');
        expect(modelLabel('anthropic/claude-haiku-5.5')).toBe('Claude Haiku 5.5');
        expect(MODEL_LADDER_LABEL).toBe('Claude Opus 5.5 · Claude Sonnet 5.5 · Claude Haiku 5.5');
    });
});
