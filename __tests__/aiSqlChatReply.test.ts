import { describe, expect, it } from 'vitest';
import { ColumnType, type Dataset } from '../types';
import { buildChatMessages, parseChatReply, CHAT_SYSTEM_PROMPT } from '../services/ai-sql/chatReply';

const dataset = {
    id: 'retail', name: '01_Retail_Sales_RAW.xlsx', totalRows: 3, etlLogs: [], version: 1,
    rows: [
        { region: 'North', product: 'Kettle', revenue: 120.5, order_date: '2024-01-03' },
        { region: 'South', product: 'Toaster', revenue: 980.25, order_date: '2024-02-11' },
        { region: 'North', product: 'Kettle', revenue: 77.1, order_date: '2024-03-21' },
    ],
    columns: [
        { name: 'region', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'product', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'revenue', type: ColumnType.METRIC, originalType: 'number' },
        { name: 'order_date', type: ColumnType.DATE, originalType: 'string' },
    ],
} as unknown as Dataset;

describe('AI SQL chat — conversation replies', () => {
    it('explains how follow-ups are decided, from the facts it is given', () => {
        expect(CHAT_SYSTEM_PROMPT).toContain('Follow-up or new question');
        expect(CHAT_SYSTEM_PROMPT).toContain('never see the data');
    });

    it('sends column names, recent words and the last SQL — never rows or values', () => {
        const [, user] = buildChatMessages('How do you know if my question is follow up?', dataset,
            [{ role: 'user', text: 'Revenue by region' }, { role: 'assistant', text: 'Revenue by region' }],
            'SELECT "region", SUM("revenue") AS total_revenue FROM "data" GROUP BY 1');
        expect(user.content).toContain('"revenue"');
        expect(user.content).toContain('RECENT CONVERSATION');
        for (const leaked of ['North', 'Kettle', 'Toaster', '120.5', '980.25', '2024-02-11']) expect(user.content).not.toContain(leaked);
    });

    it('reads a reply, suggestions, and a data question to hand over', () => {
        expect(parseChatReply('{"message":"Here is how.","suggestions":["Revenue by region"],"analyze":null}'))
            .toEqual({ message: 'Here is how.', suggestions: ['Revenue by region'], analyze: undefined });
        expect(parseChatReply('{"message":"Let me work that out.","analyze":"Total revenue by region"}').analyze).toBe('Total revenue by region');
        expect(parseChatReply('Plain words are fine too.').message).toBe('Plain words are fine too.');
    });
});
