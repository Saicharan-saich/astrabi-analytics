import React, { useMemo } from 'react';
import { AnalysisResult, FormattingConfig } from '../types';
import { resolveDimensionVisualization } from '../utils/dimensionVisualization';
import { ChartVisualization } from './ChartVisualization';
import { SmallMultiplesGrid } from './SmallMultiplesGrid';

interface DashboardResultVisualizationProps {
    result: AnalysisResult;
    data: Record<string, any>[];
    formatting?: FormattingConfig;
}

/** Replays the same dimensional layout in dashboard cards and presentation. */
export const DashboardResultVisualization: React.FC<DashboardResultVisualizationProps> = ({ result, data, formatting }) => {
    const layout = useMemo(() => resolveDimensionVisualization(
        data, result.xKey, result.yKey, result.config,
        result.visualizationMode || 'auto',
    ), [data, result.xKey, result.yKey, result.config, result.visualizationMode]);
    const chartType = (result.vis || 'bar') as any;

    if (layout.useGrid && layout.facetKey) {
        return (
            <SmallMultiplesGrid
                data={layout.rows}
                config={result.config}
                xKey={result.xKey}
                yKey={result.yKey}
                yLabel={result.yLabel}
                splitKey={layout.facetKey}
                seriesKey={layout.seriesKey}
                chartType={chartType}
                formatting={formatting}
            />
        );
    }

    return (
        <ChartVisualization
            config={result.config}
            data={layout.rows}
            xKey={result.xKey}
            yKey={result.yKey}
            yLabel={result.yLabel}
            chartType={chartType}
            seriesKey={layout.seriesKey}
            disableAutoSeries={layout.groupedDimensions.length > 1 && !layout.seriesKey}
            onChartTypeChange={() => {}}
            formatting={formatting}
            hideControls
        />
    );
};
