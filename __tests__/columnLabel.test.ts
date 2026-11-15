import { describe, expect, it } from 'vitest';
import { columnLabel } from '../utils/columnLabel';

describe('readable column names', () => {
    it('tidy any name without changing what it refers to', () => {
        expect(columnLabel('order_id')).toBe('Order ID');
        expect(columnLabel('funnel_stage')).toBe('Funnel stage');
        expect(columnLabel('revenue')).toBe('Revenue');
        expect(columnLabel('slaMet')).toBe('SLA met');
        expect(columnLabel('csat_score')).toBe('CSAT score');
        expect(columnLabel('lineitem_name')).toBe('Product');
        expect(columnLabel('IT')).toBe('IT');
        expect(columnLabel('sold_to_us')).toBe('Sold to us');
        expect(columnLabel('Net Sales (£)')).toBe('Net sales (£)');
    });
});
