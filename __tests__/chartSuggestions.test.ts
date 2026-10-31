import { describe, expect, it } from 'vitest';
import { aiSqlPresentationChart, chartShapeSignature, profileChartShape, refineGenericChart, resolveCountryName, suggestCharts } from '../utils/chartSuggestions';
import { gaugeScale, niceCeiling } from '../utils/chartPresentation';
import { frameCountries } from '../utils/countryCentroids';

const rows = (labels: string[], values: number[], x = 'label', y = 'value') =>
    labels.map((label, index) => ({ [x]: label, [y]: values[index] }));

const types = (result: ReturnType<typeof suggestCharts>) => result.suggestions.map(s => s.type);

describe('chart suggestions', () => {
    it('uses a number card for a single value and offers a gauge when there is a goal', () => {
        const single = suggestCharts({ rows: [{ metric: 120 }], xKey: '', yKey: 'metric', kpiGoal: 200 });
        expect(single.best?.type).toBe('kpiCard');
        expect(types(single)).toContain('gauge');
        expect(types(suggestCharts({ rows: [{ metric: 120 }], xKey: '', yKey: 'metric' }))).not.toContain('gauge');
    });

    it('draws an additive measure over time as an area and an average as a line', () => {
        const months = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];
        const sum = suggestCharts({ rows: rows(months, [5, 6, 7, 6, 8, 9], 'month', 'revenue'), xKey: 'month', yKey: 'revenue', aggregation: 'SUM' });
        expect(sum.shape.kind).toBe('time');
        expect(sum.best?.type).toBe('area');
        expect(types(sum)).toContain('waterfall');
        const avg = suggestCharts({ rows: rows(months, [5, 6, 7, 6, 8, 9], 'month', 'revenue'), xKey: 'month', yKey: 'revenue', aggregation: 'AVG' });
        expect(avg.best?.type).toBe('line');
        expect(types(avg)).not.toContain('waterfall');
    });

    it('recognises quarter labels as time', () => {
        expect(profileChartShape({ rows: rows(['Q1 2024', 'Q2 2024', 'Q3 2024', 'Q4 2024'], [1, 2, 3, 4]), xKey: 'label', yKey: 'value' }).kind).toBe('time');
        expect(profileChartShape({ rows: rows(['2024-Q1', '2024-Q2', '2024-Q3'], [1, 2, 3]), xKey: 'label', yKey: 'value' }).kind).toBe('time');
    });

    it('shows a few additive parts as a donut and many as a treemap', () => {
        const few = suggestCharts({ rows: rows(['A', 'B', 'C', 'D'], [4, 3, 2, 1]), xKey: 'label', yKey: 'value', aggregation: 'SUM' });
        expect(few.best?.type).toBe('doughnut');
        const many = Array.from({ length: 20 }, (_, i) => `Item ${i}`);
        const lots = suggestCharts({ rows: rows(many, many.map((_, i) => 100 - i)), xKey: 'label', yKey: 'value', aggregation: 'SUM' });
        expect(lots.best?.type).toBe('treemap');
    });

    it('never offers part-to-whole charts for averages or rates', () => {
        const avg = suggestCharts({ rows: rows(['A', 'B', 'C', 'D'], [4, 3, 2, 1]), xKey: 'label', yKey: 'value', aggregation: 'AVG' });
        const rate = suggestCharts({ rows: rows(['A', 'B', 'C', 'D'], [0.4, 0.3, 0.2, 0.1], 'label', 'conversion_rate'), xKey: 'label', yKey: 'conversion_rate', aggregation: 'SUM' });
        for (const result of [avg, rate]) {
            expect(types(result)).not.toContain('doughnut');
            expect(types(result)).not.toContain('pie');
            expect(types(result)).not.toContain('treemap');
            expect(types(result)).not.toContain('waterfall');
        }
    });

    it('uses a waterfall when an additive measure has gains and losses', () => {
        const result = suggestCharts({ rows: rows(['North', 'South', 'East', 'West'], [120, -40, 60, -10], 'region', 'profit'), xKey: 'region', yKey: 'profit', aggregation: 'SUM' });
        expect(result.best?.type).toBe('waterfall');
        expect(types(result)).not.toContain('doughnut');
    });

    it('offers a map only when the labels are real places', () => {
        const countries = suggestCharts({ rows: rows(['UK', 'Germany', 'France', 'United States'], [4, 3, 2, 1], 'country', 'revenue'), xKey: 'country', yKey: 'revenue', aggregation: 'SUM' });
        expect(countries.best?.type).toBe('map');
        expect(countries.shape.geography).toBe('world');
        const states = profileChartShape({ rows: rows(['Texas', 'Ohio', 'Utah'], [1, 2, 3]), xKey: 'label', yKey: 'value' });
        expect(states.geography).toBe('us');
        const cities = suggestCharts({ rows: rows(['London', 'Leeds', 'Bristol'], [4, 3, 2], 'city', 'revenue'), xKey: 'city', yKey: 'revenue' });
        expect(types(cities)).not.toContain('map');
        expect(resolveCountryName('USA')).toBe('united states of america');
    });

    it('shows pipeline stages as a funnel', () => {
        const result = suggestCharts({ rows: rows(['Lead', 'Qualified', 'Proposal', 'Won'], [400, 180, 90, 40], 'stage', 'deals'), xKey: 'stage', yKey: 'deals', dimension: 'deal_stage', aggregation: 'COUNT' });
        expect(result.best?.type).toBe('funnel');
    });

    it('ranks a top-N list with horizontal bars or a lollipop', () => {
        const names = Array.from({ length: 8 }, (_, i) => `Customer ${i}`);
        const top = suggestCharts({ rows: rows(names, names.map((_, i) => 90 - i)), xKey: 'label', yKey: 'value', aggregation: 'SUM', sort: 'desc', limit: 8 });
        expect(top.best?.type).toBe('horizontalBar');
        expect(types(top)).toContain('lollipop');
        expect(types(top)).not.toContain('doughnut');
    });

    it('stacks series that add up and keeps period comparisons on an axis', () => {
        const series = [
            { month: '2025-01', cat: 'A', v: 1 }, { month: '2025-01', cat: 'B', v: 2 },
            { month: '2025-02', cat: 'A', v: 2 }, { month: '2025-02', cat: 'B', v: 3 },
        ];
        expect(suggestCharts({ rows: series, xKey: 'month', yKey: 'v', seriesKey: 'cat', aggregation: 'SUM' }).best?.type).toBe('stackedArea');
        const compared = suggestCharts({ rows: rows(['A', 'B', 'C'], [3, 2, 1]), xKey: 'label', yKey: 'value', hasComparison: true });
        expect(types(compared).every(type => ['bar', 'horizontalBar', 'line', 'area'].includes(type))).toBe(true);
    });

    it('returns nothing for an empty result', () => {
        expect(suggestCharts({ rows: [], xKey: 'a', yKey: 'b' }).best).toBeNull();
    });

    it('upgrades only plain bar and line defaults', () => {
        const parts = rows(['A', 'B', 'C'], [5, 3, 2], 'region', 'sales');
        expect(refineGenericChart('bar', { rows: parts, xKey: 'region', yKey: 'sales' })).toBe('doughnut');
        expect(refineGenericChart('groupedBar', { rows: parts, xKey: 'region', yKey: 'sales' })).toBe('groupedBar');
        expect(refineGenericChart('bar', { rows: parts, xKey: 'region', yKey: 'sales', secondaryYKeys: ['profit'] })).toBe('bar');
        const avg = rows(['A', 'B', 'C'], [5, 3, 2], 'region', 'avg_order_value');
        expect(refineGenericChart('bar', { rows: avg, xKey: 'region', yKey: 'avg_order_value' })).toBe('bar');
        const months = rows(['2025-01', '2025-02', '2025-03', '2025-04', '2025-05'], [1, 2, 3, 2, 4], 'month', 'revenue');
        expect(refineGenericChart('line', { rows: months, xKey: 'month', yKey: 'revenue' })).toBe('area');
        expect(aiSqlPresentationChart({ chartData: parts, chart: { chartType: 'dualAxisCombo', xKey: 'region', yKey: 'sales' } })).toBe('combo');
        expect(aiSqlPresentationChart({ chartData: parts, chart: { chartType: 'donut', xKey: 'region', yKey: 'sales' } })).toBe('doughnut');
    });

    it('keeps a chart choice while the same question is refined', () => {
        const base = { metric: 'revenue', dimension: 'category', aggregation: 'SUM', filters: [] };
        expect(chartShapeSignature({ ...base, filters: [{ column: 'city' }], sort: 'asc' })).toBe(chartShapeSignature(base));
        expect(chartShapeSignature({ ...base, dimension: 'city' })).not.toBe(chartShapeSignature(base));
        expect(chartShapeSignature({ ...base, comparison: 'none' })).toBe(chartShapeSignature(base));
    });

    it('scales a gauge against the goal, 100% or a rounded ceiling', () => {
        expect(gaugeScale([120], 200, 'revenue')).toEqual({ value: 120, max: 200, basis: 'goal' });
        expect(gaugeScale([0.42], undefined, 'conversion_rate')).toEqual({ value: 0.42, max: 1, basis: 'percent' });
        expect(gaugeScale([42], undefined, 'margin_pct').max).toBe(100);
        expect(gaugeScale([8400], undefined, 'revenue').max).toBe(10000);
        expect(niceCeiling(230)).toBe(250);
    });

    it('frames a map around the countries with data', () => {
        const project = ([lon, lat]: [number, number]) => [400 + lon * 2.2, 220 - lat * 2.2] as [number, number];
        const europe = frameCountries(['united kingdom', 'germany', 'france', 'spain'], project, 800, 440);
        expect(europe?.zoom).toBeGreaterThan(2);
        expect(europe?.center[1]).toBeGreaterThan(40);
        expect(frameCountries(['united states of america', 'australia', 'brazil', 'russia'], project, 800, 440)).toBeNull();
        expect(frameCountries(['atlantis'], project, 800, 440)).toBeNull();
    });
});
