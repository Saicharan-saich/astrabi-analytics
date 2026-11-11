/**
 * The column dictionary on kinds of data the app was not built around —
 * a factory, staff turnover, a clinic, a subscription business — so judgement
 * words ("worst", "losing", "struggling") are read from what the columns mean,
 * not from rules written for one kind of file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { columnDictionary, dictionaryForPrompt, dictionaryRequest, applyDictionary, rememberMeanings, rememberedMeanings, goodDirectionOf, unclearName, columnsNeedingWord, sessionColumnContext, keepSessionColumnContext, clearSessionColumnContext, MEANINGS_VERSION } from '../services/columnDictionary';
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

describe('columns whose meaning is only a guess', () => {
    const ward = ds('ward.csv', [['admitted', T], ['ward', D], ['LOS', M], ['bucket', D], ['type_b', M], ['readmissions', M]],
        i => ({ admitted: day(i % 30), ward: `W${i % 3}`, LOS: 1 + (i % 9), bucket: ['A', 'B', 'C'][i % 3], type_b: i % 4, readmissions: i % 2 }));

    it('flags abbreviations and internal codes, and trusts common names', () => {
        for (const name of ['LOS', 'OEE', 'Adj', 'var2', 'Bucket', 'amount_2', 'los_ald', 'x', 'type_b', 'group_a']) expect(unclearName(name), name).toBe(true);
        for (const name of ['dept', 'qty', 'sku', 'VAT', 'mrr', 'revenue', 'budgeted_amount', 'variance_pct', 'transaction_id', 'ord_no', 'cust_id', 'los_hrs', 'net_sales', 'segment', 'customer_email']) expect(unclearName(name), name).toBe(false);
    });

    it('asks the user about those columns only, and tells the AI they are not confirmed', () => {
        expect(columnsNeedingWord(ward).map(m => m.column).sort()).toEqual(['LOS', 'bucket', 'type_b']);
        const prompt = dictionaryForPrompt(ward);
        expect(prompt).toMatch(/"LOS": NOT CONFIRMED/);
        expect(prompt).not.toMatch(/"readmissions": NOT CONFIRMED/);
    });

    it('an AI that is unsure adds a question; an AI that is sure does not clear a vague name', () => {
        const applied = applyDictionary({ domain: 'Healthcare', summary: '', confidence: 1, detectedAt: 0, columnSemantics: {} } as any, { columns: {
            readmissions: { sure: false, question: 'Is this a count of readmissions or a yes/no flag?' },
            LOS: { sure: true, meaning: 'Length of stay in days.' },
        } }, ward);
        const next = { ...ward, domainProfile: applied } as Dataset;
        const open = columnsNeedingWord(next);
        expect(open.map(m => m.column)).toContain('readmissions');
        expect(open.find(m => m.column === 'readmissions')?.question).toBe('Is this a count of readmissions or a yes/no flag?');
        expect(open.map(m => m.column)).toContain('LOS');
    });

    it("the user's answer clears the flag and is remembered for the same kind of file", () => {
        const semantics = { LOS: { role: M, aggregation: 'AVG', format: 'raw', humanLabel: 'LOS', isHidden: false, description: 'Length of stay in days', meaningSource: 'user', meaningSure: true } } as any;
        const answered = { ...ward, domainProfile: { domain: 'Healthcare', summary: '', confidence: 1, detectedAt: 0, columnSemantics: semantics } } as unknown as Dataset;
        expect(columnsNeedingWord(answered).map(m => m.column)).not.toContain('LOS');
        expect(dictionaryForPrompt(answered)).toMatch(/"LOS": Length of stay in days/);
        rememberMeanings(ward.columns.map(c => c.name), semantics);
        expect(columnsNeedingWord(ward).map(m => m.column)).not.toContain('LOS');
    });

    it('a direction alone does not count as saying what the column means', () => {
        const semantics = { bucket: { role: D, aggregation: 'NONE', format: 'raw', humanLabel: 'bucket', isHidden: false, goodDirection: 'higher', meaningSource: 'user' } } as any;
        const set = { ...ward, domainProfile: { domain: 'General', summary: '', confidence: 1, detectedAt: 0, columnSemantics: semantics } } as unknown as Dataset;
        expect(columnsNeedingWord(set).map(m => m.column)).toContain('bucket');
    });
});

describe('meanings checked online', () => {
    const ward = ds('ward_online.csv', [['admitted', T], ['ward', D], ['LOS', M], ['bucket', D], ['readmissions', M]],
        i => ({ admitted: day(i % 30), ward: `W${i % 3}`, LOS: 1 + (i % 9), bucket: ['A', 'B', 'C'][i % 3], readmissions: i % 2 }));
    const blank = { domain: 'Healthcare', summary: '', confidence: 1, detectedAt: 0, columnSemantics: {} } as any;
    const found = {
        checkedOnline: true,
        about: 'A hospital ward stays record ([NHS](https://www.england.nhs.uk/x)).',
        sources: [{ title: 'Length of stay - NHS Data Dictionary', url: 'https://www.datadictionary.nhs.uk/los' }],
        columns: {
            LOS: { meaning: 'Length of stay: days a patient spent on the ward ([source](https://www.datadictionary.nhs.uk/los)).', good: 'lower', sure: true, checked: true, source: 'https://www.datadictionary.nhs.uk/los' },
            bucket: { meaning: 'An internal grouping.', sure: false, question: 'What do the bucket letters stand for?', checked: false },
            readmissions: { meaning: 'Patients admitted again after leaving.', good: 'lower', sure: true, checked: true, source: 'javascript:alert(1)' },
        },
    };

    it('asks the AI to check online with names and metadata only', () => {
        const request = dictionaryRequest(ward, { online: true });
        expect(request).toMatch(/CHECK THIS ONLINE/);
        expect(request).toMatch(/"checked"/);
        expect(request).toMatch(/"LOS"/);
        // Nothing from the rows: no ward names, no numbers from the data.
        expect(request).not.toMatch(/W0|W1|W2/);
        expect(dictionaryRequest(ward)).not.toMatch(/CHECK THIS ONLINE/);
    });

    it('an abbreviation settled online stops asking; an internal code still asks', () => {
        const next = { ...ward, domainProfile: applyDictionary(blank, found, ward) } as Dataset;
        const open = columnsNeedingWord(next).map(m => m.column);
        expect(open).toEqual(['bucket']);
        const los = columnDictionary(next).find(m => m.column === 'LOS')!;
        expect(los.sure).toBe(true);
        expect(los.checkedOnline).toBe(true);
        expect(los.meaning).toBe('Length of stay: days a patient spent on the ward.');
        expect(los.sources).toEqual([{ title: 'Length of stay - NHS Data Dictionary', url: 'https://www.datadictionary.nhs.uk/los' }]);
        expect(dictionaryForPrompt(next)).toMatch(/"LOS": Length of stay/);
        expect(dictionaryForPrompt(next)).toMatch(/"bucket": NOT CONFIRMED/);
        expect(next.domainProfile!.meaningsCheckedOnline).toBe(true);
        expect(next.domainProfile!.meaningsVersion).toBe(MEANINGS_VERSION);
        expect(next.domainProfile!.meaningsAbout).toBe('A hospital ward stays record.');
    });

    it('only real web addresses are kept as sources, and only a web-checked reply can claim a check', () => {
        const next = applyDictionary(blank, found, ward);
        expect(next.columnSemantics.readmissions.meaningSources).toEqual([]);
        const offline = applyDictionary(blank, { ...found, checkedOnline: false }, ward);
        expect(offline.columnSemantics.LOS.meaningCheckedOnline).toBe(false);
        expect(offline.meaningsVersion).toBe(1);
        expect(columnsNeedingWord({ ...ward, domainProfile: offline } as Dataset).map(m => m.column)).toContain('LOS');
    });

    it("the user's word still wins over what was found online", () => {
        const mine = { ...blank, columnSemantics: { LOS: { role: M, aggregation: 'AVG', format: 'raw', humanLabel: 'LOS', isHidden: false, description: 'Level of service score', meaningSource: 'user', meaningSure: true } } };
        const next = applyDictionary(mine, found, ward);
        expect(next.columnSemantics.LOS.description).toBe('Level of service score');
        expect(next.columnSemantics.LOS.meaningSource).toBe('user');
    });

    it('what was found is kept for the session and cleared at logout', () => {
        const names = ward.columns.map(c => c.name);
        expect(sessionColumnContext(names)).toBeNull();
        keepSessionColumnContext(names, found);
        expect(sessionColumnContext(names)).toEqual(found);
        // Same kind of file, columns in another order: the same entry.
        expect(sessionColumnContext([...names].reverse())).toEqual(found);
        clearSessionColumnContext();
        expect(sessionColumnContext(names)).toBeNull();
    });
});
