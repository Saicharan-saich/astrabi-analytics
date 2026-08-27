import { describe, expect, it } from 'vitest';
import { buildQueryContract, validateResultAgainstContract, validateSQLAgainstContract } from './queryContract';
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
            `WITH period_totals AS (
                SELECT period, SUM(sales) AS total_sales
                FROM data
                GROUP BY period
             ), comparison AS (
                SELECT period, total_sales,
                       LAG(total_sales, 1) OVER (ORDER BY period) AS previous_value
                FROM period_totals
             )
             SELECT period, total_sales, previous_value,
                    (total_sales - previous_value) * 100.0 / NULLIF(previous_value, 0) AS growth_pct
             FROM comparison`,
            contract,
        )).toEqual([]);
    });

    it('locks the requested entity grain and relationship path for multi-table questions', () => {
        const schema = {
            tables: [
                { name: 'COUNTRIES', rowCount: 20, columns: [{ name: 'CountryId', isPK: true }, { name: 'CountryName' }, { name: 'Continent' }] },
                { name: 'CONTINENTS', rowCount: 5, columns: [{ name: 'ContId', isPK: true }, { name: 'Continent' }] },
                { name: 'CAR_MAKERS', rowCount: 50, columns: [{ name: 'Id', isPK: true }, { name: 'Maker' }, { name: 'Country' }] },
            ],
            links: [
                { leftTable: 'COUNTRIES', leftColumn: 'Continent', rightTable: 'CONTINENTS', rightColumn: 'ContId', type: 'fk' as const },
                { leftTable: 'CAR_MAKERS', leftColumn: 'Country', rightTable: 'COUNTRIES', rightColumn: 'CountryId', type: 'fk' as const },
            ],
        };
        const question = 'Which European countries have at least 3 manufacturers?';
        const contract = buildQueryContract(question, plan({ intent: 'breakdown' }), [], model, schema);

        expect(contract.outputEntity).toMatchObject({ table: 'COUNTRIES', field: 'CountryName', confidence: 'high' });
        expect(contract.requiredTables).toEqual(expect.arrayContaining(['COUNTRIES', 'CAR_MAKERS']));
        expect(contract.requiresRanking).toBe(false); // "at least" is a comparator, not a ranking cue

        const wrong = `SELECT data.Continent, COUNT(data.ContId)
            FROM data
            WHERE data.Continent = 'europe'
            GROUP BY data.Continent
            HAVING COUNT(data.ContId) >= 3`;
        expect(validateSQLAgainstContract(wrong, contract).map(issue => issue.code))
            .toEqual(expect.arrayContaining(['missing_requested_dimension', 'missing_output_entity', 'missing_required_table']));

        const correct = `SELECT c.CountryName
            FROM COUNTRIES c
            JOIN CAR_MAKERS m ON c.CountryId = m.Country
            GROUP BY c.CountryName
            HAVING COUNT(*) >= 3`;
        expect(validateSQLAgainstContract(correct, contract)).toEqual([]);
    });

    it('requires explicit anti-join semantics for absence questions', () => {
        const schema = {
            tables: [
                { name: 'countries', rowCount: 20, columns: [{ name: 'country_id', isPK: true }, { name: 'country_name' }] },
                { name: 'manufacturers', rowCount: 50, columns: [{ name: 'manufacturer_id', isPK: true }, { name: 'country_id' }] },
            ],
            links: [
                { leftTable: 'manufacturers', leftColumn: 'country_id', rightTable: 'countries', rightColumn: 'country_id', type: 'fk' as const },
            ],
        };
        const question = 'List countries without any manufacturers';
        const contract = buildQueryContract(question, plan({ intent: 'breakdown' }), [], model, schema);
        expect(contract.existenceMode).toBe('anti');

        const wrong = `SELECT country_name FROM countries GROUP BY country_name HAVING COUNT(country_id) = 0`;
        expect(validateSQLAgainstContract(wrong, contract).map(issue => issue.code))
            .toEqual(expect.arrayContaining(['missing_required_table', 'missing_existence_logic']));

        const correct = `SELECT c.country_name
            FROM countries c
            WHERE NOT EXISTS (
                SELECT 1 FROM manufacturers m WHERE m.country_id = c.country_id
            )`;
        expect(validateSQLAgainstContract(correct, contract)).toEqual([]);
    });

    it('does not confuse a no-issue status phrase with missing related records', () => {
        const loanModel: SemanticModel = {
            ...model,
            datasetName: 'loan',
            fields: [
                {
                    name: 'status', displayLabel: 'Status', physicalType: 'string',
                    semanticType: 'category', role: 'dimension', defaultAgg: 'none',
                    timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 4, hasNulls: false,
                },
                {
                    name: 'amount', displayLabel: 'Loan amount', physicalType: 'number',
                    semanticType: 'currency', role: 'metric', defaultAgg: 'sum',
                    timeGrainSupport: [], synonyms: ['loan amount'], valueDescriptors: [], distinctCount: 9000, hasNulls: false,
                },
            ],
        };
        const question = 'What is the percentage of loan amount that has been fully paid with no issue?';
        const contract = buildQueryContract(question, plan({
            intent: 'single_metric',
            metrics: [{ field: 'amount', agg: 'sum' }],
        }), [], loanModel);

        expect(contract.existenceMode).toBe('none');
        expect(validateSQLAgainstContract(
            `SELECT CAST(SUM(CASE WHEN status = 'A' THEN amount ELSE 0 END) AS REAL) * 100 / SUM(amount) FROM data`,
            contract,
        ).map(issue => issue.code)).not.toContain('missing_existence_logic');
    });

    it('recognises a group with the most number of members as a frequency ranking', () => {
        const channelModel: SemanticModel = {
            ...model,
            datasetName: 'TV_Channel',
            fields: [
                {
                    name: 'Country', displayLabel: 'Country', physicalType: 'string',
                    semanticType: 'category', role: 'dimension', defaultAgg: 'none',
                    timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 4, hasNulls: false,
                },
                {
                    name: 'channel_id', displayLabel: 'Channel ID', physicalType: 'number',
                    semanticType: 'identifier', role: 'dimension', defaultAgg: 'count_distinct',
                    timeGrainSupport: [], synonyms: ['TV channel'], valueDescriptors: [], distinctCount: 15, hasNulls: false,
                },
            ],
        };
        const question = 'What is the country with the most number of TV Channels and how many does it have?';
        const rankingPlan = plan({
            intent: 'ranking',
            dimensions: [{ field: 'Country' }],
            metrics: [{ field: 'channel_id', agg: 'count' }],
            sort: [{ field: 'channel_id', dir: 'desc' }],
            limit: 1,
        });
        const contract = buildQueryContract(question, rankingPlan, [], channelModel);

        expect(contract.requiresGrouping).toBe(true);
        expect(contract.requiredDimension).toBe('Country');
        expect(contract.rankingLimit).toBe(1);
        expect(validateSQLAgainstContract(
            'SELECT COUNT(*) AS channel_count FROM data ORDER BY channel_count DESC LIMIT 1',
            contract,
        ).map(issue => issue.code)).toEqual(expect.arrayContaining(['missing_grouping', 'missing_requested_dimension']));
        expect(validateSQLAgainstContract(
            'SELECT Country, COUNT(*) AS channel_count FROM data GROUP BY Country ORDER BY channel_count DESC LIMIT 1',
            contract,
        )).toEqual([]);
    });

    it('enforces explicit aggregation and ranking direction without inheriting a bad plan guess', () => {
        const averageContract = buildQueryContract(
            'What is the average sales?',
            plan({ metrics: [{ field: 'sales', agg: 'sum' }] }),
            [],
            model,
        );
        expect(averageContract.expectedAggregation).toBe('avg');
        expect(validateSQLAgainstContract('SELECT SUM(sales) FROM data', averageContract).map(issue => issue.code))
            .toContain('missing_aggregation');
        expect(validateSQLAgainstContract('SELECT AVG(sales) FROM data', averageContract)).toEqual([]);

        const formulaContract = buildQueryContract(
            'What is the average sales?\n\nEvidence: average sales = DIVIDE(SUM(sales), COUNT(order_id))',
            plan({ metrics: [{ field: 'sales', agg: 'avg' }] }),
            [],
            model,
        );
        expect(formulaContract.expectedAggregations).toEqual(['sum', 'count']);
        expect(formulaContract.expectedAggregation).toBe('sum');
        expect(validateSQLAgainstContract(
            'SELECT SUM(sales) / NULLIF(COUNT(order_id), 0) FROM data',
            formulaContract,
        ).map(issue => issue.code)).not.toContain('missing_aggregation');

        const rankContract = buildQueryContract(
            'Which product has the lowest total sales?',
            plan({ intent: 'ranking', dimensions: [{ field: 'product_name' }], limit: 1 }),
            [],
            model,
        );
        expect(rankContract.rankingDirection).toBe('asc');
        expect(validateSQLAgainstContract(
            'SELECT product_name, SUM(sales) total_sales FROM data GROUP BY product_name ORDER BY total_sales DESC LIMIT 1',
            rankContract,
        ).map(issue => issue.code)).toContain('wrong_ranking_direction');
    });

    it('rejects truncated grouped results using only local schema cardinality', () => {
        const contract = buildQueryContract(
            'Show each category and the maximum sales for each category',
            plan({
                intent: 'breakdown',
                dimensions: [{ field: 'category' }],
                metrics: [{ field: 'sales', agg: 'max' }],
            }),
            [],
            model,
        );

        expect(contract.resultRowExpectation).toEqual({ minimum: 10, basis: 'distinct_groups' });
        expect(validateResultAgainstContract([{ category: 'A', maximum_sales: 100 }], contract)
            .map(issue => issue.code)).toContain('unexpected_result_cardinality');
        expect(validateResultAgainstContract(
            Array.from({ length: 10 }, (_, index) => ({ category: index, maximum_sales: index })),
            contract,
        )).toEqual([]);
    });

    it('rejects a collapsed ordered projection and accepts the full local population', () => {
        const contract = buildQueryContract(
            'Show product name, category and sales for all records ordered by sales descending',
            plan({
                intent: 'projection',
                metrics: [],
                dimensions: [],
                projectionFields: ['product_name', 'category', 'sales'],
                sort: [{ field: 'sales', dir: 'desc' }],
            }),
            [],
            model,
        );

        expect(contract.resultRowExpectation).toEqual({ exact: 10_000, basis: 'source_rows' });
        expect(validateResultAgainstContract([{ product_name: 'one' }], contract)).toHaveLength(1);
        expect(validateResultAgainstContract(
            Array.from({ length: 10_000 }, (_, index) => ({ product_name: String(index) })),
            contract,
        )).toEqual([]);
    });
});
