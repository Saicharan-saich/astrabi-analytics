import { describe, expect, it } from 'vitest';
import { buildHandover } from '../utils/setupHandover';
import { ColumnType, type CleaningSetup } from '../types';

const setup: CleaningSetup = {
    id: 'setup_x', name: 'Acme · monthly orders', createdAt: Date.UTC(2026, 10, 2), updatedAt: Date.UTC(2026, 10, 9),
    headers: ['Order ID', 'Region', 'Revenue', 'Discount', 'Order Date'],
    columns: [
        { name: 'order_id', type: ColumnType.ID }, { name: 'region', type: ColumnType.DIMENSION },
        { name: 'revenue', type: ColumnType.METRIC }, { name: 'discount', type: ColumnType.METRIC }, { name: 'order_date', type: ColumnType.DATE },
    ],
    etlOptions: {
        manualSteps: [
            { id: 'a', kind: 'filter_rows', column: 'customer', op: 'contains', value: 'test', action: 'remove', note: "The client's QA team places test orders" },
            { id: 'b', kind: 'rename_column', column: 'cust', to: 'Customer', off: true },
        ],
        blankDecisions: { discount: 'zero' },
        outlierDecisions: { revenue: 'keep' },
        typoDecisions: { region: 'merge' },
        flagDecisions: { 'mapping:city->country': 'fix' },
        customRules: [{ id: 'r1', column: 'revenue', test: 'min', value: '0', action: 'flag' }],
        keepDuplicateRows: true,
        dateOrder: 'day_first',
    },
    columnTypes: { order_id: ColumnType.ID },
    timesUsed: 3, lastUsedAt: Date.UTC(2026, 10, 20),
};

describe('handover page', () => {
    const page = buildHandover(setup);
    const section = (id: string) => page.sections.find(s => s.id === id)!;

    it('says what the setup does and that no data is in it', () => {
        expect(page.title).toBe('Acme · monthly orders');
        expect(page.summary).toMatch(/never leaves your computer/);
        expect(page.summary).toMatch(/It contains: 1 step · 1 check · 1 blank-cell choice · 3 review decisions · 1 step left as uploaded · a date order · 1 column kind\.$/);
        expect(page.facts).toEqual([
            { label: 'Set up', value: '2 November 2026' }, { label: 'Last changed', value: '9 November 2026' },
            { label: 'Columns', value: '5 (2 numbers)' }, { label: 'Used', value: '3 times, last on 20 November 2026' },
        ]);
    });

    it('lists the file it expects, every step with its reason, and every decision in plain words', () => {
        expect(section('file').columns![2]).toEqual({ name: 'Revenue', kind: 'Number (added up and averaged)' });
        // Headers as the client's file has them; a column the cleaning renamed or dropped says so.
        const made = buildHandover({ ...setup, headers: [...setup.headers, 'Notes'], columns: [...setup.columns, { name: 'profit', type: ColumnType.METRIC }] });
        expect(made.sections[0].columns!.map(c => c.name)).toEqual(['Order ID', 'Region', 'Revenue', 'Discount', 'Order Date', 'Notes']);
        expect(made.sections[0].columns!.at(-1)!.kind).toBe('Renamed or removed by the cleaning');
        expect(section('steps').items).toEqual([
            { text: "Remove rows where 'customer' contains 'test'", why: "The client's QA team places test orders", off: undefined },
            { text: "Rename 'cust' to 'Customer'", why: undefined, off: true },
        ]);
        expect(section('blanks').items[0].text).toBe("In 'discount', a blank counts as 0.");
        expect(section('decisions').items.map(i => i.text)).toEqual([
            "In 'revenue', unusually high or low values are real and kept.",
            "In 'region', likely misspellings are merged into one spelling.",
            "Mapping flags in 'city' and 'country': the values are corrected.",
            'Dates like 03/04 are read day first (3 April).',
        ]);
        expect(section('checks').items[0].text).toBe('revenue is at least 0: rows that break it are flagged for review.');
        expect(section('kept').items[0].text).toBe('Repeated rows are kept (not removed as copies).');
        expect(section('kinds').items[0].text).toBe("'order id' is treated as identifier.");
        expect(section('warnings').items).toHaveLength(5);
    });

    it('leaves out sections with nothing in them', () => {
        const bare = buildHandover({ ...setup, etlOptions: {}, columnTypes: undefined, timesUsed: 0, updatedAt: setup.createdAt });
        expect(bare.sections.map(s => s.id)).toEqual(['file', 'warnings']);
        expect(bare.facts.map(f => f.label)).toEqual(['Set up', 'Columns', 'Used']);
        expect(bare.summary).toMatch(/the automatic cleaning, with no extra choices\.$/);
    });
});
