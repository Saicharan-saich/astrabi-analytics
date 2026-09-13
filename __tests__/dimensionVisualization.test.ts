import { describe, expect, it } from 'vitest';
import { resolveDimensionVisualization } from '../utils/dimensionVisualization';

const period = 'period_id → Dim_Period.period_label';
const rows = [
    { trade_scope: 'Goods + Services', flow_direction: 'Import', [period]: 'FY2022-23', value_usd_bn: 979 },
    { trade_scope: 'Goods + Services', flow_direction: 'Export', [period]: 'FY2022-23', value_usd_bn: 860 },
    { trade_scope: 'Goods + Services', flow_direction: 'Import', [period]: 'FY2023-24', value_usd_bn: 1010 },
    { trade_scope: 'Goods + Services', flow_direction: 'Export', [period]: 'FY2023-24', value_usd_bn: 920 },
];

describe('dimension visualization layout', () => {
    it('automatically facets a third requested dimension even when it has only two values', () => {
        const layout = resolveDimensionVisualization(rows, 'trade_scope', 'value_usd_bn', {
            dimension: 'trade_scope', secondaryDimensions: ['flow_direction', period],
        }, 'auto');

        expect(layout.useGrid).toBe(true);
        expect(layout.facetKey).toBe(period);
        expect(layout.seriesKey).toBe('flow_direction');
        expect(layout.rows).toBe(rows);
    });

    it('keeps every group distinct in a manually selected combined view', () => {
        const layout = resolveDimensionVisualization(rows, 'trade_scope', 'value_usd_bn', {
            dimension: 'trade_scope', secondaryDimensions: ['flow_direction', period],
        }, 'combined');

        expect(layout.useGrid).toBe(false);
        expect(layout.seriesKey).toBe('__qi_group_series');
        expect(new Set(layout.rows.map(row => row[layout.seriesKey!])).size).toBe(4);
        expect(layout.rows[0][layout.seriesKey!]).toContain('FY2022-23');
    });

    it('uses one dimension as a grouped series without unnecessary panels', () => {
        const layout = resolveDimensionVisualization(rows, 'trade_scope', 'value_usd_bn', {
            dimension: 'trade_scope', secondaryDimensions: ['flow_direction'],
        }, 'auto');

        expect(layout.useGrid).toBe(false);
        expect(layout.seriesKey).toBe('flow_direction');
    });

    it('prefers a readable facet when the last dimension is too wide', () => {
        const manyRows = Array.from({ length: 60 }, (_, i) => ({
            trade_scope: `Product ${i}`,
            flow_direction: i % 2 ? 'Import' : 'Export',
            [period]: `Period ${i}`,
            value_usd_bn: i,
        }));
        const layout = resolveDimensionVisualization(manyRows, 'trade_scope', 'value_usd_bn', {
            dimension: 'trade_scope', secondaryDimensions: ['flow_direction', period],
        }, 'auto');

        expect(layout.useGrid).toBe(true);
        expect(layout.facetKey).toBe('flow_direction');
        expect(layout.seriesKey).toBe(period);
    });
});
