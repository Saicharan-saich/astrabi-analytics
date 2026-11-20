import { describe, expect, it } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import {
    appliedSetup, buildSetup, columnsInChoices, compareWithSetup, describeSetup, headerKey, headersOf,
    matchScore, mergeSetups, overridesFor, pickSetup, readSetupFile, setupFile,
} from '../utils/cleaningSetups';
import { getStepGuide } from '../components/etlStepGuide';
import { ColumnType, type CleaningSetup, type Dataset } from '../types';

function monthFile(month: number, extra = false) {
    const rows: Record<string, any>[] = [];
    for (let i = 0; i < 40; i++) {
        const row: Record<string, any> = {
            'Order ID': `M${month}-${1000 + i}`,
            'Order Date': `2026-${String(month).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
            Region: ['North', 'South', 'East'][i % 3],
            Revenue: 100 + ((i * 7 + month) % 13) * 10,
            Discount: i % 5 === 0 ? '' : 2 + (i % 4),
        };
        if (extra) row['Sales Rep'] = ['Ann', 'Bob'][i % 2];
        rows.push(row);
    }
    return rows;
}

function cleaned(rows: Record<string, any>[], options: any = {}, name = 'acme_sales_jan.csv'): Dataset {
    const result = runETLPipeline(rows, name, undefined, options);
    return { id: 'd1', name, rows: result.rows, rawRows: rows, columns: result.columns, totalRows: result.rows.length, etlLogs: result.logs, etlOptions: options } as Dataset;
}

describe('saved cleaning setups', () => {
    it('saves the choices and the file\'s columns, never rows', () => {
        const january = cleaned(monthFile(1), { blankDecisions: { discount: 'zero' }, customRules: [{ id: 'r1', column: 'revenue', test: 'min', value: '0', action: 'flag' }] });
        const setup = buildSetup(january, 'Acme · monthly sales', undefined, 1000);
        expect(setup.name).toBe('Acme · monthly sales');
        expect(setup.headers.sort()).toEqual(['Discount', 'Order Date', 'Order ID', 'Region', 'Revenue']);
        expect(setup.columns.map(c => c.name)).toContain('discount');
        expect(setup.etlOptions.blankDecisions).toEqual({ discount: 'zero' });
        expect(JSON.stringify(setup)).not.toContain('M1-1000');
        expect(describeSetup(setup)).toBe('1 check · 1 blank-cell choice');
        expect(describeSetup({ etlOptions: {} })).toBe('The automatic cleaning, with no extra choices');
    });

    it('recognises the next file by its columns, whatever their order or spelling', () => {
        const setup = buildSetup(cleaned(monthFile(1)), 'Acme', undefined, 1000);
        expect(headerKey(' Order-Date ')).toBe('order_date');
        expect(pickSetup(['revenue', 'ORDER ID', 'order_date', 'Region', 'discount'], [setup])?.match).toBe('exact');
        const close = pickSetup(headersOf(monthFile(2, true)), [setup]);
        expect(close?.match).toBe('close');
        expect(close?.score).toBeCloseTo(5 / 6);
        expect(pickSetup(['Ticket', 'Opened', 'Team', 'CSAT'], [setup])).toBeNull();
        expect(matchScore([], setup)).toBe(0);
    });

    it('picks the closest setup, and the most recently used on a tie', () => {
        const base = buildSetup(cleaned(monthFile(1)), 'Old', undefined, 1000);
        const newer = { ...base, id: 'b', name: 'Newer', lastUsedAt: 5000 };
        expect(pickSetup(base.headers, [base, newer])?.setup.name).toBe('Newer');
        const exact = { ...base, id: 'c', name: 'Exact', headers: [...base.headers, 'Sales Rep'] };
        expect(pickSetup([...base.headers, 'Sales Rep'], [base, exact])?.setup.name).toBe('Exact');
    });

    it('cleans February exactly like January', () => {
        const setup = buildSetup(cleaned(monthFile(1), { blankDecisions: { discount: 'zero' } }), 'Acme');
        const february = monthFile(2);
        const result = runETLPipeline(february, 'acme_sales_feb.csv', overridesFor(setup, headersOf(february)), setup.etlOptions);
        expect(result.rows.filter(r => r.discount === 0).length).toBe(8);
        expect(result.rows.some(r => r.discount === null || r.discount === undefined)).toBe(false);
        const record = appliedSetup(setup, 'exact', result.columns, 42);
        expect(record).toMatchObject({ id: setup.id, name: 'Acme', match: 'exact', appliedAt: 42 });
        expect(record.changes).toEqual([]);
    });

    it('reports a changed file, most serious first', () => {
        const setup: CleaningSetup = {
            id: 's', name: 'Acme', createdAt: 1, updatedAt: 1, headers: ['a'],
            columns: [{ name: 'revenue', type: ColumnType.METRIC }, { name: 'discount', type: ColumnType.METRIC }, { name: 'region', type: ColumnType.DIMENSION }],
            etlOptions: { blankDecisions: { discount: 'zero', vat: 'zero' } },
        };
        const changes = compareWithSetup(setup, [
            { name: 'revenue', type: ColumnType.DIMENSION },
            { name: 'region', type: ColumnType.DIMENSION },
            { name: 'sales_rep', type: ColumnType.DIMENSION },
        ]);
        const kinds = changes.map(c => `${c.kind}:${c.column}:${c.serious}`);
        expect(kinds).toEqual([
            'kind_changed:revenue:true',
            'missing_column:discount:true',
            'choice_skipped:vat:true',
            'new_column:sales_rep:false',
        ]);
        expect(changes[0].text).toMatch(/was a number and now reads as a category/);
        expect(changes[1].text).toMatch(/choices for it were skipped/);
    });

    it('lists every column a choice is about', () => {
        expect(columnsInChoices({
            outlierDecisions: { revenue: 'keep' }, typoDecisions: { region: 'merge' }, blankDecisions: { discount: 'zero' },
            customRules: [{ id: 'r', column: 'email', test: 'not_blank', action: 'flag' }],
            flagDecisions: { 'mapping:city->country': 'fix', 'rule:r': 'remove', 'future:order_date': 'keep' },
        }).sort()).toEqual(['city', 'country', 'discount', 'email', 'order_date', 'region', 'revenue']);
    });

    it('moves setups between computers as a file', () => {
        const setup = buildSetup(cleaned(monthFile(1)), 'Acme', undefined, 1000);
        const back = readSetupFile(setupFile([setup]));
        expect(back.error).toBeUndefined();
        expect(back.setups[0].id).toBe(setup.id);
        expect(readSetupFile('not json').error).toMatch(/not a QuickInsight setup file/);
        expect(readSetupFile('{"format":"quickinsight-cleaning-setups","setups":[{"id":1}]}').error).toMatch(/no setups/);
        const older = { ...setup, name: 'Old name', updatedAt: 500 };
        expect(mergeSetups([setup], [older])[0].name).toBe('Acme');
        expect(mergeSetups([older], [setup])[0].name).toBe('Acme');
    });

    it('explains the setup step in plain words', () => {
        const guide = getStepGuide('Saved Setup Applied');
        expect(guide.title).toBe('Your saved setup');
        expect(guide.ifSkipped).toMatch(/cleaned from scratch/);
    });
});
