/**
 * The column dictionary on kinds of data the app was not built around —
 * a factory, staff turnover, a clinic, a subscription business — so judgement
 * words ("worst", "losing", "struggling") are read from what the columns mean,
 * not from rules written for one kind of file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { columnDictionary, dictionaryForPrompt, dictionaryRequest, applyDictionary, rememberMeanings, rememberedMeanings, goodDirectionOf } from '../services/columnDictionary';
import { judgedAgainstMeaning } from '../services/ai-sql/readingCheck';
import { numberShape, dateSpan, buildMaskedProfiles, profilesToPromptText } from '../services/dataMasker';
import { describeData } from '../services/ai-sql/leanPipeline';
import { ColumnType, type Dataset } from '../types';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)), removeItem: (k: string) => store.delete(k) };
beforeEach(() => store.clear());

let seed = 4;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
const M = ColumnType.METRIC, D = ColumnType.DIMENSION, T = ColumnType.DATE;
function ds(name: string, columns: [string, ColumnType][], row: (i: number) => Record<string, any>): Dataset {
    seed = 4;
    const rows = Array.from({ length: 120 }, (_, i) => row(i));
    return { id: name, name, rows, totalRows: rows.length, etlLogs: [], columns: columns.map(([n, type]) => ({ name: n, type })) } as unknown as Dataset;
}
const factory = ds('line_output.csv', [['date', T], ['machine', D], ['units_made', M], ['defects', M], ['downtime_minutes', M]],
    i => ({ date: day(i % 30), machine: `M${i % 4}`, units_made: 200 + Math.round(rnd() * 50), defects: Math.round(rnd() * 9), downtime_minutes: Math.round(rnd() * 40) }));
const staff = ds('team.csv', [['month', T], ['team', D], ['headcount', M], ['leavers', M], ['absence_days', M]],
    i => ({ month: day(i * 7), team: `T${i % 5}`, headcount: 10 + (i % 7), leavers: i % 3, absence_days: Math.round(rnd() * 12) }));
const clinic = ds('appointments.csv', [['date', T], ['clinic', D], ['wait_minutes', M], ['no_shows', M], ['satisfaction', M]],
    i => ({ date: day(i % 30), clinic: `C${i % 3}`, wait_minutes: 5 + Math.round(rnd() * 60), no_shows: i % 4, satisfaction: 1 + (i % 5) }));
const subs = ds('subscriptions.csv', [['month', T], ['plan', D], ['mrr', M], ['churned_customers', M], ['new_customers', M]],
    i => ({ month: day(i * 7), plan: ['Basic', 'Pro'][i % 2], mrr: 1000 + Math.round(rnd() * 900), churned_customers: i % 6, new_customers: 3 + (i % 8) }));

describe('which way is good, for data the app has not seen', () => {
    it('reads directions that the names make plain', () => {
        expect(goodDirectionOf(factory, 'defects')).toBe('lower');
        expect(goodDirectionOf(factory, 'downtime_minutes')).toBe('lower');
        expect(goodDirectionOf(staff, 'leavers')).toBe('lower');
        expect(goodDirectionOf(staff, 'absence_days')).toBe('lower');
        expect(goodDirectionOf(clinic, 'wait_minutes')).toBe('lower');
        expect(goodDirectionOf(clinic, 'satisfaction')).toBe('higher');
        expect(goodDirectionOf(subs, 'churned_customers')).toBe('lower');
        expect(goodDirectionOf(staff, 'headcount')).toBeUndefined(); // neither: left to the AI and the user
    });

    it('tells the AI, with every question, which way is worse — in words, no values', () => {
        const text = describeData(clinic).schema;
        expect(text).toContain('COLUMN MEANINGS');
        expect(text).toMatch(/"wait_minutes": .*higher is worse/);
        expect(text).toMatch(/"satisfaction": .*higher is better/);
        expect(text).not.toMatch(/\bC[0-2]\b/);
    });

    it('treats a snapshot as a latest value, never something to add up across dates', () => {
        expect(columnDictionary(staff).find(m => m.column === 'headcount')?.combine).toBe('latest value');
    });
});

describe('the AI fills the rest; the user has the last word', () => {
    it('asks with names, roles and formulas only', () => {
        const request = dictionaryRequest(subs);
        expect(request).toContain('"mrr"');
        expect(request).not.toMatch(/Basic|Pro\b|\d{4}-\d{2}-\d{2}/);
    });

    it('takes the AI\'s meanings where the rules are silent, and never overrides the user', () => {
        const profile = applyDictionary({ domain: 'SaaS', summary: '', confidence: 1, detectedAt: 1, columnSemantics: {} } as any, { columns: {
            mrr: { meaning: 'Monthly recurring revenue from the plan', good: 'higher', words: ['recurring revenue', 'MRR'] },
            churned_customers: { meaning: 'Customers who cancelled that month', good: 'higher', words: ['churn', 'cancellations'] },
        } }, subs);
        const withMeanings = { ...subs, domainProfile: profile } as Dataset;
        expect(goodDirectionOf(withMeanings, 'mrr')).toBe('higher');
        // The name says more cancellations is worse; a contrary AI guess does not change that.
        expect(goodDirectionOf(withMeanings, 'churned_customers')).toBe('lower');
        expect(dictionaryForPrompt(withMeanings)).toContain('"churned_customers": Customers who cancelled that month; higher is worse; people call it: churn, cancellations');
        // The user says so: their word is final, and remembered for the same kind of file.
        const user = { ...profile, columnSemantics: { ...profile.columnSemantics, mrr: { ...profile.columnSemantics.mrr, goodDirection: 'neutral', meaningSource: 'user' } } } as any;
        rememberMeanings(subs.columns.map(c => c.name), user.columnSemantics);
        expect(goodDirectionOf({ ...subs, domainProfile: user } as Dataset, 'mrr')).toBe('neutral');
        expect(rememberedMeanings(subs.columns.map(c => c.name)).mrr?.goodDirection).toBe('neutral');
        const nextUpload = applyDictionary({ domain: 'SaaS', summary: '', confidence: 1, detectedAt: 2, columnSemantics: {} } as any, { columns: { mrr: { good: 'higher' } } }, subs);
        expect(nextUpload.columnSemantics.mrr.goodDirection).toBe('neutral');
    });
});

describe('a judgement checked against the meanings, on any data', () => {
    it('catches "worst clinic" judged by the shortest wait', () => {
        const turned = judgedAgainstMeaning({ column: 'wait_minutes', worse: 'lower' }, goodDirectionOf(clinic, 'wait_minutes'));
        expect(turned?.read).toBe('a lower wait minutes as worse');
        expect(judgedAgainstMeaning({ column: 'wait_minutes', worse: 'higher' }, goodDirectionOf(clinic, 'wait_minutes'))).toBeNull();
        expect(judgedAgainstMeaning({ column: 'units_made', worse: 'higher' }, 'higher')).not.toBeNull();
        expect(judgedAgainstMeaning({ column: 'headcount', worse: 'higher' }, undefined)).toBeNull();
    });
});

describe('what the upload profiler sends', () => {
    it('describes numbers and dates by their shape, never a value', () => {
        expect(numberShape({ min: -120, max: 4800, mean: 900 })).toBe('whole numbers, some below 0, thousands');
        expect(numberShape({ min: 0, max: 1, mean: 0.4 })).toBe('decimals, between 0 and 1');
        expect(dateSpan({ min: '2025-01-01', max: '2026-03-01' })).toBe('spans about 14 months');
        const text = profilesToPromptText(buildMaskedProfiles(clinic.rows, clinic.columns as any));
        expect(text).not.toMatch(/Range:|Mean:|2026-01/);
        expect(text).toMatch(/Numbers: /);
    });
});
