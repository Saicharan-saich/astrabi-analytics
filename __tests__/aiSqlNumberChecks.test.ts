import { describe, expect, it } from 'vitest';
import { averagedRatioNote, averageNotesFromValues, averageValuesQuery, fillMonthlyGaps, missingMonthsNote, partialMonthNote, perItemColumns, perItemSumNote, perLineAverageNote, summedBalanceNote } from '../services/ai-sql/numberChecks';
import { LEAN_SYSTEM_PROMPT } from '../services/ai-sql/leanPipeline';
import { averageCaution, smallSampleNote } from '../utils/averageCheck';
import { ColumnType, type ColumnDefinition } from '../types';

describe('average check — any query shape', () => {
    it('returns the values behind the average, keeping filters and dropping the final LIMIT', () => {
        const q = averageValuesQuery('SELECT "region", ROUND(AVG("sales"), 2) AS average_sales FROM "data" WHERE "year" = 2024 GROUP BY 1 ORDER BY 2 DESC LIMIT 10');
        expect(q).toEqual({ column: 'sales', sql: 'SELECT "region", LIST(CAST("sales" AS DOUBLE)) AS average_sales FROM "data" WHERE "year" = 2024 GROUP BY 1 ORDER BY 2 DESC' });
    });

    it('handles "average per person": an average of per-person totals from a sub-query', () => {
        const q = averageValuesQuery('SELECT ROUND(AVG(total_sales), 2) AS avg_sales_per_person FROM (SELECT "person", SUM("sales") AS total_sales FROM "data" GROUP BY 1)');
        expect(q?.sql).toBe('SELECT LIST(CAST(total_sales AS DOUBLE)) AS avg_sales_per_person FROM (SELECT "person", SUM("sales") AS total_sales FROM "data" GROUP BY 1)');
    });

    it('leaves alone queries it cannot rewrite safely', () => {
        expect(averageValuesQuery('SELECT AVG("a"), AVG("b") FROM "data"')).toBeNull();
        expect(averageValuesQuery('SELECT AVG("price" * "qty") FROM "data"')).toBeNull();
        expect(averageValuesQuery('SELECT "r", AVG("s") AS a FROM "data" GROUP BY 1 HAVING AVG("s") > 10')).toBeNull();
        expect(averageValuesQuery('SELECT SUM("s") FROM "data"')).toBeNull();
    });

    it('explains 100, 0, 0, 0 in plain words', () => {
        const notes = averageNotesFromValues([{ avg_sales_per_person: [100, 0, 0, 0] }], [{ avg_sales_per_person: 25 }], [], 'total_sales');
        expect(notes[0]).toBe('The average total sales (25) can mislead here: the 4 values are 100, 0, 0 and 0, so one value makes up 100% of the total. The typical value (median) is 0.');
        expect(notes[1]).toBe('This average rests on only 4 rows: one more or one fewer could change it a lot.');
    });

    it('names the shown group whose average misleads, and groups with very few rows', () => {
        const listRows = [
            { region: 'North', a: [100, 0, 0, 0, 0, 0, 0, 0] },
            { region: 'South', a: Array.from({ length: 40 }, () => 20) },
            { region: 'East', a: [30, 32] },
            { region: 'Hidden', a: [500, 0, 0, 0] },
        ];
        const shown = [{ region: 'North' }, { region: 'South' }, { region: 'East' }];
        const notes = averageNotesFromValues(listRows, shown, ['region'], 'sales');
        expect(notes[0]).toMatch(/^Careful with the average for North: it is 12\.5, but /);
        expect(notes.join(' ')).not.toContain('Hidden');
        expect(notes[1]).toBe('Some averages rest on very few rows, so they can swing a lot: East (2 rows).');
    });

    it('reads lists that arrive as typed arrays or vectors', () => {
        const vector = { toArray: () => new Float64Array([100, 0, 0, 0]) };
        expect(averageNotesFromValues([{ a: vector }], [{ a: 25 }], [], 'sales')[0]).toContain('the 4 values are 100, 0, 0 and 0');
        expect(averageNotesFromValues([{ a: new Float64Array([100, 0, 0, 0]) }], [{ a: 25 }], [], 'sales')[0]).toContain('one value makes up 100%');
    });

    it('stays quiet when values are alike and plentiful', () => {
        const values = Array.from({ length: 50 }, (_, i) => 20 + (i % 5));
        expect(averageNotesFromValues([{ a: values }], [{ a: 22 }], [], 'sales')).toEqual([]);
        expect(averageCaution([25, 26, 24, 25])).toBeNull();
        expect(smallSampleNote(45)).toBeNull();
    });
});

describe('per-item figures are averaged, not added up', () => {
    const columns = [
        { name: 'order_date', type: ColumnType.DATE },
        { name: 'unit_price', type: ColumnType.METRIC },
        { name: 'quantity', type: ColumnType.METRIC },
        { name: 'revenue', type: ColumnType.METRIC },
        { name: 'customer_age', type: ColumnType.METRIC },
    ] as ColumnDefinition[];

    it('warns about SUM of a unit price, and suggests price × quantity', () => {
        expect(perItemSumNote('SELECT SUM("unit_price") AS total FROM "data"', columns))
            .toBe('Adding up unit price gives a number that means little: unit price is a per-item figure. Ask for the average unit price, or unit price × quantity for a total.');
        expect(perItemSumNote('SELECT SUM("revenue") FROM "data"', columns)).toBeNull();
        expect(perItemSumNote('SELECT SUM("unit_price" * "quantity") FROM "data"', columns)).toBeNull();
    });

    it('tells the AI which columns are per-item (from names only)', () => {
        expect([...perItemColumns(columns)].sort()).toEqual(['customer_age', 'unit_price']);
    });
});

describe('time series: missing months and a part-month', () => {
    const rows = [{ period: '2025-01-01', total: 10 }, { period: '2025-02-01', total: 20 }, { period: '2025-05-01', total: 5 }];

    it('adds months with no rows as 0 for totals, so the line does not skip them', () => {
        const out = fillMonthlyGaps(rows, 'period', ['total'], 'SELECT DATE_TRUNC(\'month\', d) AS period, SUM(x) AS total FROM data GROUP BY 1');
        expect(out.rows.map(r => [r.period, r.total])).toEqual([['2025-01-01', 10], ['2025-02-01', 20], ['2025-03-01', 0], ['2025-04-01', 0], ['2025-05-01', 5]]);
        expect(missingMonthsNote(out.missing, true)).toBe('No rows in Mar 2025 and Apr 2025: they are shown as 0 rather than skipped.');
    });

    it('leaves averages blank for empty months (an average of nothing is not 0)', () => {
        const out = fillMonthlyGaps(rows, 'period', ['total'], 'SELECT period, AVG(x) AS total FROM data GROUP BY 1');
        expect(out.rows[2].total).toBeNull();
    });

    it('leaves complete or multi-series results alone', () => {
        expect(fillMonthlyGaps(rows.slice(0, 2), 'period', ['total'], 'SUM(x)').missing).toEqual([]);
        expect(fillMonthlyGaps([...rows, { period: '2025-01-01', total: 3 }], 'period', ['total'], 'SUM(x)').missing).toEqual([]);
    });

    it('flags a last month the data only partly covers', () => {
        expect(partialMonthNote(rows, 'period', '2025-05-12', 'SUM(x)')).toBe('May 2025 is only partly in the data (up to 12 May), so its total looks lower than a full month would be.');
        expect(partialMonthNote(rows, 'period', '2025-05-31', 'SUM(x)')).toBeNull();
        expect(partialMonthNote(rows, 'period', '2025-05-12', 'AVG(x)')).toBeNull();
    });
});

describe('per-row percentages, order lines and balances', () => {
    const columns = [
        { name: 'order_id', type: ColumnType.DIMENSION },
        { name: 'order_date', type: ColumnType.DATE },
        { name: 'sales', type: ColumnType.METRIC },
        { name: 'margin_pct', type: ColumnType.METRIC },
        { name: 'stock_level', type: ColumnType.METRIC },
    ] as ColumnDefinition[];

    it('warns that averaging a per-row margin % is not the overall margin', () => {
        expect(averagedRatioNote('SELECT AVG("margin_pct") FROM "data"', columns)).toContain('The overall margin pct, worked out from the totals, can be quite different.');
        expect(averagedRatioNote('SELECT AVG("sales") FROM "data"', columns)).toBeNull();
    });

    it('warns when "average order value" averages lines of orders', () => {
        const lines = [{ order_id: 'A', sales: 10 }, { order_id: 'A', sales: 20 }, { order_id: 'B', sales: 30 }];
        expect(perLineAverageNote('SELECT AVG("sales") FROM "data"', 'What is the average order value?', lines, columns))
            .toBe('One order spans several rows here (one row per line), so this is the average per line, not per order. For the average per order, ask for the total divided by the number of orders.');
        expect(perLineAverageNote('SELECT SUM("sales") / COUNT(DISTINCT "order_id") FROM "data"', 'average order value', lines, columns)).toBeNull();
        expect(perLineAverageNote('SELECT AVG("sales") FROM "data"', 'average sales', lines, columns)).toBeNull();
    });

    it('warns when stock levels are added up across dates', () => {
        expect(summedBalanceNote('SELECT SUM("stock_level") FROM "data"', columns)).toMatch(/^Stock level looks like a snapshot/);
        expect(summedBalanceNote('SELECT SUM("sales") FROM "data"', columns)).toBeNull();
    });

    it('the AI is given the standard BI rules', () => {
        for (const rule of ['NULLIF(SUM("revenue"), 0)', 'COUNT(DISTINCT "order_id")', 'never SUM them across dates', 'SUM(x) OVER ()', '(new - old) / NULLIF(old, 0)']) {
            expect(LEAN_SYSTEM_PROMPT).toContain(rule);
        }
    });
});

describe('% of total with a top-N limit', () => {
    it('says the shares are of the rows shown, not of everything', async () => {
        const { applyTableCalculation } = await import('../utils/tableCalculations');
        const rows = [{ c: 'A', v: 50 }, { c: 'B', v: 30 }];
        expect(applyTableCalculation(rows, 'v', 'percent_of_total', 'Revenue', 'raw', undefined, 3, undefined, 2).yLabel).toBe('% of the top 2 shown (Revenue)');
        expect(applyTableCalculation(rows, 'v', 'percent_of_total', 'Revenue').yLabel).toBe('% of Total (Revenue)');
    });
});
