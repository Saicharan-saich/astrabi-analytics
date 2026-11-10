/**
 * Export layouts small shops upload, cleaned the way an upload is: order
 * amounts written "79.00" are money, a sparse discount code is a category
 * that belongs to the whole order, and blanks load as blanks.
 */
import { describe, it, expect } from 'vitest';
import { parseDelimitedText } from '../services/delimitedText';
import { runETLPipeline } from '../services/etlPipeline';
import { runConstraintGates } from '../services/ai-sql/constraintGates';
import { duckCellValue, duckLiteral } from '../utils/duckColumnType';
import { ColumnType } from '../types';

function shopifyCsv(): string {
    const lines = ['Name,Email,Financial Status,Subtotal,Shipping,Taxes,Total,Discount Code,Discount Amount,Lineitem quantity,Lineitem name,Lineitem price'];
    const products = [['Tee', 22], ['Tote', 15], ['Mug', 16], ['Pin', 6]] as const;
    for (let o = 0; o < 40; o++) {
        const items = products.slice(0, 1 + (o % 3));
        const sub = items.reduce((s, [, p]) => s + p, 0);
        const code = o % 5 === 0 ? 'WELCOME10' : o % 7 === 0 ? 'SUMMER15' : '';
        const disc = code ? sub * 0.1 : 0;
        items.forEach(([name, price], k) => {
            lines.push(k === 0
                ? `#${1001 + o},c${o % 17}@example.com,paid,${sub.toFixed(2)},3.95,${((sub - disc) / 6).toFixed(2)},${(sub - disc + 3.95).toFixed(2)},${code},${disc.toFixed(2)},${1 + (o % 2)},${name},${price.toFixed(2)}`
                : `#${1001 + o},,,,,,,,,1,${name},${price.toFixed(2)}`);
        });
    }
    return lines.join('\n');
}

describe('a Shopify orders export', () => {
    const r = runETLPipeline(parseDelimitedText(shopifyCsv()).rows, 'orders_export.csv');
    const type = (name: string) => r.columns.find(c => c.name === name)?.type;

    it('treats amounts written with two decimals as money, whatever they are called', () => {
        expect(type('subtotal')).toBe(ColumnType.METRIC);
        expect(type('taxes')).toBe(ColumnType.METRIC);
        expect(type('total')).toBe(ColumnType.METRIC);
    });

    it('keeps a discount code as a category for the whole order; no code is "None", not "Unknown"', () => {
        expect(type('discount_code')).toBe(ColumnType.DIMENSION);
        const order = r.rows.filter(row => row.name === '#1001');
        expect(order.length).toBe(1);
        const multi = r.rows.filter(row => row.name === '#1006'); // a three-line order with a code (o = 5)
        expect(multi.map(row => row.discount_code)).toEqual(['WELCOME10', 'WELCOME10', 'WELCOME10']);
        expect(r.rows.filter(row => row.name === '#1002').every(row => row.discount_code === 'None')).toBe(true);
        expect(r.rows.some(row => row.discount_code === 'Unknown')).toBe(false);
    });

    it('leaves order amounts on the first line only, so they add up once per order', () => {
        const lines = r.rows.filter(row => row.name === '#1003');
        expect(lines.length).toBe(3);
        expect(lines.slice(1).every(row => row.total === null || row.total === undefined)).toBe(true);
    });
});

describe('column meaning for the AI', () => {
    const gate = (name: string, values: { distinct: number; min: number; max: number; integer: boolean; yesNo?: boolean }) => runConstraintGates({
        name, etlType: ColumnType.METRIC, totalRows: 500, distinctCount: values.distinct, nullRate: 0,
        range: { min: values.min, max: values.max }, isIntegerLike: values.integer, dateParseRate: 0, hasTimeComponent: false, yesNo: values.yesNo,
    }).bestGuess;

    it('a discount in pounds is money; a discount of 5, 10 or 15 is a percentage', () => {
        expect(gate('discount', { distinct: 27, min: 0, max: 10.8, integer: false }).semanticType).toBe('currency');
        expect(gate('discount_amount', { distinct: 69, min: 0, max: 13.2, integer: false }).semanticType).toBe('currency');
        expect(gate('discount', { distinct: 4, min: 0, max: 20, integer: true }).semanticType).toBe('percentage');
        expect(gate('discount_rate', { distinct: 30, min: 0, max: 0.3, integer: false }).semanticType).toBe('percentage');
    });

    it('a quantity that is only ever 1 or 2 is still added up', () => {
        const q = gate('lineitem_quantity', { distinct: 2, min: 1, max: 2, integer: true, yesNo: false });
        expect(q.role).toBe('metric');
    });
});

describe('loading cells into DuckDB', () => {
    it('loads empty text as a blank, so a missing customer is not a customer called ""', () => {
        expect(duckCellValue('', 'VARCHAR')).toBeNull();
        expect(duckCellValue('  ', 'VARCHAR')).toBeNull();
        expect(duckCellValue('CUST-1', 'VARCHAR')).toBe('CUST-1');
        expect(duckLiteral("O'Brien", 'VARCHAR')).toBe("'O''Brien'");
        expect(duckLiteral('1,234.50', 'DOUBLE')).toBe('1234.5');
        expect(duckLiteral('true', 'BOOLEAN')).toBe('TRUE');
    });
});
