/**
 * Queries are fitted to how columns are really stored before they run, so a
 * yes/no column kept as "Yes"/"No" text or 0/1, or a date kept as text, does
 * not make DuckDB refuse the query (and no AI repair is paid for).
 */
import { describe, expect, it } from 'vitest';
import { fitToStoredTypes, type StoredTypes } from '../services/ai-sql/storedTypeFix';

const types: StoredTypes = {
    yesNo: new Map([['sla_met', 'text'], ['reopened', 'number'], ['is_paid', 'boolean']]),
    textDates: new Map([['opened_date', 'DATE'], ['created_at', 'TIMESTAMP']]),
};
const fit = (sql: string) => fitToStoredTypes(sql, types).sql;
const YES = `(LOWER(CAST("sla_met" AS VARCHAR)) IN ('yes','y','true','t','1'))`;

describe('yes/no columns', () => {
    it('the query from the bug report runs', () => {
        expect(fit('SELECT ROUND(100.0 * COUNT_IF("sla_met") / COUNT(*), 1) AS sla_met_rate_pct FROM "data"'))
            .toBe(`SELECT ROUND(100.0 * COUNT_IF(${YES}) / COUNT(*), 1) AS sla_met_rate_pct FROM "data"`);
    });

    it('as a condition, negated, compared with TRUE/FALSE, cast or averaged', () => {
        expect(fit('SELECT COUNT(*) FROM "data" WHERE "sla_met" AND "channel" = \'Email\'')).toBe(`SELECT COUNT(*) FROM "data" WHERE ${YES} AND "channel" = 'Email'`);
        expect(fit('SELECT COUNT(*) FROM "data" WHERE NOT "sla_met"')).toBe(`SELECT COUNT(*) FROM "data" WHERE NOT ${YES}`);
        expect(fit('SELECT COUNT(*) FROM "data" WHERE "sla_met" = FALSE')).toBe(`SELECT COUNT(*) FROM "data" WHERE NOT ${YES}`);
        expect(fit('SELECT COUNT(*) FROM "data" WHERE "sla_met" IS TRUE')).toBe(`SELECT COUNT(*) FROM "data" WHERE ${YES}`);
        expect(fit('SELECT AVG(CAST("sla_met" AS INTEGER)) FROM "data"')).toBe(`SELECT AVG(CAST(${YES} AS INTEGER)) FROM "data"`);
        expect(fit('SELECT AVG("sla_met"::DOUBLE) FROM "data"')).toBe(`SELECT AVG(${YES}::DOUBLE) FROM "data"`);
        expect(fit('SELECT SUM("sla_met") FROM "data"')).toBe(`SELECT SUM(CAST(${YES} AS INTEGER)) FROM "data"`);
        expect(fit('SELECT SUM(CASE WHEN "sla_met" THEN 1 ELSE 0 END) FROM "data"')).toBe(`SELECT SUM(CASE WHEN ${YES} THEN 1 ELSE 0 END) FROM "data"`);
        expect(fit('SELECT COUNT(*) FILTER (WHERE d."sla_met") FROM "data" d')).toBe(`SELECT COUNT(*) FILTER (WHERE (LOWER(CAST(d."sla_met" AS VARCHAR)) IN ('yes','y','true','t','1'))) FROM "data" d`);
    });

    it('stored as 0/1 is tested with = 1; real true/false is left alone', () => {
        expect(fit('SELECT COUNT_IF("reopened") FROM "data"')).toBe('SELECT COUNT_IF(("reopened" = 1)) FROM "data"');
        expect(fit('SELECT COUNT_IF("is_paid") FROM "data"')).toBe('SELECT COUNT_IF("is_paid") FROM "data"');
    });

    it('leaves queries that already test the column correctly unchanged', () => {
        for (const sql of [
            `SELECT COUNT_IF(LOWER("sla_met") IN ('yes','y')) FROM "data"`,
            `SELECT "sla_met", COUNT(*) FROM "data" GROUP BY "sla_met"`,
            `SELECT COUNT(*) FROM "data" WHERE "sla_met" = 'Yes'`,
            `SELECT AVG(CASE WHEN LOWER("sla_met") = 'yes' THEN 1 ELSE 0 END) FROM "data"`,
        ]) expect(fitToStoredTypes(sql, types)).toEqual({ sql, adjusted: [] });
    });
});

describe('dates stored as text', () => {
    it('are converted before date maths', () => {
        expect(fit(`SELECT DATE_TRUNC('month', "opened_date") AS m, COUNT(*) FROM "data" GROUP BY 1`)).toBe(`SELECT DATE_TRUNC('month', CAST("opened_date" AS DATE)) AS m, COUNT(*) FROM "data" GROUP BY 1`);
        expect(fit(`SELECT YEAR("opened_date") FROM "data"`)).toBe(`SELECT YEAR(CAST("opened_date" AS DATE)) FROM "data"`);
        expect(fit(`SELECT STRFTIME("opened_date", '%Y-%m') FROM "data"`)).toBe(`SELECT STRFTIME(CAST("opened_date" AS DATE), '%Y-%m') FROM "data"`);
        expect(fit(`SELECT EXTRACT(MONTH FROM "opened_date") FROM "data"`)).toBe(`SELECT EXTRACT(MONTH FROM CAST("opened_date" AS DATE)) FROM "data"`);
        expect(fit(`SELECT * FROM "data" WHERE "opened_date" >= DATE '2025-01-01'`)).toBe(`SELECT * FROM "data" WHERE CAST("opened_date" AS DATE) >= DATE '2025-01-01'`);
        expect(fit(`SELECT * FROM "data" WHERE "opened_date" > CURRENT_DATE - INTERVAL 30 DAY`)).toBe(`SELECT * FROM "data" WHERE CAST("opened_date" AS DATE) > CURRENT_DATE - INTERVAL 30 DAY`);
        expect(fit(`SELECT HOUR("created_at") FROM "data"`)).toBe(`SELECT HOUR(CAST("created_at" AS TIMESTAMP)) FROM "data"`);
        expect(fit(`SELECT DATE_DIFF('day', "opened_date", "opened_date" + INTERVAL 1 DAY) FROM "data"`)).toBe(`SELECT DATE_DIFF('day', CAST("opened_date" AS DATE), CAST("opened_date" AS DATE) + INTERVAL 1 DAY) FROM "data"`);
    });

    it('leaves already-converted dates and plain text comparisons alone', () => {
        for (const sql of [
            `SELECT DATE_TRUNC('month', CAST("opened_date" AS DATE)) FROM "data"`,
            `SELECT YEAR("opened_date"::DATE) FROM "data"`,
            `SELECT * FROM "data" WHERE "opened_date" >= '2025-01-01'`,
            `SELECT MIN("opened_date"), MAX("opened_date") FROM "data"`,
        ]) expect(fitToStoredTypes(sql, types).sql).toBe(sql);
    });
});
