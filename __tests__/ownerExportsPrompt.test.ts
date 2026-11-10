/**
 * What the AI is told about real export layouts (the owner benchmark's café,
 * shop and Shopify files): column roles and the data shape, never values.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { OWNER_BENCHMARK_SUITE } from '../services/benchmark/ownerFixtures.generated';
import { describeData } from '../services/ai-sql/leanPipeline';

const dataset = (ref: string) => JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'public', ref))).toString('utf8'));

describe('what the AI is told about these exports', () => {
    const schema = (tag: string) => {
        const c = OWNER_BENCHMARK_SUITE.cases.find(x => x.tags.includes(tag))!;
        return describeData(dataset(c.datasetRef!)).schema;
    };
    it('Shopify orders: the order number, order-level amounts and the customer', () => {
        const text = schema('online');
        expect(text).toMatch(/"name" is the order number/);
        expect(text).toMatch(/"subtotal", "shipping", "taxes", "total", "discount_amount", "refunded_amount" are amounts for the whole order, filled on its first row only/);
        expect(text).toMatch(/Sales by product or line item: SUM\("lineitem_price" \* "lineitem_quantity"\)/);
        expect(text).toMatch(/"email" identifies the customer/);
        expect(text).toMatch(/"discount_code": TEXT; category; a blank is stored as 'None'/);
        expect(text).toMatch(/"paid_at": TEXT date and time/);
        expect(text).toMatch(/"lineitem_quantity": NUMBER; measure\b/);
        expect(text).toMatch(/"subtotal": NUMBER; measure \(money\)/);
        expect(text).toMatch(/"discount_amount": NUMBER; measure \(money\)/);
    });
    it('Square item sales: transactions, customers and refunds', () => {
        const text = schema('cafe');
        expect(text).toMatch(/"transaction_id" is the transaction number/);
        expect(text).toMatch(/"customer_id" identifies the customer/);
        expect(text).toMatch(/Some rows have a negative "qty", "gross_sales", "discounts", "net_sales", "tax"/);
        expect(text).toMatch(/"time": TEXT clock time/);
    });
    it('till export: receipts, and a discount in pounds is money', () => {
        const text = schema('shop');
        expect(text).toMatch(/"receipt_no" is the receipt number/);
        expect(text).toMatch(/"discount": NUMBER; measure \(money\)/);
    });
});
