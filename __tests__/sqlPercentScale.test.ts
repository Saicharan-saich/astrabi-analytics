import { describe, expect, it } from 'vitest';
import { percentScaleFromSql, selectItemFor } from '../utils/sqlPercentScale';

describe('percent scale from the SQL that computed it', () => {
    it('finds the select item for an alias, across nested functions', () => {
        const sql = 'SELECT region, ROUND(SUM(returns) * 100.0 / NULLIF(SUM(orders), 0), 2) AS return_rate FROM data GROUP BY region';
        expect(selectItemFor(sql, 'return_rate')).toBe('ROUND(SUM(returns) * 100.0 / NULLIF(SUM(orders), 0), 2)');
    });

    it('reads a rate multiplied by 100 as percent points', () => {
        expect(percentScaleFromSql('SELECT region, ROUND(SUM(r) * 100.0 / SUM(o), 2) AS return_rate FROM data', 'return_rate')).toBe('points');
        expect(percentScaleFromSql('SELECT 100 * SUM(r) / SUM(o) AS "conversion rate" FROM data', 'conversion rate')).toBe('points');
    });

    it('reads a plain ratio as a fraction', () => {
        expect(percentScaleFromSql('SELECT region, SUM(r) / NULLIF(SUM(o), 0) AS return_rate FROM data', 'return_rate')).toBe('fraction');
    });

    it('uses the final select when a CTE defines the same alias', () => {
        const sql = 'WITH t AS (SELECT SUM(r) / SUM(o) AS rate FROM data) SELECT ROUND(rate * 100, 1) AS rate FROM t';
        expect(percentScaleFromSql(sql, 'rate')).toBe('points');
    });

    it('says nothing when the column is not computed in the SQL', () => {
        expect(percentScaleFromSql('SELECT region, AVG(discount_pct) AS discount_pct FROM data', 'discount_pct')).toBeNull();
        expect(percentScaleFromSql('SELECT region FROM data', 'rate')).toBeNull();
        expect(percentScaleFromSql(undefined, 'rate')).toBeNull();
    });
});
