/**
 * The rate queries the AI is taught for records data run on DuckDB with
 * yes/no columns stored as BOOLEAN (as the app now loads them).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { duckColumnType } from '../utils/duckColumnType';

const ROWS = Array.from({ length: 200 }, (_, i) => ({
    appointment_id: 1000 + i,
    patient_id: 10 + (i % 120),
    neighbourhood: i % 2 ? 'Centro' : 'Praia',
    sms_received: i % 3 === 0,
    showed_up: i % 5 !== 0,
    date_diff: i % 30,
}));

let duck: DuckHandle;
beforeAll(async () => {
    duck = await createDuck();
    duck.loadTable('data', ROWS);
}, 60000);
afterAll(() => duck?.close());

describe('rate queries on yes/no columns', () => {
    it('loads true/false as BOOLEAN', () => {
        expect(duckColumnType(ROWS, 'showed_up')).toBe('BOOLEAN');
    });

    it('works out a rate with COUNT_IF and keeps the count beside it', () => {
        const rows = duck.query(`SELECT "neighbourhood", COUNT(*) AS appointments, ROUND(100.0 * COUNT_IF(NOT "showed_up") / COUNT(*), 1) AS no_show_rate_pct FROM "data" GROUP BY "neighbourhood" HAVING COUNT(*) >= 30 ORDER BY no_show_rate_pct DESC`);
        expect(rows).toHaveLength(2);
        const total = rows.reduce((s: number, r: any) => s + Number(r.appointments), 0);
        expect(total).toBe(200);
        for (const r of rows) expect(Number(r.no_show_rate_pct)).toBe(20);
    });

    it('filters on a yes/no directly and counts distinct patients', () => {
        const [row] = duck.query(`SELECT COUNT(DISTINCT "patient_id") AS patients, COUNT_IF("sms_received") AS with_sms FROM "data" WHERE "sms_received"`);
        expect(Number(row.with_sms)).toBe(67);
        expect(Number(row.patients)).toBeGreaterThan(0);
    });
});
