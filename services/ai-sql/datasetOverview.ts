/**
 * "Summarise my data": an overview worked out in the browser from the rows —
 * size, the main measure's total and spread across the main grouping, the
 * trend over time, and gaps — with one chart. No AI call, nothing sent.
 */
import { ColumnType, type AnalysisResult, type Dataset, type FormattingConfig, AggregationType, AnalysisType, TimeGrain } from '../../types';
import { AI_SQL_DEFAULT_FORMATTING } from '../../utils/aiSqlAnswerPresentation';

export interface DatasetOverview {
    title: string;
    summary: string;
    insights: string[];
    analysis: AnalysisResult;
    formatting: FormattingConfig;
    rowCount: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const words = (name: string) => name.replace(/_/g, ' ');
const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const MONEY = /(revenue|sales|price|cost|amount|profit|spend|income|value|total|margin|fee|pay)/i;
const CURRENCY_FORMAT: Record<string, FormattingConfig['numberFormat']> = { GBP: 'currency_gbp', EUR: 'currency_eur', USD: 'currency_usd' };

function formatter(currency?: string) {
    const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : currency === 'USD' ? '$' : '';
    return (value: number) => {
        const abs = Math.abs(value);
        const sign = value < 0 ? '-' : '';
        if (abs >= 1e9) return `${sign}${symbol}${(abs / 1e9).toFixed(2)}bn`;
        if (abs >= 1e6) return `${sign}${symbol}${(abs / 1e6).toFixed(2)}m`;
        if (abs >= 1e4) return `${sign}${symbol}${(abs / 1e3).toFixed(1)}K`;
        return `${sign}${symbol}${abs.toLocaleString(undefined, { maximumFractionDigits: abs < 100 ? 2 : 0 })}`;
    };
}

export function buildDatasetOverview(dataset: Dataset): DatasetOverview {
    const rows = dataset.rows || [];
    const columns = dataset.columns.filter(column => !column.name.startsWith('__'));
    const measures = columns.filter(column => column.type === ColumnType.METRIC);
    const dimensions = columns.filter(column => column.type === ColumnType.DIMENSION);
    const dates = columns.filter(column => column.type === ColumnType.DATE);
    const name = dataset.name.replace(/\.[^.]+$/, '');

    // The measure people mean first: money with a currency, then money by name.
    const measure = measures.find(m => m.currency) || measures.find(m => MONEY.test(m.name)) || measures[0];
    const fmt = formatter(measure?.currency);
    const values = measure ? rows.map(row => row[measure.name]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : [];
    const total = values.reduce((sum, v) => sum + v, 0);

    // The grouping that says most: a few to a couple of dozen distinct values.
    const distinct = (column: string) => new Set(rows.map(row => row[column]).filter(v => !isBlank(v))).size;
    const grouping = dimensions
        .map(d => ({ d, n: distinct(d.name) }))
        .filter(item => item.n >= 2 && item.n <= 30)
        .sort((a, b) => Math.abs(a.n - 8) - Math.abs(b.n - 8))[0]?.d;
    const dateColumn = dates.find(d => rows.some(row => typeof row[d.name] === 'string' && /^\d{4}-\d{2}/.test(row[d.name])));

    const parts = [`${rows.length.toLocaleString()} rows and ${columns.length} columns`];
    if (measures.length) parts.push(`${measures.length} measure${measures.length === 1 ? '' : 's'} (${measures.slice(0, 4).map(m => words(m.name)).join(', ')}${measures.length > 4 ? ', …' : ''})`);
    if (dimensions.length) parts.push(`${dimensions.length} categor${dimensions.length === 1 ? 'y' : 'ies'} (${dimensions.slice(0, 4).map(d => words(d.name)).join(', ')}${dimensions.length > 4 ? ', …' : ''})`);
    let range = '';
    if (dateColumn) {
        const days = rows.map(row => row[dateColumn.name]).filter((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}/.test(v)).sort();
        if (days.length) range = `${monthLabel(days[0])} to ${monthLabel(days[days.length - 1])}`;
    }
    const summary = `${name} has ${parts.join(', ')}${range ? `, covering ${range}` : ''}.`;

    const insights: string[] = [];
    if (measure && values.length) {
        insights.push(`Total ${words(measure.name)} is ${fmt(total)}, an average of ${fmt(total / values.length)} per row.`);
    }
    let byGroup: { key: string; value: number }[] = [];
    if (measure && grouping) {
        const sums = new Map<string, number>();
        for (const row of rows) {
            const key = row[grouping.name];
            const v = row[measure.name];
            if (isBlank(key) || typeof v !== 'number') continue;
            sums.set(String(key), (sums.get(String(key)) || 0) + v);
        }
        byGroup = [...sums.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
        if (byGroup.length >= 2 && total) {
            const top = byGroup[0], bottom = byGroup[byGroup.length - 1];
            insights.push(`By ${words(grouping.name)}, ${top.key} leads with ${fmt(top.value)} (${((top.value / total) * 100).toFixed(1)}% of the total); ${bottom.key} is lowest at ${fmt(bottom.value)}.`);
        }
    }
    let byMonth: { key: string; value: number }[] = [];
    if (measure && dateColumn) {
        const sums = new Map<string, number>();
        for (const row of rows) {
            const day = row[dateColumn.name];
            const v = row[measure.name];
            if (typeof day !== 'string' || !/^\d{4}-\d{2}/.test(day) || typeof v !== 'number') continue;
            const key = `${day.slice(0, 7)}-01`;
            sums.set(key, (sums.get(key) || 0) + v);
        }
        byMonth = [...sums.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key));
        if (byMonth.length >= 3) {
            const peak = byMonth.reduce((best, item) => (item.value > best.value ? item : best), byMonth[0]);
            const last = byMonth[byMonth.length - 1];
            insights.push(`Monthly ${words(measure.name)} peaked in ${monthLabel(peak.key)} at ${fmt(peak.value)}; the latest month, ${monthLabel(last.key)}, was ${fmt(last.value)}.`);
        }
    }
    const gaps = columns
        .map(column => ({ column, share: rows.length ? rows.filter(row => isBlank(row[column.name])).length / rows.length : 0 }))
        .filter(item => item.share > 0)
        .sort((a, b) => b.share - a.share);
    insights.push(gaps.length
        ? `${gaps.length} column${gaps.length === 1 ? ' has' : 's have'} missing values; the most is ${words(gaps[0].column.name)} (${Math.round(gaps[0].share * 100)}% blank).`
        : 'No column has missing values.');

    // One chart: the main measure over time, or across the main grouping.
    const useTime = byMonth.length >= 3;
    const xKey = useTime ? 'month' : (grouping?.name || 'group');
    const yKey = measure ? `total_${measure.name}` : 'rows';
    const data = useTime
        ? byMonth.map(item => ({ month: item.key, [yKey]: Math.round(item.value * 100) / 100 }))
        : byGroup.slice(0, 12).map(item => ({ [xKey]: item.key, [yKey]: Math.round(item.value * 100) / 100 }));
    const vis = useTime ? 'area' : byGroup.length > 6 ? 'horizontalBar' : 'bar';
    const formatting: FormattingConfig = {
        ...AI_SQL_DEFAULT_FORMATTING,
        numberFormat: (measure?.currency && CURRENCY_FORMAT[measure.currency]) || 'auto',
        showDataLabels: !useTime && data.length <= 12,
        dataLabelMode: !useTime && data.length <= 12 ? 'all' : 'off',
        axisLabelSize: vis === 'horizontalBar' ? 'sm' : 'md',
    };
    const analysis: AnalysisResult = {
        data,
        xKey,
        yKey,
        yLabel: measure ? `Total ${words(measure.name)}` : 'Rows',
        insight: summary,
        sql: '',
        config: {
            metric: measure?.name || yKey,
            dimension: xKey,
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            questionId: `overview_${Date.now()}`,
            questionLabel: `Overview of ${name}`,
            limit: 0,
            sort: useTime ? 'asc' : 'desc',
        },
        vis: vis as any,
        visualizationMode: 'auto',
    };
    return { title: `Overview of ${name}`, summary, insights: insights.slice(0, 5), analysis, formatting, rowCount: rows.length };
}
