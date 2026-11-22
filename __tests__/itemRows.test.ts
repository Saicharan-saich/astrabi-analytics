import { describe, expect, it } from 'vitest';
import { blankRows, rowMatches, rowsForLog, rowsToCsv, viewLabel } from '../utils/itemRows';
import { runETLPipeline } from '../services/etlPipeline';
import type { ETLLog } from '../types';

const base: ETLLog = { step: 'x', stepNumber: 6, status: 'info', timestamp: 1, details: '' };

describe('view rows for a checklist item', () => {
    it('finds every unusual value again in the cleaned data', () => {
        const raw = Array.from({ length: 120 }, (_, i) => ({ 'Order ID': `O${i}`, Region: ['North', 'South', 'East'][i % 3], 'Food Cost': 10 + (i % 7) }));
        raw[5]['Food Cost'] = 950; raw[40]['Food Cost'] = 1200; raw[77]['Food Cost'] = -400;
        const out = runETLPipeline(raw, 'orders.csv');
        const flag = out.logs.find(l => l.step === 'Outlier Flag' && l.affectedColumns?.[0] === 'food_cost')!;
        expect(flag.rowMatch?.column).toBe('food_cost');
        const view = rowsForLog(flag, out.rows)!;
        expect(view.mode).toBe('rows');
        if (view.mode !== 'rows') return;
        expect(view.source).toBe('data');
        expect(view.rows.map(r => r.food_cost).sort((a, b) => a - b)).toEqual([-400, 950, 1200]);
        expect(view.total).toBe(flag.affectedRows);
        expect(view.highlight).toEqual(['food_cost']);
        expect(viewLabel(view)).toBe('View the 3 rows');
    });

    it('reads the range from older entries that have no row match', () => {
        const old: ETLLog = { ...base, step: 'Outlier Flag', affectedColumns: ['cost'], decision: { kind: 'outlier', column: 'cost' },
            details: "Column 'cost': 2 value(s) outside the expected range [1.50, 20.00] (e.g. 99). Review before trusting sums/averages — not auto-removed." };
        const view = rowsForLog(old, [{ cost: 5 }, { cost: 99 }, { cost: '1.2' }, { cost: null }]);
        expect(view?.mode === 'rows' && view.rows).toEqual([{ cost: 99 }, { cost: '1.2' }]);
    });

    it('matches values, negatives, blanks and ignores exempt values', () => {
        expect(rowMatches({ c: ' Nrth ' }, { column: 'c', values: ['Nrth'] })).toBe(true);
        expect(rowMatches({ c: -2 }, { column: 'c', negative: true })).toBe(true);
        expect(rowMatches({ c: '' }, { column: 'c', blank: true })).toBe(true);
        expect(rowMatches({ c: 0 }, { column: 'c', outside: [1, 5], exempt: [0] })).toBe(false);
        expect(rowMatches({ c: '£1,200' }, { column: 'c', outside: [1, 5] })).toBe(true);
        expect(blankRows('c', [{ c: 1 }, { c: null }, { c: ' ' }])?.total).toBe(2);
        expect(blankRows('c', [{ c: 1 }])).toBeNull();
    });

    it('lists removed rows, examples and changes, saying when only some were kept', () => {
        const removed = rowsForLog({ ...base, removedRowSamples: [{ a: 1 }, { a: 2 }], rowsBefore: 250, rowsAfter: 10 }, [])!;
        expect(removed).toMatchObject({ mode: 'rows', source: 'removed', total: 240 });
        expect(viewLabel(removed)).toBe('View 2 of 240 removed rows');
        const all = rowsForLog({ ...base, removedRowSamples: [{ a: 1 }], rowsBefore: 11, rowsAfter: 10 }, [])!;
        expect(viewLabel(all)).toBe('View the removed row');
        const examples = rowsForLog({ ...base, sampleRows: [{ a: 1 }], affectedRows: 1 }, [])!;
        expect(viewLabel(examples)).toBe('View the row');
        const changes = rowsForLog({ ...base, transformSamples: [{ column: 'a', before: 'x', after: 'y' }], affectedRows: 40 }, [])!;
        expect(changes.mode).toBe('changes');
        expect(viewLabel(changes)).toBe('View 1 example changes');
        expect(rowsForLog({ ...base }, [])).toBeNull();
        expect(rowsForLog(undefined, [])).toBeNull();
    });

    it('downloads as CSV without letting a cell run as a spreadsheet formula', () => {
        expect(rowsToCsv([{ a: '=1+1', b: 'x, y', c: -5, d: '-3.2', e: null }], ['a', 'b', 'c', 'd', 'e'])).toBe(`a,b,c,d,e\r\n'=1+1,"x, y",-5,-3.2,`);
    });
});
