// ═══════════════════════════════════════════════════════════════════
// Chart Type Registry & Number Formatting
//
// Extracted from ChartVisualization.tsx for reuse across components.
// Contains:
//   1. CHART_TYPE_OPTIONS — The full chart type selection menu structure
//   2. Number formatting functions (currency, compact, percent, axis)
//   3. Date formatting utilities for chart labels
// ═══════════════════════════════════════════════════════════════════

import {
    BarChart2, LineChart as LineChartIcon, TrendingUp, PieChart as PieIcon,
    Activity, Grid, Disc, Circle, Hexagon, ScatterChart, CircleDot,
    LayoutGrid, Globe, type LucideIcon
} from 'lucide-react';

// ── Chart Type Registry ──────────────────────────────────────────

export interface ChartTypeItem {
    id: string;
    icon: LucideIcon;
    label: string;
}

export interface ChartTypeCategory {
    category: string;
    items: ChartTypeItem[];
}

export const CHART_TYPE_OPTIONS: ChartTypeCategory[] = [
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
            { id: 'map', icon: Globe, label: 'Map' },
            { id: 'combo', icon: Activity, label: 'Combo' },
        ]
    },
];

// ── Number Formatting ────────────────────────────────────────────

export type NumberFormatType = 'raw' | 'currency_usd' | 'currency_eur' | 'percent' | 'compact';

/**
 * Detect the appropriate number format based on metric name semantics.
 */
export function detectNumberFormat(metricName: string): NumberFormatType {
    const name = metricName.toLowerCase();

    if (
        name.includes('discount') ||
        (name.includes('rate') && !/\b(hourly|daily|weekly|monthly|annual|yearly|billing|bill|pay|charge|base|flat)[_ ]?rate\b/.test(name)) ||
        name.includes('ratio') || name.includes('percent') ||
        name.includes('share') || name.includes('conversion') ||
        name.includes('margin_pct')
    ) {
        return 'percent';
    }

    if (
        name.includes('sales') || name.includes('revenue') ||
        name.includes('price') || name.includes('cost') ||
        name.includes('amount') || name.includes('profit') ||
        name.includes('margin')
    ) {
        return 'currency_usd';
    }

    if (
        name.includes('count') || name.includes('quantity') ||
        name.includes('units') || name.includes('volume') ||
        name.includes('orders') || name.includes('users') ||
        name.includes('sessions')
    ) {
        return 'raw';
    }

    return 'compact';
}

/**
 * Format a number value based on the given format type and precision.
 */
export function formatValue(value: number, format: NumberFormatType, fractionDigits: number = 0): string {
    try {
        switch (format) {
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
                return value.toLocaleString(undefined, {
                    minimumFractionDigits: fractionDigits,
                    maximumFractionDigits: fractionDigits
                });
        }
    } catch {
        return value.toLocaleString();
    }
}

/**
 * Format a number for axis display (compact by default).
 * Returns strings like "$1.2M", "500K", "10.5%"
 */
export function formatAxisValue(
    value: number | undefined | null,
    metricName: string = '',
    axisFormat: string = 'compact'
): string {
    if (value === undefined || value === null || isNaN(value)) return '0';
    if (value === 0) return '0';

    const name = metricName.toLowerCase();
    const isCurrency = name.includes('sales') || name.includes('revenue') ||
        name.includes('price') || name.includes('cost') ||
        name.includes('amount') || name.includes('profit');
    const isPercent = name.includes('percent') ||
        (name.includes('rate') && !/\b(hourly|daily|weekly|monthly|annual|yearly|billing|bill|pay|charge|base|flat)[_ ]?rate\b/.test(name)) ||
        name.includes('ratio') || name.includes('share');

    if (isPercent) {
        return value.toFixed(1) + '%';
    }

    if (axisFormat === 'full') {
        return formatValue(value, isCurrency ? 'currency_usd' : 'raw');
    }

    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    const prefix = isCurrency ? '$' : '';
    if (abs >= 1e9) return `${sign}${prefix}${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${sign}${prefix}${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}${prefix}${(abs / 1e3).toFixed(1)}K`;
    if (isCurrency) return `$${value.toFixed(0)}`;
    return value.toLocaleString();
}

// ── Date Label Formatting ────────────────────────────────────────

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a date string for chart axis labels based on the selected format.
 */
export function formatChartDateLabel(
    val: string,
    format: string = 'auto',
    timeGrain?: string
): string {
    if (!val) return val;
    if (format === 'raw') return val;
    if (!val.match(/^\d{4}/)) return val;

    try {
        const parts = val.split(/[-/]/);
        const y = parseInt(parts[0]);
        const m = parseInt(parts[1]) - 1; // 0-indexed
        const d = parseInt(parts[2]) || 1;

        if (isNaN(m)) return val;

        if (format === 'auto') {
            const isMonthGrain = (parts.length === 2 && m <= 11) || (!parts[2] && m <= 11);
            const isWeekGrain = m > 11 || timeGrain === 'week';

            if (isWeekGrain) return `${y}-W${m + 1}`;
            if (isMonthGrain) return `${MONTHS_SHORT[m] || ''} ${y}`;
            return `${MONTHS_SHORT[m] || ''} ${d}, ${y}`;
        }

        switch (format) {
            case 'yyyy-mm-dd': return val;
            case 'mm/dd/yyyy':
                return `${String(m + 1).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
            case 'month_name_year':
                return `${MONTHS_FULL[m]} ${y}`;
            case 'month_short_year':
                return `${MONTHS_SHORT[m]} '${String(y).substring(2)}`;
            case 'month_number':
                return String(m + 1);
            case 'month_name_only':
                return MONTHS_FULL[m];
            default: return val;
        }
    } catch {
        return val;
    }
}

// ── Chart Type Helpers ───────────────────────────────────────────

export function isBarVariant(chartType: string): boolean {
    return chartType === 'bar' || chartType === 'horizontalBar' ||
        chartType === 'stackedBar' || chartType === 'groupedBar';
}

export function isLineVariant(chartType: string): boolean {
    return chartType === 'line' || chartType === 'curvedLine' ||
        chartType === 'steppedLine' || chartType === 'area' || chartType === 'stackedArea';
}

export function isPieVariant(chartType: string): boolean {
    return chartType === 'pie' || chartType === 'doughnut' ||
        chartType === 'polarArea' || chartType === 'radar' || chartType === 'gauge';
}

export function isSpecialChart(chartType: string): boolean {
    return chartType === 'kpiCard' || chartType === 'treemap' ||
        chartType === 'map' || chartType === 'gauge';
}
