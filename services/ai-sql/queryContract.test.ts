import { describe, expect, it } from 'vitest';
import { buildQueryContract, validateSQLAgainstContract } from './queryContract';
import type { AnalysisPlan, SemanticModel } from './types';

const model: SemanticModel = {
    datasetName: 'Orders',
    rowCount: 10_000,
    grain: 'one row per order',
    compositeMetrics: [],
    derivedMetrics: [],
    timeContext: {
        anchorDate: '2017-12-30',
        minDate: '2015-01-01',
        maxDate: '2017-12-30',
        primaryDateColumn: 'order_date',
    },
    fields: [
        {
            name: 'order_date', displayLabel: 'Order date', physicalType: 'date',
            semanticType: 'date', role: 'dimension', defaultAgg: 'none',
            timeGrainSupport: ['day', 'week', 'month', 'quarter', 'year'],
            synonyms: ['date'], valueDescriptors: [], distinctCount: 1000, hasNulls: false,
        },
        {
            name: 'category', displayLabel: 'Category', physicalType: 'string',
            semanticType: 'category', role: 'dimension', defaultAgg: 'none',
            timeGrainSupport: [], synonyms: ['product category'], valueDescriptors: [],
            distinctCount: 10, hasNulls: false,
        },
        {
            name: 'product_name', displayLabel: 'Product name', physicalType: 'string',
            semanticType: 'category', role: 'dimension', defaultAgg: 'none',
            timeGrainSupport: [], synonyms: ['product'], valueDescriptors: [],
            distinctCount: 100, hasNulls: false,
        },
        {
            name: 'sales', displayLabel: 'Sales', physicalType: 'number',
            semanticType: 'currency', role: 'metric', defaultAgg: 'sum',
            timeGrainSupport: [], synonyms: ['revenue'], valueDescriptors: [],
            distinctCount: 9000, hasNulls: false,
        },
    ],
};

function plan(overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
    return {
        intent: 'single_metric',
        dimensions: [],
        metrics: [{ field: 'sales', agg: 'sum' }],
        filters: [],
        sort: [],
        limit: null,
        ambiguous: false,
        resultGrain: 'one row',
        originalQuestion: '',
        ...overrides,
    };
}

function codes(sql: string, question: string, inputPlan = plan()): string[] {
    const contract = buildQueryContract(question, inputPlan, [], model);
    return validateSQLAgainstContract(sql, contract).map(issue => issue.code);
}

describe('AI SQL query contract regression suite', () => {
    it('rejects a scalar total for a fiscal-quarter breakdown', () => {
        const question = 'Revenue by fiscal quarter where fiscal year starts in April';
        const contract = buildQueryContract(question, plan({ intent: 'breakdown' }), [], model);

        expect(contract.requiredDimension).toBe('order_date');
        expect(codes('SELECT SUM(sales) AS total_sales FROM data', question, plan({ intent: 'breakdown' })))
            .toEqual(expect.arrayContaining(['missing_grouping', 'missing_requested_dimension', 'missing_fiscal_calendar']));

        const validSql = `SELECT
            DATE_TRUNC('quarter', order_date - INTERVAL '3 months') + INTERVAL '3 months' AS fiscal_quarter,
            SUM(sales) AS revenue
          FROM data
          GROUP BY 1`;
        expect(validateSQLAgainstContract(validSql, contract)).toEqual([]);
    });

    it('requires the explicitly requested breakdown dimension', () => {
        const question = 'Show sales by category';
        const contract = buildQueryContract(question, plan({ intent: 'breakdown' }), [], model);

        expect(contract.requiredDimension).toBe('category');
        expect(codes('SELECT SUM(sales) AS total_sales FROM data', question, plan({ intent: 'breakdown' })))
            .toEqual(expect.arrayContaining(['missing_grouping', 'missing_requested_dimension']));
        expect(validateSQLAgainstContract(
            'SELECT category, SUM(sales) AS total_sales FROM data GROUP BY category',
            contract,
        )).toEqual([]);
    });

    it('requires the exact requested ranking limit', () => {
        const question = 'Top 5 products by sales';
        const contract = buildQueryContract(question, plan({ intent: 'ranking' }), [], model);

        expect(contract.rankingLimit).toBe(5);
        expect(codes(
            'SELECT product_name, SUM(sales) AS total_sales FROM data GROUP BY product_name ORDER BY total_sales DESC',
            question,
            plan({ intent: 'ranking' }),
        )).toContain('missing_ranking');
        expect(validateSQLAgainstContract(
            'SELECT product_name, SUM(sales) AS total_sales FROM data GROUP BY product_name ORDER BY total_sales DESC LIMIT 5',
            contract,
        )).toEqual([]);
    });

    it('rejects a single-period total for a requested period comparison', () => {
        const question = 'Sales this month versus last month';
        const contract = buildQueryContract(question, plan({
            intent: 'total_comparison',
            comparison: { type: 'previous_period', mode: 'total', grain: 'month' },
        }), [], model);

        expect(codes('SELECT SUM(sales) AS total_sales FROM data', question, plan({
            intent: 'total_comparison',
            comparison: { type: 'previous_period', mode: 'total', grain: 'month' },
        }))).toContain('missing_comparison');
        expect(validateSQLAgainstContract(
            `SELECT
                SUM(CASE WHEN order_date >= DATE '2017-12-01' THEN sales ELSE 0 END) AS sales_this_month,
                SUM(CASE WHEN order_date < DATE '2017-12-01' THEN sales ELSE 0 END) AS sales_last_month
              FROM data`,
            contract,
        )).toEqual([]);
    });
});
