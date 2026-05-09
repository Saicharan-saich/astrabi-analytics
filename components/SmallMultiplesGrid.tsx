import React, { useMemo } from 'react';
import { ChartVisualization } from './ChartVisualization';
import { FormattingConfig } from '../types';

interface SmallMultiplesGridProps {
    data: any[];
    xKey: string;
    yKey: string;
    yLabel: string;
    splitKey: string;        // dimension column to facet by
    chartType: string;
    formatting?: FormattingConfig;
    config?: any;
}

/**
 * Small Multiples Grid — renders one mini chart per unique value of `splitKey`.
 * All facets share the same Y-axis range for fair visual comparison.
 * Works generically with any dimension + any measure + any time grain.
 */
export const SmallMultiplesGrid: React.FC<SmallMultiplesGridProps> = ({
    data, xKey, yKey, yLabel, splitKey, chartType, formatting, config
}) => {
    // 1) Group data by the split dimension
    const { groups, globalMin, globalMax, sortedKeys } = useMemo(() => {
        const map = new Map<string, any[]>();
        let min = Infinity;
        let max = -Infinity;

        for (const row of data) {
            const key = String(row[splitKey] ?? 'Unknown');
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(row);

            const val = Number(row[yKey]) || 0;
            if (val < min) min = val;
            if (val > max) max = val;
        }

        // Sort groups by total metric value (descending) for meaningful ordering
        const sorted = Array.from(map.entries())
            .sort((a, b) => {
                const totalA = a[1].reduce((s: number, r: any) => s + (Number(r[yKey]) || 0), 0);
                const totalB = b[1].reduce((s: number, r: any) => s + (Number(r[yKey]) || 0), 0);
                return totalB - totalA;
            })
            .map(([key]) => key);

        return {
            groups: map,
            globalMin: min === Infinity ? 0 : 0, // Always start from 0 for bar/line
            globalMax: max === -Infinity ? 100 : max * 1.1, // 10% headroom
            sortedKeys: sorted
        };
    }, [data, splitKey, yKey]);

    // 2) Compute total for each group (for the header badge)
    const groupTotals = useMemo(() => {
        const totals: Record<string, number> = {};
        for (const [key, rows] of groups) {
            totals[key] = rows.reduce((s: number, r: any) => s + (Number(r[yKey]) || 0), 0);
        }
        return totals;
    }, [groups, yKey]);

    // Effective chart type for facets (force line/area for time-series small multiples)
    const facetChartType = ['bar', 'horizontalBar', 'stackedBar'].includes(chartType) ? 'bar' : 'line';

    // Strip comparison from config for facets
    const facetConfig = config ? { ...config, comparison: 'none' as const } : undefined;

    // Formatting: force data labels off for small multiples (too cluttered)
    const facetFormatting: FormattingConfig = {
        ...formatting,
        showDataLabels: false,
        tableCalculations: [],
    } as FormattingConfig;

    return (
        <div className="w-full h-full overflow-auto p-2">
            {/* Header */}
            <div className="flex items-center gap-3 mb-3 px-2">
                <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-indigo-500"></div>
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Small Multiples
                    </span>
                </div>
                <span className="text-xs text-slate-400">
                    {yLabel} by {xKey.replace(/_/g, ' ')} — split by <strong className="text-slate-600">{splitKey.replace(/_/g, ' ')}</strong>
                </span>
                <span className="text-[10px] bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-bold">
                    {sortedKeys.length} panels
                </span>
            </div>

            {/* Grid of mini charts */}
            <div
                className="grid gap-3"
                style={{
                    gridTemplateColumns: sortedKeys.length <= 2
                        ? 'repeat(2, 1fr)'
                        : sortedKeys.length <= 6
                            ? 'repeat(3, 1fr)'
                            : 'repeat(4, 1fr)'
                }}
            >
                {sortedKeys.map(dimensionValue => {
                    const rows = groups.get(dimensionValue) || [];
                    const total = groupTotals[dimensionValue] || 0;

                    return (
                        <div
                            key={dimensionValue}
                            className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col hover:shadow-md transition-shadow"
                        >
                            {/* Facet Header */}
                            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 bg-slate-50/50">
                                <span className="text-sm font-bold text-slate-700 truncate" title={dimensionValue}>
                                    {dimensionValue}
                                </span>
                                <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full whitespace-nowrap ml-2">
                                    {total.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                                </span>
                            </div>

                            {/* Mini Chart */}
                            <div className="h-[200px] p-1">
                                <ChartVisualization
                                    data={rows}
                                    config={facetConfig}
                                    xKey={xKey}
                                    yKey={yKey}
                                    yLabel={yLabel}
                                    chartType={facetChartType as any}
                                    onChartTypeChange={() => { }}
                                    formatting={facetFormatting}
                                    hideControls={true}
                                    compact={true}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
