import { describe, expect, it } from 'vitest';
import { buildResultNarrative } from '../services/ai-sql/resultNarrative';
import { correlationInWords, friendlyNumber, isYesNoColumn, relabelYesNo, yesNoLabel } from '../services/ai-sql/plainLabels';
import { explainAnswer } from '../services/ai-sql/explainAnswer';
import { classifyTurn } from '../services/ai-sql/chatContext';
import { parseLeanReply } from '../services/ai-sql/leanPipeline';
import { parseChatReply, CHAT_SYSTEM_PROMPT } from '../services/ai-sql/chatReply';

const base = { chart: {} as any, model: { fields: [] } as any };
const profile = (metrics: string[], dims: string[] = []) => ({ metricColumns: metrics, dimensionColumns: dims, metricSemanticTypes: {}, hasTimeDimension: false } as any);

describe('answers in plain words', () => {
    it('reads yes/no columns as words, never 0 and 1', () => {
        expect(isYesNoColumn([0, 1, 1, null])).toBe(true);
        expect(isYesNoColumn([0, 1, 2])).toBe(false);
        expect(yesNoLabel('Holiday_Flag', 1)).toBe('Holiday');
        expect(yesNoLabel('is_member', 'false')).toBe('Not member');
        const rows = relabelYesNo([{ Holiday_Flag: 0, avg_weekly_sales: 1041256.38 }, { Holiday_Flag: 1, avg_weekly_sales: 1122887.89 }], ['Holiday_Flag']).rows;
        const n = buildResultNarrative({ ...base, profile: profile(['avg_weekly_sales'], ['Holiday_Flag']), question: 'Compare average weekly sales for holiday weeks versus non-holiday weeks', data: rows, plan: { metrics: [{ field: 'Weekly_Sales', agg: 'avg' }], dimensions: [{ field: 'Holiday_Flag' }], intent: 'breakdown' } as any })!;
        expect(n.summary).toBe('Average weekly sales is 7.8% higher for Holiday (1.12 million) than for Not holiday (1.04 million).');
    });

    it('says what a correlation means', () => {
        const n = buildResultNarrative({ ...base, profile: profile(['sales_temperature_correlation']), question: 'correlation between sales and temperature', data: [{ sales_temperature_correlation: -0.0638 }], plan: { metrics: [], dimensions: [] } as any, sql: 'SELECT CORR("Weekly_Sales", "Temperature") AS sales_temperature_correlation FROM "data"' })!;
        expect(n.headline).toBe('Almost no link between weekly sales and temperature');
        expect(correlationInWords(0.62, 'price', 'mileage').summary).toContain('a strong link between price and mileage');
        expect(correlationInWords(-0.62, 'price', 'mileage').summary).toContain('when price is higher, mileage tends to be lower');
    });

    it('says which day "today" means when the data is not live, and writes millions as words', () => {
        const n = buildResultNarrative({ ...base, profile: profile(['total_weekly_sales']), question: 'What are todays sales?', data: [{ total_weekly_sales: 45544116.29 }], plan: { metrics: [{ field: 'Weekly_Sales', agg: 'sum' }], dimensions: [] } as any, latestDate: '2012-10-26' })!;
        expect(n.headline).toBe('Weekly sales on 26 Oct 2012: 45.5 million');
        expect(n.summary).toContain('this is the latest day available, not today');
        expect(friendlyNumber(6740000000, '£')).toBe('£6.74 billion');
    });

    it('names numbered groups: "Store 45", not "45"', () => {
        const n = buildResultNarrative({ ...base, profile: profile(['total_sales'], ['Store']), question: 'top stores by sales', data: [{ Store: 45, total_sales: 9 }, { Store: 3, total_sales: 5 }, { Store: 7, total_sales: 4 }], plan: { metrics: [{ field: 'sales', agg: 'sum' }], dimensions: [{ field: 'Store' }], intent: 'ranking' } as any })!;
        expect(n.summary).toMatch(/^Store 45 comes first with 9, then Store 3 with 5/);
    });
});

describe('"what does that mean?" is answered from the last answer, on this computer', () => {
    it('routes explanation questions there', () => {
        const columns = { columns: [{ name: 'weekly_sales' }, { name: 'temperature' }] } as any;
        for (const q of ['What does the above number mean?', 'So what does the analysis found?', 'So the result was -0.06. What does that mean?', 'What do you mean?', 'Can you explain this in simple words?']) {
            expect(classifyTurn(q, true, columns).kind).toBe('explain');
        }
        expect(classifyTurn('What does median mean?', true, columns).kind).toBe('chat');
        expect(classifyTurn('What does that mean?', false, columns).kind).not.toBe('explain');
    });

    it('builds the explanation from the answer, numbers and cautions included', () => {
        const text = explainAnswer({ title: 'Sales and temperature', standaloneQuestion: '', sql: 'x', rowCount: 1, tokens: 0, analysis: {} as any, formatting: {} as any,
            summary: 'There is almost no link between weekly sales and temperature (-0.06, on a scale from −1 to +1).', insights: [], cautions: ['This average rests on only 4 rows.'], explanation: 'Measured how weekly sales and temperature move together.' });
        expect(text).toContain("Here's what it means. There is almost no link");
        expect(text).toContain('Keep in mind:\n- This average rests on only 4 rows.');
    });
});

describe('no jargon reaches the reader', () => {
    it('removes underscores from titles, explanations, options and suggestions', () => {
        const answer = parseLeanReply('{"action":"answer","sql":"SELECT 1","title":"Total weekly_sales by store","explanation":"Added up weekly_sales per Store."}') as any;
        expect(answer.title).toBe('Total weekly sales by store');
        expect(answer.explanation).toBe('Added up weekly sales per Store.');
        const clarify = parseLeanReply('{"action":"clarify","question":"Which?","options":[{"label":"weekly_sales","question":"Total weekly_sales by store"}]}') as any;
        expect(clarify.options[0]).toEqual({ label: 'weekly sales', question: 'Total weekly sales by store' });
        expect(parseChatReply('{"message":"Hi","suggestions":["Compare weekly_sales by store"]}').suggestions).toEqual(['Compare weekly sales by store']);
    });

    it('tells the conversation AI to talk like a colleague, not an engineer', () => {
        expect(CHAT_SYSTEM_PROMPT).toContain('Talk like a helpful colleague');
        expect(CHAT_SYSTEM_PROMPT).toContain('never weekly_sales');
        expect(CHAT_SYSTEM_PROMPT).toContain('Never say "I can\'t see the computed result"');
    });
});
