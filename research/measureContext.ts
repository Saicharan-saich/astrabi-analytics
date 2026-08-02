/**
 * Context-size measurement harness for the Hybrid Analytics Planning paper.
 * Reproduces Tables 1–3 of docs/hybrid-analytics-planning.md.
 *
 *   npx vite-node research/measureContext.ts
 *
 * The generator is deterministic, so the numbers are reproducible. Token counts
 * are ESTIMATED at 4 characters per token — the paper's protocol (§9.5) replaces
 * these with exact provider `usage` counts, which the pipeline already captures.
 */
import { readFileSync } from 'fs';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel, serializeSemanticModel } from '../services/ai-sql/semanticLayer';
import { serializeSchema } from '../services/ai-sql/schemaSerializer';

const estTokens = (s: string) => Math.ceil(s.length / 4);

const REGIONS = ['North', 'South', 'East', 'West', 'Central'];
const CATEGORIES = ['Beverages', 'Bakery', 'Dairy', 'Produce', 'Frozen', 'Snacks'];
const PRODUCTS = ['Coffee', 'Tea', 'Juice', 'Bread', 'Croissant', 'Milk',
    'Cheese', 'Apples', 'Bananas', 'Pizza', 'Crisps', 'Chocolate'];
const CHANNELS = ['In-store', 'Online', 'Delivery'];
const PAYMENTS = ['Card', 'Cash', 'Voucher'];

/** 14 columns: identifiers, person names, email, categoricals, numerics, ordinal, date. */
function makeRows(n: number): Record<string, any>[] {
    const rows: Record<string, any>[] = [];
    for (let i = 0; i < n; i++) {
        const d = new Date(2024, 0, 1 + (i % 730));
        const qty = 1 + (i % 9);
        const price = Math.round((2 + (i % 40) * 0.37) * 100) / 100;
        rows.push({
            OrderID: 100000 + i,
            OrderDate: d.toISOString().slice(0, 10),
            CustomerName: `Customer ${i % 4000}`,
            CustomerEmail: `user${i % 4000}@example.com`,
            Region: REGIONS[i % REGIONS.length],
            Category: CATEGORIES[i % CATEGORIES.length],
            Product: PRODUCTS[i % PRODUCTS.length],
            Channel: CHANNELS[i % CHANNELS.length],
            PaymentMethod: PAYMENTS[i % PAYMENTS.length],
            Quantity: qty,
            UnitPrice: price,
            Discount: Math.round((i % 5) * 0.05 * 100) / 100,
            TotalPrice: Math.round(qty * price * 100) / 100,
            Rating: 1 + (i % 5),
        });
    }
    return rows;
}

function modelFor(rows: Record<string, any>[]) {
    const etl = runETLPipeline(rows, 'sales.csv');
    const model = buildSemanticModel({
        id: 'measure', name: 'sales', rows: etl.rows, columns: etl.columns,
        totalRows: etl.rows.length, etlLogs: [], timeContext: etl.timeContext,
    } as any);
    return { etl, model };
}

function table1() {
    console.log('\nTable 1 — Context size against dataset size');
    console.log('rows,semanticModelTokens,directSqlSchemaTokens,fullTableTokens');
    for (const n of [1_000, 10_000, 50_000, 250_000]) {
        const { etl, model } = modelFor(makeRows(n));
        console.log([
            n,
            estTokens(serializeSemanticModel(model)),
            estTokens(serializeSchema([{ name: 'sales', rows: etl.rows.slice(0, 200) }])),
            estTokens(JSON.stringify(etl.rows)),
        ].join(','));
    }
}

function table2() {
    console.log('\nTable 2 — Context size against schema width (10,000 rows)');
    console.log('columns,semanticModelTokens');
    const base = makeRows(10_000);
    for (const keep of [5, 8, 11, 14]) {
        const cols = Object.keys(base[0]).slice(0, keep);
        const rows = base.map(r => Object.fromEntries(cols.map(c => [c, r[c]])));
        console.log(`${keep},${estTokens(serializeSemanticModel(modelFor(rows).model))}`);
    }
}

function table3() {
    console.log('\nTable 3 — HAP against conventional prompt constructions (14 cols, 50,000 rows)');
    const { etl, model } = modelFor(makeRows(50_000));

    // Static instruction blocks, read from source so they cannot drift from the
    // prompts actually shipped.
    const plannerSrc = readFileSync('services/ai-sql/intentPlanner.ts', 'utf8');
    // Take ONLY buildPlannerPrompt's returned template — bounded by `return \`` and
    // the closing `` `; ``. Sweeping every template literal in the rest of the file
    // would fold in unrelated console.log strings and make the figure drift.
    const fnStart = plannerSrc.indexOf('function buildPlannerPrompt');
    const tplStart = plannerSrc.indexOf('return `', fnStart) + 'return `'.length;
    const tplEnd = plannerSrc.indexOf('`;', tplStart);
    const plannerInstructions = plannerSrc.slice(tplStart, tplEnd);
    const directSrc = readFileSync('services/ai-sql/directSqlEngine.ts', 'utf8');
    const directInstructions = (directSrc.match(/const SYSTEM_PROMPT\s*=\s*`[\s\S]*?`/) || [''])[0];

    const semantic = serializeSemanticModel(model);
    const schemaBlock = serializeSchema([{ name: 'sales', rows: etl.rows.slice(0, 200) }]);

    const cols = Object.keys(etl.rows[0]);
    const ddl = `CREATE TABLE sales (\n${cols.map(c => `  ${c} TEXT`).join(',\n')}\n);`;

    const payloads: Record<string, string> = {
        'HAP direct-SQL schema block': schemaBlock,
        'HAP direct-SQL total': directInstructions + schemaBlock,
        'HAP semantic model alone': semantic,
        'HAP planner prompt total': plannerInstructions + semantic,
        'B1: DDL only': ddl,
        'B2: DDL + 3 rows': `${ddl}\n\n${JSON.stringify(etl.rows.slice(0, 3), null, 1)}`,
        'B2: DDL + 20 rows': `${ddl}\n\n${JSON.stringify(etl.rows.slice(0, 20), null, 1)}`,
        'Full table (50k rows)': JSON.stringify(etl.rows),
    };

    const hapPlanner = estTokens(plannerInstructions + semantic);
    console.log('payload,tokens,ratioVsHapPlanner');
    for (const [name, text] of Object.entries(payloads)) {
        const t = estTokens(text);
        console.log(`${name},${t},${(t / hapPlanner).toFixed(2)}`);
    }
}

/**
 * Cost of answering ONE question, before and after the planner became
 * conditional on the direct-SQL engine failing.
 */
function table4() {
    console.log('\nTable 4 — Tokens per question, both engine strategies (14 cols, 50,000 rows)');
    const { etl, model } = modelFor(makeRows(50_000));

    const plannerSrc = readFileSync('services/ai-sql/intentPlanner.ts', 'utf8');
    const fnStart = plannerSrc.indexOf('function buildPlannerPrompt');
    const tplStart = plannerSrc.indexOf('return `', fnStart) + 'return `'.length;
    const plannerInstructions = plannerSrc.slice(tplStart, plannerSrc.indexOf('`;', tplStart));
    const directSrc = readFileSync('services/ai-sql/directSqlEngine.ts', 'utf8');
    const directInstructions = (directSrc.match(/const SYSTEM_PROMPT\s*=\s*`[\s\S]*?`/) || [''])[0];

    const semantic = serializeSemanticModel(model);
    const schemaBlock = serializeSchema([{ name: 'sales', rows: etl.rows.slice(0, 200) }]);

    const planner = estTokens(plannerInstructions + semantic);
    const direct = estTokens(directInstructions + schemaBlock);

    console.log('strategy,tokens');
    console.log(`Always call both (previous),${direct + planner}`);
    console.log(`Planner only on direct-SQL failure — typical question,${direct}`);
    console.log(`Planner only on direct-SQL failure — fallback path,${direct + planner}`);
    console.log(`Saving on the typical question,${(100 * planner / (direct + planner)).toFixed(1)}%`);
}

table1();
table2();
table3();
table4();
