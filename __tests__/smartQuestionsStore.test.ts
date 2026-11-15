/**
 * AI-written suggested questions are kept per dataset version, so opening the
 * app or signing in again does not pay for them twice.
 */
import { describe, expect, it } from 'vitest';
import { ColumnType, type Dataset } from '../types';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
};

const questions = Array.from({ length: 6 }, (_, i) => ({ question: `Which region leads on revenue ${i}?`, category: 'ranking', priority: 60 - i }));
let calls = 0;
(globalThis as any).fetch = async () => { calls++; return { ok: true, json: async () => ({ questions }) } as any; };

const dataset = (version = 1) => ({ id: 'd1', name: 'sales.csv', version, rows: [], totalRows: 100, columns: [{ name: 'region', type: ColumnType.DIMENSION }, { name: 'revenue', type: ColumnType.METRIC }] }) as unknown as Dataset;

describe('suggested questions', () => {
    it('are asked for once per dataset version, even across visits', async () => {
        const generator = await import('../services/questionGenerator');
        const a = await generator.generateQuestions(dataset());
        const callsAfterFirst = calls;
        expect(a.source).toBe('ai');
        expect(store.get(generator.SMART_QUESTIONS_STORE)).toBeTruthy();
        generator.forgetQuestionsInMemory(); // a new visit
        const second = generator;
        await second.generateQuestions(dataset());
        expect(calls).toBe(callsAfterFirst);
        await second.generateQuestions(dataset(2));
        expect(calls).toBe(callsAfterFirst + 1);
        second.clearQuestionCache();
        expect(store.has(second.SMART_QUESTIONS_STORE)).toBe(false);
    });
});
