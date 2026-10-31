import { afterEach, describe, expect, it } from 'vitest';
import { runETLPipeline, prefersDayFirst } from '../services/etlPipeline';
import { parseDelimitedText } from '../services/delimitedText';
import { buildSemanticModel } from '../services/semanticModel';
import {
    detectNumberStyle, parseLocaleNumber, parseNumberWithUnit, isTotalLabel, periodFromHeader, parseDurationMinutes,
} from '../services/etlHardening';

const sum = (rows: any[], key: string) => rows.reduce((total, row) => total + (typeof row[key] === 'number' ? row[key] : 0), 0);
const logText = (logs: any[]) => logs.map(l => `${l.step}: ${l.details}`).join('\n');
const typeOf = (etl: ReturnType<typeof runETLPipeline>, name: string) => etl.columns.find(c => c.name === name)?.type;

describe('rows are never lost silently', () => {
    it('keeps identical transactions when no ID proves they are copies', () => {
        const raw = Array.from({ length: 60 }, (_, i) => ({ date: `2025-01-0${1 + (i % 3)}`, store: ['A', 'B'][i % 2], item: 'Coffee', amount: 3.5 }));
        const etl = runETLPipeline(raw, 'till.csv');
        expect(etl.rows).toHaveLength(60);
        expect(sum(etl.rows, 'amount')).toBeCloseTo(210, 6);
        expect(logText(etl.logs)).toMatch(/Repeated Rows Kept/);
    });

    it('keeps every line of a multi-line order', () => {
        const raw: any[] = [];
        for (let i = 1; i <= 100; i++) {
            raw.push({ order_id: `SO-${i}`, product: 'Desk', quantity: 2, unit_price: 50, line_total: 100 });
            if (i % 20 === 0) raw.push({ order_id: `SO-${i}`, product: 'Cable', quantity: 1, unit_price: 10, line_total: 10 });
        }
        const etl = runETLPipeline(raw, 'lines.csv');
        expect(etl.rows).toHaveLength(105);
        expect(sum(etl.rows, 'line_total')).toBe(10050);
        expect(logText(etl.logs)).toMatch(/Line Totals Verified/);
    });

    it('removes exact re-exported copies when an ID shows rows should be unique', () => {
        const raw = Array.from({ length: 20 }, (_, i) => ({ invoice_id: `INV-${i}`, amount: 100 + i }));
        raw.push({ ...raw[3] }, { ...raw[7] });
        const etl = runETLPipeline(raw, 'invoices.csv');
        expect(etl.rows).toHaveLength(20);
        expect(logText(etl.logs)).toMatch(/Removed 2 exact duplicate row\(s\)/);
    });

    it('keeps a sparse measure column and treats it as a measure', () => {
        const raw = Array.from({ length: 100 }, (_, i) => ({ order_id: `O${i}`, amount: 50, refund_amount: i % 34 === 0 ? 25 : '' }));
        const etl = runETLPipeline(raw, 'refunds.csv');
        expect(typeOf(etl, 'refund_amount')).toBe('METRIC');
        expect(sum(etl.rows, 'refund_amount')).toBe(75);
    });

    it('removes total and subtotal rows that equal the rows they total', () => {
        const raw = [
            { region: 'North', product: 'A', sales: 100 }, { region: 'North', product: 'B', sales: 50 },
            { region: 'North Subtotal', product: '', sales: 150 },
            { region: 'South', product: 'A', sales: 70 }, { region: 'South', product: 'B', sales: 30 },
            { region: 'South Subtotal', product: '', sales: 100 },
            { region: 'Grand Total', product: '', sales: 250 },
        ];
        const etl = runETLPipeline(raw, 'report.csv');
        expect(etl.rows).toHaveLength(4);
        expect(sum(etl.rows, 'sales')).toBe(250);
        expect(logText(etl.logs)).toMatch(/Removed 3 total\/subtotal row/);
    });

    it('keeps a row labelled "Total" whose numbers do not add up, and flags it', () => {
        const raw = [{ region: 'North', sales: 10 }, { region: 'South', sales: 20 }, { region: 'East', sales: 30 }, { region: 'Total', sales: 999 }];
        const etl = runETLPipeline(raw, 'odd.csv');
        expect(etl.rows).toHaveLength(4);
        expect(logText(etl.logs)).toMatch(/Total Row Flag/);
    });

    it('drops header rows repeated inside concatenated exports', () => {
        const raw = [
            { order_id: 'A1', amount: '10' }, { order_id: 'order_id', amount: 'amount' }, { order_id: 'A2', amount: '20' },
        ];
        const etl = runETLPipeline(raw, 'joined.csv');
        expect(etl.rows).toHaveLength(2);
    });
});

describe('numbers are read the way the file means them', () => {
    it('decides the decimal convention per column', () => {
        expect(detectNumberStyle(['1.234,50', '12,5', '€1.234', '980,00'])).toBe('eu');
        expect(detectNumberStyle(['1,234.50', '12.5', '$1,234', '980.00'])).toBe('us');
        expect(parseLocaleNumber('€1.234', 'eu')).toBe(1234);
        expect(parseLocaleNumber('€1.234', 'us')).toBe(1.234);
        const raw = ['1.234,50', '12,50', '€1.234', '2.000,00', '3,75'].map((amount, i) => ({ id: `R${i}`, amount }));
        const etl = runETLPipeline(raw, 'eu.csv');
        expect(etl.rows.map(r => r.amount)).toEqual([1234.5, 12.5, 1234, 2000, 3.75]);
    });

    it('reads typographic minus signs and values written with units', () => {
        expect(parseLocaleNumber('−500')).toBe(-500);
        expect(parseNumberWithUnit('3 units')).toMatchObject({ value: 3, unit: 'units' });
        expect(parseNumberWithUnit('approx 5')).toMatchObject({ value: 5, approximate: true });
        expect(parseNumberWithUnit('2 million')).toMatchObject({ value: 2_000_000 });
        const raw = Array.from({ length: 12 }, (_, i) => ({ order_id: `O${i}`, quantity: i === 3 ? '3 units' : i === 4 ? '~5' : 4 }));
        const etl = runETLPipeline(raw, 'units.csv');
        expect(etl.rows.find(r => r.order_id === 'O3')?.quantity).toBe(3);
        expect(etl.rows.find(r => r.order_id === 'O4')?.quantity).toBe(5);
        expect(logText(etl.logs)).toMatch(/Units Removed/);
    });

    it('puts "10%" and 0.1 on the same scale', () => {
        const raw = Array.from({ length: 20 }, (_, i) => ({ order_id: `O${i}`, discount: i % 2 ? '10%' : 0.1 }));
        const etl = runETLPipeline(raw, 'discounts.csv');
        expect(new Set(etl.rows.map(r => r.discount))).toEqual(new Set([10]));
        expect(logText(etl.logs)).toMatch(/Percent Scale Standardized/);
    });

    it('converts durations to minutes', () => {
        expect(parseDurationMinutes('01:30:00')).toBe(90);
        expect(parseDurationMinutes('2:15')).toBe(135);
        const raw = Array.from({ length: 10 }, (_, i) => ({ call_id: `C${i}`, call_duration: `00:0${i}:30` }));
        const etl = runETLPipeline(raw, 'calls.csv');
        expect(typeOf(etl, 'call_duration')).toBe('METRIC');
        expect(etl.rows[2].call_duration).toBe(2.5);
    });

    it('treats a repeated 999999 code as missing but keeps a one-off extreme value', () => {
        const raw = Array.from({ length: 30 }, (_, i) => ({ sku_id: `S${i}`, unit_cost: i === 5 || i === 9 ? 999999 : 20 + (i % 4) }));
        const etl = runETLPipeline(raw, 'costs.csv');
        expect(etl.rows.filter(r => r.unit_cost === null)).toHaveLength(2);
        expect(logText(etl.logs)).toMatch(/Placeholder Values Removed/);
    });

    it('never adds different currencies together silently', () => {
        const raw = Array.from({ length: 20 }, (_, i) => ({ invoice_id: `I${i}`, amount: i % 2 ? `$${100 + i}` : `€${200 + i}` }));
        const etl = runETLPipeline(raw, 'fx.csv');
        expect(etl.columns.some(c => c.name === 'amount_currency')).toBe(true);
        expect(new Set(etl.rows.map(r => r.amount_currency))).toEqual(new Set(['USD', 'EUR']));
        expect(logText(etl.logs)).toMatch(/Mixed Currency Flag/);
    });

    it('keeps long numeric IDs exactly as uploaded', () => {
        const raw = Array.from({ length: 10 }, (_, i) => ({ transaction_id: `90071992547409${90 + i}`, amount: 5 }));
        const etl = runETLPipeline(raw, 'long-ids.csv');
        expect(etl.rows.map(r => r.transaction_id)).toEqual(raw.map(r => r.transaction_id));
    });
});

describe('measures are derived and aggregated correctly', () => {
    it('leaves revenue = quantity × unit price to the governed metric, and says so', () => {
        const raw = Array.from({ length: 10 }, (_, i) => ({ order_id: `O${i}`, quantity: i + 1, unit_price: 2.5 }));
        const etl = runETLPipeline(raw, 'no-total.csv');
        expect(etl.columns.some(c => c.name === 'line_total')).toBe(false);
        expect(logText(etl.logs)).toMatch(/Revenue From Price × Quantity/);
    });

    it('averages unit cost, derives line cost, and never builds profit from a unit cost', () => {
        const raw = Array.from({ length: 12 }, (_, i) => ({ order_id: `O${i}`, quantity: 2, unit_cost: 10, revenue: 50 }));
        const etl = runETLPipeline(raw, 'costs.csv');
        expect(sum(etl.rows, 'line_cost')).toBe(240);
        const model = buildSemanticModel({ id: 'x', name: 'x', rows: etl.rows, columns: etl.columns, totalRows: etl.rows.length, etlLogs: [] } as any);
        expect(model.measures.find(m => m.column === 'unit_cost')?.aggregation).toBe('AVG');
        const profit = model.derivedMeasures.find(d => d.id === 'profit');
        expect(profit?.denominator).toBe('line_cost');
    });

    it('does not invent a second profit when the data already has one', () => {
        const raw = Array.from({ length: 12 }, (_, i) => ({ order_id: `O${i}`, revenue: 50, total_cost: 30, profit: 20 }));
        const etl = runETLPipeline(raw, 'profit.csv');
        const model = buildSemanticModel({ id: 'x', name: 'x', rows: etl.rows, columns: etl.columns, totalRows: etl.rows.length, etlLogs: [] } as any);
        expect(model.derivedMeasures.some(d => d.id === 'profit')).toBe(false);
    });

    it('spreads an order-level amount repeated on every line so it is counted once', () => {
        const raw: any[] = [];
        for (let o = 0; o < 10; o++) for (let l = 0; l < 3; l++) raw.push({ order_id: `O${o}`, line_total: 10 + l, shipping: 6 + o });
        const etl = runETLPipeline(raw, 'shipping.csv');
        const expected = Array.from({ length: 10 }, (_, o) => 6 + o).reduce((a, b) => a + b, 0);
        expect(sum(etl.rows, 'shipping_allocated')).toBeCloseTo(expected, 4);
        expect(logText(etl.logs)).toMatch(/Repeated Order-Level Amount/);
    });

    it('treats hours and visits as measures even when the numbers are small', () => {
        const raw = Array.from({ length: 40 }, (_, i) => ({ employee_id: `E${i % 8}`, hours_worked: 4 + (i % 5), site_visits: i % 3 }));
        const etl = runETLPipeline(raw, 'timesheet.csv');
        expect(typeOf(etl, 'hours_worked')).toBe('METRIC');
        expect(typeOf(etl, 'site_visits')).toBe('METRIC');
    });
});

describe('table shape and dimensions', () => {
    it('reshapes one-column-per-month tables into period and value', () => {
        expect(periodFromHeader('Jan 2024')).toBe('2024-01-01');
        expect(periodFromHeader('2024-03')).toBe('2024-03-01');
        expect(periodFromHeader('Q2 2024')).toBe('2024-04-01');
        expect(periodFromHeader('Feb')).toBe('');
        expect(periodFromHeader('revenue')).toBeNull();
        const raw = [
            { product: 'Desk', 'Jan 2024': 100, 'Feb 2024': 120, 'Mar 2024': 90 },
            { product: 'Chair', 'Jan 2024': 40, 'Feb 2024': 45, 'Mar 2024': 50 },
        ];
        const etl = runETLPipeline(raw, 'wide.csv');
        expect(etl.rows).toHaveLength(6);
        expect(typeOf(etl, 'period')).toBe('DATE');
        expect(sum(etl.rows, 'value')).toBe(445);
    });

    it('builds a period date from year and month columns', () => {
        const raw = Array.from({ length: 24 }, (_, i) => ({ year: 2024 + Math.floor(i / 12), month: (i % 12) + 1, sales: 100 }));
        const etl = runETLPipeline(raw, 'monthly.csv');
        expect(typeOf(etl, 'period')).toBe('DATE');
        expect(String(etl.rows[13].period).slice(0, 10)).toBe('2025-02-01');
    });

    it('keeps business categories as uploaded (no guessed synonyms)', () => {
        const raw = Array.from({ length: 12 }, (_, i) => ({ order_id: `O${i}`, channel: ['Wholesale', 'Retail', 'Online'][i % 3], status: ['Open', 'Closed'][i % 2], amount: 10 }));
        const etl = runETLPipeline(raw, 'channels.csv');
        expect(new Set(etl.rows.map(r => r.channel))).toEqual(new Set(['Wholesale', 'Retail', 'Online']));
        expect(new Set(etl.rows.map(r => r.status))).toEqual(new Set(['Open', 'Closed']));
    });

    it('keeps two columns whose headers differ only in case', () => {
        const raw = Array.from({ length: 5 }, (_, i) => ({ id: `R${i}`, Sales: 10, sales: 20 }));
        const etl = runETLPipeline(raw, 'case.csv');
        expect(sum(etl.rows, 'sales') + sum(etl.rows, 'sales_2')).toBe(150);
    });

    it('treats placeholder dates as missing', () => {
        const raw = Array.from({ length: 20 }, (_, i) => ({ order_id: `O${i}`, order_date: i === 4 ? '1900-01-01' : i === 5 ? '9999-12-31' : `2025-03-${String(1 + i).padStart(2, '0')}`, amount: 5 }));
        const etl = runETLPipeline(raw, 'dates.csv');
        expect(etl.rows.filter(r => r.order_date === null)).toHaveLength(2);
        expect(etl.timeContext?.minDate?.slice(0, 4)).toBe('2025');
    });
});

describe('reading delimited files', () => {
    it('handles semicolons, a title line, quoted line breaks and duplicate headers', () => {
        const text = '﻿Sales report Q1\n\nRegion;Amount;Notes;Amount\nNorth;"1.234,50";"Line one\nline two";5\nSouth;980,00;;7\n';
        const parsed = parseDelimitedText(text);
        expect(parsed.delimiter).toBe(';');
        expect(parsed.rows).toHaveLength(2);
        expect(parsed.rows[0]).toMatchObject({ Region: 'North', Amount: '1.234,50', Notes: 'Line one\nline two', Amount_2: '5' });
    });

    it('reads tab-separated text', () => {
        const parsed = parseDelimitedText('a\tb\n1\t2\n3\t4');
        expect(parsed.delimiter).toBe('\t');
        expect(parsed.rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
    });
});

describe('date order follows the locale when the data cannot decide', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    afterEach(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); });

    it('reads 03/04/2025 as 3 April for a UK user', () => {
        Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-GB' }, configurable: true });
        expect(prefersDayFirst()).toBe(true);
        const raw = Array.from({ length: 10 }, (_, i) => ({ order_id: `O${i}`, order_date: '03/04/2025', amount: 1 }));
        const etl = runETLPipeline(raw, 'uk.csv');
        expect(String(etl.rows[0].order_date).slice(0, 10)).toBe('2025-04-03');
    });

    it('reads it as March 4 for a US user', () => {
        Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
        const raw = Array.from({ length: 10 }, (_, i) => ({ order_id: `O${i}`, order_date: '03/04/2025', amount: 1 }));
        const etl = runETLPipeline(raw, 'us.csv');
        expect(String(etl.rows[0].order_date).slice(0, 10)).toBe('2025-03-04');
    });

    it('recognises total labels', () => {
        expect(isTotalLabel('Grand Total')).toBe(true);
        expect(isTotalLabel('North Subtotal')).toBe(true);
        expect(isTotalLabel('Total:')).toBe(true);
        expect(isTotalLabel('Total Gym Equipment')).toBe(false);
        expect(isTotalLabel('North')).toBe(false);
    });
});
