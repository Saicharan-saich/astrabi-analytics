/**
 * Relationship discovery — inferring joins from evidence rather than names.
 *
 * The failure this prevents: two sheets that both happen to have an `id`
 * column get joined because the names match, producing a silently wrong
 * answer. A join is only proposed when the parent side is a real key and the
 * child's values are genuinely contained in it.
 */
import { describe, it, expect } from 'vitest';
import { detectCandidateKeys, discoverRelationships, type DiscoveryTable } from '../services/ai-sql/relationshipDiscovery';

const customers: DiscoveryTable = {
    name: 'customers',
    rows: [
        { customer_id: 1, name: 'Jane', city: 'London' },
        { customer_id: 2, name: 'John', city: 'Leeds' },
        { customer_id: 3, name: 'Amir', city: 'London' },
        { customer_id: 4, name: 'Mei', city: 'Hull' },
    ],
};

const orders: DiscoveryTable = {
    name: 'orders',
    rows: [
        { order_id: 100, customer_id: 1, total: 20 },
        { order_id: 101, customer_id: 2, total: 35 },
        { order_id: 102, customer_id: 1, total: 12 },
        { order_id: 103, customer_id: 3, total: 44 },
        { order_id: 104, customer_id: 4, total: 8 },
        { order_id: 105, customer_id: 2, total: 19 },
    ],
};

describe('detectCandidateKeys', () => {
    it('accepts a unique, non-null column as a key', () => {
        const k = detectCandidateKeys(customers).find(x => x.column === 'customer_id')!;
        expect(k.isKey).toBe(true);
        expect(k.distinctCount).toBe(4);
    });

    it('rejects a repeating column', () => {
        const k = detectCandidateKeys(customers).find(x => x.column === 'city')!;
        expect(k.isKey).toBe(false);
        expect(k.reason).toMatch(/repeat|not unique/i);
    });

    it('rejects a column containing blanks', () => {
        const t: DiscoveryTable = { name: 't', rows: [{ id: 1 }, { id: null }, { id: 3 }, { id: 4 }] };
        const k = detectCandidateKeys(t).find(x => x.column === 'id')!;
        expect(k.isKey).toBe(false);
        expect(k.reason).toMatch(/blank/i);
    });

    it('rejects a near-constant column even though it is technically unique', () => {
        const t: DiscoveryTable = { name: 't', rows: [{ flag: 'Y' }, { flag: 'N' }] };
        expect(detectCandidateKeys(t).find(x => x.column === 'flag')!.isKey).toBe(false);
    });
});

describe('discoverRelationships', () => {
    it('finds the real many-to-one relationship', () => {
        const { relationships } = discoverRelationships([customers, orders]);
        const r = relationships.find(x => x.fromTable === 'orders' && x.fromColumn === 'customer_id')!;
        expect(r).toBeDefined();
        expect(r.toTable).toBe('customers');
        expect(r.toColumn).toBe('customer_id');
        expect(r.coverage).toBe(1);
        expect(r.cardinality).toBe('many-to-one');
        expect(r.confidence).toBeGreaterThan(0.8);
    });

    it('never proposes the fact table as the parent of a dimension', () => {
        // orders.order_id is a key too, but customers has no column contained in it.
        const { relationships } = discoverRelationships([customers, orders]);
        expect(relationships.some(r => r.fromTable === 'customers' && r.toTable === 'orders')).toBe(false);
    });

    it('does NOT join two sheets just because a column name matches', () => {
        // Both have `code`, but the values are unrelated — no containment.
        const a: DiscoveryTable = { name: 'a', rows: [{ code: 'AAA' }, { code: 'BBB' }, { code: 'CCC' }, { code: 'DDD' }] };
        const b: DiscoveryTable = { name: 'b', rows: [{ code: 'XXX' }, { code: 'YYY' }, { code: 'ZZZ' }, { code: 'WWW' }] };
        const { relationships } = discoverRelationships([a, b]);
        expect(relationships).toEqual([]);
    });

    it('refuses a partial overlap and explains why', () => {
        // Half of these ids do not exist in customers — not a reliable join.
        const partial: DiscoveryTable = {
            name: 'partial',
            rows: [{ customer_id: 1 }, { customer_id: 2 }, { customer_id: 900 }, { customer_id: 901 }],
        };
        const { relationships, rejected } = discoverRelationships([customers, partial]);
        expect(relationships.some(r => r.fromTable === 'partial')).toBe(false);
        expect(rejected.some(r => /not a reliable relationship/i.test(r.reason))).toBe(true);
    });

    it('does not match a number column to an unrelated text column', () => {
        const t: DiscoveryTable = { name: 'codes', rows: [{ ref: 'a1' }, { ref: 'b2' }, { ref: 'c3' }, { ref: 'd4' }] };
        const { relationships } = discoverRelationships([customers, t]);
        expect(relationships.some(r => r.toColumn === 'customer_id' && r.fromTable === 'codes')).toBe(false);
    });

    it('matches across a type boundary when the values really are the same', () => {
        // A sheet stores the id as text; the values still line up exactly.
        const asText: DiscoveryTable = {
            name: 'notes',
            rows: [{ customer_id: '1', note: 'x' }, { customer_id: '2', note: 'y' }, { customer_id: '3', note: 'z' }],
        };
        const { relationships } = discoverRelationships([customers, asText]);
        expect(relationships.some(r => r.fromTable === 'notes' && r.toTable === 'customers')).toBe(true);
    });

    it('identifies a one-to-one relationship distinctly', () => {
        const profile: DiscoveryTable = {
            name: 'profiles',
            rows: [{ customer_id: 1, tier: 'Gold' }, { customer_id: 2, tier: 'Silver' }, { customer_id: 3, tier: 'Gold' }],
        };
        const r = discoverRelationships([customers, profile]).relationships
            .find(x => x.fromTable === 'profiles')!;
        expect(r.cardinality).toBe('one-to-one');
    });

    it('keeps only the strongest parent per child column', () => {
        // customer_id could match two key columns; only one survives.
        const twin: DiscoveryTable = {
            name: 'twin',
            rows: [{ customer_id: 1 }, { customer_id: 2 }, { customer_id: 3 }, { customer_id: 4 }],
        };
        const other: DiscoveryTable = {
            name: 'lookup',
            rows: [{ ref_id: 1 }, { ref_id: 2 }, { ref_id: 3 }, { ref_id: 4 }],
        };
        const { relationships } = discoverRelationships([customers, other, twin]);
        const forTwin = relationships.filter(r => r.fromTable === 'twin' && r.fromColumn === 'customer_id');
        expect(forTwin).toHaveLength(1);
        // Name agreement breaks the tie toward customers.customer_id.
        expect(forTwin[0].toTable).toBe('customers');
    });

    it('carries human-readable evidence for every relationship', () => {
        const r = discoverRelationships([customers, orders]).relationships[0];
        expect(r.evidence.join(' ')).toMatch(/values found in/);
        expect(r.evidence.join(' ')).toMatch(/unique and non-null/);
    });

    it('handles empty and single-table inputs safely', () => {
        expect(discoverRelationships([]).relationships).toEqual([]);
        expect(discoverRelationships([{ name: 'empty', rows: [] }]).relationships).toEqual([]);
        expect(discoverRelationships([customers]).relationships).toEqual([]);
    });
});
