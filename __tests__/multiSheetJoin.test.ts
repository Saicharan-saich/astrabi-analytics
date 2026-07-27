/**
 * End-to-end multi-sheet join correctness.
 *
 * A workbook carries no foreign keys, so relationships must be inferred. The
 * old path marked a column as a primary key when its NAME ended in "id" and it
 * happened to be first, then matched sheets on column names. That marks
 * orders.customer_id — which repeats — as a key, and joins sheets that merely
 * share a name.
 *
 * These tests run the real path (discover → edges → autoJoinDatasets) and check
 * the merged data itself: correct attribution, and above all no inflated totals.
 */
import { describe, it, expect } from 'vitest';
import { discoverRelationships, detectCandidateKeys } from '../services/ai-sql/relationshipDiscovery';
import { autoJoinDatasets } from '../services/analysisEngine';

const SHEETS: Record<string, any[]> = {
    customers: [
        { customer_id: 1, customer_name: 'Jane', city: 'London' },
        { customer_id: 2, customer_name: 'John', city: 'Leeds' },
        { customer_id: 3, customer_name: 'Amir', city: 'London' },
    ],
    orders: [
        { order_id: 100, customer_id: 1, total: 20 },
        { order_id: 101, customer_id: 2, total: 35 },
        { order_id: 102, customer_id: 1, total: 12 },
        { order_id: 103, customer_id: 3, total: 44 },
        { order_id: 104, customer_id: 2, total: 19 },
    ],
};

const GRAND_TOTAL = 20 + 35 + 12 + 44 + 19;   // 130

/** The worker's path: infer relationships, turn them into join edges. */
function edgesFor(sheets: Record<string, any[]>) {
    const tables = Object.entries(sheets).map(([name, rows]) => ({ name, rows }));
    const { relationships } = discoverRelationships(tables);
    return relationships.map(r => ({
        leftTable: r.fromTable, leftColumn: r.fromColumn,
        rightTable: r.toTable, rightColumn: r.toColumn,
        type: 'fk' as const,
    }));
}

describe('key detection on real sheet data', () => {
    it('marks the dimension key as a key', () => {
        const k = detectCandidateKeys({ name: 'customers', rows: SHEETS.customers });
        expect(k.find(x => x.column === 'customer_id')!.isKey).toBe(true);
    });

    it('does NOT mark the fact table\'s foreign key as a key', () => {
        // The old name+position rule marked this as a PK. It repeats, so it isn't.
        const k = detectCandidateKeys({ name: 'orders', rows: SHEETS.orders });
        expect(k.find(x => x.column === 'customer_id')!.isKey).toBe(false);
        expect(k.find(x => x.column === 'order_id')!.isKey).toBe(true);
    });
});

describe('joining two related sheets', () => {
    const edges = edgesFor(SHEETS);

    it('infers exactly one relationship, in the right direction', () => {
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({
            leftTable: 'orders', leftColumn: 'customer_id',
            rightTable: 'customers', rightColumn: 'customer_id',
        });
    });

    it('keeps one row per order — no fan-out', () => {
        const { mergedRows } = autoJoinDatasets(SHEETS, edges as any);
        expect(mergedRows).toHaveLength(SHEETS.orders.length);
    });

    it('does not inflate the total — the whole point of getting joins right', () => {
        const { mergedRows } = autoJoinDatasets(SHEETS, edges as any);
        const sum = mergedRows.reduce((a: number, r: any) => a + (Number(r.total) || 0), 0);
        expect(sum).toBe(GRAND_TOTAL);
    });

    it('attaches the correct customer to each order', () => {
        const { mergedRows } = autoJoinDatasets(SHEETS, edges as any);
        const byOrder = new Map(mergedRows.map((r: any) => [r.order_id, r]));
        expect(byOrder.get(100)?.customer_name).toBe('Jane');
        expect(byOrder.get(101)?.customer_name).toBe('John');
        expect(byOrder.get(103)?.customer_name).toBe('Amir');
    });
});

describe('sheets that only look related', () => {
    it('refuses to join on a shared column name with unrelated values', () => {
        const unrelated: Record<string, any[]> = {
            products: [{ id: 'P1', label: 'Widget' }, { id: 'P2', label: 'Gadget' }, { id: 'P3', label: 'Cable' }],
            regions: [{ id: 'R1', label: 'North' }, { id: 'R2', label: 'South' }, { id: 'R3', label: 'East' }],
        };
        // Both sheets have `id` and `label`; none of the values overlap.
        expect(edgesFor(unrelated)).toHaveLength(0);
    });

    it('refuses a partial overlap rather than dropping unmatched rows', () => {
        const partial: Record<string, any[]> = {
            customers: SHEETS.customers,
            visits: [
                { visit_id: 1, customer_id: 1 },
                { visit_id: 2, customer_id: 999 },
                { visit_id: 3, customer_id: 998 },
                { visit_id: 4, customer_id: 997 },
            ],
        };
        expect(edgesFor(partial)).toHaveLength(0);
    });
});

describe('a single sheet needs no join at all', () => {
    it('passes one sheet straight through', () => {
        const { mergedRows } = autoJoinDatasets({ orders: SHEETS.orders }, [] as any);
        expect(mergedRows).toHaveLength(SHEETS.orders.length);
        const sum = mergedRows.reduce((a: number, r: any) => a + (Number(r.total) || 0), 0);
        expect(sum).toBe(GRAND_TOTAL);
    });
});
