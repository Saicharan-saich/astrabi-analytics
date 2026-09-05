import { describe, expect, it } from 'vitest';
import { buildTraceStory } from '../services/ai-sql/traceStory';

describe('AI SQL calculation trace story', () => {
    it('describes only operations evidenced by the executed top-N SQL and result', () => {
        const story = buildTraceStory({
            sql: 'SELECT product, SUM(sales) AS total_sales FROM data GROUP BY product ORDER BY total_sales DESC LIMIT 10',
            querySpec: {
                goal: 'Top ten products by sales',
                operations: {
                    measures: [{ field: 'sales', aggregation: 'sum' }],
                    groupBy: [{ field: 'product' }],
                    orderBy: [{ expression: 'SUM(sales)', direction: 'desc' }],
                    limit: 10,
                },
                expectedResult: { grain: 'one row per product', columns: ['product', 'total_sales'] },
                assumptions: [],
            },
            sourceTables: [{ name: 'data', rowCount: 1_194 }],
            resultRows: 10,
            resultColumns: ['product', 'total_sales'],
            chart: { chartType: 'horizontalBar', xKey: 'product', yKey: 'total_sales' },
        });

        expect(story.verifiedFrom).toBe('executed_sql_and_result');
        expect(story.steps.map(step => step.kind)).toEqual(['source', 'group', 'calculate', 'rank', 'result']);
        expect(story.steps.find(step => step.kind === 'source')?.description).toContain('1,194 rows');
        expect(story.steps.find(step => step.kind === 'group')?.description).toContain('product');
        expect(story.steps.find(step => step.kind === 'calculate')?.evidence).toContain('SUM(sales)');
        expect(story.steps.find(step => step.kind === 'rank')?.evidence).toContain('LIMIT 10');
        expect(story.steps.at(-1)?.description).toContain('10 result rows');
    });

    it('includes filters, joins, HAVING, windows and set operations only when present', () => {
        const story = buildTraceStory({
            sql: `WITH ranked AS (
                SELECT c.region, SUM(o.sales) AS sales, RANK() OVER (ORDER BY SUM(o.sales) DESC) AS sales_rank
                FROM orders o JOIN customers c ON c.customer_id = o.customer_id
                WHERE o.status = 'Complete'
                GROUP BY c.region HAVING SUM(o.sales) > 0
            ) SELECT region FROM ranked WHERE sales_rank <= 5
              INTERSECT SELECT region FROM targets`,
            sourceTables: [
                { name: 'orders', rowCount: 100 },
                { name: 'customers', rowCount: 20 },
                { name: 'targets', rowCount: 5 },
            ],
            resultRows: 3,
            resultColumns: ['region'],
        });
        const kinds = story.steps.map(step => step.kind);
        expect(kinds).toEqual(expect.arrayContaining(['relationship', 'filter', 'group', 'calculate', 'qualify', 'set', 'result']));
    });
});
