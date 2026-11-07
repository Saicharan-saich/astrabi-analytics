import { describe, expect, it } from 'vitest';
import { averageNotesFromValues, averageValuesQuery, perItemColumns, perItemSumNote } from '../services/ai-sql/numberChecks';
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
