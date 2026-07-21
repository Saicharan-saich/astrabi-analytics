/**
 * Contribution / mix-shift knob: for a categorical dimension over two periods,
 * the per-segment delta that drove the total change. Deterministic, end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan } from '../services/ai-sql/types';

// April (previous) vs May (current):
//   Delivery: 100 → 150 (+50) ; Dine-In: 50 → 40 (-10) ; Online: 0 → 30 (+30)
const ROWS = [
    { order_id: 1, channel: 'Delivery', order_date: '2024-04-10', sales: 100 },
    { order_id: 2, channel: 'Dine-In', order_date: '2024-04-12', sales: 50 },
    { order_id: 3, channel: 'Delivery', order_date: '2024-05-05', sales: 150 },
    { order_id: 4, channel: 'Dine-In', order_date: '2024-05-06', sales: 40 },
    { order_id: 5, channel: 'Online', order_date: '2024-05-07', sales: 30 },
];

let duck: DuckHandle, model: any;
beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(ROWS, 'orders.csv');
    model = buildSemanticModel({ id: 't', name: 'data', rows: etl.rows, columns: etl.columns, totalRows: etl.rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', etl.rows);
}, 60000);
afterAll(() => duck?.close());

const plan = (): AnalysisPlan => ({
    intent: 'total_comparison',
    dimensions: [{ field: 'channel' }],
    metrics: [{ field: 'sales', agg: 'sum' }],
    filters: [{ field: 'order_date', op: 'between', value: ['2024-05-01', '2024-05-31'] }],
    sort: [], limit: null, ambiguous: false, resultGrain: '', originalQuestion: 'what drove the change in sales by channel',
    comparison: { type: 'previous_period', mode: 'total' },
});

describe('contribution / mix-shift', () => {
    it('per-segment current, previous and contribution, ranked', () => {
        const rows = duck.query(normalizeSQLForDuckDB(correctSQL(plan(), model)));
        const by: Record<string, { cur: number; prev: number; contrib: number }> = {};
        for (const r of rows) by[String(r.channel).toLowerCase()] = {
            cur: Number(r.current_value), prev: Number(r.previous_value), contrib: Number(r.contribution),
        };
        expect(by['delivery']).toEqual({ cur: 150, prev: 100, contrib: 50 });
        expect(by['dine-in']).toEqual({ cur: 40, prev: 50, contrib: -10 });
        expect(by['online']).toEqual({ cur: 30, prev: 0, contrib: 30 });
        // Ranked by contribution DESC: Delivery (+50) first, Dine-In (-10) last.
        expect(String(rows[0].channel).toLowerCase()).toBe('delivery');
        expect(String(rows[rows.length - 1].channel).toLowerCase()).toBe('dine-in');
    });
});
