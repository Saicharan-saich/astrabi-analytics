/**
 * "Summarise my data" in the AI SQL chat: the top findings of the data story
 * (services/dataStory.ts), worked out in the browser from every row, with one
 * chart. No AI call, nothing sent.
 */
import { type AnalysisResult, type Dataset, type FormattingConfig, AggregationType, AnalysisType, TimeGrain } from '../../types';
import { AI_SQL_DEFAULT_FORMATTING } from '../../utils/aiSqlAnswerPresentation';
import { buildDataStory, type StoryChart } from '../dataStory';

export interface DatasetOverview {
    title: string;
    summary: string;
    insights: string[];
    analysis: AnalysisResult;
    formatting: FormattingConfig;
    rowCount: number;
}

/** A story chart in the shape the app's chart component draws. */
export function storyChartToAnalysis(chart: StoryChart, insight: string): { analysis: AnalysisResult; formatting: FormattingConfig } {
    const timeLike = chart.vis === 'area' || chart.vis === 'line';
    const labels = !timeLike && chart.data.length <= 12;
    const formatting: FormattingConfig = {
        ...AI_SQL_DEFAULT_FORMATTING,
        numberFormat: chart.numberFormat,
        showDataLabels: labels,
        dataLabelMode: labels ? 'all' : 'off',
        axisLabelSize: chart.vis === 'horizontalBar' ? 'sm' : 'md',
    };
    const analysis: AnalysisResult = {
        data: chart.data,
        xKey: chart.xKey,
        yKey: chart.yKey,
        yLabel: chart.yLabel,
        insight,
        sql: '',
        config: {
            metric: chart.yKey,
            dimension: chart.xKey,
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            questionId: `story_${chart.xKey}_${chart.yKey}`,
            questionLabel: chart.yLabel,
            limit: 0,
            sort: timeLike ? 'asc' : 'desc',
        },
        vis: chart.vis as any,
        visualizationMode: 'auto',
    };
    return { analysis, formatting };
}

export function buildDatasetOverview(dataset: Dataset, question = ''): DatasetOverview {
    const story = buildDataStory(dataset, question);
    const [overview, ...rest] = story.findings;
    const pick = rest.find(f => f.kind === 'plan' && f.chart) || rest.find(f => f.kind === 'trend' && f.chart) || rest.find(f => f.chart);
    const empty: StoryChart = { data: [], xKey: 'group', yKey: 'value', vis: 'bar', yLabel: '', numberFormat: 'auto' };
    const { analysis, formatting } = storyChartToAnalysis(pick?.chart || empty, overview?.headline || '');
    return {
        title: `Overview of ${story.title}`,
        summary: [overview?.headline, ...(overview?.points.slice(-1) || [])].filter(Boolean).join(' ') || `${story.title} has ${story.rowCount.toLocaleString('en-GB')} rows.`,
        insights: rest.slice(0, 5).map(f => f.headline),
        analysis,
        formatting,
        rowCount: story.rowCount,
    };
}
