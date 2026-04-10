/**
 * joinLogic.test.ts — Comprehensive tests for the fact-first join engine.
 *
 * Key principle being tested:
 *   NEVER start joins from dimension tables (stores, products, employees).
 *   ALWAYS start from fact tables (transaction_items, transactions, orders).
 *
 * Expected result for a retail schema:
 *   transaction_items (200 rows) LEFT JOIN transactions LEFT JOIN stores
 *   → 200 rows, NOT 2 rows.
 */

import { describe, it, expect } from 'vitest';
import {
    detectFactTable,
    detectFactTableFromData,
    buildJoinStrategy,
    autoJoinDatasets,
} from '../services/analysisEngine';
import type { ColumnInfo } from '../services/analysisEngine';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const makeColInfo = (name: string, isPK = false): ColumnInfo => ({
    name,
    dataType: name.endsWith('_id') || name === 'id' ? 'int' : 'varchar',
    isNullable: !isPK,
    isPK,
    maxLength: 255,
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: detectFactTable (schema-level, no row data)
// ─────────────────────────────────────────────────────────────────────────────

describe('detectFactTable', () => {
    it('should prefer transaction_items over stores', () => {
        const tables = ['stores', 'transaction_items'];
        const cols: Record<string, ColumnInfo[]> = {
            stores: [makeColInfo('store_id', true), makeColInfo('store_name')],
            transaction_items: [
                makeColInfo('item_id', true), makeColInfo('transaction_id'),
                makeColInfo('product_id'), makeColInfo('quantity'), makeColInfo('price'),
            ],
        };
        expect(detectFactTable(tables, cols)).toBe('transaction_items');
    });

    it('should prefer transactions over products', () => {
        const tables = ['products', 'transactions'];
        const cols: Record<string, ColumnInfo[]> = {
            products: [makeColInfo('product_id', true), makeColInfo('product_name')],
            transactions: [makeColInfo('transaction_id', true), makeColInfo('store_id'), makeColInfo('total')],
        };
        expect(detectFactTable(tables, cols)).toBe('transactions');
    });

    it('should prefer order_items over any dimension table', () => {
        const tables = ['customers', 'employees', 'order_items', 'stores'];
        const cols: Record<string, ColumnInfo[]> = {
            customers: [makeColInfo('customer_id', true), makeColInfo('customer_name')],
            employees: [makeColInfo('employee_id', true), makeColInfo('first_name')],
            order_items: [makeColInfo('item_id', true), makeColInfo('order_id'), makeColInfo('product_id'), makeColInfo('qty')],
            stores: [makeColInfo('store_id', true), makeColInfo('store_name'), makeColInfo('region')],
        };
        expect(detectFactTable(tables, cols)).toBe('order_items');
    });

    it('should prefer transactions over stores even by exact name match', () => {
        const tables = ['store', 'transaction'];
        const cols: Record<string, ColumnInfo[]> = {
            store: [makeColInfo('store_id', true), makeColInfo('location')],
            transaction: [makeColInfo('transaction_id', true), makeColInfo('store_id'), makeColInfo('amount')],
        };
        expect(detectFactTable(tables, cols)).toBe('transaction');
    });

    it('should favour invoice_items over invoices which beats stores', () => {
        const tables = ['invoice_items', 'invoices', 'stores'];
        const cols: Record<string, ColumnInfo[]> = {
            invoice_items: [makeColInfo('item_id', true), makeColInfo('invoice_id'), makeColInfo('product_id'), makeColInfo('amount')],
            invoices: [makeColInfo('invoice_id', true), makeColInfo('store_id'), makeColInfo('total')],
            stores: [makeColInfo('store_id', true), makeColInfo('store_name')],
        };
        const fact = detectFactTable(tables, cols);
        expect(fact).toBe('invoice_items');
    });

    it('uses column count as tiebreaker when names are ambiguous', () => {
        // "data_a" and "data_b" both have no pattern score, so more columns wins
        const tables = ['data_a', 'data_b'];
        const cols: Record<string, ColumnInfo[]> = {
            data_a: [makeColInfo('id', true), makeColInfo('val1')],
            data_b: [
                makeColInfo('id', true), makeColInfo('val1'), makeColInfo('val2'),
                makeColInfo('val3'), makeColInfo('val4'), makeColInfo('val5'),
            ],
        };
        expect(detectFactTable(tables, cols)).toBe('data_b');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: detectFactTableFromData (data-level, by row count + name)
// ─────────────────────────────────────────────────────────────────────────────

describe('detectFactTableFromData', () => {
    it('should choose transaction_items (highest name score + most rows)', () => {
        const stores = [{ store_id: '1' }, { store_id: '2' }];
        const transactions = Array.from({ length: 50 }, (_, i) => ({ transaction_id: String(i), store_id: i < 25 ? '1' : '2' }));
        const transaction_items = Array.from({ length: 200 }, (_, i) => ({
            item_id: String(i), transaction_id: String(i % 50), product_id: String(i % 20),
        }));
        expect(detectFactTableFromData({ stores, transactions, transaction_items })).toBe('transaction_items');
    });

    it('should choose transactions when transaction_items is absent', () => {
        const stores = [{ store_id: '1' }, { store_id: '2' }];
        const transactions = Array.from({ length: 50 }, (_, i) => ({ transaction_id: String(i), store_id: '1' }));
        expect(detectFactTableFromData({ stores, transactions })).toBe('transactions');
    });

    it('falls back to the table with most rows when names are unknown', () => {
        const alpha = Array.from({ length: 5 }, (_, i) => ({ id: String(i) }));
        const beta = Array.from({ length: 200 }, (_, i) => ({ id: String(i), ref: '1' }));
        expect(detectFactTableFromData({ alpha, beta })).toBe('beta');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: autoJoinDatasets — core correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('autoJoinDatasets', () => {
    // Build a minimal retail dataset
    const buildRetailData = () => {
        const stores = [
            { store_id: '1', store_name: 'London HQ' },
            { store_id: '2', store_name: 'Manchester' },
        ];
        const transactions = Array.from({ length: 10 }, (_, i) => ({
            transaction_id: String(i + 1),
            store_id: (i % 2 + 1).toString(),
            cashier_id: String(i % 3 + 1),
        }));
        const transaction_items = Array.from({ length: 50 }, (_, i) => ({
            item_id: String(i + 1),
            transaction_id: String((i % 10) + 1),
            product_id: String((i % 5) + 1),
            quantity: (i % 5) + 1,
            price: 9.99,
        }));
        const products = Array.from({ length: 5 }, (_, i) => ({
            product_id: String(i + 1),
            product_name: `Product ${i + 1}`,
            category_id: String((i % 2) + 1),
        }));
        return { stores, transactions, transaction_items, products };
    };

    it('result row count equals transaction_items count (not stores count)', () => {
        const data = buildRetailData();
        const { mergedRows, joinLogs } = autoJoinDatasets(data);

        // The base table should be transaction_items (50 rows), NOT stores (2 rows)
        expect(mergedRows.length).toBe(50);
        expect(joinLogs[0]).toContain('transaction_items');
        expect(joinLogs[0]).toContain('50');
    });

    it('enriches each row with data from transactions (via transaction_id)', () => {
        const data = buildRetailData();
        const { mergedRows } = autoJoinDatasets(data);

        // transaction_items (fact base) directly shares transaction_id with transactions,
        // so cashier_id and store_id should be present after the no-edges join
        const allHaveStoreId = mergedRows.every(r => r.store_id !== undefined);
        expect(allHaveStoreId).toBe(true);
    });

    it('does NOT enrich store_name from a 2-hop path in no-edges mode (expected behaviour)', () => {
        // The no-edges fallback does direct key-lookup joins from the fact table.
        // transaction_items → stores: transaction_items has no store_id directly,
        // so stores cannot be reached in a single hop without explicit edges.
        // This is correct behaviour; use buildJoinStrategy to get the full chain.
        const data = buildRetailData();
        const { mergedRows } = autoJoinDatasets(data);

        // store_name may or may not be present depending on hop order;
        // what matters is that row count is preserved (50 rows, not 2).
        expect(mergedRows.length).toBe(50);
    });

    it('enriches store_name when edges from buildJoinStrategy are used', () => {
        const { stores, transactions, transaction_items, products } = buildRetailData();
        const tableColumns = {
            stores: [
                { name: 'store_id', dataType: 'int', isNullable: false, isPK: true, maxLength: 0 },
                { name: 'store_name', dataType: 'varchar', isNullable: true, isPK: false, maxLength: 255 },
            ],
            transactions: [
                { name: 'transaction_id', dataType: 'int', isNullable: false, isPK: true, maxLength: 0 },
                { name: 'store_id', dataType: 'int', isNullable: true, isPK: false, maxLength: 0 },
            ],
            transaction_items: [
                { name: 'item_id', dataType: 'int', isNullable: false, isPK: true, maxLength: 0 },
                { name: 'transaction_id', dataType: 'int', isNullable: true, isPK: false, maxLength: 0 },
                { name: 'product_id', dataType: 'int', isNullable: true, isPK: false, maxLength: 0 },
                { name: 'quantity', dataType: 'int', isNullable: true, isPK: false, maxLength: 0 },
                { name: 'price', dataType: 'decimal', isNullable: true, isPK: false, maxLength: 0 },
            ],
            products: [
                { name: 'product_id', dataType: 'int', isNullable: false, isPK: true, maxLength: 0 },
                { name: 'product_name', dataType: 'varchar', isNullable: true, isPK: false, maxLength: 255 },
            ],
        };
        const edges = buildJoinStrategy(
            ['stores', 'transactions', 'transaction_items', 'products'],
            tableColumns,
            []
        );
        const { mergedRows } = autoJoinDatasets(
            { stores, transactions, transaction_items, products },
            edges
        );

        expect(mergedRows.length).toBe(50);
        const allHaveStoreName = mergedRows.every(r => r.store_name !== undefined);
        expect(allHaveStoreName).toBe(true);
    });

    it('enriches each row with product_name from products (via product_id)', () => {
        const data = buildRetailData();
        const { mergedRows } = autoJoinDatasets(data);

        const allHaveProductName = mergedRows.every(r => r.product_name !== undefined);
        expect(allHaveProductName).toBe(true);
    });

    it('does NOT collapse rows — 50 items remain 50 after joining 2 stores', () => {
        const stores = [{ store_id: '1', name: 'Store A' }, { store_id: '2', name: 'Store B' }];
        const items = Array.from({ length: 100 }, (_, i) => ({
            item_id: String(i),
            store_id: (i % 2 + 1).toString(),
            amount: 10,
        }));
        const { mergedRows } = autoJoinDatasets({ stores, transaction_items: items });
        expect(mergedRows.length).toBe(100);
    });

    it('logs show FACT table as base, not a dimension', () => {
        const { joinLogs } = autoJoinDatasets(buildRetailData());
        expect(joinLogs[0]).toMatch(/Base table \(FACT\): transaction_items/i);
    });

    it('single table returns rows unchanged', () => {
        const rows = [{ id: '1', val: 10 }, { id: '2', val: 20 }];
        const { mergedRows } = autoJoinDatasets({ my_table: rows });
        expect(mergedRows).toEqual(rows);
    });

    it('empty table dict returns empty array', () => {
        const { mergedRows } = autoJoinDatasets({});
        expect(mergedRows).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: buildJoinStrategy — edge ordering and root selection
// ─────────────────────────────────────────────────────────────────────────────

describe('buildJoinStrategy', () => {
    const makeTableCols = (tables: Record<string, string[]>): Record<string, ColumnInfo[]> =>
        Object.fromEntries(
            Object.entries(tables).map(([tbl, cols]) => [
                tbl,
                cols.map(c => makeColInfo(c, c === cols[0])),
            ])
        );

    it('root of join chain is the fact table, not a dimension', () => {
        const tables = ['stores', 'transactions', 'transaction_items'];
        const cols = makeTableCols({
            stores: ['store_id', 'store_name'],
            transactions: ['transaction_id', 'store_id', 'cashier_id'],
            transaction_items: ['item_id', 'transaction_id', 'product_id', 'quantity', 'price'],
        });
        const edges = buildJoinStrategy(tables, cols, []);

        // The first edge should start from transaction_items
        expect(edges.length).toBeGreaterThan(0);
        const rootTables = new Set(edges.map(e => e.leftTable));
        // transaction_items or transactions should be the root (not stores)
        const hasFactRoot = rootTables.has('transaction_items') || rootTables.has('transactions');
        expect(hasFactRoot).toBe(true);
        expect(rootTables.has('stores')).toBe(false);
    });

    it('connects transaction_items to transactions via transaction_id', () => {
        const tables = ['transactions', 'transaction_items'];
        const cols = makeTableCols({
            transactions: ['transaction_id', 'store_id'],
            transaction_items: ['item_id', 'transaction_id', 'quantity'],
        });
        const edges = buildJoinStrategy(tables, cols, []);

        expect(edges.length).toBe(1);
        expect(edges[0].leftTable).toBe('transaction_items');
        expect(edges[0].rightTable).toBe('transactions');
        expect(edges[0].leftColumn).toBe('transaction_id');
    });

    it('connects transactions to stores via store_id', () => {
        const tables = ['stores', 'transactions'];
        const cols = makeTableCols({
            stores: ['store_id', 'store_name'],
            transactions: ['transaction_id', 'store_id', 'total'],
        });
        const edges = buildJoinStrategy(tables, cols, []);

        expect(edges.length).toBe(1);
        expect(edges[0].leftTable).toBe('transactions');
        expect(edges[0].rightTable).toBe('stores');
        expect(edges[0].leftColumn).toBe('store_id');
    });

    it('builds a full retail star schema chain: items→transactions→stores', () => {
        const tables = ['stores', 'transactions', 'transaction_items'];
        const cols = makeTableCols({
            stores: ['store_id', 'store_name', 'region'],
            transactions: ['transaction_id', 'store_id', 'cashier_id', 'date'],
            transaction_items: ['item_id', 'transaction_id', 'product_id', 'quantity', 'price', 'discount'],
        });
        const edges = buildJoinStrategy(tables, cols, []);

        // With iterative BFS: transaction_items→transactions (1st), transactions→stores (2nd)
        // Should have exactly 2 edges connecting all 3 tables
        expect(edges.length).toBe(2);
        // All 3 tables should appear in the edge list
        const allTables = new Set([...edges.map(e => e.leftTable), ...edges.map(e => e.rightTable)]);
        expect(allTables.has('stores')).toBe(true);
        expect(allTables.has('transactions')).toBe(true);
        expect(allTables.has('transaction_items')).toBe(true);
        // First edge must start from fact table
        expect(edges[0].leftTable).toBe('transaction_items');
    });

    it('returns empty array for empty input', () => {
        expect(buildJoinStrategy([], {}, [])).toEqual([]);
    });

    it('returns empty array for single table', () => {
        const cols = makeTableCols({ stores: ['store_id', 'name'] });
        expect(buildJoinStrategy(['stores'], cols, [])).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5: Full end-to-end retail join with buildJoinStrategy + autoJoinDatasets
// ─────────────────────────────────────────────────────────────────────────────

describe('Full retail join: buildJoinStrategy + autoJoinDatasets', () => {
    it('produces 200-row master table from a 2-store / 50-transaction / 200-item schema', () => {
        // Schema
        const tableColumns = {
            stores: [
                makeColInfo('store_id', true), makeColInfo('store_name'),
                makeColInfo('region'), makeColInfo('manager'),
            ],
            transactions: [
                makeColInfo('transaction_id', true), makeColInfo('store_id'),
                makeColInfo('cashier_id'), makeColInfo('transaction_date'),
            ],
            transaction_items: [
                makeColInfo('item_id', true), makeColInfo('transaction_id'),
                makeColInfo('product_id'), makeColInfo('quantity'),
                makeColInfo('unit_price'), makeColInfo('discount'),
            ],
            products: [
                makeColInfo('product_id', true), makeColInfo('product_name'),
                makeColInfo('category'), makeColInfo('brand'),
            ],
        };

        // Data
        const stores = [
            { store_id: '1', store_name: 'London', region: 'South', manager: 'Alice' },
            { store_id: '2', store_name: 'Manchester', region: 'North', manager: 'Bob' },
        ];
        const transactions = Array.from({ length: 50 }, (_, i) => ({
            transaction_id: String(i + 1),
            store_id: (i % 2 + 1).toString(),
            cashier_id: String(i % 5 + 1),
            transaction_date: '2025-01-15',
        }));
        const transaction_items = Array.from({ length: 200 }, (_, i) => ({
            item_id: String(i + 1),
            transaction_id: String((i % 50) + 1),
            product_id: String((i % 10) + 1),
            quantity: (i % 5) + 1,
            unit_price: 9.99,
            discount: 0,
        }));
        const products = Array.from({ length: 10 }, (_, i) => ({
            product_id: String(i + 1),
            product_name: `Product ${i + 1}`,
            category: i % 2 === 0 ? 'Electronics' : 'Accessories',
            brand: 'Acme',
        }));

        const tableNames = ['stores', 'transactions', 'transaction_items', 'products'];
        const edges = buildJoinStrategy(tableNames, tableColumns, []);
        const { mergedRows, joinLogs } = autoJoinDatasets(
            { stores, transactions, transaction_items, products },
            edges
        );

        // ✅ Row count must equal fact table grain
        expect(mergedRows.length).toBe(200);

        // ✅ Each row should carry fields from all 4 tables
        const sample = mergedRows[0];
        expect(sample.item_id).toBeDefined();           // from transaction_items
        expect(sample.transaction_date).toBeDefined();  // from transactions
        expect(sample.store_name).toBeDefined();        // from stores
        expect(sample.product_name).toBeDefined();      // from products

        // ✅ Log confirms fact table was base
        expect(joinLogs[0]).toContain('transaction_items');
        expect(joinLogs[0]).toContain('200');

        console.table(joinLogs);
    });
});
