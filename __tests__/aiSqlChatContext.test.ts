import { describe, expect, it } from 'vitest';
import { ColumnType } from '../types';
import { classifyTurn, contextForFollowUp, formatContextForPrompt, suggestFollowUps } from '../services/ai-sql/chatContext';
import { answeredTurns, loadConversations, saveConversations, titleFrom, type Conversation } from '../services/ai-sql/chatStore';

const dataset = {
    columns: [
        { name: 'order_date', type: ColumnType.DATE, originalType: 'string' },
        { name: 'region', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'product', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'revenue', type: ColumnType.METRIC, originalType: 'number' },
        { name: 'profit', type: ColumnType.METRIC, originalType: 'number' },
    ],
} as any;

describe('AI SQL chat — deciding what a message is, without the AI', () => {
    it('sends conversation to the AI to reply in words, with a fallback reply ready', () => {
        for (const text of ['hi', 'Hello there!', 'thanks', 'Thank you so much', 'ok', 'what can you do?', 'bye',
            'How do you know if my question is follow up or isolated question?', 'What does median mean?',
            'Is my data safe with you?', 'how does this work?', 'Why did you use a line chart?']) {
            const decision = classifyTurn(text, true, dataset);
            expect(decision.kind, text).toBe('chat');
            expect(decision.fallback?.message, text).toBeTruthy();
        }
    });

    it('keeps data questions as analysis even when they mention "you"', () => {
        expect(classifyTurn('Can you show total revenue by region?', false, dataset).kind).toBe('new');
        expect(classifyTurn('What is the average profit per product?', true, dataset).kind).toBe('new');
        expect(classifyTurn('What is my best performing product?', false, dataset).kind).toBe('new');
    });

    it('sends the first question on its own', () => {
        expect(classifyTurn('now by month', false, dataset).kind).toBe('new');
        expect(classifyTurn('Total revenue by region', false, dataset).kind).toBe('new');
    });

    it('recognises follow-ups that need the last answer', () => {
        for (const text of [
            'now by month', 'what about profit?', 'Only 2024', 'show it as a pie', 'Top 5 only', 'break it down by product',
            'and for London?', 'Great, now by month', 'same for last year', 'per region', 'profit instead', 'exclude returns',
            'I cannot see the product names in the visual, why?', 'the chart is missing March', 'Why is only one product shown?',
            "that's wrong", 'I don\'t see the names',
        ]) {
            expect(classifyTurn(text, true, dataset).kind, text).toBe('follow_up');
        }
    });

    it('treats a complete new question as new, so no history is sent', () => {
        for (const text of [
            'Total revenue by region',
            'Which products have the highest profit margin?',
            'How many orders were placed each month in 2024?',
            'Show the revenue trend by order date',
        ]) {
            expect(classifyTurn(text, true, dataset).kind, text).toBe('new');
        }
    });

    it('sends overview requests to the data story', () => {
        expect(classifyTurn('Give me a summary of my data', true, dataset).kind).toBe('summary');
        expect(classifyTurn('summarise this dataset', false, dataset).kind).toBe('summary');
        expect(classifyTurn('Can you generate a summary of my dataset uploaded?', true, dataset).kind).toBe('summary');
        expect(classifyTurn('What does profit margin mean?', true, { columns: [...dataset.columns, { name: 'profit' }] } as any).kind).toBe('chat');
        // A figure split per/by something is analysis, even with no matching column name.
        expect(classifyTurn('What is the average sales per person?', false, dataset).kind).toBe('new');
        expect(classifyTurn('What is a median?', false, dataset).kind).toBe('chat');
        expect(classifyTurn('What does average mean?', false, dataset).kind).toBe('chat');
        // Questions about the user's own data are analysis, even when they start "What are…".
        expect(classifyTurn('What are my best products?', false, { columns: [{ name: 'product' }, { name: 'revenue' }] } as any).kind).toBe('new');
        expect(classifyTurn('What are our top categories?', false, dataset).kind).toBe('new');
        expect(classifyTurn('What are you able to do?', false, dataset).kind).toBe('chat');
        expect(classifyTurn("What's in my file?", false, dataset).kind).toBe('summary');
        // A summary of one measure split by something is an analysis.
        expect(classifyTurn('Give me a summary of revenue by region', false, dataset).kind).toBe('new');
    });

    it('keeps the context window to the chosen number of answers, questions and SQL only', () => {
        const answered = [1, 2, 3, 4].map(n => ({ question: `Q${n}`, sql: `SELECT ${n}` }));
        expect(contextForFollowUp(answered, 0)).toEqual([]);
        expect(contextForFollowUp(answered, 2).map(turn => turn.question)).toEqual(['Q3', 'Q4']);
        const text = formatContextForPrompt(contextForFollowUp(answered, 1));
        expect(text).toBe('1. Asked: "Q4"\n   SQL: SELECT 4');
    });

    it('suggests follow-ups that are themselves sent as follow-ups', () => {
        const suggestions = suggestFollowUps({ sql: 'SELECT "region", SUM("revenue") AS total_revenue FROM "data" GROUP BY 1', analysis: { xKey: 'region', data: [1, 2, 3, 4, 5, 6].map(n => ({ n })), vis: 'bar' } }, dataset);
        expect(suggestions).toContain('Now show it by month');
        expect(suggestions).toContain('Break it down by product');
        expect(suggestions).toContain('What about profit?');
        for (const suggestion of suggestions) expect(classifyTurn(suggestion, true, dataset).kind, suggestion).toBe('follow_up');
    });
});

describe('AI SQL chat — history', () => {
    it('saves and reloads chats, and marks an unfinished answer as stopped', () => {
        const store = new Map<string, string>();
        (globalThis as any).localStorage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => { store.set(key, value); },
            removeItem: (key: string) => { store.delete(key); },
        };
        const conversation: Conversation = {
            id: 'c1', title: titleFrom('total revenue by region?'), createdAt: 1, updatedAt: 2, tokens: 900,
            turns: [
                { id: 'u1', role: 'user', createdAt: 1, text: 'total revenue by region?', kind: 'new', contextTurns: 0 },
                { id: 'a1', role: 'assistant', createdAt: 1, status: 'done', answer: {
                    title: 'Revenue by region', standaloneQuestion: 'Total revenue by region', sql: 'SELECT 1', rowCount: 3, tokens: 900,
                    analysis: { data: Array.from({ length: 500 }, (_, i) => ({ i })), xKey: 'region', yKey: 'total_revenue' } as any,
                    formatting: {} as any,
                } },
                { id: 'u2', role: 'user', createdAt: 2, text: 'now by month', kind: 'follow_up', contextTurns: 1 },
                { id: 'a2', role: 'assistant', createdAt: 2, status: 'pending' },
            ],
        };
        saveConversations('k', [conversation, { ...conversation, id: 'empty', turns: [] }]);
        const loaded = loadConversations('k');
        expect(loaded).toHaveLength(1);
        expect(loaded[0].title).toBe('Total revenue by region');
        expect(loaded[0].turns[1].answer!.analysis.data).toHaveLength(200);
        expect(loaded[0].turns[3].status).toBe('stopped');
        expect(answeredTurns(loaded[0])).toEqual([{ question: 'Total revenue by region', sql: 'SELECT 1' }]);
    });
});
