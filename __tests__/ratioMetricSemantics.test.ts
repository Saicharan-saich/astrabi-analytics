import { describe, expect, it } from 'vitest';
import { buildQueryPlan } from '../services/queryPlan/buildQueryPlan';
import { compileSQL } from '../services/queryPlan/sqlCompiler';
import { executeQueryPlan } from '../services/queryPlan/executeQueryPlan';
import { getDates } from '../services/dateHelpers';
import { registerDerivedInSemanticModel } from '../services/aiDerivedSuggestions';
import { generateLocalPlan } from '../services/ai-sql/intentPlanner';
import { recommendChart } from '../services/ai-sql/chartRecommender';
import type { SemanticModel as AISemanticModel, ResultProfile, AnalysisPlan } from '../services/ai-sql/types';
import type { SemanticModel } from '../services/semanticModel';
import { runAnalysis } from '../services/analysisEngine';
import { SALES_TEMPLATES } from '../services/metricTemplates/sales';
import { autoSuggestMappings, validateTemplateMappingGrain } from '../services/metricTemplates';
import { repairLegacyProfitMarginDataset } from '../services/legacyDerivedMetricMigration';
import { AggregationType, AnalysisType, ColumnType, TimeGrain, type Dataset, type QueryConfig } from '../types';

describe('governed ratio metrics', () => {
    it('maps the sales margin template to line profit and revenue at matching grain', () => {
        const template = SALES_TEMPLATES.find(metric => metric.id === 'profit_margin_pct')!;
        const columns = ['unit_price', 'cost_amount', 'profit', 'sales_amount'].map(name => ({
            name, type: 'METRIC',
        }));
        const mapping = autoSuggestMappings(template, columns);
        expect(mapping).toEqual({ profit: 'profit', revenue: 'sales_amount' });
        expect(validateTemplateMappingGrain(template, mapping)).toBeNull();
        expect(template.formulaFn({ profit: 10, revenue: 100 })).toBe(10);
        expect(template.formulaFn({ profit: 180, revenue: 900 })).toBe(20);
        expect(validateTemplateMappingGrain(
            SALES_TEMPLATES.find(metric => metric.id === 'gross_profit')!,
            { price: 'unit_price', cost: 'cost_amount', qty: 'units' },
        )).toMatch(/same grain/i);
    });

    it('repairs a stored legacy margin column before restoring the builder session', () => {
        const dataset: Dataset = {
            id: 'legacy-margin', name: 'retail.csv', totalRows: 2, etlLogs: [],
            version: 1,
            columns: [
                { name: 'profit', type: ColumnType.METRIC, originalType: 'number' },
                { name: 'sales_amount', type: ColumnType.METRIC, originalType: 'number' },
                { name: 'unit_price', type: ColumnType.METRIC, originalType: 'number' },
                { name: 'cost_amount', type: ColumnType.METRIC, originalType: 'number' },
                { name: 'profit_margin_pct', type: ColumnType.METRIC, originalType: 'number', semanticRole: 'derived_metric', label: 'Profit Margin %' } as any,
            ],
            rows: [
                { profit: 10, sales_amount: 100, unit_price: 2, cost_amount: 300, profit_margin_pct: -14900 },
                { profit: 180, sales_amount: 900, unit_price: 5, cost_amount: 400, profit_margin_pct: -7900 },
            ],
        };
        const repaired = repairLegacyProfitMarginDataset(dataset);
        expect(repaired.rows.map(row => row.profit_margin_pct)).toEqual([10, 20]);
        expect(repaired.columns.find(column => column.name === 'profit_margin_pct')).toMatchObject({
            derivedFormulaVersion: 2,
            derivedInputColumns: { profit: 'profit', revenue: 'sales_amount' },
        });
        expect(repairLegacyProfitMarginDataset(repaired)).toBe(repaired);
    });

    it('recomputes a row-level ratio as a weighted average in JS and SQL', () => {
        const plan = buildQueryPlan({
            metric: 'profit',
            aggregation: 'SUM',
            secondaryMetrics: ['profit_margin_pct'],
            secondaryMetricAggregations: { profit_margin_pct: 'AVG' },
            metricWeightColumns: { profit_margin_pct: 'sales' },
        }, 'order_date', getDates('2025-01-31'), 'data');

        const result = executeQueryPlan(plan, [
            { profit: 10, sales: 100, profit_margin_pct: 0.10 },
            { profit: 180, sales: 900, profit_margin_pct: 0.20 },
        ]);

        expect(result.data).toEqual([{
            sum_profit: 190,
            avg_profit_margin_pct: 0.19,
        }]);
        expect(compileSQL(plan)).toContain(
            'SUM("profit_margin_pct" * "sales") / NULLIF(SUM(CASE WHEN "profit_margin_pct" IS NOT NULL THEN "sales" END), 0) AS "avg_profit_margin_pct"',
        );
    });

    it('registers a simple custom division with its denominator as the weight', () => {
        const model: SemanticModel = {
            dimensions: [], measures: [], derivedMeasures: [], relationships: [],
            primaryDateColumn: null, dateColumns: [], grain: null, version: 1,
            builtAt: 1, source: 'manual', warnings: [],
        };
        const updated = registerDerivedInSemanticModel(model, [{
            id: 'profit_margin_pct', label: 'Profit Margin Pct', description: 'Custom',
            formula: 'divide', columnA: 'profit', columnB: 'sales',
            category: 'custom', confidence: 100, format: 'percent',
            expression: [
                { column: 'profit', operator: 'divide' },
                { column: 'sales' },
            ],
        }]);

        expect(updated.measures[0]).toMatchObject({
            column: 'profit_margin_pct', aggregation: 'AVG', behavior: 'non_additive',
            requiresWeighting: true, weightColumn: 'sales', format: 'percent',
        });
    });

    it('applies ratio weighting to a secondary Question Builder metric', async () => {
        const semanticModel = registerDerivedInSemanticModel({
            dimensions: [],
            measures: [
                { name: 'profit', column: 'profit', aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false, isHidden: false },
                { name: 'sales', column: 'sales', aggregation: AggregationType.SUM, behavior: 'additive', format: 'currency_usd', requiresWeighting: false, isHidden: false },
            ],
            derivedMeasures: [], relationships: [], primaryDateColumn: null, dateColumns: [],
            grain: 'transaction', version: 1, builtAt: 1, source: 'manual', warnings: [],
        }, [{
            id: 'profit_margin_pct', label: 'Profit Margin Pct', description: 'Custom',
            formula: 'divide', columnA: 'profit', columnB: 'sales',
            category: 'custom', confidence: 100, format: 'percent',
            expression: [{ column: 'profit', operator: 'divide' }, { column: 'sales' }],
        }]);
        const dataset: Dataset = {
            id: 'ratio-test', name: 'data', totalRows: 2, etlLogs: [], semanticModel,
            columns: [
                { name: 'profit', type: ColumnType.METRIC, originalType: 'number' },
                { name: 'sales', type: ColumnType.METRIC, originalType: 'number' },
                { name: 'profit_margin_pct', type: ColumnType.METRIC, originalType: 'number' },
            ],
            rows: [
                { profit: 10, sales: 100, profit_margin_pct: 0.10 },
                { profit: 180, sales: 900, profit_margin_pct: 0.20 },
            ],
        };
        const query: QueryConfig = {
            questionId: 'custom_builder', metric: 'profit', dimension: '',
            aggregation: AggregationType.SUM, timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD, secondaryMetrics: ['profit_margin_pct'],
            secondaryMetricAggregations: { profit_margin_pct: 'AVG' },
            asOfDate: '2025-01-31',
        };

        const result = await runAnalysis(dataset, query);
        expect(result.data[0]).toMatchObject({
            sum_profit: 190,
            avg_profit_margin_pct: 0.19,
        });
        expect(result.sql).toContain('SUM("profit_margin_pct" * "sales")');
        expect(result.secondaryYKeys).toEqual(['avg_profit_margin_pct']);
    });
});

describe('profit plus profit-margin planning and presentation', () => {
    const field = (name: string, synonyms: string[], displayLabel = name): any => ({
        name, physicalType: 'number', semanticType: 'currency', role: 'metric',
        defaultAgg: 'sum', timeGrainSupport: [], synonyms, valueDescriptors: [],
        distinctCount: 10, hasNulls: false, displayLabel,
    });
    const model: AISemanticModel = {
        datasetName: 'data', rowCount: 10, grain: 'one row per transaction', derivedMetrics: [],
        fields: [
            field('profit', ['margin', 'net income'], 'Profit'),
            field('cost_amount', ['expense', 'total', 'sum'], 'Cost Amount'),
            field('sales_amount', ['sales', 'revenue', 'total sales'], 'Sales Amount'),
        ],
        compositeMetrics: [{
            id: 'net_profit_margin_pct', label: 'Net Profit Margin %',
            formula: 'SUM(profit) / NULLIF(SUM(sales_amount), 0) * 100',
            dependsOn: ['profit', 'sales_amount'], semanticType: 'percentage',
            preAggregated: true, description: 'Profit as a percentage of sales',
            synonyms: ['profit margin', 'net margin', 'profit pct'],
        }],
    };

    it('does not interpret the aggregation word total as cost_amount', () => {
        const plan = generateLocalPlan('What were our total profit and profit margin?', model);
        expect(plan.metrics).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'profit', agg: 'sum' }),
            expect.objectContaining({ compositeId: 'net_profit_margin_pct' }),
        ]));
        expect(plan.metrics.some(metric => metric.field === 'cost_amount')).toBe(false);
    });

    it('presents a one-row multi-KPI answer even if a weak plan calls it projection', () => {
        const profile: ResultProfile = {
            rowCount: 1, columnCount: 2, metricCount: 2, dimensionCount: 0,
            dimensionColumns: [], metricColumns: ['total_profit', 'net_profit_margin_pct'],
            dimensionCardinality: {}, hasTimeDimension: false, metricsScaleMismatch: 1000,
            metricSemanticTypes: { total_profit: 'currency', net_profit_margin_pct: 'percentage' },
            isPivoted: true, isSingleValue: false,
        };
        const weakPlan = {
            intent: 'projection', projectionFields: ['profit'], dimensions: [], metrics: [], filters: [],
            sort: [], limit: null, ambiguous: false, resultGrain: 'one row', originalQuestion: 'profit and margin',
        } as AnalysisPlan;

        expect(recommendChart(profile, weakPlan, model).chartType).toBe('groupedBar');
    });
});
