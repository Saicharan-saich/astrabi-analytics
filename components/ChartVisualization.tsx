import React, { useMemo, useRef, useCallback, useState } from 'react';
import html2canvas from 'html2canvas';
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
    RadialLinearScale
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
    Legend,
    Filler,
    RadialLinearScale,
    TreemapController,
    TreemapElement
);

import { Dataset, ColumnType, AggregationType, QueryConfig, AnalysisResult, TimeGrain, AnalysisType, ChartConfig, FormattingConfig } from '../types';
import { applyTableCalculation } from '../utils/tableCalculations';
import {
    PALETTES, FONT_SIZES,
    isSequentialData, createGradient, lightenColor,
    selectPalette, generateColors as genColors,
    formatNumber as formatNum, formatDateLabel
} from '../utils/chartUtils';
import { MapChart } from './MapChart';

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
    onAIInsight?: () => void;
    isAIInsightOpen?: boolean;
    chartContainerRef?: React.RefObject<HTMLDivElement | null>;
}

// ── Chart Type Registry ──────────────────────────────────────────────
const CHART_TYPE_OPTIONS = [
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
    onAIInsight,
    isAIInsightOpen,
    chartContainerRef
}) => {
    // Chart ref for PNG export
    // Chart ref for PNG export
    const chartRef = useRef<any>(null);
    const localChartRef = useRef<HTMLDivElement>(null);
    const resolvedRef = (chartContainerRef || localChartRef) as React.RefObject<HTMLDivElement>;
    const [zoom, setZoom] = useState(1);
    const [chartSelectorOpen, setChartSelectorOpen] = useState(false);

    const exportChart = useCallback(async () => {
        if (resolvedRef.current) {
            try {
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

    const { transformedData, yLabel: calculatedYLabel, suggestedNumberFormat } = useMemo(() => {
        if (!primaryCalc) {
            return {
                transformedData: data,
                yLabel: yLabel || '',
                suggestedNumberFormat: formatting?.numberFormat || 'raw'
            };
        }

        return applyTableCalculation(
            data,
            yKey,
            primaryCalc,
            yLabel || '',
            formatting?.numberFormat,
            undefined,
            formatting?.movingAvgWindow || 3
        );
    }, [data, yKey, primaryCalc, yLabel, formatting?.numberFormat, formatting?.movingAvgWindow]);

    // Use calculated number format if available
    const activeNumberFormat = suggestedNumberFormat || formatting?.numberFormat || 'raw';

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
            // Check for Currency indicators BEFORE percentage — currency is far more common
            // and prevents false-positive % detection (e.g., "generate" matching "rate")
            else if (metricName.includes('sales') || metricName.includes('revenue') || metricName.includes('price') || metricName.includes('cost') || metricName.includes('amount') || metricName.includes('profit') || metricName.includes('margin')) {
                effectiveFormat = 'currency_usd';
            }
            // Check for Percentage indicators — use word-boundary regex to avoid
            // false positives like "generate" matching "rate"
            else if (
                (rawLabel.startsWith('%') && (rawLabel.includes(' by ') || rawLabel.includes(' of ') || rawLabel.includes(' from '))) ||
                metricName.includes('percent of') || /\bshare\b/.test(metricName) ||
                /\brate\b/.test(metricName) || /\bconversion\b/.test(metricName) || /\bratio\b/.test(metricName)
            ) {
                effectiveFormat = 'percent';
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
                case 'percent':
                    return value.toFixed(fractionDigits) + '%';
                case 'compact':
                    return new Intl.NumberFormat('en-US', {
                        notation: 'compact',
                        compactDisplay: 'short',
                        minimumFractionDigits: fractionDigits,
                        maximumFractionDigits: fractionDigits
                    }).format(value);
                default:
                    return value.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
            }
        } catch {
            return value.toLocaleString();
        }
    };

    // Prepare chart data
    const chartData = useMemo(() => {
        if (!transformedData || transformedData.length === 0) return null;

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
        const isBarVariant = chartType === 'bar' || chartType === 'horizontalBar' || chartType === 'stackedBar' || chartType === 'groupedBar' || chartType === 'waterfall' || chartType === 'funnel' || chartType === 'lollipop';
        const isLineVariant = chartType === 'line' || chartType === 'area' || chartType === 'stackedArea' || chartType === 'steppedLine' || chartType === 'curvedLine';

        // TREEMAP DATA TRANSFORMATION
        if (chartType === 'treemap') {
            return {
                datasets: [{
                    label: calculatedYLabel || 'Value',
                    tree: transformedData,
                    key: yKey,
                    groups: [xKey],
                    backgroundColor: (ctx: any) => {
                        if (ctx.type !== 'data') return 'transparent';
                        const value = ctx.raw.v;
                        return genColors(1, PALETTES.vibrant, false)[0]; // Simplified for now
                    },
                    borderColor: '#fff',
                    borderWidth: 1,
                    spacing: 0,
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

        // SMART COLOR SELECTION: Sequential vs Discrete
        const useSequential = isSequentialData(xKey, transformedData);

        // Select appropriate palette
        let palette: string[];
        if (formatting?.colorMode) {
            // User manually selected a palette
            const selectedMode = formatting.colorMode as keyof typeof PALETTES;

            if (useSequential) {
                // If Sequential Data: Map Discrete selection to Sequential Palette
                // vibrant -> blue, neon -> green, sunset -> orange, etc.
                const map: Record<string, string[]> = {
                    vibrant: PALETTES.blueSequential,
                    electric: PALETTES.purpleSequential,
                    neon: PALETTES.greenSequential,
                    sunset: PALETTES.orangeSequential,
                    ocean: PALETTES.tealSequential
                };
                // If the user actually selected a sequential palette explicitly (if we allowed it), use it. 
                // Otherwise map from discrete.
                palette = map[selectedMode] || PALETTES[selectedMode] || PALETTES.blueSequential;
            } else {
                // Discrete Data: Use the selected Multi-Color palette
                palette = PALETTES[selectedMode] || PALETTES.vibrant;
            }
        } else {
            // Auto-select based on data type
            if (useSequential) {
                // Time-series or measure analysis → Use sequential gradient
                palette = PALETTES.blueSequential;
            } else {
                // Categorical/dimension analysis → Use discrete multi-color
                palette = PALETTES.vibrant;
            }
        }

        const baseColor = palette[Math.floor(palette.length / 2)]; // Mid-tone
        const borderColor = palette[Math.floor(palette.length / 3)]; // Darker shade

        // Generate colors for multiple data points
        const generateColors = (input: number | number[]) => {
            const count = Array.isArray(input) ? input.length : input;

            if (useSequential) {
                // Sequential: Use gradient from light to dark based on VALUE
                if (Array.isArray(input)) {
                    const vals = input;
                    const max = Math.max(...vals);
                    const min = Math.min(...vals);
                    const range = max - min || 1;

                    return vals.map(v => {
                        // Normalize 0 to 1
                        const normalized = (v - min) / range;
                        // Map to palette index. Higher value = Higher index (Darker)
                        const index = Math.floor(normalized * (palette.length - 1));
                        return palette[index];
                    });
                } else {
                    // Fallback for Pie charts or where values aren't passed
                    return Array.from({ length: count }, (_, i) => {
                        const index = Math.floor((i / Math.max(1, count - 1)) * (palette.length - 1));
                        return palette[index];
                    });
                }
            } else {
                // Discrete: Cycle through distinct colors
                return Array.from({ length: count }, (_, i) => palette[i % palette.length]);
            }
        };

        // KPI Card: no Chart.js dataset needed
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
                    { label: calculatedYLabel || 'Value', data: [...waterfallData, cumulative], backgroundColor: [...bgColors, baseColor], borderWidth: 0, borderRadius: 4, borderSkipped: false, barPercentage: 0.5, stack: 'waterfall' }
                ]
            };
        }

        // Funnel: horizontal bars sorted by descending value
        if (chartType === 'funnel') {
            const sorted = transformedData
                .map((d, i) => ({ label: labels[i], value: values[i] }))
                .sort((a, b) => b.value - a.value);
            return {
                labels: sorted.map(d => d.label),
                datasets: [{
                    label: calculatedYLabel || 'Value',
                    data: sorted.map(d => d.value),
                    backgroundColor: generateColors(sorted.length),
                    borderRadius: 4,
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

        // Standard dataset construction for all other types
        const isFillChart = chartType === 'area' || chartType === 'stackedArea';
        const isStepped = chartType === 'steppedLine';
        const isCurved = chartType === 'curvedLine' || chartType === 'area';

        const datasets: any[] = [{
            label: calculatedYLabel || 'Value',
            data: values,
            backgroundColor: isPieChart
                ? generateColors(values.length)
                : isFillChart
                    ? `${baseColor}40`
                    : isBarVariant
                        ? generateColors(values)
                        : `${baseColor}DD`,
            borderColor: isPieChart
                ? (generateColors(values.length) as string[]).map((c) => lightenColor(c, -10))
                : borderColor,
            borderWidth: isPieChart ? 2 : isLineVariant ? 3 : isBarVariant ? 0 : 2,
            fill: isFillChart,
            tension: isCurved ? 0.4 : isStepped ? 0 : (chartType === 'line' ? 0.35 : 0),
            stepped: isStepped ? 'middle' as const : false,
            pointRadius: isLineVariant ? 4 : 0,
            pointHoverRadius: isLineVariant ? 6 : 0,
            pointBackgroundColor: '#fff',
            pointBorderColor: borderColor,
            pointBorderWidth: 2,
            pointHoverBorderWidth: 3,
            borderRadius: isBarVariant ? 6 : 0,
            borderSkipped: 'bottom',
            maxBarThickness: 50,
            hoverBackgroundColor: isBarVariant ? lightenColor(baseColor, 10) : undefined,
            yAxisID: 'y',
        }];

        // Add Comparison Dataset ONLY when comparison is explicitly enabled
        if (config?.comparison === 'previous_period' && transformedData.some(d => d.previous_value !== undefined)) {
            const prevValues = transformedData.map(d => d.previous_value !== undefined ? Number(d.previous_value) || 0 : null);

            // Derive a clearly visible complementary color for comparison bars
            const comparisonColor = useSequential
                ? '#f59e0b' // Amber-500 — warm contrast against blue sequential palette
                : '#6366f1'; // Indigo-500 — distinct secondary color for vibrant palettes

            datasets.push({
                label: 'Previous Period',
                data: prevValues,
                backgroundColor: comparisonColor,
                borderColor: useSequential ? '#d97706' : '#4f46e5',
                borderWidth: chartType === 'line' ? 2 : 1,
                borderDash: chartType === 'line' ? [5, 5] : undefined,
                borderRadius: chartType === 'bar' ? 4 : 0,
                maxBarThickness: 80,
                type: chartType,
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

        return {
            labels,
            datasets
        };
    }, [transformedData, xKey, yKey, chartType, calculatedYLabel, formatting]);

    const options = useMemo(() => {
        const isPieChart = chartType === 'pie' || chartType === 'gauge';
        const isBarVariant = chartType === 'bar' || chartType === 'horizontalBar' || chartType === 'stackedBar' || chartType === 'groupedBar' || chartType === 'waterfall' || chartType === 'funnel' || chartType === 'lollipop';
        const isStacked = chartType === 'stackedBar' || chartType === 'stackedArea' || chartType === 'waterfall';
        const isHorizontal = chartType === 'horizontalBar' || chartType === 'funnel';
        const fontSize = formatting ? FONT_SIZES[formatting.fontSize || 'md'] : 12;
        const xVisible = formatting?.showXAxis ?? formatting?.showAxis ?? false;
        const yVisible = formatting?.showYAxis ?? formatting?.showAxis ?? false;

        return {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: isHorizontal ? 'y' as const : 'x' as const,
            layout: {
                padding: { top: 60, left: 20, right: 20, bottom: 20 }
            },
            plugins: {
                // Custom Data Labels Plugin
                customDataLabels: { // Namespace for our custom plugin
                    display: formatting ? formatting.showDataLabels : false,
                    formatter: (val: number) => {
                        return formatNumber(val);
                    },
                    color: '#334155', // Slate 700
                    font: {
                        weight: 'bold',
                        size: 11
                    },
                    anchor: 'end',
                    align: 'end',
                    offset: 4
                },
                legend: {
                    position: 'bottom' as const, // Moved to bottom to avoid overlap
                    align: 'center' as const,
                    labels: {
                        font: { size: fontSize },
                        usePointStyle: true,
                        padding: 15,
                    }
                },
                title: {
                    display: false, // Handled by parent container header
                    text: calculatedYLabel || '',
                    font: {
                        size: formatting?.headerSize === 'sm' ? 14 :
                            formatting?.headerSize === 'md' ? 16 :
                                formatting?.headerSize === 'lg' ? 18 :
                                    formatting?.headerSize === 'xl' ? 22 : 18,
                        weight: formatting?.headerBold ? 'bold' as const : 'normal' as const
                    },
                    color: '#1e293b',
                    padding: {
                        top: 10,
                        bottom: 15
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.92)',
                    titleColor: '#f1f5f9',
                    bodyColor: '#cbd5e1',
                    borderColor: 'rgba(99, 102, 241, 0.25)',
                    borderWidth: 1,
                    padding: { top: 10, bottom: 10, left: 14, right: 14 },
                    cornerRadius: 10,
                    titleFont: {
                        size: 13,
                        weight: 'bold' as const,
                        family: "'Inter', 'system-ui', sans-serif"
                    },
                    bodyFont: {
                        size: 12,
                        family: "'Inter', 'system-ui', sans-serif"
                    },
                    displayColors: true,
                    boxPadding: 6,
                    callbacks: {
                        label: function (context: any) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }

                            if (context.parsed.y !== null || context.parsed.x !== null) {
                                // For horizontal bars, value is in parsed.x; for vertical, it's in parsed.y
                                const val = isHorizontal ? context.parsed.x : context.parsed.y;
                                if (val !== null && val !== undefined) {
                                    label += formatNumber(val);
                                }
                            } else if (context.parsed !== null) {
                                label += formatNumber(context.parsed); // For Pie charts
                            }

                            // If comparison data exists, show growth in tooltip
                            if (context.datasetIndex === 0 && transformedData[context.dataIndex]?.growth_pct !== undefined) {
                                const growth = transformedData[context.dataIndex].growth_pct;
                                const sign = growth >= 0 ? '+' : '';
                                label += ` (${sign}${growth.toFixed(1)}%)`;
                            }
                            return label;
                        }
                    }
                },
            },
            scales: isPieChart ? undefined : {
                x: {
                    display: xVisible,
                    stacked: isStacked,
                    ...(isHorizontal ? { beginAtZero: true, min: 0 } : {}),
                    grid: {
                        display: isHorizontal, // Show grid on X for horizontal (value axis)
                        drawBorder: xVisible,
                        borderColor: 'rgba(0, 0, 0, 0.1)',
                        ...(isHorizontal ? { color: 'rgba(148, 163, 184, 0.06)' } : {}),
                    },
                    ticks: {
                        display: xVisible,
                        maxRotation: isHorizontal ? 0 : 45,
                        minRotation: 0,
                        font: {
                            size: fontSize + 1,
                            weight: formatting?.axisBold ? 'bold' as const : 'normal' as const
                        },
                        color: formatting?.axisColor || '#475569',
                        // For horizontal bars, X-axis is the VALUE axis — format numbers
                        // For vertical bars, X-axis is the CATEGORY axis — no callback needed
                        ...(isHorizontal ? {
                            callback: function (value: any) {
                                return formatNumber(value);
                            }
                        } : {}),
                    },
                },
                y: {
                    display: yVisible,
                    ...(isHorizontal ? {} : { min: 0, beginAtZero: true }),
                    stacked: isStacked,
                    grid: {
                        display: isHorizontal ? false : yVisible,  // Hide grid on Y for horizontal (category axis)
                        color: 'rgba(148, 163, 184, 0.06)',
                        drawBorder: false,
                        tickLength: 0,
                    },
                    ticks: {
                        display: yVisible,
                        font: {
                            size: isHorizontal ? fontSize : fontSize + 2,
                            weight: formatting?.axisBold ? 'bold' as const : 'normal' as const
                        },
                        color: formatting?.axisColor || '#475569',
                        // For vertical bars, Y-axis is the VALUE axis — format numbers
                        // For horizontal bars, Y-axis is the CATEGORY axis — let Chart.js show labels natively
                        ...(!isHorizontal ? {
                            callback: function (value: any) {
                                return formatNumber(value);
                            }
                        } : {}),
                    }
                }
            },
            // SMOOTH ANIMATIONS
            animation: {
                duration: 800, // Smooth entrance
                easing: 'easeInOutQuart' as const,
                active: {
                    animation: {
                        duration: 300
                    }
                }
            },
            interaction: {
                mode: 'index' as const,
                intersect: false,
            },
        } as any; // Cast to any to allow custom scale ID 'y1'
    }, [chartType, formatting, transformedData, chartData, calculatedYLabel, xKey, yKey]);

    if (!data || data.length === 0 || !chartData) {
        return (
            <div className="flex items-center justify-center h-full min-h-[300px] text-slate-400">
                No data to display
            </div>
        );
    }

    const dataLabelsPlugin = useMemo<any>(() => ({
        id: 'customDataLabels',
        afterDatasetsDraw(chart: any, args: any, options: any) {
            if (!options.display) return;

            const { ctx } = chart;
            ctx.save();
            ctx.font = `${options.font.weight} ${options.font.size}px "Inter", sans-serif`;
            ctx.fillStyle = options.color;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';

            chart.data.datasets.forEach((dataset: any, i: number) => {
                const meta = chart.getDatasetMeta(i);
                if (meta.hidden) return;

                meta.data.forEach((element: any, index: number) => {
                    const value = dataset.data[index];
                    const text = options.formatter ? options.formatter(value, { dataset }) : value;

                    let x = element.x;
                    let y = element.y;

                    if (chart.config.type === 'pie' || chart.config.type === 'doughnut') {
                        const { x: cx, y: cy } = element.tooltipPosition();
                        x = cx;
                        y = cy;
                        ctx.textBaseline = 'middle';
                    } else {
                        if (value < 0) {
                            y = element.y + 10;
                            ctx.textBaseline = 'top';
                        } else {
                            y = element.y - 10;
                            ctx.textBaseline = 'bottom';
                        }
                    }

                    if (y > 10) {
                        ctx.fillText(text, x, y);
                    }
                });
            });
            ctx.restore();
        }
    }), []);

    // Growth % labels plugin — draws colored growth text above bar pairs
    const growthLabelsPlugin = useMemo<any>(() => ({
        id: 'growthLabels',
        afterDatasetsDraw(chart: any) {
            const hasComparison = transformedData.some(d => d.growth_pct !== undefined);
            if (!hasComparison) return;

            const { ctx } = chart;
            const mainMeta = chart.getDatasetMeta(0);
            if (!mainMeta || mainMeta.hidden) return;

            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';

            mainMeta.data.forEach((element: any, index: number) => {
                const row = transformedData[index];
                if (!row || row.growth_pct === undefined) return;

                const growth = Number(row.growth_pct);
                const isPositive = growth >= 0;
                const sign = isPositive ? '+' : '';
                const text = `${sign}${growth.toFixed(1)}%`;

                // Color: green for positive, red for negative
                ctx.fillStyle = isPositive ? '#059669' : '#dc2626';
                ctx.font = 'bold 11px "Inter", sans-serif';

                // Position above the main bar
                const x = element.x;
                const y = element.y - 16;

                if (y > 8) {
                    // Draw a small rounded pill background
                    const textWidth = ctx.measureText(text).width;
                    const pillPad = 4;
                    const pillH = 16;
                    const pillW = textWidth + pillPad * 2;
                    const pillX = x - pillW / 2;
                    const pillY = y - pillH + 2;
                    const radius = 4;

                    ctx.fillStyle = isPositive ? 'rgba(5,150,105,0.12)' : 'rgba(220,38,38,0.12)';
                    ctx.beginPath();
                    ctx.moveTo(pillX + radius, pillY);
                    ctx.lineTo(pillX + pillW - radius, pillY);
                    ctx.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + radius);
                    ctx.lineTo(pillX + pillW, pillY + pillH - radius);
                    ctx.quadraticCurveTo(pillX + pillW, pillY + pillH, pillX + pillW - radius, pillY + pillH);
                    ctx.lineTo(pillX + radius, pillY + pillH);
                    ctx.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - radius);
                    ctx.lineTo(pillX, pillY + radius);
                    ctx.quadraticCurveTo(pillX, pillY, pillX + radius, pillY);
                    ctx.closePath();
                    ctx.fill();

                    // Draw text
                    ctx.fillStyle = isPositive ? '#059669' : '#dc2626';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(text, x, pillY + pillH / 2);
                }
            });
            ctx.restore();
        }
    }), [transformedData]);

    const plugins = useMemo(() => [dataLabelsPlugin, growthLabelsPlugin], [dataLabelsPlugin, growthLabelsPlugin]);

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

    const renderChart = () => {
        // KPI Card — pure HTML, no Chart.js
        if (chartType === 'kpiCard') {
            const total = transformedData?.reduce((a: number, d: any) => a + (Number(d[yKey]) || 0), 0) ?? 0;
            const count = transformedData?.length ?? 0;
            const avg = count > 0 ? total / count : 0;
            const max = Math.max(...(transformedData?.map((d: any) => Number(d[yKey]) || 0) ?? [0]));
            return (
                <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
                    <div className="text-5xl font-black text-indigo-600">{formatNumber(total)}</div>
                    <div className="text-sm font-medium text-slate-500 uppercase tracking-wider">{calculatedYLabel || 'Total'}</div>
                    <div className="flex gap-6 mt-2">
                        <div className="text-center"><div className="text-lg font-bold text-slate-700">{count}</div><div className="text-[10px] text-slate-400">Records</div></div>
                        <div className="text-center"><div className="text-lg font-bold text-slate-700">{formatNumber(avg)}</div><div className="text-[10px] text-slate-400">Average</div></div>
                        <div className="text-center"><div className="text-lg font-bold text-slate-700">{formatNumber(max)}</div><div className="text-[10px] text-slate-400">Max</div></div>
                    </div>
                </div>
            );
        }

        let ChartComponent: any;
        switch (chartType) {
            case 'bar':
            case 'horizontalBar':
            case 'stackedBar':
            case 'groupedBar':
            case 'waterfall':
            case 'funnel':
                ChartComponent = Bar; break;
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
        <div className="h-full w-full flex flex-col overflow-hidden bg-white">
            {/* Controls - Hidden on Dashboard */}
            {!hideControls && (
                <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 shrink-0">
                    {/* Chart Type Dropdown */}
                    <div className="relative">
                        <button
                            onClick={() => setChartSelectorOpen(!chartSelectorOpen)}
                            className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 text-[13px] font-bold hover:bg-indigo-100 transition-all"
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
                                <div className="absolute top-full left-0 mt-1 z-50 bg-white rounded-xl shadow-2xl border border-slate-200 p-3 w-[420px] max-h-[500px] overflow-y-auto">
                                    {CHART_TYPE_OPTIONS.map(group => (
                                        <div key={group.category} className="mb-3 last:mb-0">
                                            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider px-1 mb-1.5">{group.category}</div>
                                            <div className="grid grid-cols-3 gap-1.5">
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
                    <div className="flex items-center gap-0.5 border border-slate-200 rounded-lg overflow-hidden">
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
                            className={`px-3.5 py-2 rounded-lg flex items-center gap-2 text-[13px] font-bold transition-all shadow-sm ${formatting?.showDataLabels
                                ? 'bg-slate-700 text-white ring-2 ring-slate-400'
                                : 'text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300'
                                }`}
                            title="Toggle Data Labels"
                        >
                            <div className="flex items-center justify-center w-4.5 h-4.5 border border-current rounded text-xs font-mono">12</div>
                            <span>Labels</span>
                        </button>
                    )}
                </div>
            )}

            {/* Chart Area - Absolute positioning prevents flex sizing loops */}
            <div className="flex-1 min-h-0 relative overflow-auto" ref={resolvedRef}>
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
