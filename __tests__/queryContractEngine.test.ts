import { describe, expect, it } from 'vitest';
import { buildQueryContract, validateSQLAgainstContract } from '../services/ai-sql/queryContract';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';

const field = (name: string, role: 'metric' | 'dimension', semanticType: any): any => ({
    name,
    displayLabel: name.replace(/_/g, ' '),
    physicalType: role === 'metric' ? 'number' : semanticType === 'date' ? 'date' : 'string',
    semanticType,
    role,
    defaultAgg: role === 'metric' ? 'sum' : 'none',
    timeGrainSupport: semanticType === 'date' ? ['day', 'week', 'month', 'quarter', 'year'] : [],
    synonyms: [],
    valueDescriptors: [],
    distinctCount: role === 'metric' ? 900 : 20,
    hasNulls: false,
});

const model: SemanticModel = {
    datasetName: 'data',
    rowCount: 1_000,
    grain: 'one row per transaction',
    compositeMetrics: [],
    derivedMetrics: [],
    fields: [
        field('product_name', 'dimension', 'category'),
        field('sales', 'metric', 'currency'),
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

describe('production query-contract engine', () => {
    it('locks the requested entity grain and relationship path', () => {
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
        const contract = buildQueryContract(
            'Which European countries have at least 3 manufacturers?',
            plan({ intent: 'breakdown' }),
            [],
            model,
            schema,
        );

        expect(contract.outputEntity).toMatchObject({ table: 'COUNTRIES', field: 'CountryName', confidence: 'high' });
        expect(contract.requiredTables).toEqual(expect.arrayContaining(['COUNTRIES', 'CAR_MAKERS']));
        expect(contract.requiresRanking).toBe(false);
        expect(contract.expectedAggregation).toBe('count');
        expect(contract.threshold).toEqual({ operator: '>=', value: 3, requiresHaving: true });

        const wrong = `SELECT data.Continent, COUNT(data.ContId)
            FROM data
            WHERE data.Continent = 'europe'
            GROUP BY data.Continent
            HAVING COUNT(data.ContId) >= 3`;
        expect(validateSQLAgainstContract(wrong, contract).map(issue => issue.code))
            .toEqual(expect.arrayContaining(['missing_requested_dimension', 'missing_required_table']));

        const correct = `SELECT c.CountryName
            FROM COUNTRIES c
            JOIN CAR_MAKERS m ON c.CountryId = m.Country
            GROUP BY c.CountryName
            HAVING COUNT(*) >= 3`;
        expect(validateSQLAgainstContract(correct, contract)).toEqual([]);

        const missingThreshold = `SELECT c.CountryName, COUNT(*)
            FROM COUNTRIES c
            JOIN CAR_MAKERS m ON c.CountryId = m.Country
            GROUP BY c.CountryName`;
        expect(validateSQLAgainstContract(missingThreshold, contract).map(issue => issue.code))
            .toContain('missing_comparator');
    });

    it('requires set-difference logic for absence questions', () => {
        const schema = {
            tables: [
                { name: 'countries', rowCount: 20, columns: [{ name: 'country_id', isPK: true }, { name: 'country_name' }] },
                { name: 'manufacturers', rowCount: 50, columns: [{ name: 'manufacturer_id', isPK: true }, { name: 'country_id' }] },
            ],
            links: [
                { leftTable: 'manufacturers', leftColumn: 'country_id', rightTable: 'countries', rightColumn: 'country_id', type: 'fk' as const },
            ],
        };
        const contract = buildQueryContract('List countries without any manufacturers', plan({ intent: 'breakdown' }), [], model, schema);
        expect(contract.existenceMode).toBe('anti');

        const wrong = 'SELECT country_name FROM countries GROUP BY country_name HAVING COUNT(country_id) = 0';
        expect(validateSQLAgainstContract(wrong, contract).map(issue => issue.code))
            .toEqual(expect.arrayContaining(['missing_required_table', 'missing_existence_logic']));

        const correct = `SELECT c.country_name
            FROM countries c
            WHERE NOT EXISTS (SELECT 1 FROM manufacturers m WHERE m.country_id = c.country_id)`;
        expect(validateSQLAgainstContract(correct, contract)).toEqual([]);
    });

    it('enforces explicit aggregation and ranking direction', () => {
        const averageContract = buildQueryContract(
            'What is the average sales?',
            plan({ metrics: [{ field: 'sales', agg: 'sum' }] }),
            [],
            model,
        );
        expect(validateSQLAgainstContract('SELECT SUM(sales) FROM data', averageContract).map(issue => issue.code))
            .toContain('missing_aggregation');
        expect(validateSQLAgainstContract('SELECT AVG(sales) FROM data', averageContract)).toEqual([]);

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

  it('does not force GROUP BY for a row-level superlative', () => {
        const singerModel: SemanticModel = {
            ...model,
            fields: [
                field('Song_Name', 'dimension', 'category'),
                field('Song_release_year', 'dimension', 'count'),
                field('Age', 'metric', 'quantity'),
            ],
        };
        const contract = buildQueryContract(
            'Show the name and release year of the song by the youngest singer.',
            plan({
                intent: 'ranking',
                dimensions: [{ field: 'Song_Name' }],
                metrics: [{ field: 'Age', agg: 'min' }],
                sort: [{ field: 'Age', dir: 'asc' }],
                limit: 1,
            }),
            [],
            singerModel,
        );
        expect(contract.requiresGrouping).toBe(false);
        expect(contract.outputEntity).toMatchObject({ field: 'Song_Name', confidence: 'high' });
        expect(validateSQLAgainstContract(
            'SELECT Name, Song_release_year FROM data ORDER BY Age ASC LIMIT 1',
            contract,
        ).map(issue => issue.code)).toContain('missing_output_entity');
        expect(validateSQLAgainstContract(
            'SELECT Song_Name, Song_release_year FROM data ORDER BY Age ASC LIMIT 1',
            contract,
        )).toEqual([]);
    });

    it('distinguishes a percentage of accounts from a percentage of money', () => {
        const ratioModel: SemanticModel = {
            ...model,
            fields: [
                field('account_id', 'dimension', 'identifier'),
                field('status', 'dimension', 'category'),
                field('amount', 'metric', 'currency'),
            ],
        };
        const contract = buildQueryContract(
            'For loans under 100000, what percentage of accounts are still running?',
            plan(),
            [],
            ratioModel,
        );

        expect(contract.ratio).toMatchObject({ basis: 'row_count' });
        expect(validateSQLAgainstContract(
            `SELECT SUM(CASE WHEN status = 'C' THEN amount ELSE 0 END) * 100.0 / SUM(amount) FROM data`,
            contract,
        ).map(issue => issue.code)).toContain('wrong_ratio_basis');
        expect(validateSQLAgainstContract(
            `SELECT SUM(CASE WHEN status = 'C' THEN 1 ELSE 0 END) * 100.0 / COUNT(account_id) FROM data`,
            contract,
        ).map(issue => issue.code)).not.toContain('wrong_ratio_basis');
    });

    it('locks explicit row-to-global-average comparisons before entity projection', () => {
        const contract = buildQueryContract(
            'Which events have less than the average parking cost?',
            plan({ intent: 'aggregate_filter', dimensions: [{ field: 'event_name' }] }),
            [],
            model,
        );

        expect(contract.relativeComparison?.scope).toBe('row_to_global_average');
        expect(validateSQLAgainstContract(
            `SELECT event_name, SUM(cost) AS parking_cost FROM expense GROUP BY event_name HAVING SUM(cost) < (SELECT AVG(cost) FROM expense)`,
            contract,
        ).map(issue => issue.code)).toContain('wrong_comparison_scope');
        expect(validateSQLAgainstContract(
            `SELECT event_name FROM expense WHERE cost < (SELECT AVG(cost) FROM expense)`,
            contract,
        ).map(issue => issue.code)).not.toContain('wrong_comparison_scope');
    });

    it('keeps one requested count scalar instead of grouping by filter values', () => {
        const contract = buildQueryContract(
            "What are the number of votes from state 'NY' or 'CA'?",
            plan({ intent: 'breakdown', dimensions: [{ field: 'state' }], metrics: [{ field: 'row_id', agg: 'count' }] }),
            [{ code: 'missing_dimension' }],
            model,
        );
        expect(contract.expectedCardinality).toBe('scalar');
        expect(contract.requiresGrouping).toBe(false);
        expect(validateSQLAgainstContract(
            "SELECT state, COUNT(*) FROM data WHERE state IN ('NY', 'CA') GROUP BY state",
            contract,
        ).map(issue => issue.code)).toContain('unexpected_grouping');
        expect(validateSQLAgainstContract(
            "SELECT COUNT(*) FROM data WHERE state IN ('NY', 'CA')",
            contract,
        ).map(issue => issue.code)).not.toContain('unexpected_grouping');
    });

    it('uses matched joins unless unmatched entities are explicitly requested', () => {
        const schema = {
            tables: [
                { name: 'teacher', rowCount: 7, columns: [{ name: 'Teacher_ID', isPK: true }, { name: 'Name' }] },
                { name: 'course_arrange', rowCount: 6, columns: [{ name: 'Course_ID' }, { name: 'Teacher_ID' }] },
            ],
            links: [
                { leftTable: 'course_arrange', leftColumn: 'Teacher_ID', rightTable: 'teacher', rightColumn: 'Teacher_ID', type: 'fk' as const },
            ],
        };
        const contract = buildQueryContract(
            'What are the names of the teachers and how many courses do they teach?',
            plan({ intent: 'breakdown', dimensions: [{ field: 'Name' }], metrics: [{ field: 'Course_ID', agg: 'count' }] }),
            [],
            model,
            schema,
        );
        expect(contract.relationshipMode).toBe('inner');
        expect(validateSQLAgainstContract(
            'SELECT t.Name, COUNT(c.Course_ID) FROM teacher t LEFT JOIN course_arrange c ON t.Teacher_ID = c.Teacher_ID GROUP BY t.Name',
            contract,
        ).map(issue => issue.code)).toContain('wrong_join_semantics');
        expect(validateSQLAgainstContract(
            'SELECT t.Name, COUNT(c.Course_ID) FROM teacher t JOIN course_arrange c ON t.Teacher_ID = c.Teacher_ID GROUP BY t.Name',
            contract,
        ).map(issue => issue.code)).not.toContain('wrong_join_semantics');
    });
  });
