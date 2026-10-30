import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
// html2canvas is only needed when the user exports a chart to PNG — load it
// lazily so it stays out of the initial bundle.
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    BarElement,
    ArcElement,
    Title,
    Tooltip,
    Legend,
    Filler,
    Plugin, // Import Plugin type
    RadialLinearScale,
    DoughnutController,
    PieController
} from 'chart.js';
import { Chart, Bar, Line, Pie, Doughnut, PolarArea, Radar, Scatter, Bubble } from 'react-chartjs-2';
import { TreemapController, TreemapElement } from 'chartjs-chart-treemap';
import {
    BarChart2, LineChart as LineChartIcon, TrendingUp, PieChart as PieIcon,
    Activity, Grid, Disc, Palette, Download, ZoomIn, ZoomOut, RotateCcw, Globe,
    LayoutGrid, Circle, Hexagon, ScatterChart, CircleDot, ChevronDown
} from 'lucide-react';

// Register Chart.js components
ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    BarElement,
    ArcElement,
    Title,
    Tooltip,
    Legend,
    Filler,
    RadialLinearScale,
    DoughnutController,
    PieController,
    TreemapController,
    TreemapElement
);

// Charts use the same typeface as the rest of the UI (Inter, see index.css)
// so axis ticks, legends and tooltips read as part of the interface.
const CHART_FONT_FAMILY = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
ChartJS.defaults.font.family = CHART_FONT_FAMILY;

import { Dataset, ColumnType, AggregationType, QueryConfig, AnalysisResult, TimeGrain, AnalysisType, ChartConfig, FormattingConfig } from '../types';
import { applyTableCalculation } from '../utils/tableCalculations';
import {
    FONT_SIZES,
    resolveColorEncoding, selectPalette, createGradient, createBarGradient, lightenColor,
    generateColors as genColors,
    formatNumber as formatNum, formatDateLabel
} from '../utils/chartUtils';
import { sanitizeRows } from '../utils/numberSafety';
import { effectiveDataLabelMode, shouldRenderDataLabel } from '../utils/dataLabelVisibility';
import { layoutChartLabels } from '../utils/chartLabelLayout';
import { fitPieLabelText, layoutPieLabelRows } from '../utils/pieLabelLayout';
import { extraTooltipMetricKeys, readableChartTextColor } from '../utils/chartPresentation';
import { MapChart } from './MapChart';
import { CHART_TYPE_OPTIONS } from './charts/chartRegistry';
import { doughnutCenterPlugin, stackTotalsPlugin } from './charts/cleanChartPlugins';

interface ChartVisualizationProps {
    data: any[];
    config?: QueryConfig; // Make it optional just in case
    xKey: string;
    yKey: string;
    chartType: 'bar' | 'horizontalBar' | 'stackedBar' | 'groupedBar' | 'line' | 'area' | 'stackedArea' | 'steppedLine' | 'curvedLine' | 'pie' | 'doughnut' | 'polarArea' | 'radar' | 'scatter' | 'bubble' | 'treemap' | 'map' | 'waterfall' | 'funnel' | 'lollipop' | 'gauge' | 'kpiCard' | 'combo';
    onChartTypeChange: (type: any) => void;
    yLabel?: string;
    formatting?: FormattingConfig;
    onToggleFormat?: () => void;
    isFormatOpen?: boolean;
    onToggleAnalytics?: () => void;
    isAnalyticsOpen?: boolean;
    onToggleLabels?: () => void;
    hideControls?: boolean;
    compact?: boolean;
    onDrillDown?: (dimensionValue: string) => void;
    onGoBack?: () => void;
    onAIInsight?: () => void;
    isAIInsightOpen?: boolean;
    chartContainerRef?: React.RefObject<HTMLDivElement | null>;
    /** Concise legend/axis label; yLabel may remain the full question elsewhere. */
    seriesLabel?: string;
    /** Explicit grouping field; prevents another string column from stealing the legend. */
    seriesKey?: string;
    /** Shared numeric scale for comparable small-multiple panels. */
    axisRange?: { min: number; max: number };
    /** Prevent incidental string columns (such as paired IDs) becoming chart series. */
    disableAutoSeries?: boolean;
}

// Chart type registry now imported from ./charts/chartRegistry
const _CHART_TYPE_OPTIONS_REMOVED = [
    {
        category: 'Bar Charts',
        items: [
            { id: 'bar', icon: BarChart2, label: 'Vertical Bar' },
            { id: 'horizontalBar', icon: BarChart2, label: 'Horizontal Bar' },
            { id: 'stackedBar', icon: LayoutGrid, label: 'Stacked Bar' },
            { id: 'groupedBar', icon: BarChart2, label: 'Grouped Bar' },
        ]
    },
    {
        category: 'Line Charts',
        items: [
            { id: 'line', icon: LineChartIcon, label: 'Line' },
            { id: 'curvedLine', icon: LineChartIcon, label: 'Curved Line' },
            { id: 'steppedLine', icon: LineChartIcon, label: 'Stepped Line' },
            { id: 'area', icon: TrendingUp, label: 'Area' },
            { id: 'stackedArea', icon: TrendingUp, label: 'Stacked Area' },
        ]
    },
    {
        category: 'Circular Charts',
        items: [
            { id: 'pie', icon: PieIcon, label: 'Pie' },
            { id: 'doughnut', icon: Disc, label: 'Donut' },
            { id: 'polarArea', icon: Circle, label: 'Polar Area' },
            { id: 'radar', icon: Hexagon, label: 'Radar' },
        ]
    },
    {
        category: 'Statistical',
        items: [
            { id: 'scatter', icon: ScatterChart, label: 'Scatter Plot' },
            { id: 'bubble', icon: CircleDot, label: 'Bubble' },
        ]
    },
    {
        category: 'Part-to-Whole',
        items: [
            { id: 'treemap', icon: Grid, label: 'Treemap' },
            { id: 'waterfall', icon: BarChart2, label: 'Waterfall' },
            { id: 'funnel', icon: Activity, label: 'Funnel' },
        ]
    },
    {
        category: 'KPI & Specialized',
        items: [
            { id: 'gauge', icon: Activity, label: 'Gauge' },
            { id: 'kpiCard', icon: LayoutGrid, label: 'KPI Card' },
            { id: 'lollipop', icon: CircleDot, label: 'Lollipop' },
            { id: 'map', icon: Globe, label: 'Geo Map' },
        ]
    }
];

// Categorical chart types where every row becomes its own mark (bar/slice). A
// high-cardinality dimension (e.g. SUM by patient name over thousands of names)
// would render thousands of marks + labels and freeze the tab. Cap these to the
// top-N by magnitude. Time-series/scatter are left alone (a line handles many
// points fine).
const CATEGORICAL_CHART_TYPES = new Set([
    'bar', 'horizontalBar', 'stackedBar', 'groupedBar', 'pie', 'doughnut',
    'polarArea', 'lollipop', 'funnel', 'treemap', 'waterfall', 'radar',
]);
// Absolute safety ceiling regardless of any user setting — prevents the freeze.
const MAX_RENDER_CATEGORIES = 100;

/** Chart types whose marks ARE the categories, so each keeps its own colour. */
const PER_CATEGORY_COLOUR_TYPES = new Set(['pie', 'doughnut', 'polarArea', 'radar', 'treemap', 'funnel', 'waterfall', 'gauge']);

function capCategoriesForRender(rows: any[], chartType: string, yKey: string, maxCategories?: number): { rows: any[]; truncatedFrom: number } {
    const cap = Math.min(maxCategories && maxCategories > 0 ? maxCategories : MAX_RENDER_CATEGORIES, MAX_RENDER_CATEGORIES);
    if (!CATEGORICAL_CHART_TYPES.has(chartType) || rows.length <= cap) {
        return { rows, truncatedFrom: 0 };
    }
    // Keep the largest categories so the chart still tells the top story.
    const sorted = [...rows].sort((a, b) => (Math.abs(Number(b[yKey])) || 0) - (Math.abs(Number(a[yKey])) || 0));
    return { rows: sorted.slice(0, cap), truncatedFrom: rows.length };
}

export const ChartVisualization: React.FC<ChartVisualizationProps> = ({
    data,
    xKey,
    yKey,
    chartType,
    onChartTypeChange,
    yLabel,
    config, // Destructure Config
    formatting,
    onToggleFormat,
    isFormatOpen,
    onToggleAnalytics,
    isAnalyticsOpen,
    onToggleLabels,
    hideControls = false,
    compact = false,
    onDrillDown,
    onGoBack,
    onAIInsight,
    isAIInsightOpen,
    chartContainerRef,
    seriesLabel,
    seriesKey,
    axisRange,
    disableAutoSeries = false
}) => {
    // Chart ref for PNG export
    // Chart ref for PNG export
    const chartRef = useRef<any>(null);
    const localChartRef = useRef<HTMLDivElement>(null);
    const transformedDataRef = useRef<any[]>([]);
    const resolvedRef = (chartContainerRef || localChartRef) as React.RefObject<HTMLDivElement>;
    const [zoom, setZoom] = useState(1);
    const [chartSelectorOpen, setChartSelectorOpen] = useState(false);

    // The chart surface follows the app theme. Reading an ancestor's computed
    // background-color is unreliable for gradient-backed cards (it is often
    // transparent even when the rendered surface is dark).
    const [isDark, setIsDark] = useState(() =>
        typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
    const detectSurface = useCallback(() => {
        setIsDark(typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
    }, []);
    useEffect(() => {
        detectSurface();
        if (typeof document === 'undefined') return;
        const obs = new MutationObserver(() => detectSurface());
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => obs.disconnect();
    }, [detectSurface, chartType, data]);

    const exportChart = useCallback(async () => {
        if (resolvedRef.current) {
            try {
                const { default: html2canvas } = await import('html2canvas');
                // Capture the visualization container with high resolution
                const canvas = await html2canvas(resolvedRef.current, {
                    scale: 3, // High resolution (300 DPI equivalent)
                    useCORS: true, // Allow external images if any
                    backgroundColor: document.documentElement.classList.contains('dark') ? '#0f172a' : '#ffffff', // Capture theme background (Slate-900 vs White)
                    logging: false,
                    ignoreElements: (element) => element.classList.contains('no-export') // Optional: ignore specific controls
                });

                const base64 = canvas.toDataURL('image/png');
                const a = document.createElement('a');
                a.href = base64;
                a.download = `chart-${yLabel || 'visualization'}.png`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } catch (err) {
                console.error('Export failed:', err);
                alert('Failed to export chart. Please try again.');
            }
        } else if (chartRef.current) {
            // Fallback for Chart.js only (lower quality, no bg)
            const base64 = chartRef.current.toBase64Image();
            const a = document.createElement('a');
            a.href = base64;
            a.download = `chart-${yLabel || 'export'}.png`;
            a.click();
        }
    }, [yLabel, resolvedRef]);
    // console.log('[ChartVisualization] Formatting:', formatting);

    // Apply table calculations — chart uses the FIRST selected calculation for its Y-axis
    const activeCalcs = (formatting?.tableCalculations || []).filter(c => c !== 'none');
    const primaryCalc = activeCalcs.length > 0 ? activeCalcs[0] : null;

    const { transformedData, yLabel: calculatedYLabel, suggestedNumberFormat, truncatedFrom } = useMemo(() => {
        const result = !primaryCalc
            ? {
                transformedData: data,
                yLabel: seriesLabel || yLabel || '',
                suggestedNumberFormat: formatting?.numberFormat || 'raw'
            }
            : applyTableCalculation(
                data,
                yKey,
                primaryCalc,
                yLabel || '',
                formatting?.numberFormat,
                undefined,
                formatting?.movingAvgWindow || 3,
                formatting?.tableCalculationComparison
                    ? { ...formatting.tableCalculationComparison, dimensionKey: xKey }
                    : undefined
            );
        // Output-boundary safety net: no NaN/Infinity can ever reach a chart,
        // regardless of which engine or table-calc produced the data.
        const sanitized = sanitizeRows(result.transformedData);
        // Cap high-cardinality categorical charts so thousands of marks can't
        // freeze the tab. Honors an optional user "max categories" setting.
        const { rows: capped, truncatedFrom } = capCategoriesForRender(
            sanitized, chartType, yKey, (formatting as any)?.maxCategories,
        );
        return { ...result, transformedData: capped, truncatedFrom };
    }, [data, xKey, yKey, primaryCalc, yLabel, seriesLabel, formatting?.numberFormat, formatting?.movingAvgWindow, formatting?.tableCalculationComparison, chartType, (formatting as any)?.maxCategories]);

    // Calculation output semantics take precedence over the source metric. For
    // example, "% of Total (Sales)" is a percentage, while rank is ordinal.
    const calculationNumberFormat = primaryCalc === 'percent_of_total' || primaryCalc === 'pct_diff_from_prev' || primaryCalc === 'percentile'
        ? 'percent'
        : primaryCalc === 'rank_asc' || primaryCalc === 'rank_desc' || primaryCalc === 'std_dev' || primaryCalc === 'z_score' || primaryCalc === 'variance'
            ? 'raw'
            : undefined;
    const activeNumberFormat = calculationNumberFormat || suggestedNumberFormat || formatting?.numberFormat || 'raw';

    // Helper for number formatting — uses activeNumberFormat which includes table calculation overrides
    const formatNumber = (value: number | undefined | null) => {
        if (value === undefined || value === null || isNaN(value)) return '0';

        let effectiveFormat: string | undefined = activeNumberFormat;

        // Intelligent Auto-Format
        if (!effectiveFormat || effectiveFormat === 'auto') {
            // Combine all available hints: config.metric, yLabel, and yKey
            const metricRef = (config?.metric || yLabel || yKey || '').toLowerCase();
            const metricName = metricRef;
            // Also check the raw question/label (yLabel) for leading "%" patterns
            const rawLabel = (yLabel || '').toLowerCase();

            // Check for explicit COUNT aggregation first - ALWAYS a number
            if (metricName.includes('count') || metricName.includes('quantity') || metricName.includes('volume') || metricName.includes('users') || metricName.includes('sessions')) {
                effectiveFormat = 'compact'; // Use compact for counts (1.2k, 5M) or raw if small
                if (value < 1000) effectiveFormat = 'raw';
            }
            // Check for %-of-total labels FIRST — before currency grabs "revenue"
            // Catches questions like "% Revenue by Product Today" where rawLabel starts with %
            // BUT EXCLUDE change/growth questions like "% Revenue Change vs Yesterday"
            // where bars show actual revenue values, not percentages
            // Check for _pct/_percent suffix FIRST — e.g., sales_pct should be % not $
            else if (/[_\s](pct|percent|share|ratio)$/i.test(metricName) || /^pct_/i.test(metricName)) {
                effectiveFormat = 'percent';
            }
            else if (
                (rawLabel.startsWith('%') && !rawLabel.includes('change') && !rawLabel.includes('growth') && !rawLabel.includes('vs')) ||
                rawLabel.includes('% of') || rawLabel.includes('percent of') ||
                /\bshare\b/.test(metricName) ||
                /\bdiscount\b/.test(metricName) || /\bmarkdown\b/.test(metricName) ||
                (/\brate\b/.test(metricName) && !/\b(hourly|daily|weekly|monthly|annual|yearly|billing|bill|pay|charge|base|flat)\s*_?\s*rate\b/.test(metricName)) ||
                /\bconversion\b/.test(metricName) || /\bratio\b/.test(metricName)
            ) {
                effectiveFormat = 'percent';
            }
            // Check for Currency indicators
            else if (metricName.includes('sales') || metricName.includes('revenue') || metricName.includes('price') || metricName.includes('cost') || metricName.includes('amount') || metricName.includes('profit') || metricName.includes('margin')) {
                effectiveFormat = 'currency_usd';
            }
            // Default fallbacks
            else {
                effectiveFormat = 'compact';
            }
        }

        const fractionDigits = formatting?.decimals !== undefined ? formatting.decimals : (effectiveFormat === 'currency_usd' || effectiveFormat === 'percent' ? 2 : 0);

        try {
            switch (effectiveFormat) {
                case 'raw':
                    return new Intl.NumberFormat('en-US', {
                        minimumFractionDigits: fractionDigits,
                        maximumFractionDigits: fractionDigits
                    }).format(value);
                case 'currency_usd':
                    return new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                        minimumFractionDigits: fractionDigits,
                        maximumFractionDigits: fractionDigits
                    }).format(value);
                case 'currency_eur':
                    return new Intl.NumberFormat('de-DE', {
                        style: 'currency',
                        currency: 'EUR',
                        minimumFractionDigits: fractionDigits,
                        maximumFractionDigits: fractionDigits
                    }).format(value);
                case 'percent': {
                    // Fractional percents (e.g. 0.073) are stored as 0–1; scale to 7.3%.
                    // Matches formatForMetricName so every surface is consistent.
                    const pctVal = (Math.abs(value) <= 1 && Math.abs(value) > 0) ? value * 100 : value;
                    return pctVal.toFixed(fractionDigits) + '%';
                }
                case 'compact': {
                    // Premium compact: one decimal for large values ($1.2M, 15.3K),
                    // clean integers below 1000 — unless the user pinned a decimal count.
                    const cd = formatting?.decimals !== undefined
                        ? formatting.decimals
                        : (Math.abs(value) >= 1000 ? 1 : 0);
                    return new Intl.NumberFormat('en-US', {
                        notation: 'compact',
                        compactDisplay: 'short',
                        minimumFractionDigits: 0,
                        maximumFractionDigits: cd
                    }).format(value);
                }
                default:
                    return value.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
            }
        } catch {
            return value.toLocaleString();
        }
    };

    // Compact formatter for ON-CHART data labels: keeps them short and premium
    // ($1.36M, not $1,358,215.74) so bars aren't buried under giant numbers.
    // Tooltips/axes keep their own (fuller) precision.
    const formatCompactLabel = (value: number | undefined | null) => {
        if (value === undefined || value === null || isNaN(value)) return '0';
        const abs = Math.abs(value);
        const metricRef = (config?.metric || yLabel || yKey || '').toLowerCase();
        const autoDetect = !activeNumberFormat || activeNumberFormat === 'auto';
        const isCurrency = activeNumberFormat === 'currency_usd' || activeNumberFormat === 'currency_eur'
            || (autoDetect && /(sales|revenue|price|cost|amount|profit|margin|spend|payment|balance|budget|salary)/.test(metricRef));
        if (isCurrency && abs >= 1000) {
            return new Intl.NumberFormat('en-US', {
                style: 'currency', currency: activeNumberFormat === 'currency_eur' ? 'EUR' : 'USD',
                notation: 'compact', compactDisplay: 'short', minimumFractionDigits: 0, maximumFractionDigits: 1,
            }).format(value);
        }
        // Non-currency large magnitudes → compact; everything else uses the
        // standard formatter (percent, small ints, etc.).
        if (!isCurrency && abs >= 10000) {
            return new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 1 }).format(value);
        }
        return formatNumber(value);
    };

    // Per-metric format resolver — given a column name, returns formatted value
    const formatForMetricName = (value: number, metricName: string): string => {
        const name = metricName.toLowerCase();
        let fmt: string;
        let fd: number;
        // Check _pct/_percent suffix FIRST — e.g., sales_pct must be % not $
        if (/[_ ](pct|percent|share|ratio)$/i.test(name) || /^pct[_ ]/i.test(name)) {
            fmt = 'percent';
            fd = 2;
        } else if (name.includes('count') || name.includes('quantity') || name.includes('units') || name.includes('volume') || name.includes('orders') || name.includes('users') || name.includes('sessions')) {
            fmt = value < 1000 ? 'raw' : 'compact';
            fd = 0;
        } else if (name.includes('discount') || (name.includes('rate') && !/\b(hourly|daily|weekly|monthly|annual|yearly|billing|bill|pay|charge|base|flat)[_ ]?rate\b/.test(name)) || name.includes('ratio') || name.includes('percent') || name.includes('share') || name.includes('conversion') || name.includes('margin_pct')) {
            fmt = 'percent';
            fd = 2;
        } else if (name.includes('sales') || name.includes('revenue') || name.includes('price') || name.includes('cost') || name.includes('amount') || name.includes('profit') || name.includes('margin') || name.includes('billing') || name.includes('payment') || name.includes('fee') || name.includes('charge') || name.includes('salary') || name.includes('income') || name.includes('expense')) {
            fmt = 'currency_usd';
            fd = 2;
        } else if (name.includes('score') || name.includes('rating') || name.includes('index') || name.includes('grade') || name.includes('satisfaction') || name.includes('nps') || name.includes('csat')) {
            // Scores/ratings: show with 2 decimal places for precision
            fmt = 'score';
            fd = 2;
        } else if (name.includes('average') || name.includes('avg') || name.includes('mean') || name.includes('median')) {
            // Averages often have meaningful decimals
            fmt = 'score';
            fd = 2;
        } else {
            // For small values with decimals, show decimals; for large values, compact
            if (Math.abs(value) < 100 && value % 1 !== 0) {
                fmt = 'score';
                fd = 2;
            } else {
                fmt = value < 1000 ? 'raw' : 'compact';
                fd = 0;
            }
        }
        try {
            switch (fmt) {
                case 'currency_usd': return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: fd, maximumFractionDigits: fd }).format(value);
                case 'percent': {
                    const pctVal = (Math.abs(value) <= 1 && Math.abs(value) > 0) ? value * 100 : value;
                    return pctVal.toFixed(fd) + '%';
                }
                case 'compact': return new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short' }).format(value);
                case 'score': return new Intl.NumberFormat('en-US', { minimumFractionDigits: fd, maximumFractionDigits: fd }).format(value);
                default: return new Intl.NumberFormat('en-US', { minimumFractionDigits: fd, maximumFractionDigits: fd }).format(value);
            }
        } catch { return value.toLocaleString(); }
    };

    const formatCompactMetricLabel = (value: number, metricName: string): string => {
        const full = formatForMetricName(value, metricName);
        if (Math.abs(value) >= 1000 && full.includes('$')) {
            return new Intl.NumberFormat('en-US', {
                style: 'currency', currency: 'USD', notation: 'compact',
                maximumFractionDigits: 1,
            }).format(value);
        }
        return full;
    };

    // Compact axis formatter — uses K/M/B by default for axis ticks to save space
    const formatAxisNumber = (value: number | undefined | null) => {
        if (value === undefined || value === null || isNaN(value)) return '0';
        if (value === 0) return '0';

        const axisFormat = formatting?.yAxisFormat || 'compact';

        if (axisFormat === 'full') {
            return formatNumber(value);
        }

        // A table calculation changes what the values mean. Only infer from the
        // source metric when no calculation (or user-selected format) specifies it.
        const metricRef = (config?.metric || yLabel || yKey || '').toLowerCase();
        const hasExplicitFormat = activeNumberFormat !== 'auto';
        const isCurrency = activeNumberFormat === 'currency_usd' || activeNumberFormat === 'currency_eur' ||
            (!hasExplicitFormat && (metricRef.includes('sales') || metricRef.includes('revenue') ||
                metricRef.includes('price') || metricRef.includes('cost') ||
                metricRef.includes('amount') || metricRef.includes('profit')));
        const isPercent = activeNumberFormat === 'percent' ||
            (!hasExplicitFormat && (metricRef.includes('percent') || (metricRef.includes('rate') && !/\b(hourly|daily|weekly|monthly|annual|yearly|billing|bill|pay|charge|base|flat)[_ ]?rate\b/.test(metricRef)) ||
                metricRef.includes('ratio') || metricRef.includes('share') ||
                /\bdiscount\b/.test(metricRef) || metricRef.includes('markdown')));

        if (isPercent) {
            // Scale fractional percents (0.073 → 7.3%) so axis ticks read correctly.
            const pctVal = (Math.abs(value) <= 1 && Math.abs(value) > 0) ? value * 100 : value;
            return pctVal.toFixed(1) + '%';
        }

        if (axisFormat === 'short_currency' && isCurrency) {
            // $800K, $1.2M format
            const abs = Math.abs(value);
            const sign = value < 0 ? '-' : '';
            if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
            if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
            if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
            return `$${value.toFixed(0)}`;
        }

        // Default compact: $800K / 1.2M / 500
        const abs = Math.abs(value);
        const sign = value < 0 ? '-' : '';
        const prefix = isCurrency ? '$' : '';
        if (abs >= 1e9) return `${sign}${prefix}${(abs / 1e9).toFixed(1)}B`;
        if (abs >= 1e6) return `${sign}${prefix}${(abs / 1e6).toFixed(1)}M`;
        if (abs >= 1e3) return `${sign}${prefix}${(abs / 1e3).toFixed(1)}K`;
        if (isCurrency) return `$${value.toFixed(0)}`;
        return value.toLocaleString();
    };

    // Prepare chart data
    const chartData = useMemo(() => {
        if (!transformedData || transformedData.length === 0) return null;
        // Keep ref in sync so Chart.js plugins always read the latest data
        transformedDataRef.current = transformedData;

        const formatDate = (val: string) => {
            const format = formatting?.dateFormat || 'auto';
            if (!val) return val;
            if (format === 'raw') return val;

            // Handle Quarter (2023-Q1) manually if needed, or assume standard date strings
            // If val is not a date-like string, return raw
            if (!val.match(/^\d{4}/)) return val;

            try {
                // Parse date carefully to avoid timezone shifts
                // Treating YYYY-MM-DD as simple text parts is safer than new Date() for formatting
                const parts = val.split(/[-/]/);
                // Standard ISO: YYYY-MM-DD
                let y = parseInt(parts[0]);
                let m = parseInt(parts[1]) - 1; // 0-indexed
                let d = parseInt(parts[2]) || 1;

                if (isNaN(m)) return val; // Safety fallback

                const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
                const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

                if (format === 'auto') {
                    // Check grain based on parts length
                    // YYYY-MM (parts[2] is usually undefined or empty if split by -)
                    const isMonthGrain = (parts.length === 2 && m <= 11) || (!parts[2] && m <= 11);

                    // Detect Week Grain: If month index > 11 (e.g. 52), it's a week number
                    // Or if config explicitly says 'week'
                    const isWeekGrain = m > 11 || (config?.timeGrain as string) === 'week';

                    if (isWeekGrain) {
                        // Reconstruct week number (m was 0-indexed from parts[1])
                        return `${y}-W${m + 1}`;
                    }

                    if (isMonthGrain) {
                        return `${shortMonths[m] || ''} ${y}`; // "Nov 2017"
                    }
                    // Day grain
                    return `${shortMonths[m] || ''} ${d}, ${y}`; // "Nov 5, 2017"
                }

                switch (format) {
                    case 'yyyy-mm-dd': return val;
                    case 'mm/dd/yyyy':
                        return `${String(m + 1).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
                    case 'month_name_year':
                        return `${months[m]} ${y}`;
                    case 'month_short_year':
                        return `${shortMonths[m]} '${String(y).substring(2)}`;
                    case 'month_number':
                        return String(m + 1);
                    case 'month_name_only':
                        return months[m];
                    default: return val;
                }
            } catch (e) {
                return val;
            }
        };

        const labels = transformedData.map(d => formatDate(String(d[xKey] ?? '')));
        const values = transformedData.map(d => Number(d[yKey]) || 0);

        const isPieChart = chartType === 'pie' || chartType === 'doughnut' || chartType === 'polarArea' || chartType === 'radar' || chartType === 'gauge';

        // Override chartType for dataset styling when comparison exists with few data points
        // This ensures bar-appropriate styling (solid fill, no points, rounded corners)
        const compOff = !config?.comparison || config?.comparison === 'none';
        const hasCompData = !compOff && transformedData.some(d => d.previous_value !== undefined);
        const fewPoints = transformedData.length <= 4;
        const lineTypes = ['line', 'area', 'steppedLine', 'curvedLine', 'stackedArea'];
        const effectiveType = (hasCompData && fewPoints && lineTypes.includes(chartType))
            ? 'bar' : chartType;

        const isBarVariant = effectiveType === 'bar' || effectiveType === 'horizontalBar' || effectiveType === 'stackedBar' || effectiveType === 'groupedBar' || effectiveType === 'waterfall' || effectiveType === 'funnel' || effectiveType === 'lollipop' || effectiveType === 'combo';
        const isLineVariant = effectiveType === 'line' || effectiveType === 'area' || effectiveType === 'stackedArea' || effectiveType === 'steppedLine' || effectiveType === 'curvedLine';

        // TREEMAP DATA TRANSFORMATION
        if (chartType === 'treemap') {
            const encoding = resolveColorEncoding(formatting, xKey, transformedData, chartType);
            const treeColors = genColors(values, selectPalette(formatting, xKey, transformedData, chartType), encoding === 'sequential');
            return {
                datasets: [{
                    label: calculatedYLabel || 'Value',
                    tree: transformedData,
                    key: yKey,
                    groups: [xKey],
                    backgroundColor: (ctx: any) => {
                        if (ctx.type !== 'data') return 'transparent';
                        return treeColors[(ctx.dataIndex ?? 0) % treeColors.length];
                    },
                    borderColor: '#fff',
                    borderWidth: 3,
                    spacing: 2,
                    labels: {
                        display: true,
                        align: 'left',
                        position: 'top',
                        color: 'white',
                        font: { size: 12, weight: 'bold' },
                        formatter: (ctx: any) => {
                            if (ctx.type !== 'data') return;
                            return `${ctx.raw.g}\n${formatNumber(ctx.raw.v)}`;
                        }
                    }
                }]
            };
        }

        // Time periods encode a low-to-high measure; named categories encode
        // identity. The appearance panel can explicitly override this choice.
        // Clean style: a single-series chart uses ONE colour by default, as in
        // most BI tools — colour then only ever means "a different series".
        // Choosing "Low → high" or "Categories" in Appearance still applies a
        // value ramp or per-category colours; part-to-whole charts keep
        // per-category colours because the slices are the series.
        const encodingIsAuto = !formatting?.colorEncoding || (formatting.colorEncoding as string) === 'auto';
        const singleHue = encodingIsAuto && !PER_CATEGORY_COLOUR_TYPES.has(chartType);
        const useSequential = !singleHue && resolveColorEncoding(formatting, xKey, transformedData, chartType) === 'sequential';
        let palette = singleHue
            ? [selectPalette({ ...formatting, colorEncoding: 'discrete' } as any, xKey, transformedData, chartType)[0]]
            : selectPalette(formatting, xKey, transformedData, chartType);

        // Keep the auto blue value ramp visible on both surfaces: high values
        // become darker on light charts and brighter on dark charts.
        if (useSequential && (!formatting?.colorMode || formatting.colorMode === 'vibrant')) {
            palette = isDark
                ? ['#417a9f', '#4887ae', '#4f94bc', '#57a2cb', '#60b0da', '#6abfe9', '#77cef4']
                : ['#4f91c2', '#4888bd', '#407eb5', '#3874aa', '#306a9e', '#285f90', '#205481'];
        }

        const baseColor = palette[Math.floor(palette.length / 2)]; // Mid-tone
        const borderColor = palette[Math.floor(palette.length / 3)]; // Darker shade

        // Generate colors for multiple data points
        const generateColors = (input: number | number[]) => genColors(input, palette, useSequential);

        // KPI Card: no Chart.js dataset needed (comparison handled in renderChart inline)
        if (chartType === 'kpiCard') {
            return { labels: [], datasets: [] };
        }

        // Gauge: special doughnut dataset
        if (chartType === 'gauge') {
            const total = values.reduce((a, b) => a + b, 0);
            const maxVal = Math.max(...values) * 1.2;
            return {
                labels: ['Value', 'Remaining'],
                datasets: [{
                    data: [total, Math.max(0, maxVal - total)],
                    backgroundColor: [baseColor, '#e2e8f0'],
                    borderWidth: 0,
                    circumference: 180,
                    rotation: 270,
                    cutout: '75%',
                }]
            };
        }

        // Waterfall: compute running totals with positive/negative coloring
        if (chartType === 'waterfall') {
            const waterfallData: number[] = [];
            const waterfallBase: number[] = [];
            const bgColors: string[] = [];
            let cumulative = 0;
            values.forEach((v, i) => {
                waterfallBase.push(cumulative);
                waterfallData.push(v);
                cumulative += v;
                bgColors.push(v >= 0 ? '#10b981' : '#ef4444');
            });
            // Add total bar
            return {
                labels: [...labels, 'Total'],
                datasets: [
                    { label: 'Base', data: [...waterfallBase, 0], backgroundColor: 'transparent', borderWidth: 0, borderSkipped: false, barPercentage: 0.5, stack: 'waterfall' },
                    { label: calculatedYLabel || 'Value', data: [...waterfallData, cumulative], backgroundColor: [...bgColors, baseColor], borderWidth: 0, borderRadius: 3, borderSkipped: false, barPercentage: 0.5, stack: 'waterfall' }
                ]
            };
        }

        // Funnel: horizontal bars sorted by descending value
        if (chartType === 'funnel') {
            const sorted = transformedData
                .map((d, i) => ({ label: labels[i], value: values[i] }))
                .sort((a, b) => b.value - a.value);
            const funnelColors = generateColors(sorted.length);
            return {
                labels: sorted.map(d => d.label),
                datasets: [{
                    label: calculatedYLabel || 'Value',
                    data: sorted.map(d => d.value),
                    backgroundColor: sorted.map((_, index) => funnelColors[index] || baseColor),
                    borderRadius: 3,
                    borderSkipped: false,
                    barPercentage: 0.85,
                    categoryPercentage: 0.95,
                }]
            };
        }

        // Lollipop: thin bar + scatter point overlay
        if (chartType === 'lollipop') {
            return {
                labels,
                datasets: [
                    { label: calculatedYLabel || 'Value', data: values, backgroundColor: generateColors(values), borderRadius: 2, borderSkipped: false, barPercentage: 0.15, maxBarThickness: 6, yAxisID: 'y', type: 'bar' as const },
                    { label: '', data: values, backgroundColor: generateColors(values), borderColor: '#fff', borderWidth: 2, pointRadius: 8, pointHoverRadius: 10, showLine: false, type: 'scatter' as const, yAxisID: 'y' }
                ]
            };
        }

        // ═══ MULTI-SERIES DETECTION & SPLITTING ═══════════════════════════
        // When data has a secondary dimension (e.g., product_name alongside time_hour),
        // split into separate datasets — one line/bar per dimension value.
        // This enables multi-line charts for "Sales by Hour, split by Product".
        const seriesCol = (() => {
            if (disableAutoSeries || transformedData.length === 0 || isPieChart) return null;
            if (seriesKey) {
                const unique = new Set(transformedData.map(d => String(d[seriesKey] ?? 'Unknown')));
                return seriesKey in transformedData[0] && unique.size > 1 ? seriesKey : null;
            }
            const candidateCols = Object.keys(transformedData[0]).filter(k =>
                k !== xKey && k !== yKey &&
                typeof transformedData[0][k] === 'string' &&
                !k.startsWith('previous_') && !k.startsWith('comparison_') &&
                k !== '__comparison_label'
            );
            return candidateCols.find(col => {
                const unique = new Set(transformedData.map(d => d[col]));
                return unique.size > 1 && unique.size <= 50;
            }) || null;
        })();

        if (seriesCol && !isPieChart) {
            // Get unique series values and x-axis labels
            const seriesValues = [...new Set(transformedData.map(d => String(d[seriesCol])))];
            const uniqueLabels = [...new Set(transformedData.map(d => formatDate(String(d[xKey] ?? ''))))];
            const seriesColors = genColors(seriesValues.length, selectPalette({ ...formatting, colorEncoding: 'discrete' }, xKey, transformedData, chartType), false);
            const isFillChart = chartType === 'area' || chartType === 'stackedArea';
            const isCurved = chartType === 'curvedLine' || chartType === 'area';
            const isStepped = chartType === 'steppedLine';

            const multiDatasets = seriesValues.map((sv, idx) => {
                const seriesRows = transformedData.filter(d => String(d[seriesCol]) === sv);
                // Build a map of xLabel → value for this series
                const valMap = new Map<string, number>();
                seriesRows.forEach(d => {
                    const lbl = formatDate(String(d[xKey] ?? ''));
                    valMap.set(lbl, (valMap.get(lbl) || 0) + (Number(d[yKey]) || 0));
                });
                const seriesData = uniqueLabels.map(lbl => valMap.get(lbl) ?? null);
                const color = seriesColors[idx % seriesColors.length];

                return {
                    label: sv,
                    data: seriesData,
                    backgroundColor: isFillChart ? `${color}30` : isBarVariant ? color : `${color}DD`,
                    // Stacked bars: a 2px surface-coloured border reads as a clean
                    // gap between segments (premium "floating segment" look).
                    borderColor: (isBarVariant && chartType === 'stackedBar') ? (isDark ? '#161920' : '#ffffff') : color,
                    borderWidth: (isBarVariant && chartType === 'stackedBar') ? 1 : (isLineVariant ? 2.5 : isBarVariant ? 0 : 1.5),
                    borderSkipped: false,
                    fill: isFillChart,
                    tension: isCurved ? 0.4 : isStepped ? 0 : (isLineVariant ? 0.35 : 0),
                    stepped: isStepped ? 'middle' as const : false,
                    pointRadius: isLineVariant ? (uniqueLabels.length > 30 ? 0 : 3) : 0,
                    pointHoverRadius: isLineVariant ? 7 : 0,
                    pointBackgroundColor: '#fff',
                    pointBorderColor: color,
                    pointBorderWidth: 2,
                    borderRadius: isBarVariant && chartType !== 'stackedBar' ? 3 : 0,
                    maxBarThickness: isBarVariant ? Math.max(20, Math.floor(200 / seriesValues.length)) : undefined,
                    yAxisID: 'y',
                    spanGaps: true,
                };
            });

            return { labels: uniqueLabels, datasets: multiDatasets };
        }
        // ═══ END MULTI-SERIES ═════════════════════════════════════════════

        // Standard dataset construction for all other types
        const isFillChart = chartType === 'area' || chartType === 'stackedArea';
        const isStepped = chartType === 'steppedLine';
        const isCurved = chartType === 'curvedLine' || chartType === 'area';

        // ═══ PIE / DOUGHNUT / POLAR AREA — clean Arc dataset ═══════════
        // These chart types use Arc elements, NOT Cartesian elements.
        // Mixing in Cartesian properties (fill, tension, pointRadius,
        // borderSkipped, maxBarThickness) can break Arc rendering.
        if (isPieChart) {
            const bgColors = generateColors(values);
            return {
                labels,
                datasets: [{
                    label: calculatedYLabel || 'Value',
                    data: values,
                    backgroundColor: bgColors,
                    borderColor: isDark ? '#161920' : '#ffffff',
                    borderWidth: 2,
                    hoverOffset: 4,
                    hoverBorderColor: isDark ? '#161920' : '#ffffff',
                    hoverBorderWidth: 2,
                    spacing: 0,
                }]
            };
        }

        const primaryColors = generateColors(values);
        const datasets: any[] = [{
            label: calculatedYLabel || 'Value',
            data: values,
            backgroundColor: isFillChart
                    ? (context: any) => createGradient(context.chart.ctx, baseColor, context.chart.chartArea)
                    : isBarVariant
                        ? primaryColors
                        : `${baseColor}DD`,
            borderColor: isBarVariant
                ? 'transparent'
                : borderColor,
            borderWidth: isLineVariant ? 2.5 : isBarVariant ? 0 : 2,
            fill: isFillChart,
            tension: isCurved ? 0.45 : isStepped ? 0 : (chartType === 'line' ? 0.4 : 0),
            stepped: isStepped ? 'middle' as const : false,
            pointRadius: isLineVariant ? (values.length > 30 ? 0 : 3) : 0,
            pointHoverRadius: isLineVariant ? 7 : 0,
            pointBackgroundColor: isLineVariant ? primaryColors : '#fff',
            pointBorderColor: isLineVariant ? primaryColors : baseColor,
            pointBorderWidth: 2,
            pointHoverBorderWidth: 3,
            pointHoverBackgroundColor: '#fff',
            segment: isLineVariant && useSequential
                ? { borderColor: (context: any) => primaryColors[context.p1DataIndex] || baseColor }
                : undefined,
            borderRadius: isBarVariant ? 3 : 0,
            borderSkipped: isBarVariant ? 'start' as const : false,
            maxBarThickness: 64,
            barPercentage: isBarVariant ? 0.72 : undefined,
            categoryPercentage: isBarVariant ? 0.82 : undefined,
            hoverBackgroundColor: isBarVariant
                ? (context: any) => lightenColor(primaryColors[context.dataIndex] || baseColor, 9)
                : undefined,
            hoverBorderWidth: isBarVariant ? 0 : undefined,
            yAxisID: 'y',
            // Mixed Chart component (combo, lollipop) requires explicit type on each dataset
            ...(chartType === 'combo' ? { type: 'bar' as const } : {}),
        }];

        // When trend comparison is detected from data, override primary dataset for line rendering
        // (the original chartType might be 'groupedBar' etc. which sets borderWidth=0 and pointRadius=0)
        // GUARD: If config explicitly says comparison='none', skip all comparison logic
        const comparisonExplicitlyOff = !config?.comparison || config?.comparison === 'none';
        const hasTrendData = !comparisonExplicitlyOff && transformedData.length > 2 && transformedData.some(d => d.previous_value !== undefined);
        const hasAnyComparisonData = !comparisonExplicitlyOff && transformedData.some(d => d.previous_value !== undefined);
        if (hasTrendData) {
            // Check if primary chart is a bar type — keep it as bars, just style for comparison
            const primaryIsBarType = ['bar', 'groupedBar', 'stackedBar', 'horizontalBar', 'waterfall'].includes(chartType);
            if (primaryIsBarType) {
                // Keep bars but add comparison styling
                datasets[0].label = 'Current Period';
                datasets[0].borderWidth = 1.5;
                datasets[0].borderRadius = 6;
                datasets[0].maxBarThickness = 80;
                datasets[0].barPercentage = 0.7;
                datasets[0].categoryPercentage = 0.8;
            } else {
                // Line-type charts: style for trend overlay
                datasets[0].label = 'Current Period';
                datasets[0].borderWidth = 3;
                datasets[0].pointRadius = 4;
                datasets[0].pointHoverRadius = 6;
                datasets[0].pointBackgroundColor = '#fff';
                datasets[0].pointBorderColor = borderColor;
                datasets[0].pointBorderWidth = 2;
                datasets[0].fill = false;
                datasets[0].tension = 0.35;
                datasets[0].backgroundColor = `${baseColor}DD`;
                datasets[0].borderDash = undefined;
            }
        } else if (hasAnyComparisonData) {
            // Few-point comparison → render as solid bars
            datasets[0].label = 'Current Period';
            datasets[0].backgroundColor = '#6366f1';
            datasets[0].borderColor = '#4338ca';
            datasets[0].borderWidth = 1.5;
            datasets[0].borderRadius = 6;
            datasets[0].maxBarThickness = 80;
            datasets[0].barPercentage = 0.7;
            datasets[0].categoryPercentage = 0.8;
        }
        // Add Comparison Dataset when comparison is enabled OR data contains previous_value (trend mode)
        const hasConfigComparison = !comparisonExplicitlyOff && (config?.comparison === 'previous_period' || config?.comparison === 'same_period_last_year' || config?.comparison === 'same_period_last_n');
        const hasDataComparison = !comparisonExplicitlyOff && transformedData.some(d => d.previous_value !== undefined);
        if ((hasConfigComparison || hasDataComparison) && hasDataComparison) {
            const prevValues = transformedData.map(d => d.previous_value !== undefined ? Number(d.previous_value) || 0 : null);

            const isSPLY = config?.comparison === 'same_period_last_year';
            // Derive a clearly visible complementary color for comparison line/bars
            const comparisonColor = isSPLY
                ? '#f59e0b' // Amber-500 for SPLY
                : useSequential
                    ? '#f59e0b' // Amber-500 — warm contrast against blue sequential palette
                    : '#6366f1'; // Indigo-500 — distinct secondary color for vibrant palettes

            // Decision: bar-type charts → always use grouped bars for comparison
            // Line/area charts → use line overlay for comparison
            const primaryIsBar = ['bar', 'groupedBar', 'stackedBar', 'horizontalBar', 'waterfall'].includes(chartType);
            const primaryIsLine = ['line', 'area', 'stackedArea', 'steppedLine', 'curvedLine'].includes(chartType);
            const cjsType = primaryIsLine ? 'line' as const : 'bar' as const;
            const isLineType = cjsType === 'line';

            // For grouped bars: set bar sizing to allow side-by-side
            if (!isLineType && datasets.length > 0) {
                datasets[0].barPercentage = 0.7;
                datasets[0].categoryPercentage = 0.8;
            }

            // Build descriptive label
            const compLabel = config?.comparison === 'same_period_last_n'
                ? `${config.comparisonOffset || 1} ${config.comparisonGrain || 'month'}${(config.comparisonOffset || 1) > 1 ? 's' : ''} ago`
                : isSPLY ? 'Same Period Last Year' : 'Previous Period';

            datasets.push({
                label: compLabel,
                data: prevValues,
                backgroundColor: isLineType ? 'transparent' : '#f97316',
                borderColor: isLineType ? (isSPLY ? '#d97706' : '#4f46e5') : '#ea580c',
                borderWidth: isLineType ? 2.5 : 1.5,
                borderDash: isLineType ? [6, 4] : undefined,
                borderRadius: isLineType ? 0 : 6,
                maxBarThickness: 80,
                barPercentage: isLineType ? undefined : 0.7,
                categoryPercentage: isLineType ? undefined : 0.8,
                type: cjsType,
                fill: isLineType ? false : undefined,
                tension: isLineType ? 0.3 : undefined,
                pointRadius: isLineType ? 3 : undefined,
                pointBackgroundColor: isLineType ? (isSPLY ? '#d97706' : '#4f46e5') : undefined,
                pointBorderColor: isLineType ? '#fff' : undefined,
                pointBorderWidth: isLineType ? 1.5 : undefined,
                yAxisID: 'y'
            });
        }

        // Add Running Total Grand Total reference line
        if (primaryCalc === 'running_total' && values.length > 0) {
            const grandTotal = values[values.length - 1]; // Last value IS the grand total
            datasets.push({
                label: `Grand Total (${formatNumber(grandTotal)})`,
                data: Array(values.length).fill(grandTotal),
                type: 'line' as const,
                borderColor: '#64748b',
                borderWidth: 2,
                borderDash: [8, 4],
                pointRadius: 0,
                pointHoverRadius: 0,
                fill: false,
                yAxisID: 'y',
                order: -1, // Draw behind bars
            });
        }

        // Add Raw Daily Values for Moving Average questions
        // Shows daily bars behind the smooth MA line so users can see the smoothing effect
        if (transformedData.some(d => d.raw_value !== undefined)) {
            const rawValues = transformedData.map(d => d.raw_value !== undefined ? Number(d.raw_value) || 0 : null);
            datasets.unshift({
                label: 'Daily Revenue',
                data: rawValues,
                type: 'bar' as const,
                backgroundColor: 'rgba(148, 163, 184, 0.25)',
                borderColor: 'rgba(148, 163, 184, 0.4)',
                borderWidth: 1,
                borderRadius: 3,
                maxBarThickness: 20,
                yAxisID: 'y',
                order: 1, // Draw behind the MA line
            } as any);
        }

        // ── SECONDARY METRIC DATASETS (multi-metric overlay) ──
        // Auto-detect additional numeric keys in data beyond xKey, yKey, and known metadata keys
        const knownKeys = new Set([xKey, yKey, 'previous_value', 'previous_period_label', 'growth_pct', 'difference', 'raw_value', 'rawValue', '__original_value', '_original', 'x', 'value', 'period', 'metric']);
        // Skip secondary metric detection for pie/doughnut charts — they only use one metric
        // Arc/gauge charts return before this Cartesian dataset path.
        const skipSecondary = false;
        // Only overlay secondary metrics that were EXPLICITLY requested via
        // config.secondaryMetrics. Previously this scavenged ANY stray numeric
        // column in the result rows, which spawned phantom lines + an ugly dual
        // axis on plain single-metric charts (e.g. "SUM of sales by ship_mode"
        // sprouting an amber line on a second scale). A metric the user did not
        // ask for must never appear — and never on a second y-scale.
        const declaredSecondary = (config?.secondaryMetrics || []).map((m: string) => m.toLowerCase().trim());
        const matchesDeclared = (k: string) => {
            const raw = k.replace(/^(sum|avg|count|count_distinct|min|max)_/i, '').toLowerCase().trim();
            return declaredSecondary.includes(raw) || declaredSecondary.includes(k.toLowerCase().trim());
        };
        const secondaryKeys = (!skipSecondary && declaredSecondary.length > 0 && data.length > 0)
            ? Object.keys(data[0]).filter(k => {
                const explicitlyDeclared = matchesDeclared(k);
                return !knownKeys.has(k)
                    && typeof data[0][k] === 'number'
                    // Only the explicit presentation contract can create an
                    // overlay. This safely permits SQL-authored outputs named
                    // percentage_of_total_sales or cumulative_* while keeping
                    // incidental numeric columns out of the visual.
                    && explicitlyDeclared;
            })
            : [];

        const SECONDARY_COLORS = [
            { border: isDark ? '#9ccc65' : '#7cb342', bg: isDark ? '#9ccc6540' : '#7cb34230' },
            { border: isDark ? '#f2c25c' : '#e0a82e', bg: isDark ? '#f2c25c40' : '#e0a82e30' },
            { border: isDark ? '#ef8c8c' : '#e06b6b', bg: isDark ? '#ef8c8c40' : '#e06b6b30' },
        ];

        // Determine axis mode: compare primary vs secondary max values
        let autoAxisMode: 'single' | 'dual' | 'blended' = 'blended';
        // For combo chart type, always use dual axis
        if (chartType === 'combo') {
            autoAxisMode = 'dual';
        } else if (secondaryKeys.length > 0 && values.length > 0) {
            const primaryMax = Math.max(...values.map(v => Math.abs(Number(v) || 0)));
            const secMaxes = secondaryKeys.map(sk => Math.max(...transformedData.map(d => Math.abs(Number(d[sk]) || 0))));
            const overallSecMax = Math.max(...secMaxes);
            const ratio = primaryMax > 0 && overallSecMax > 0
                ? Math.max(primaryMax / overallSecMax, overallSecMax / primaryMax)
                : 1;
            autoAxisMode = ratio > 5 ? 'dual' : 'blended';
        }
        // Also force dual axis if config says so
        const useDualAxis = autoAxisMode === 'dual' || config?.axisMode === 'dual';

        // Read secondary metric visual types from config (default: line)
        const secVisuals: Record<string, string> = config?.secondaryMetricVisuals || {};

        secondaryKeys.forEach((secKey, idx) => {
            const colorSet = SECONDARY_COLORS[idx % SECONDARY_COLORS.length];
            const secValues = transformedData.map(d => Number(d[secKey]) || 0);
            // Look up visual type: try exact key first, then try raw column name
            // (data keys are aliased like "sum_sale_amt" but visuals map uses raw "sale_amt")
            const rawColName = secKey.replace(/^(sum|avg|count|count_distinct|min|max)_/i, '');
            const visType = secVisuals[secKey] || secVisuals[rawColName] || 'line';
            const isBarType = visType === 'bar';
            const isAreaType = visType === 'area';

            // Human-readable label: "discount" → "Discount", "unit_price" → "Unit Price"
            const humanLabel = secKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

            datasets.push({
                label: humanLabel,
                qiSecondaryMetric: true,
                data: secValues,
                type: isBarType ? 'bar' as const : 'line' as const,
                borderColor: colorSet.border,
                backgroundColor: isBarType ? colorSet.bg : (isAreaType ? colorSet.bg : 'transparent'),
                borderWidth: isBarType ? 1.5 : 2.5,
                pointRadius: isBarType ? 0 : 4,
                pointHoverRadius: isBarType ? 0 : 6,
                pointBackgroundColor: isDark ? '#12243c' : '#fff',
                pointBorderColor: colorSet.border,
                pointBorderWidth: 2,
                fill: isAreaType,
                tension: 0.35,
                yAxisID: useDualAxis ? 'y1' : 'y',
                order: isBarType ? 1 : -2,
            });
        });

        return {
            labels,
            datasets
        };
    }, [transformedData, xKey, yKey, chartType, calculatedYLabel, formatting, data, config, seriesKey, disableAutoSeries, isDark]);

    const options = useMemo(() => {
        const isPieChart = chartType === 'pie' || chartType === 'doughnut' || chartType === 'gauge';
        const isBarVariant = chartType === 'bar' || chartType === 'horizontalBar' || chartType === 'stackedBar' || chartType === 'groupedBar' || chartType === 'waterfall' || chartType === 'funnel' || chartType === 'lollipop' || chartType === 'combo';
        const isStacked = chartType === 'stackedBar' || chartType === 'stackedArea' || chartType === 'waterfall';
        const isHorizontal = chartType === 'horizontalBar' || chartType === 'funnel';
        // Difference calculations can legitimately be negative. Keep the familiar
        // zero baseline for positive-only charts, but do not clip negative bars.
        const hasNegativeValues = transformedData.some(row => Number(row[yKey]) < 0);
        const fontSize = formatting ? FONT_SIZES[formatting.fontSize || 'md'] : 12;
        const xVisible = formatting?.showXAxis ?? formatting?.showAxis ?? false;
        const yVisible = formatting?.showYAxis ?? formatting?.showAxis ?? false;
        // Independent sizing maps for new formatting controls
        const DATA_LABEL_SIZES: Record<string, number> = { xs: 10, sm: 12, md: 14, lg: 16 };
        const AXIS_LABEL_SIZES: Record<string, number> = { xs: 10, sm: 12, md: 14, lg: 17 };
        const dataLabelFontSize = DATA_LABEL_SIZES[formatting?.dataLabelSize || 'md'] || 11;
        const categoryCount = chartData?.labels?.length || 0;
        const axisLabelFontSize = Math.min(
            AXIS_LABEL_SIZES[formatting?.axisLabelSize || 'md'] || 12,
            categoryCount > 10 ? 11 : 17,
        );
        const prefersReducedMotion = typeof window !== 'undefined'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const secondaryAxisColor = chartData?.datasets?.find((ds: any) => ds.yAxisID === 'y1')?.borderColor;

        return {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: isHorizontal ? 'y' as const : 'x' as const,
            layout: {
                padding: isPieChart
                    ? (formatting?.showDataLabels ? { top: 30, left: 56, right: 56, bottom: 30 } : { top: 8, left: 8, right: 8, bottom: 8 })
                    : { top: isStacked && chartType !== 'waterfall' ? 28 : 20, left: 8, right: 12, bottom: 4 }
            },
            ...(chartType === 'doughnut' ? { cutout: '64%' } : {}),
            ...(chartType === 'gauge' ? { cutout: '70%' } : {}),
            plugins: {
                qiDoughnutCenter: {
                    display: chartType === 'doughnut',
                    text: chartType === 'doughnut'
                        ? formatCompactLabel((chartData?.datasets?.[0]?.data || []).reduce((a: number, v: any) => a + (Number(v) || 0), 0))
                        : '',
                    caption: 'Total',
                    color: isDark ? '#e8eaef' : '#1f2430',
                    captionColor: isDark ? '#8c94a4' : '#8a92a3',
                    fontFamily: CHART_FONT_FAMILY,
                },
                qiStackTotals: {
                    display: chartType === 'stackedBar' && (formatting?.showLabels ?? true),
                    formatter: (value: number) => formatCompactLabel(value),
                    color: isDark ? '#e8eaef' : '#1f2430',
                    fontFamily: CHART_FONT_FAMILY,
                    horizontal: isHorizontal,
                },
                // Custom Data Labels Plugin
                customDataLabels: { // Namespace for our custom plugin
                    display: formatting ? formatting.showDataLabels : false,
                    labelMode: effectiveDataLabelMode(formatting),
                    formatter: (val: number) => {
                        return formatCompactLabel(val);
                    },
                    secondaryFormatter: (val: number, metricName: string) => {
                        return formatCompactMetricLabel(val, metricName);
                    },
                    primaryLabel: yLabel || yKey || '',
                    color: readableChartTextColor(formatting?.dataLabelColor, isDark, isDark ? '#c9ced8' : '#4b5363'),
                    font: {
                        weight: formatting?.dataLabelBold !== false ? 'bold' : 'normal',
                        size: dataLabelFontSize
                    },
                    anchor: 'end',
                    align: 'end',
                    offset: 4
                },
                legend: {
                    // Hide legend on pie/doughnut when data labels are on — labels already show "Category: XX.X%"
                    display: (formatting?.showLabels ?? true)
                        && !(isPieChart && formatting?.showDataLabels)
                        && (isPieChart || (chartData?.datasets?.length ?? 0) > 1),
                    // Clean style: legend above the plot, left-aligned (or beside a
                    // pie/donut), small dots, quiet text.
                    position: isPieChart ? 'right' as const : 'top' as const,
                    align: isPieChart ? 'center' as const : 'start' as const,
                    labels: {
                        font: {
                            size: Math.max(fontSize, 12),
                            family: CHART_FONT_FAMILY,
                            weight: '500' as any,
                        },
                        usePointStyle: true,
                        pointStyle: 'circle',
                        padding: isPieChart ? 14 : 16,
                        color: isDark ? '#a4abb9' : '#596275',
                        boxWidth: 7,
                        boxHeight: 7,
                        ...(isPieChart ? {
                            // "Electronics  27%" — share sits in the legend, as in the reference
                            generateLabels: (chart: any) => {
                                const base = ChartJS.overrides.doughnut.plugins.legend.labels.generateLabels(chart);
                                const values: number[] = (chart.data.datasets?.[0]?.data || []).map((v: any) => Number(v) || 0);
                                const total = values.reduce((a, b) => a + b, 0) || 1;
                                return base.map((item: any, index: number) => ({
                                    ...item,
                                    text: `${item.text}  ${Math.round((values[index] / total) * 100)}%`,
                                }));
                            },
                        } : {}),
                    },
                },
                title: {
                    display: false, // Handled by parent container header
                    text: calculatedYLabel || '',
                    font: {
                        size: formatting?.headerSize === 'sm' ? 15 :
                            formatting?.headerSize === 'md' ? 18 :
                                formatting?.headerSize === 'lg' ? 21 :
                                    formatting?.headerSize === 'xl' ? 24 : 21,
                        weight: formatting?.headerBold !== false ? 'bold' as const : 'normal' as const
                    },
                    color: readableChartTextColor(formatting?.headerColor, isDark, isDark ? '#f8fafc' : '#172a45'),
                    padding: {
                        top: 10,
                        bottom: 15
                    }
                },
                tooltip: {
                    // Clean style: a light card on light charts, dark on dark.
                    backgroundColor: isDark ? '#1b1f27' : '#ffffff',
                    titleColor: isDark ? '#e8eaef' : '#1f2430',
                    bodyColor: isDark ? '#a4abb9' : '#596275',
                    borderColor: isDark ? 'rgba(255, 255, 255, 0.10)' : '#e6e8ec',
                    borderWidth: 1,
                    padding: { top: 10, bottom: 10, left: 12, right: 12 },
                    cornerRadius: 8,
                    caretSize: 5,
                    titleFont: {
                        size: 12,
                        weight: 600 as any,
                        family: CHART_FONT_FAMILY
                    },
                    bodyFont: {
                        size: 12,
                        family: CHART_FONT_FAMILY
                    },
                    bodySpacing: 5,
                    titleMarginBottom: 6,
                    displayColors: true,
                    boxWidth: 7,
                    boxHeight: 7,
                    boxPadding: 5,
                    usePointStyle: true,
                    mode: 'index' as const,
                    intersect: false,
                    callbacks: {
                        title: function (contexts: any[]) {
                            const label = contexts[0]?.label || '';
                            const latestData = transformedDataRef.current;
                            const idx = contexts[0]?.dataIndex;
                            const dp = idx !== undefined ? latestData[idx] : null;
                            if (dp && dp.previous_period_label) {
                                return [label, `vs ${dp.previous_period_label}`];
                            }
                            // For comparison trend charts, compute the previous period date
                            // by shifting the current label by the comparison offset
                            if (dp && dp.previous_value !== undefined && label) {
                                if (config?.comparison === 'same_period_last_n' && config.comparisonGrain && config.comparisonOffset) {
                                    try {
                                        const d = new Date(label);
                                        if (!isNaN(d.getTime())) {
                                            const grain = config.comparisonGrain;
                                            const offset = config.comparisonOffset || 1;
                                            if (grain === 'day') d.setDate(d.getDate() - offset);
                                            else if (grain === 'week') d.setDate(d.getDate() - (offset * 7));
                                            else if (grain === 'month') d.setMonth(d.getMonth() - offset);
                                            else if (grain === 'quarter') d.setMonth(d.getMonth() - (offset * 3));
                                            else if (grain === 'year') d.setFullYear(d.getFullYear() - offset);
                                            const prevLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                                            return [label, `vs ${prevLabel}`];
                                        }
                                    } catch (_) { /* ignore parse errors */ }
                                } else if (config?.comparison === 'previous_period') {
                                    return [label, 'vs Previous Period'];
                                }
                            }
                            return label;
                        },
                        label: function (context: any) {
                            const latestData = transformedDataRef.current;
                            const idx = context.dataIndex;
                            const isTrend = latestData.length > 0 && latestData[idx]?.previous_value !== undefined;

                            if (isTrend) {
                                if (context.datasetIndex === 0) {
                                    // Use chart's parsed value (always correct regardless of data key name)
                                    const currVal = context.parsed?.y ?? context.parsed?.x ?? (Number(latestData[idx].value || latestData[idx][yKey]) || 0);
                                    return `  Current Period: ${formatNumber(currVal)}`;
                                } else if (context.datasetIndex === 1) {
                                    const prevVal = Number(latestData[idx].previous_value) || 0;
                                    return `  Previous Period: ${formatNumber(prevVal)}`;
                                } else {
                                    // Secondary metric dataset — show with proper label and formatting
                                    const dsLabel = context.dataset.label || '';
                                    const val = context.parsed?.y ?? context.parsed?.x ?? 0;
                                    if (val !== null && val !== undefined) {
                                        return `  ${dsLabel.replace(/_/g, ' ')}: ${formatForMetricName(val, dsLabel)}`;
                                    }
                                    return `  ${dsLabel}: ${val}`;
                                }
                            }

                            // Default tooltip for non-trend charts
                            let label = context.dataset.label || '';
                            const val = isHorizontal ? context.parsed.x : context.parsed.y;

                            // Use per-metric formatting for secondary datasets
                            if (label && label !== yKey && label !== calculatedYLabel) {
                                // This is a secondary metric — format based on its column name
                                if (val !== null && val !== undefined) {
                                    return `  ${label.replace(/_/g, ' ')}: ${formatForMetricName(val, label)}`;
                                }
                            }

                            if (label) label += ': ';
                            if (context.parsed.y !== null || context.parsed.x !== null) {
                                if (val !== null && val !== undefined) {
                                    label += formatNumber(val);
                                }
                            } else if (context.parsed !== null) {
                                label += formatNumber(context.parsed);
                            }

                            return label;
                        },
                        afterBody: function (contexts: any[]) {
                            const latestData = transformedDataRef.current;
                            if (!contexts || contexts.length === 0) return '';
                            const idx = contexts[0].dataIndex;
                            const dp = latestData[idx];
                            if (!dp) return '';

                            const isTrend = dp.previous_value !== undefined;
                            const lines: string[] = [];

                            // Growth % for trend mode
                            if (isTrend) {
                                const growthPct = dp.growth_pct;
                                if (growthPct !== undefined && !isNaN(growthPct)) {
                                    const sign = growthPct >= 0 ? '+' : '';
                                    const arrow = growthPct >= 0 ? '▲' : '▼';
                                    lines.push(`  ${arrow} Growth: ${sign}${Number(growthPct).toFixed(1)}%`);
                                }
                            }

                            // The tooltip body already shows every plotted series.
                            // Include only extra numeric fields from the result row.
                            const metaKeys = new Set([xKey, yKey, 'previous_value', 'previous_period_label', 'growth_pct',
                                'difference', 'raw_value', 'rawValue', '__original_value', '_original',
                                'x', 'value', 'period', 'metric']);
                            const isCalcKey = (k: string) => /running_total|cumulative|percent_of_total|pct_of_total|rank|percentile|moving_avg|pct_diff|diff_from_prev|_sum$|_count$|_avg$|_min$|_max$/i.test(k);
                            const plottedLabels = [
                                ...contexts.map(context => String(context.dataset?.label || '')),
                                ...(config?.secondaryMetrics || []),
                            ];
                            extraTooltipMetricKeys(dp, plottedLabels, metaKeys).forEach(k => {
                                if (isCalcKey(k)) return;
                                const humanName = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                                lines.push(`  ● ${humanName}: ${formatForMetricName(dp[k], k)}`);
                            });

                            return lines.length > 0 ? lines.join('\n') : '';
                        }
                    },
                    // Filter out tooltip items with null/0/undefined values
                    // Prevents grouped bar charts from showing all datasets
                    // when only some have data at a given category (e.g. top 3 products per category)
                    filter: function (tooltipItem: any) {
                        const raw = tooltipItem.raw;
                        return raw !== null && raw !== undefined && raw !== 0 && raw !== '';
                    }
                }
            },
            scales: isPieChart ? undefined : {
                x: {
                    display: xVisible ?? true,
                    stacked: isStacked,
                    ...(isHorizontal && !hasNegativeValues ? { beginAtZero: true, min: 0 } : {}),
                    grid: {
                        display: formatting?.showGridLines ?? false, // Clean: no X grid by default
                        drawBorder: false,
                        color: isDark ? 'rgba(255, 255, 255, 0.06)' : '#eef0f3',
                    },
                    border: {
                        display: false,
                    },
                    ticks: {
                        display: xVisible ?? true,
                        maxRotation: isHorizontal ? 0 : categoryCount > 10 ? 38 : 45,
                        minRotation: 0,
                        font: {
                            size: axisLabelFontSize,
                            family: CHART_FONT_FAMILY,
                            weight: formatting?.axisBold === true ? '600' as const : ('400' as any)
                        },
                        color: readableChartTextColor(formatting?.axisColor, isDark, isDark ? '#8c94a4' : '#8a92a3'),
                        padding: 8,
                        // For horizontal bars, X-axis is the VALUE axis — format numbers
                        // For vertical bars, X-axis is the CATEGORY axis — no callback needed
                        ...(isHorizontal ? {
                            callback: function (value: any) {
                                return formatAxisNumber(value);
                            }
                        } : {}),
                    },
                },
                y: {
                    display: yVisible ?? true,
                    ...(isHorizontal || hasNegativeValues ? {} : { min: 0, beginAtZero: true }),
                    ...(axisRange ? { min: axisRange.min, max: axisRange.max } : {}),
                    stacked: isStacked,
                    grid: {
                        display: formatting?.showGridLines ?? true,
                        color: isDark ? 'rgba(255, 255, 255, 0.06)' : '#eef0f3',
                        drawBorder: false,
                        tickLength: 0,
                    },
                    border: {
                        display: false,
                        dash: [3, 3],
                    },
                    ticks: {
                        display: yVisible ?? true,
                        font: {
                            size: axisLabelFontSize,
                            family: CHART_FONT_FAMILY,
                            weight: formatting?.axisBold === true ? '600' as const : ('400' as any)
                        },
                        color: readableChartTextColor(formatting?.axisColor, isDark, isDark ? '#8c94a4' : '#8a92a3'),
                        padding: 8,
                        ...(!isHorizontal ? {
                            callback: function (value: any) {
                                return formatAxisNumber(value);
                            }
                        } : {}),
                    }
                },
                // Dynamic y1 axis for dual-axis multi-metric charts
                ...((() => {
                    // Detect if we have secondary metric datasets targeting y1
                    const hasY1 = chartData?.datasets?.some((ds: any) => ds.yAxisID === 'y1');
                    if (!hasY1) return {};
                    return {
                        y1: {
                            display: true, // Always show right axis when secondary metrics exist
                            position: 'right' as const,
                            beginAtZero: true,
                            grid: {
                                display: false, // Don't show dual grid lines
                                drawBorder: false,
                            },
                            ticks: {
                                display: true, // Always show ticks — they carry the secondary scale
                                font: {
                                    size: fontSize + 1,
                                    weight: formatting?.axisBold !== false ? '600' as const : 'normal' as const
                                },
                                color: typeof secondaryAxisColor === 'string' ? secondaryAxisColor : '#b45309',
                                callback: function (this: any, value: any) {
                                    // Detect secondary metric name from datasets on this axis
                                    const chart = this.chart;
                                    const secDs = chart?.data?.datasets?.find((ds: any) => ds.yAxisID === 'y1');
                                    if (secDs?.label) {
                                        return formatForMetricName(Number(value) || 0, secDs.label);
                                    }
                                    return formatAxisNumber(value);
                                }
                            }
                        }
                    };
                })())
            },
            // SMOOTH ANIMATIONS
            animation: prefersReducedMotion ? false : {
                duration: 720,
                easing: 'easeOutCubic' as const,
                delay: (context: any) => {
                    if (context.type === 'data' && context.mode === 'default') {
                        return Math.min(context.dataIndex * 18, 180) + context.datasetIndex * 30;
                    }
                    return 0;
                },
            },
            transitions: {
                active: {
                    animation: {
                        duration: 160
                    }
                }
            },
            interaction: {
                mode: (chartType === 'pie' || chartType === 'doughnut' || chartType === 'polarArea' || chartType === 'gauge') ? 'nearest' as const : 'index' as const,
                intersect: (chartType === 'pie' || chartType === 'doughnut' || chartType === 'polarArea' || chartType === 'gauge') ? true : false,
            },
        } as any; // Cast to any to allow custom scale ID 'y1'
    }, [chartType, formatting, transformedData, chartData, calculatedYLabel, xKey, yKey, isDark, axisRange?.min, axisRange?.max]);



    const dataLabelsPlugin = useMemo<any>(() => ({
        id: 'customDataLabels',
        afterDatasetsDraw(chart: any, args: any, options: any) {
            if (!options.display) return;

            const { ctx } = chart;
            ctx.save();

            const isPie = chart.config.type === 'pie' || chart.config.type === 'doughnut';

            if (isPie) {
                // ── OUTSIDE LABELS WITH LEADER LINES ──
                const meta = chart.getDatasetMeta(0);
                if (!meta || meta.hidden) { ctx.restore(); return; }

                const dataset = chart.data.datasets[0];
                const total = dataset.data.reduce((sum: number, v: number) => sum + (v || 0), 0);
                if (total === 0) { ctx.restore(); return; }

                const chartArea = chart.chartArea;
                const centerX = (chartArea.left + chartArea.right) / 2;
                const centerY = (chartArea.top + chartArea.bottom) / 2;
                const canvasWidth = chart.width;
                const canvasHeight = chart.height;

                // Collect label positions
                const dataLabels = chart.data.labels || [];
                const labelInfos: { index: number; angle: number; labelText: string; outerX: number; outerY: number; side: 'left' | 'right'; weight: number }[] = [];

                meta.data.forEach((arc: any, index: number) => {
                    const value = dataset.data[index];
                    if (!value || value === 0) return;

                    const pct = ((value / total) * 100);
                    if (pct < 1) return; // skip tiny slices

                    const startAngle = arc.startAngle;
                    const endAngle = arc.endAngle;
                    const midAngle = (startAngle + endAngle) / 2;

                    const outerRadius = arc.outerRadius;
                    const labelRadius = outerRadius + 24;

                    const outerX = centerX + Math.cos(midAngle) * labelRadius;
                    const outerY = centerY + Math.sin(midAngle) * labelRadius;

                    const catName = dataLabels[index] || '';
                    const labelText = `${catName}: ${pct.toFixed(1)}%`;
                    const side: 'left' | 'right' = outerX >= centerX ? 'right' : 'left';

                    labelInfos.push({ index, angle: midAngle, labelText, outerX, outerY, side, weight: pct });
                });

                const placed = new Map<number, number>();
                for (const side of ['left', 'right'] as const) {
                    const rows = labelInfos.filter(label => label.side === side)
                        .map(label => ({ index: label.index, preferredY: label.outerY, weight: label.weight }));
                    layoutPieLabelRows(rows, canvasHeight).forEach(row => placed.set(row.index, row.y));
                }

                // Draw each label with leader line
                labelInfos.forEach(info => {
                    const outerY = placed.get(info.index);
                    if (outerY === undefined) return;
                    const { angle, side } = info;
                    const availableWidth = side === 'right'
                        ? canvasWidth - 14 - (centerX + 12)
                        : centerX - 12 - 14;
                    ctx.font = 'bold 11px "Inter", sans-serif';
                    const labelText = fitPieLabelText(info.labelText, availableWidth, text => ctx.measureText(text).width);
                    if (!labelText) return;
                    const textWidth = ctx.measureText(labelText).width;
                    const labelX = side === 'right'
                        ? Math.max(centerX + 12, Math.min(info.outerX + 23, canvasWidth - 14 - textWidth))
                        : Math.min(centerX - 12, Math.max(info.outerX - 23, 14 + textWidth));
                    const elbowX = labelX + (side === 'right' ? -5 : 5);
                    const outerX = Math.max(8, Math.min(canvasWidth - 8, info.outerX));

                    const outerRadius = meta.data[0]?.outerRadius || 100;

                    // Start point on pie edge
                    const edgeX = centerX + Math.cos(angle) * (outerRadius + 4);
                    const edgeY = centerY + Math.sin(angle) * (outerRadius + 4);

                    // Leader line
                    ctx.strokeStyle = '#94a3b8';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(edgeX, edgeY);
                    ctx.lineTo(outerX, outerY);
                    ctx.lineTo(elbowX, outerY);
                    ctx.stroke();

                    // Label text
                    ctx.textAlign = side === 'right' ? 'left' : 'right';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = options.color || '#000000';
                    ctx.fillText(labelText, labelX, outerY);
                });
            } else {
                // ── BAR / LINE / OTHER CHARTS — show data point labels ──
                const latestData = transformedDataRef.current;
                const renderables: Array<{
                    text: string;
                    font: string;
                    x: number;
                    y: number;
                    width: number;
                    height: number;
                    horizontal: boolean;
                    positive: boolean;
                    minX?: number;
                    maxX?: number;
                    preferredDirection?: 'above' | 'below';
                }> = [];
                const mode = options.labelMode || 'all';
                const categoryCount = chart.data.labels?.length || 0;
                const categoryWidth = categoryCount > 0 ? chart.chartArea.width / categoryCount : 0;
                const denseCategories = categoryCount > 10 && categoryWidth < 78;

                chart.data.datasets.forEach((dataset: any, i: number) => {
                    const meta = chart.getDatasetMeta(i);
                    if (meta.hidden) return;

                    // Label mode filtering: 'primary' = only dataset 0, 'all' = all datasets
                    if (!shouldRenderDataLabel(mode, i)) return;

                    meta.data.forEach((element: any, index: number) => {
                        const value = dataset.data[index];
                        if (value === null || value === undefined) return;

                        // Determine dataset type first
                        const isComparisonDs = i === 1 && latestData.some((d: any) => d.previous_value !== undefined);
                        const isSecondaryDs = dataset.qiSecondaryMetric === true;

                        // Skip near-zero values for primary/comparison datasets only
                        // Secondary metrics (like discount) always show labels even for 0
                        if (!isSecondaryDs && Math.abs(Number(value)) < 0.01) return;

                        // Format the label text based on dataset type
                        let text: string;
                        if (isSecondaryDs && options.secondaryFormatter && dataset.label) {
                            text = options.secondaryFormatter(value, dataset.label);
                        } else if (options.formatter) {
                            text = options.formatter(value, { dataset });
                        } else {
                            text = String(value);
                        }

                        // Preserve font emphasis, but never inherit series colors
                        // for value labels: a single selected label color applies
                        // consistently to all datasets.
                        const baseFontSize = denseCategories ? Math.min(options.font.size || 12, 11) : (options.font.size || 12);
                        const fontSize = Math.max(9, baseFontSize - (isComparisonDs || isSecondaryDs ? 1 : 0));
                        const font = `${isComparisonDs ? 'italic' : isSecondaryDs ? 'bold' : options.font.weight} ${fontSize}px "Inter", sans-serif`;
                        ctx.font = font;
                        const isVerticalCategory = chart.options.indexAxis !== 'y' && chart.scales?.x?.type === 'category';
                        const categoryCenter = isVerticalCategory ? chart.scales.x.getPixelForTick(index) : null;
                        renderables.push({
                            text,
                            font,
                            x: element.x,
                            y: element.y,
                            width: ctx.measureText(text).width + 2,
                            height: fontSize + 2,
                            horizontal: chart.options.indexAxis === 'y',
                            positive: Number(value) >= 0,
                            minX: categoryCenter !== null && Number.isFinite(categoryCenter)
                                ? categoryCenter - categoryWidth * 0.49 : undefined,
                            maxX: categoryCenter !== null && Number.isFinite(categoryCenter)
                                ? categoryCenter + categoryWidth * 0.49 : undefined,
                            preferredDirection: isSecondaryDs && (dataset.type === 'line' || meta.type === 'line')
                                ? 'below' : undefined,
                        });
                    });
                });

                const positions = layoutChartLabels(renderables, chart.chartArea);
                ctx.fillStyle = options.color || '#000000';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                renderables.forEach((label, index) => {
                    const point = positions[index];
                    if (!point) return;
                    ctx.font = label.font;
                    ctx.fillText(label.text, point.x, point.y);
                });
            }
            ctx.restore();
        }
    }), []);

    // Growth % badge — compact box at top-center of the chart canvas
    const growthLabelsPlugin = useMemo<any>(() => ({
        id: 'growthLabels',
        afterDatasetsDraw(chart: any) {
            const latestData = transformedDataRef.current;
            const hasComparison = latestData.some((d: any) => d.growth_pct !== undefined);
            if (!hasComparison) return;

            const { ctx, chartArea } = chart;
            const mainMeta = chart.getDatasetMeta(0);
            if (!mainMeta || mainMeta.hidden) return;

            // Use growth_pct directly from data if available, otherwise compute from previous_value
            const withGrowth = latestData.filter((d: any) => d.growth_pct !== undefined && !isNaN(d.growth_pct));
            if (withGrowth.length === 0) return;

            let growth = 0;
            const firstWithGrowth = withGrowth[0];
            if (firstWithGrowth && firstWithGrowth.growth_pct !== undefined && !isNaN(firstWithGrowth.growth_pct)) {
                // For 2-bar comparisons, use the growth_pct from the current period bar
                growth = Number(firstWithGrowth.growth_pct);
            } else {
                // Fallback: compute from previous_value fields (trend/time-series charts)
                let totalCurr = 0, totalPrev = 0;
                for (const d of latestData) {
                    if (d.previous_value !== undefined) {
                        totalCurr += Number(d.value) || 0;
                        totalPrev += Number(d.previous_value) || 0;
                    }
                }
                growth = totalPrev !== 0 ? ((totalCurr - totalPrev) / Math.abs(totalPrev)) * 100 : 0;
            }
            const isPositive = growth >= 0;
            const sign = isPositive ? '+' : '';
            const text = `${sign}${growth.toFixed(1)}%`;
            const icon = isPositive ? '▲' : '▼';

            ctx.save();

            // Position: top-center of chart area
            const centerX = (chartArea.left + chartArea.right) / 2;
            const boxY = chartArea.top - 2;

            // Measure text for box sizing
            const font = 'bold 12px "Inter", sans-serif';
            ctx.font = font;
            const iconWidth = ctx.measureText(icon + ' ').width;
            const textWidth = ctx.measureText(text).width;
            const totalWidth = iconWidth + textWidth;

            const padH = 10;
            const padV = 6;
            const boxW = totalWidth + padH * 2;
            const boxH = 24;
            const boxX = centerX - boxW / 2;
            const radius = 6;

            // Draw rounded rectangle background
            ctx.fillStyle = isPositive ? 'rgba(5, 150, 105, 0.08)' : 'rgba(220, 38, 38, 0.08)';
            ctx.strokeStyle = isPositive ? 'rgba(5, 150, 105, 0.25)' : 'rgba(220, 38, 38, 0.25)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(boxX + radius, boxY);
            ctx.lineTo(boxX + boxW - radius, boxY);
            ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + radius);
            ctx.lineTo(boxX + boxW, boxY + boxH - radius);
            ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - radius, boxY + boxH);
            ctx.lineTo(boxX + radius, boxY + boxH);
            ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - radius);
            ctx.lineTo(boxX, boxY + radius);
            ctx.quadraticCurveTo(boxX, boxY, boxX + radius, boxY);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Draw icon + text
            ctx.fillStyle = isPositive ? '#059669' : '#dc2626';
            ctx.font = font;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${icon} ${text}`, centerX, boxY + boxH / 2);

            ctx.restore();
        }
    }), []); // Empty deps — uses ref internally for latest data

    const plugins = useMemo(() => [dataLabelsPlugin, growthLabelsPlugin, doughnutCenterPlugin, stackTotalsPlugin], [dataLabelsPlugin, growthLabelsPlugin]);

    const handleClick = onDrillDown ? (_event: any, elements: any[]) => {
        if (elements.length > 0) {
            const idx = elements[0].index;
            // For Treemap, elements might not have index property directly mapping to chartData.labels
            // ChartJS Treemap uses 'context'
            if (elements[0].element && elements[0].element.$context) {
                const ctx = elements[0].element.$context;
                if (ctx.type === 'data') {
                    onDrillDown(ctx.raw.g);
                    return;
                }
            }
            const label = chartData?.labels?.[idx];
            if (label) onDrillDown(String(label));
        }
    } : undefined;

    const treemapOptions = useMemo(() => ({
        onClick: handleClick,
        plugins: {
            legend: { display: false }, // Treemap legend is tricky
            tooltip: {
                callbacks: {
                    title: (items: any) => items[0].raw.g,
                    label: (item: any) => formatNumber(item.raw.v)
                }
            }
        }
    }), [handleClick]);

    // Merge onClick into the main options for non-treemap charts
    const chartOptions = useMemo(() => ({
        ...options,
        onClick: handleClick,
    }), [options, handleClick]);

    // ── EARLY RETURN — must be AFTER all hooks to avoid "fewer hooks" crash ──
    if (!data || data.length === 0 || !chartData) {
        return (
            <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-4">
                <div className="text-center">
                    <div className="text-4xl mb-3">{"\u{1F4AD}"}</div>
                    <p className="text-slate-400 text-sm mb-1">No data to display</p>
                    <p className="text-slate-500 text-xs">The current filter or selection returned no results.</p>
                </div>
                {onGoBack && (
                    <button
                        onClick={onGoBack}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 hover:text-violet-300 transition-all text-sm font-medium border border-violet-500/20"
                    >
                        {"\u2190"} Go Back to Previous View
                    </button>
                )}
            </div>
        );
    }


    /** Optional goal bar under a KPI (Appearance → Goal). */
    const renderKpiGoal = (value: number) => {
        const goal = formatting?.kpiGoal;
        if (!goal || !Number.isFinite(goal) || goal <= 0) return null;
        const progress = Math.max(0, value / goal);
        const shown = Math.min(1, progress);
        return (
            <div className="qi-kpi-goal" aria-label={`${Math.round(progress * 100)}% of goal ${formatNumber(goal)}`}>
                <div className="qi-kpi-goal-track">
                    <div className={`qi-kpi-goal-fill ${progress >= 1 ? 'is-met' : ''}`} style={{ width: `${shown * 100}%` }} />
                    <span className="qi-kpi-goal-marker" style={{ left: `${shown * 100}%` }} />
                </div>
                <div className="qi-kpi-goal-scale">
                    <span>0</span>
                    <span>{Math.round(progress * 100)}% of goal</span>
                    <span>Goal {formatNumber(goal)}</span>
                </div>
            </div>
        );
    };

    const renderChart = () => {
        // KPI Card — pure HTML, no Chart.js
        if (chartType === 'kpiCard') {
            const hasComparisonData = transformedData?.some((d: any) => d.previous_value !== undefined);
            if (hasComparisonData) {
                // Comparison KPI: show current vs previous with proportional bars + growth badge
                const currentVal = transformedData?.reduce((a: number, d: any) => a + (Number(d[yKey]) || 0), 0) ?? 0;
                const prevVal = transformedData?.reduce((a: number, d: any) => a + (Number(d.previous_value) || 0), 0) ?? 0;
                const growthPct = prevVal !== 0 ? ((currentVal - prevVal) / Math.abs(prevVal)) * 100 : (currentVal !== 0 ? 100 : 0);
                const isPositive = growthPct >= 0;
                const maxVal = Math.max(currentVal, prevVal) || 1;

                // Build period labels from config
                const compLabel = config?.comparison === 'same_period_last_n'
                    ? `Last ${config.comparisonOffset || 1} ${config.comparisonGrain || 'day'}${(config.comparisonOffset || 1) > 1 ? 's' : ''}`
                    : config?.comparison === 'same_period_last_year' ? 'Last Year' : 'Previous Period';

                const goalBar = renderKpiGoal(currentVal);
                return (
                    <div className="qi-kpi qi-kpi-comparison qi-kpi-clean flex flex-col justify-center h-full px-6 py-5">
                        <div className="qi-kpi-value qi-kpi-number">{formatNumber(currentVal)}</div>
                        <div className="qi-kpi-label qi-kpi-caption">{calculatedYLabel || 'Current period'}</div>
                        <div className={`qi-kpi-delta ${isPositive ? 'is-up' : 'is-down'}`}>
                            <span className="qi-kpi-delta-change">{isPositive ? '↑' : '↓'} {Math.abs(growthPct).toFixed(2)}%</span>
                            <span className="qi-kpi-delta-context">vs. {compLabel.toLowerCase()}: {formatNumber(prevVal)}</span>
                        </div>
                        {goalBar}
                    </div>
                );
            }

            // Standard KPI card (no comparison)
            const total = transformedData?.reduce((a: number, d: any) => a + (Number(d[yKey]) || 0), 0) ?? 0;
            const count = transformedData?.length ?? 0;
            const avg = count > 0 ? total / count : 0;
            const max = Math.max(...(transformedData?.map((d: any) => Number(d[yKey]) || 0) ?? [0]));
            return (
                <div className="qi-kpi qi-kpi-clean flex flex-col justify-center h-full px-6 py-5">
                    <div className="qi-kpi-value qi-kpi-number">{formatNumber(total)}</div>
                    <div className="qi-kpi-label qi-kpi-caption">{calculatedYLabel || 'Total'}</div>
                    {count > 1 && (
                        <div className="qi-kpi-context qi-kpi-facts">
                            <span><strong>{count.toLocaleString()}</strong> records</span>
                            <span>Avg <strong>{formatNumber(avg)}</strong></span>
                            <span>Max <strong>{formatNumber(max)}</strong></span>
                        </div>
                    )}
                    {renderKpiGoal(total)}
                </div>
            );
        }

        let ChartComponent: any;
        // Override chart type to Line when in trend comparison mode (dual-line overlay)
        // But ONLY when there are enough data points — otherwise keep bar for grouped comparison
        const compExplicitlyOff = !config?.comparison || config?.comparison === 'none';
        const hasAnyCompData = !compExplicitlyOff && data.some((d: any) => d.previous_value !== undefined);
        const hasManyPoints = data.length > 4;
        const isTrendFromConfig = !compExplicitlyOff && (config?.comparison === 'previous_period' || config?.comparison === 'same_period_last_year' || config?.comparison === 'same_period_last_n')
            && ['day', 'week', 'month', 'quarter', 'year'].includes(config?.dimension || '');
        const isTrendFromData = !compExplicitlyOff && data.length > 2 && data.some((d: any) => d.previous_value !== undefined);
        // Only override to line for multi-point trends — few points stay as bar for grouped comparison
        const isTrendComparison = hasManyPoints && (isTrendFromConfig || isTrendFromData);
        let effectiveChartType = isTrendComparison ? 'line' : chartType;
        // Force bar chart when comparison exists with few data points (grouped bars look better than dots/lines)
        if (hasAnyCompData && !hasManyPoints && ['line', 'area', 'steppedLine', 'curvedLine', 'pie', 'doughnut'].includes(effectiveChartType)) {
            effectiveChartType = 'bar';
        }
        switch (effectiveChartType) {
            case 'bar':
            case 'horizontalBar':
            case 'stackedBar':
            case 'groupedBar':
            case 'waterfall':
            case 'funnel':
                ChartComponent = Bar; break;
            case 'combo':
                ChartComponent = Chart; break; // Mixed bar+line for dual-axis
            case 'lollipop':
                ChartComponent = Chart; break; // Mixed bar+scatter
            case 'line':
            case 'area':
            case 'stackedArea':
            case 'steppedLine':
            case 'curvedLine':
                ChartComponent = Line; break;
            case 'pie': ChartComponent = Pie; break;
            case 'doughnut': ChartComponent = Doughnut; break;
            case 'gauge': ChartComponent = Doughnut; break;
            case 'polarArea': ChartComponent = PolarArea; break;
            case 'radar': ChartComponent = Radar; break;
            case 'scatter': ChartComponent = Scatter; break;
            case 'bubble': ChartComponent = Bubble; break;
            case 'treemap': ChartComponent = Chart; break;
            default: ChartComponent = Bar;
        }

        if (chartType === 'treemap') {
            return <ChartComponent type='treemap' ref={chartRef} data={chartData as any} options={treemapOptions} plugins={plugins} />;
        }

        if (chartType === 'map') {
            return (
                <div className="w-full h-full p-4">
                    <MapChart
                        data={transformedData || []}
                        locationKey={xKey}
                        valueKey={yKey}
                        labelContent={formatting?.mapLabelContent || 'value'}
                        onTooltip={(text: string) => { }}
                    />
                </div>
            );
        }


        return <ChartComponent ref={chartRef} data={chartData as any} options={chartOptions} plugins={plugins} />;
    };

    return (
        <div data-appearance={isDark ? 'dark' : 'light'} className="qi-visual h-full w-full flex flex-col overflow-hidden bg-transparent">
            {/* Controls - Hidden on Dashboard */}
            {!hideControls && (
                <div className={`qi-visual-toolbar flex items-center gap-3 border-b px-4 py-2.5 shrink-0 ${isDark ? 'border-white/10' : 'border-slate-100'}`}>
                    {/* Chart Type Dropdown */}
                    <div className="relative">
                        <button
                            onClick={() => setChartSelectorOpen(!chartSelectorOpen)}
                            className="qi-chart-type-trigger flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-bold transition-all"
                        >
                            {(() => {
                                const currentType = CHART_TYPE_OPTIONS.flatMap(g => g.items).find(i => i.id === chartType);
                                if (currentType) {
                                    const Icon = currentType.icon;
                                    return <><Icon className="w-4 h-4" /><span>{currentType.label}</span></>;
                                }
                                return <><BarChart2 className="w-4 h-4" /><span>Bar</span></>;
                            })()}
                            <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                        {chartSelectorOpen && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setChartSelectorOpen(false)} />
                                <div className="qi-chart-menu absolute top-full left-0 mt-2 z-50 bg-white rounded-2xl border border-slate-200 p-3 w-[420px] max-h-[500px] overflow-y-auto">
                                    {CHART_TYPE_OPTIONS.map(group => (
                                        <div key={group.category} className="mb-3 last:mb-0">
                                            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider px-1 mb-1.5">{group.category}</div>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                                                {group.items.map(type => (
                                                    <button
                                                        key={type.id}
                                                        onClick={() => { onChartTypeChange(type.id); setChartSelectorOpen(false); }}
                                                        className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-[13px] font-semibold transition-all ${chartType === type.id
                                                            ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300'
                                                            : 'text-slate-600 hover:bg-slate-50 hover:text-slate-800'
                                                            }`}
                                                    >
                                                        <type.icon className="w-4 h-4 shrink-0" />
                                                        <span className="truncate">{type.label}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>

                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Zoom Controls */}
                    <div className="qi-zoom-control flex items-center gap-0.5 border border-slate-200 rounded-xl overflow-hidden">
                        <button
                            onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(1)))}
                            className="p-2 text-slate-500 hover:bg-slate-100 transition-colors"
                            title="Zoom Out"
                        >
                            <ZoomOut className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setZoom(1)}
                            className="px-2 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 transition-colors min-w-[40px] text-center"
                            title="Reset Zoom"
                        >
                            {Math.round(zoom * 100)}%
                        </button>
                        <button
                            onClick={() => setZoom(z => Math.min(2, +(z + 0.1).toFixed(1)))}
                            className="p-2 text-slate-500 hover:bg-slate-100 transition-colors"
                            title="Zoom In"
                        >
                            <ZoomIn className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Chart Download */}
                    <button
                        onClick={exportChart}
                        className="p-2 rounded-lg text-sm font-bold transition-all shadow-sm text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300"
                        title="Download Chart as PNG"
                    >
                        <Download className="w-4 h-4" />
                    </button>

                    {/* Smart Insight Button */}
                    {onAIInsight && (
                        <button
                            onClick={onAIInsight}
                            className={`px-3.5 py-2 rounded-full flex items-center gap-2 text-[13px] font-bold transition-all shadow-sm ${isAIInsightOpen
                                ? 'bg-blue-600 text-white ring-2 ring-blue-300 shadow-blue-200 shadow-lg'
                                : 'text-blue-700 bg-white border border-slate-200 hover:border-blue-300 hover:shadow-md hover:scale-105'
                                }`}
                            title="Get smart interpretation of this chart (visual only — no data access)"
                        >
                            <img src="/ai-insight-btn.png" alt="" className="w-5 h-5 object-contain" />
                            <span className="text-[13px]">{isAIInsightOpen ? 'Smart Insight' : 'Smart Insight'}</span>
                        </button>
                    )}

                    {/* Style Button */}
                    {onToggleFormat && (
                        <button
                            onClick={onToggleFormat}
                            className={`px-3.5 py-2 rounded-lg flex items-center gap-2 text-[13px] font-bold transition-all shadow-sm ${isFormatOpen
                                ? 'bg-indigo-600 text-white ring-2 ring-indigo-200'
                                : 'text-indigo-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-indigo-300'
                                }`}
                            title="Open Formatting Panel"
                        >
                            <Palette className="w-4.5 h-4.5" />
                            <span>Style</span>
                        </button>
                    )}

                    {/* Analytics Button */}
                    {onToggleAnalytics && (
                        <button
                            onClick={onToggleAnalytics}
                            className={`px-3.5 py-2 rounded-lg flex items-center gap-2 text-[13px] font-bold transition-all shadow-sm ${isAnalyticsOpen
                                ? 'bg-emerald-600 text-white ring-2 ring-emerald-200'
                                : 'text-emerald-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-emerald-300'
                                }`}
                            title="Open Analytics Panel"
                        >
                            <Activity className="w-4.5 h-4.5" />
                            <span>Analytics</span>
                        </button>
                    )}

                    {/* Quick Label Toggle */}
                    {onToggleLabels && (
                        <button
                            onClick={onToggleLabels}
                            className={`px-3.5 py-2 rounded-lg flex items-center gap-2 text-[13px] font-bold transition-all shadow-sm ${
                                formatting?.showDataLabels
                                    ? effectiveDataLabelMode(formatting) === 'all'
                                        ? 'bg-indigo-600 text-white ring-2 ring-indigo-300'
                                        : 'bg-slate-700 text-white ring-2 ring-slate-400'
                                    : 'text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300'
                            }`}
                            title={!formatting?.showDataLabels ? 'Show labels for all series' : effectiveDataLabelMode(formatting) === 'all' ? 'Hide labels' : 'Show all labels'}
                        >
                            <div className="flex items-center justify-center w-4.5 h-4.5 border border-current rounded text-xs font-mono">12</div>
                            <span>Labels</span>
                            {formatting?.showDataLabels && (
                                <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                                    effectiveDataLabelMode(formatting) === 'all'
                                        ? 'bg-indigo-400/30 text-indigo-100'
                                        : 'bg-slate-500/30 text-slate-200'
                                }`}>
                                    {effectiveDataLabelMode(formatting) === 'all' ? 'All' : '1st'}
                                </span>
                            )}
                        </button>
                    )}
                </div>
            )}

            {/* Chart Area - Absolute positioning prevents flex sizing loops */}
            <div className="qi-visual-plot flex-1 min-h-0 relative overflow-auto" ref={resolvedRef}>
                {truncatedFrom > 0 && (
                    <div className={`absolute top-2 right-3 z-10 text-[11px] font-medium px-2.5 py-1 rounded-full pointer-events-none ${isDark ? 'bg-white/10 text-slate-200' : 'bg-slate-900/5 text-slate-500'}`}>
                        Showing top {transformedData.length} of {truncatedFrom.toLocaleString()}
                    </div>
                )}
                <div
                    className="absolute inset-0"
                    style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', width: `${100 / zoom}%`, height: `${100 / zoom}%` }}
                >
                    <div className="relative w-full h-full">
                        {renderChart()}
                    </div>
                </div>
            </div>
        </div>
    );
};
