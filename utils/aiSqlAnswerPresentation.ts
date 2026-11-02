/**
 * Turn an AI SQL pipeline result into what the chart components draw: an
 * AnalysisResult plus sensible formatting (currency, labels, axis size).
 * Shared by the chat (inline chart) and the full-screen answer page.
 */
import { AggregationType, AnalysisType, TimeGrain, type AnalysisResult, type FormattingConfig } from '../types';
import type { AISQLPipelineResult } from '../services/ai-sql/types';
import { aiSqlPresentationChart } from './chartSuggestions';
import { percentScaleFromSql } from './sqlPercentScale';

export const AI_SQL_DEFAULT_FORMATTING: FormattingConfig = {
    colorMode: 'vibrant',
    numberFormat: 'auto',
    fontSize: 'md',
    headerSize: 'xl',
    headerBold: true,
    headerColor: '#000000',
    showLabels: true,
    showDataLabels: true,
    tableCalculations: [],
    showAxis: true,
    showXAxis: true,
    showYAxis: true,
    axisColor: '#000000',
    axisBold: true,
    axisLabelSize: 'md',
    dataLabelColor: '#000000',
    dataLabelBold: true,
    dataLabelSize: 'md',
};

const CURRENCY_FORMAT: Record<string, FormattingConfig['numberFormat']> = { USD: 'currency_usd', GBP: 'currency_gbp', EUR: 'currency_eur' };
const AXIS_FORMAT: Record<string, FormattingConfig['numberFormat']> = { percent: 'percent', currency_usd: 'currency_usd', compact: 'compact' };

export function presentLeanAnswer(result: AISQLPipelineResult, questionLabel: string): { analysis: AnalysisResult; formatting: FormattingConfig } {
    const axisFormat = result.chart.leftAxisFormat === 'currency_usd' && result.chart.currency
        ? (CURRENCY_FORMAT[result.chart.currency] ?? 'auto')
        : result.chart.leftAxisFormat
            ? (AXIS_FORMAT[result.chart.leftAxisFormat] ?? 'auto') : 'auto';
    // A rate the SQL already multiplied by 100 must never be rescaled,
    // even when every value is below 1 (0.5 = 0.5%, not 50%).
    const numberFormat: FormattingConfig['numberFormat'] = axisFormat === 'percent'
        && percentScaleFromSql(result.sql, result.chart.yKey) === 'points' ? 'percent_points' : axisFormat;

    // Short rankings show their values; dense or time charts stay clean.
    const shownAs = aiSqlPresentationChart(result) as string;
    const labelLimit = shownAs === 'horizontalBar' ? 15 : ['bar', 'pie', 'doughnut', 'donut'].includes(shownAs) ? 12 : 8;
    const showLabels = result.chart.chartType !== 'table'
        && result.chart.chartType !== 'heatmap'
        && !['line', 'area', 'multiLine', 'stackedArea'].includes(shownAs)
        && !result.chart.pointLabelKeys
        && result.chartData.length <= labelLimit;
    const formatting: FormattingConfig = {
        ...AI_SQL_DEFAULT_FORMATTING,
        numberFormat,
        showDataLabels: showLabels,
        dataLabelMode: showLabels ? 'all' : 'off',
        axisLabelSize: shownAs === 'horizontalBar' ? 'sm' : AI_SQL_DEFAULT_FORMATTING.axisLabelSize,
    };

    const analysis: AnalysisResult = {
        data: result.chartData,
        xKey: result.chart.xKey,
        yKey: result.chart.yKey,
        yLabel: questionLabel,
        insight: result.explanation,
        sql: result.sql,
        config: {
            metric: result.plan.metrics[0]?.field || result.chart.yKey,
            dimension: result.plan.dimensions[0]?.field || result.chart.xKey,
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            questionId: 'ai_sql_' + Date.now(),
            questionLabel,
            secondaryMetrics: result.chart.secondaryYKeys,
            axisMode: result.chart.useDualAxis ? 'dual' : result.chart.singleAxis ? 'single' : 'auto',
            pointLabelKeys: result.chart.pointLabelKeys,
            secondaryMetricVisuals: result.chart.pointLabelKeys && shownAs === 'bar'
                ? Object.fromEntries((result.chart.secondaryYKeys || []).map(key => [key, 'bar']))
                : undefined,
            limit: result.plan.limit || 0,
            sort: result.plan.sort?.[0]?.dir || 'desc',
        },
        vis: shownAs as any,
        kpi: result.chart.chartType === 'kpiCard' && result.chartData.length > 0
            ? result.chartData[0][result.chart.yKey] : undefined,
        growth: result.chart.growth
            ? { diff: result.chart.growth.diff, pct: result.chart.growth.pct } : undefined,
        secondaryYKeys: result.chart.secondaryYKeys,
        visualizationMode: result.chart.chartType === 'table' ? 'grid' : 'auto',
    };
    return { analysis, formatting };
}
