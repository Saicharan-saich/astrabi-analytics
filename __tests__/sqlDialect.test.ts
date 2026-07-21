/**
 * Gold-SQL dialect translation: BIRD/SQLite backtick identifiers → DuckDB.
 * Verified by actually executing the translated SQL in DuckDB (Node harness).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { toDuckDBDialect } from '../services/benchmark/sqlDialect';

describe('toDuckDBDialect', () => {
    it('converts backtick identifiers to double quotes', () => {
        expect(toDuckDBDialect('SELECT `Free Meal Count (K-12)` FROM frpm'))
            .toBe('SELECT "Free Meal Count (K-12)" FROM frpm');
    });
    it('handles table-qualified backticks', () => {
        expect(toDuckDBDialect("WHERE T1.`District Name` = 'x'"))
            .toBe('WHERE T1."District Name" = \'x\'');
    });
    it('leaves backticks inside string literals alone', () => {
        expect(toDuckDBDialect("SELECT '`not an ident`' AS a")).toBe("SELECT '`not an ident`' AS a");
    });
    it('is a no-op for SQL without backticks', () => {
        const sql = 'SELECT a, COUNT(*) FROM t GROUP BY a';
        expect(toDuckDBDialect(sql)).toBe(sql);
    });
});

describe('translated BIRD-style gold executes in DuckDB', () => {
    let duck: DuckHandle;
    beforeAll(async () => { duck = await createDuck(); }, 60000);
    afterAll(() => duck?.close());

    it('runs a backtick query after translation (and would fail before)', () => {
        duck.loadTable('frpm', [
            { 'County Name': 'Alameda', 'Free Meal Count (K-12)': 100, 'Enrollment (K-12)': 200 },
            { 'County Name': 'Alameda', 'Free Meal Count (K-12)': 150, 'Enrollment (K-12)': 200 },
            { 'County Name': 'Fresno', 'Free Meal Count (K-12)': 10, 'Enrollment (K-12)': 100 },
        ]);
        const gold = 'SELECT `Free Meal Count (K-12)` / `Enrollment (K-12)` AS rate FROM frpm ' +
            "WHERE `County Name` = 'Alameda' ORDER BY rate DESC LIMIT 1";
        // Raw backtick SQL throws; the translated form runs.
        expect(() => duck.query(gold)).toThrow();
        const rows = duck.query(toDuckDBDialect(gold));
        expect(Number(rows[0].rate)).toBeCloseTo(0.75, 5);
    });
});
