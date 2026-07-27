/**
 * Join engine — which tables a question needs, and how to connect them.
 *
 * The dangerous case is fan-out: joining a fact table to something that has
 * many rows per fact row duplicates the fact rows, so a later SUM() silently
 * returns an inflated number. That must be detected, not discovered later.
 */
import { describe, it, expect } from 'vitest';
import {
    findTablesForColumn,
    resolveRequiredTables,
    planJoins,
    compileJoinClause,
    planJoinsForColumns,
    fromSourceSchema,
    describeSchemaForLLM,
    discoverJoinContext,
    type JoinTable,
    type JoinLink,
} from '../services/ai-sql/joinEngine';

// A small retail schema: orders (fact) → customers, products; plus a bridge.
const TABLES: JoinTable[] = [
    {
        name: 'orders', rowCount: 5000, columns: [
            { name: 'order_id', isPK: true }, { name: 'customer_id' }, { name: 'product_id' },
            { name: 'order_date' }, { name: 'quantity' }, { name: 'total_price' },
        ],
    },
    {
        name: 'customers', rowCount: 800, columns: [
            { name: 'customer_id', isPK: true }, { name: 'customer_name' }, { name: 'city' }, { name: 'segment' },
        ],
    },
    {
        name: 'products', rowCount: 120, columns: [
            { name: 'product_id', isPK: true }, { name: 'product_name' }, { name: 'category' }, { name: 'unit_cost' },
        ],
    },
    {
        name: 'reviews', rowCount: 9000, columns: [
            { name: 'review_id', isPK: true }, { name: 'product_id' }, { name: 'rating' }, { name: 'comment' },
        ],
    },
];

const LINKS: JoinLink[] = [
    { leftTable: 'orders', leftColumn: 'customer_id', rightTable: 'customers', rightColumn: 'customer_id', type: 'fk' },
    { leftTable: 'orders', leftColumn: 'product_id', rightTable: 'products', rightColumn: 'product_id', type: 'fk' },
    { leftTable: 'reviews', leftColumn: 'product_id', rightTable: 'products', rightColumn: 'product_id', type: 'fk' },
];

describe('findTablesForColumn', () => {
    it('locates a column, case-insensitively', () => {
        expect(findTablesForColumn('customer_name', TABLES)).toEqual(['customers']);
        expect(findTablesForColumn('TOTAL_PRICE', TABLES)).toEqual(['orders']);
    });

    it('reports every table when a column name is shared', () => {
        expect(findTablesForColumn('product_id', TABLES).sort()).toEqual(['orders', 'products', 'reviews']);
    });

    it('returns nothing for an unknown column', () => {
        expect(findTablesForColumn('nope', TABLES)).toEqual([]);
    });
});

describe('resolveRequiredTables', () => {
    it('maps unambiguous columns onto their tables', () => {
        const r = resolveRequiredTables(['total_price', 'customer_name'], TABLES);
        expect(r.tables.sort()).toEqual(['customers', 'orders']);
        expect(r.missing).toEqual([]);
        expect(Object.keys(r.ambiguous)).toEqual([]);
    });

    it('flags a shared column rather than silently picking one', () => {
        const r = resolveRequiredTables(['product_id'], TABLES);
        expect(r.tables).toEqual([]);
        expect(r.ambiguous.product_id.sort()).toEqual(['orders', 'products', 'reviews']);
    });

    it('settles ambiguity when one candidate is already required', () => {
        // total_price pins `orders`, which resolves product_id.
        const r = resolveRequiredTables(['total_price', 'product_id'], TABLES);
        expect(r.tables).toEqual(['orders']);
        expect(r.ambiguous.product_id).toBeUndefined();
    });

    it('reports columns that exist nowhere', () => {
        expect(resolveRequiredTables(['made_up'], TABLES).missing).toEqual(['made_up']);
    });
});

describe('planJoins', () => {
    it('picks the largest required table as the base (the fact table)', () => {
        const plan = planJoins(['customers', 'orders'], TABLES, LINKS);
        expect(plan.baseTable).toBe('orders');   // 5000 rows vs 800
    });

    it('joins a dimension without fan-out — the key is a PK', () => {
        const plan = planJoins(['orders', 'customers'], TABLES, LINKS);
        expect(plan.steps).toHaveLength(1);
        expect(plan.steps[0]).toMatchObject({ table: 'customers', toTable: 'orders', fansOut: false });
        expect(plan.fanOutWarnings).toEqual([]);
    });

    it('treats a dimension join as safe even when the dimension is the smaller table', () => {
        // reviews (9000) is the fact here, so it becomes the base and products
        // joins on its PK — one product per review, no duplication.
        const plan = planJoins(['products', 'reviews'], TABLES, LINKS);
        expect(plan.baseTable).toBe('reviews');
        expect(plan.steps.find(s => s.table === 'products')!.fansOut).toBe(false);
        expect(plan.fanOutWarnings).toEqual([]);
    });

    it('DETECTS fan-out when the joined key is not unique', () => {
        // Force products as the base. reviews.product_id is not a PK, so one
        // product matches many reviews — rows multiply and SUMs inflate.
        const plan = planJoins(['products', 'reviews'], TABLES, LINKS, { baseTable: 'products' });
        const step = plan.steps.find(s => s.table === 'reviews')!;
        expect(step.fansOut).toBe(true);
        expect(plan.fanOutWarnings.join(' ')).toMatch(/not unique/i);
    });

    it('routes through a bridge table when there is no direct link', () => {
        // orders → products → reviews; products is pulled in automatically.
        const plan = planJoins(['orders', 'reviews'], TABLES, LINKS);
        expect(plan.tablesUsed.sort()).toEqual(['orders', 'products', 'reviews']);
        expect(plan.unreachable).toEqual([]);
    });

    it('always attaches each step to a table already in the plan', () => {
        const plan = planJoins(['orders', 'reviews', 'customers'], TABLES, LINKS);
        const seen = new Set([plan.baseTable]);
        for (const s of plan.steps) {
            expect(seen.has(s.toTable), `${s.table} attached to un-joined ${s.toTable}`).toBe(true);
            seen.add(s.table);
        }
    });

    it('reports a table that no link can reach', () => {
        const orphan: JoinTable = { name: 'weather', rowCount: 300, columns: [{ name: 'temp' }] };
        const plan = planJoins(['orders', 'weather'], [...TABLES, orphan], LINKS);
        expect(plan.unreachable).toEqual(['weather']);
    });

    it('handles a single table with nothing to join', () => {
        const plan = planJoins(['orders'], TABLES, LINKS);
        expect(plan.baseTable).toBe('orders');
        expect(plan.steps).toEqual([]);
    });

    it('honours an explicitly chosen base table', () => {
        expect(planJoins(['orders', 'customers'], TABLES, LINKS, { baseTable: 'customers' }).baseTable).toBe('customers');
    });
});

describe('compileJoinClause', () => {
    it('emits a quoted FROM/LEFT JOIN clause', () => {
        const sql = compileJoinClause(planJoins(['orders', 'customers'], TABLES, LINKS));
        expect(sql).toContain('FROM "orders"');
        expect(sql).toContain('LEFT JOIN "customers" ON "orders"."customer_id" = "customers"."customer_id"');
    });

    it('emits nothing when there is no plan', () => {
        expect(compileJoinClause(planJoins([], TABLES, LINKS))).toBe('');
    });
});

describe('planJoinsForColumns — end to end', () => {
    it('goes from question columns to a join clause', () => {
        // "revenue by customer city"
        const { plan, sql, resolution } = planJoinsForColumns(['total_price', 'city'], TABLES, LINKS);
        expect(resolution.tables.sort()).toEqual(['customers', 'orders']);
        expect(plan.baseTable).toBe('orders');
        expect(sql).toContain('LEFT JOIN "customers"');
        expect(plan.fanOutWarnings).toEqual([]);
    });

    it('joins reviews to their product without warning — one product per review', () => {
        // "average rating by product category" — reviews is the grain.
        const { plan } = planJoinsForColumns(['category', 'rating'], TABLES, LINKS);
        expect(plan.tablesUsed.sort()).toEqual(['products', 'reviews']);
        expect(plan.fanOutWarnings).toEqual([]);
    });

    it('warns on a classic fan trap — two facts joined through a shared dimension', () => {
        // "revenue and rating" spans orders AND reviews, connected only via
        // products. Every order pairs with every review of that product, so any
        // SUM(total_price) would be wildly inflated. This must be flagged.
        const { plan } = planJoinsForColumns(['total_price', 'rating'], TABLES, LINKS);
        expect(plan.tablesUsed.sort()).toEqual(['orders', 'products', 'reviews']);
        expect(plan.fanOutWarnings.length).toBeGreaterThan(0);
        expect(plan.fanOutWarnings.join(' ')).toMatch(/orders/);
    });
});

describe('fromSourceSchema + describeSchemaForLLM', () => {
    const source = {
        tables: [
            { name: 'orders', rows: 5000, columns: [{ name: 'order_id', isPK: true }, { name: 'customer_id', isPK: false }] },
            { name: 'customers', rows: 800, columns: [{ name: 'customer_id', isPK: true }, { name: 'city', isPK: false }] },
        ],
        joinEdges: [{ leftTable: 'orders', rightTable: 'customers', leftColumn: 'customer_id', rightColumn: 'customer_id', type: 'fk' }],
    };

    it('adapts a connector schema into planner input', () => {
        const { tables, links } = fromSourceSchema(source);
        const plan = planJoins(['orders', 'customers'], tables, links);
        expect(plan.baseTable).toBe('orders');
        expect(plan.steps[0].fansOut).toBe(false);
    });

    it('describes tables, PKs and relationships for the model — and no row values', () => {
        const { tables, links } = fromSourceSchema(source);
        const text = describeSchemaForLLM(tables, links);
        expect(text).toContain('Table orders (5,000 rows): order_id [PK], customer_id');
        expect(text).toContain('orders.customer_id = customers.customer_id');
        expect(text).toMatch(/double-count/i);
    });

    it('marks an inferred relationship as needing verification', () => {
        const { tables, links } = fromSourceSchema({ ...source, joinEdges: [{ ...source.joinEdges[0], type: 'name_match' }] });
        expect(describeSchemaForLLM(tables, links)).toMatch(/inferred from column names/i);
    });
});

describe('discoverJoinContext — what the model is actually told', () => {
    const relatedTables = [
        {
            name: 'customers', rows: [
                { customer_id: 1, customer_name: 'Jane', city: 'London' },
                { customer_id: 2, customer_name: 'John', city: 'Leeds' },
                { customer_id: 3, customer_name: 'Amir', city: 'London' },
            ],
        },
        {
            name: 'orders', rows: [
                { order_id: 10, customer_id: 1, total: 20 },
                { order_id: 11, customer_id: 2, total: 35 },
                { order_id: 12, customer_id: 1, total: 12 },
                { order_id: 13, customer_id: 3, total: 44 },
            ],
        },
    ];

    it('returns nothing for a single-table dataset', () => {
        expect(discoverJoinContext(undefined, undefined)).toBeNull();
        expect(discoverJoinContext([relatedTables[0]], undefined)).toBeNull();
    });

    it('infers keys and relationships when no schema was declared', () => {
        const ctx = discoverJoinContext(relatedTables, undefined)!;
        expect(ctx.tableNames.sort()).toEqual(['customers', 'orders']);
        // customer_id is a key on customers but NOT on orders, where it repeats.
        const customers = ctx.tables.find(t => t.name === 'customers')!;
        const orders = ctx.tables.find(t => t.name === 'orders')!;
        expect(customers.columns.find(c => c.name === 'customer_id')!.isPK).toBe(true);
        expect(orders.columns.find(c => c.name === 'customer_id')!.isPK).toBe(false);
        // And the relationship points from the fact to the dimension.
        expect(ctx.links).toHaveLength(1);
        expect(ctx.links[0]).toMatchObject({ leftTable: 'orders', rightTable: 'customers' });
    });

    it('prefers a declared schema over inference when one exists', () => {
        const ctx = discoverJoinContext(relatedTables, {
            tables: [
                { name: 'customers', rows: 3, columns: [{ name: 'customer_id', isPK: true }] },
                { name: 'orders', rows: 4, columns: [{ name: 'order_id', isPK: true }, { name: 'customer_id', isPK: false }] },
            ],
            joinEdges: [{ leftTable: 'orders', rightTable: 'customers', leftColumn: 'customer_id', rightColumn: 'customer_id', type: 'fk' }],
        })!;
        expect(ctx.links[0].type).toBe('fk');
        expect(ctx.description).toContain('orders.customer_id = customers.customer_id');
    });

    it('the description names the tables and warns about double-counting', () => {
        const ctx = discoverJoinContext(relatedTables, undefined)!;
        expect(ctx.description).toContain('Table orders');
        expect(ctx.description).toContain('Table customers');
        expect(ctx.description).toMatch(/double-count/i);
    });

    it('a plan built from the inferred context has no fan-out', () => {
        const ctx = discoverJoinContext(relatedTables, undefined)!;
        const plan = planJoins(['orders', 'customers'], ctx.tables, ctx.links);
        expect(plan.baseTable).toBe('orders');
        expect(plan.fanOutWarnings).toEqual([]);
    });
});
