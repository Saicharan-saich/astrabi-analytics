/**
 * Saved questions, recent questions and a setup's question pack: what fits
 * the data, repeats, periods that move with the date, and the account copy
 * keeping choices but never rows.
 */
import { describe, it, expect } from 'vitest';
import {
    questionColumns, missingColumns, questionKey, keepableConfig, previousMonth, previousQuarter,
    movingPeriodOf, questionForToday, withRecent, withSaved, sortByFit, MAX_RECENT,
} from '../utils/savedQuestions';
import { buildSetup } from '../utils/cleaningSetups';
import type { SavedQuestion } from '../types';
const { cleanSetup, cleanQuestions } = require('../backend/cleaningSetups.js');

const q = (id: string, config: Record<string, any>, extra: Partial<SavedQuestion> = {}): SavedQuestion => ({ id, name: id, config, createdAt: 1, ...extra });

describe('which columns a question needs', () => {
    it('collects measures, splits, filters and date columns but not time grains', () => {
        const config = { metric: 'revenue', dimension: 'month', secondaryDimensions: ['region'], secondaryMetrics: ['profit'], filters: { channel: ['Web'] }, dateFilters: [{ column: 'order_date', timeGrain: 'year', values: ['2025'] }] };
        expect(questionColumns(config).sort()).toEqual(['channel', 'order_date', 'profit', 'region', 'revenue']);
        expect(missingColumns(config, ['revenue', 'region', 'order_date', 'channel'])).toEqual(['profit']);
    });
    it('sets aside questions this data cannot answer, with the reason', () => {
        const { ready, skipped } = sortByFit([q('a', { metric: 'revenue', dimension: 'region' }), q('b', { metric: 'revenue', dimension: 'store' })], ['revenue', 'region']);
        expect(ready.map(r => r.id)).toEqual(['a']);
        expect(skipped).toEqual([{ question: expect.objectContaining({ id: 'b' }), missing: ['store'] }]);
    });
});

describe('repeats', () => {
    it('the same choices are the same question, whatever the empty extras', () => {
        expect(questionKey({ metric: 'x', dimension: 'y', filters: {}, secondaryDimensions: [] })).toBe(questionKey({ dimension: 'y', metric: 'x', limit: undefined }));
        expect(questionKey({ metric: 'x', dimension: 'y' })).not.toBe(questionKey({ metric: 'x', dimension: 'z' }));
    });
    it('recent keeps the newest first, drops repeats and is capped', () => {
        let list: SavedQuestion[] = [];
        for (let i = 0; i < 20; i++) list = withRecent(list, q(`r${i}`, { metric: 'm', dimension: `d${i % 15}` }, { datasetName: 'Sales' }));
        expect(list.length).toBe(MAX_RECENT);
        expect(list[0].id).toBe('r19');
        expect(new Set(list.map(r => questionKey(r.config))).size).toBe(list.length);
    });
    it('saving the same question again replaces it', () => {
        const list = withSaved([q('a', { metric: 'm', dimension: 'd' })], q('b', { metric: 'm', dimension: 'd' }));
        expect(list.map(r => r.id)).toEqual(['b']);
    });
    it('keeps the builder choices only, plus the moving period', () => {
        expect(keepableConfig({ metric: 'm', _source: 'x', _handoffId: 1 }, 'last_month')).toEqual({ metric: 'm', _when: 'last_month' });
    });
});

describe('periods that move with the date', () => {
    it('knows the last full month and quarter', () => {
        expect(previousMonth('2026-09-20')).toBe('2026-08');
        expect(previousMonth('2026-01-05')).toBe('2025-12');
        expect(previousQuarter('2026-09-20')).toBe('2026-Q2');
        expect(previousQuarter('2026-02-01')).toBe('2025-Q4');
    });
    it('spots last month and last quarter, not a fixed month', () => {
        const month = (v: string) => ({ metric: 'm', dateFilters: [{ column: 'd', timeGrain: 'month', values: [v] }] });
        expect(movingPeriodOf(month('2026-08'), '2026-09-20')).toBe('last_month');
        expect(movingPeriodOf(month('2026-03'), '2026-09-20')).toBeNull();
        expect(movingPeriodOf({ metric: 'm', dateFilters: [{ column: 'd', timeGrain: 'quarter', values: ['2026-Q2'] }] }, '2026-09-20')).toBe('last_quarter');
    });
    it('a pack question saved in September answers for October next month', () => {
        const saved = keepableConfig({ metric: 'm', dateFilters: [{ column: 'd', timeGrain: 'month', values: ['2026-08'] }] }, 'last_month');
        expect(questionForToday(saved, '2026-11-03').dateFilters).toEqual([{ column: 'd', timeGrain: 'month', values: ['2026-10'] }]);
        const fixed = keepableConfig({ metric: 'm', dateFilters: [{ column: 'd', timeGrain: 'month', values: ['2026-08'] }] });
        expect(questionForToday(fixed, '2026-11-03').dateFilters[0].values).toEqual(['2026-08']);
    });
});

describe('the question pack on the account', () => {
    const base = { id: 'setup_1', name: 'Acme monthly', headers: ['a'], columns: [{ name: 'a', type: 'METRIC' }], etlOptions: {} };
    it('is kept with the setup, without rows, size-capped', () => {
        const stored = cleanSetup({ ...base, questions: [
            { id: 'q_1', name: 'Revenue by region', config: { metric: 'revenue', dimension: 'region', rows: [{ secret: 1 }], filters: { region: ['North'] } }, createdAt: 5, chartType: 'bar' },
            { id: 'bad id!', name: 'x', config: {} },
            { id: 'q_2', name: 'huge', config: { filters: { a: Array.from({ length: 2000 }, (_, i) => `value number ${i}`) } } },
            { id: 'q_3', name: '', config: { metric: 'm' } },
        ] });
        expect(stored.questions).toEqual([{ id: 'q_1', name: 'Revenue by region', config: { metric: 'revenue', dimension: 'region', filters: { region: ['North'] } }, createdAt: 5, chartType: 'bar' }]);
        expect(cleanSetup(base).questions).toBeUndefined();
        expect(cleanQuestions(Array.from({ length: 80 }, (_, i) => ({ id: `q_${i}`, name: `Q${i}`, config: { metric: 'm' } }))).length).toBe(50);
    });
    it('survives the setup being saved again from new data', () => {
        const dataset: any = { name: 'Sales.csv', columns: [{ name: 'a', type: 'METRIC' }], rows: [{ a: 1 }], etlOptions: {}, etlLogs: [] };
        const existing: any = { ...buildSetup(dataset, 'Acme'), questions: [q('q_1', { metric: 'a' })] };
        expect(buildSetup(dataset, 'Acme', existing).questions?.map(x => x.id)).toEqual(['q_1']);
    });
});
