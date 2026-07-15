/**
 * Chart color palettes, color helpers, and data formatting utilities
 * extracted from ChartVisualization.tsx for reusability and testability.
 *
 * v2 — Premium palette upgrade with gradient helpers
 */

import { FormattingConfig, QueryConfig } from '../types';

// ─── Palettes ────────────────────────────────────────────────────────
// Curated harmonious palettes inspired by Linear, Stripe, and Vercel dashboards.
// Each color is carefully chosen for visual harmony and WCAG contrast.

export const PALETTES = {
    // Discrete Multi-Color Palettes (for categorical/dimension analysis)
    vibrant: ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#3b82f6', '#f97316'],
    electric: ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0e7490', '#c026d3', '#2563eb', '#ea580c'],
    neon: ['#00b4d8', '#00cc6a', '#e63946', '#e6b800', '#a855f7', '#e11d48', '#14b8a6', '#84cc16', '#3b82f6', '#f97316'],
    sunset: ['#f43f5e', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#818cf8', '#e879f9', '#f472b6', '#fb7185'],
    ocean: ['#0ea5e9', '#06b6d4', '#14b8a6', '#10b981', '#0284c7', '#0369a1', '#0891b2', '#0d9488', '#059669', '#047857'],

    // Sequential Single-Hue Palettes (richer saturation, smooth gradients)
    blueSequential: ['#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af'],
    greenSequential: ['#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46'],
    purpleSequential: ['#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6'],
    orangeSequential: ['#ffedd5', '#fed7aa', '#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412'],
    tealSequential: ['#ccfbf1', '#99f6e4', '#5eead4', '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e', '#115e59']
};

export type PaletteName = keyof typeof PALETTES;

export const FONT_SIZES: Record<string, number> = {
    xs: 9,
    sm: 10,
    md: 12,
    lg: 14,
};

// ─── Color Helpers ───────────────────────────────────────────────────

/** Detect if analysis is dimension-based (categorical) or measure-based (sequential) */
export const isSequentialData = (xKey: string, data: any[]): boolean => {
    const timePatterns = ['date', 'day', 'week', 'month', 'quarter', 'year', 'time'];
    const isTimeKey = timePatterns.some(pattern => xKey.toLowerCase().includes(pattern));
    const xValues = data.map(d => d[xKey]);
    const isNumeric = xValues.every(v => !isNaN(Number(v)));
    return isTimeKey || (isNumeric && xValues.length > 1);
};

/** Create canvas gradient for line/area fill (top: colored → bottom: transparent) */
export const createGradient = (ctx: CanvasRenderingContext2D, color: string, chartArea: any): string | CanvasGradient => {
    if (!chartArea) return color;
    const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
    gradient.addColorStop(0, color + '08');  // Nearly transparent at bottom
    gradient.addColorStop(0.4, color + '20'); // Subtle midpoint
    gradient.addColorStop(1, color + '50');   // Visible at top near the line
    return gradient;
};

/** Create premium vertical gradient for bar fills (top: bright → bottom: deeper) */
export const createBarGradient = (ctx: CanvasRenderingContext2D, color: string, chartArea: any): string | CanvasGradient => {
    if (!chartArea) return color;
    const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
    gradient.addColorStop(0, color + 'B0'); // Slightly transparent at base
    gradient.addColorStop(1, color + 'F0'); // Rich at top
    return gradient;
};

/** Convert hex color to rgba string */
export const hexToRgba = (hex: string, alpha: number): string => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** Darken a hex color by a percentage (for borders matching bar fill) */
export const darkenColor = (color: string, percent: number = 15): string => {
    const num = parseInt(color.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.max(0, (num >> 16) - amt);
    const G = Math.max(0, ((num >> 8) & 0x00FF) - amt);
    const B = Math.max(0, (num & 0x0000FF) - amt);
    return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
};

/** Lighten or darken a hex color */
export const lightenColor = (color: string, percent: number = 20): string => {
    const num = parseInt(color.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) + amt;
    const G = (num >> 8 & 0x00FF) + amt;
    const B = (num & 0x0000FF) + amt;
    return '#' + (
        0x1000000 +
        (R < 255 ? (R < 1 ? 0 : R) : 255) * 0x10000 +
        (G < 255 ? (G < 1 ? 0 : G) : 255) * 0x100 +
        (B < 255 ? (B < 1 ? 0 : B) : 255)
    ).toString(16).slice(1);
};

/** Pick the correct palette given a formatting config, xKey, and data */
export const selectPalette = (formatting: FormattingConfig | undefined, xKey: string, data: any[]): string[] => {
    const useSequential = isSequentialData(xKey, data);
    if (formatting?.colorMode) {
        const selectedMode = formatting.colorMode as PaletteName;
        if (useSequential) {
            const map: Record<string, string[]> = {
                vibrant: PALETTES.blueSequential,
                electric: PALETTES.purpleSequential,
                neon: PALETTES.greenSequential,
                sunset: PALETTES.orangeSequential,
                ocean: PALETTES.tealSequential,
            };
            return map[selectedMode] || PALETTES[selectedMode] || PALETTES.blueSequential;
        }
        return PALETTES[selectedMode] || PALETTES.vibrant;
    }
    return useSequential ? PALETTES.blueSequential : PALETTES.vibrant;
};

/** Generate colors for a set of values using sequential or discrete logic */
export const generateColors = (
    input: number | number[],
    palette: string[],
    useSequential: boolean
): string[] => {
    const count = Array.isArray(input) ? input.length : input;
    if (useSequential) {
        if (Array.isArray(input)) {
            const vals = input;
            const max = Math.max(...vals);
            const min = Math.min(...vals);
            const range = max - min || 1;
            return vals.map(v => {
                const normalized = (v - min) / range;
                const index = Math.floor(normalized * (palette.length - 1));
                return palette[index];
            });
        }
        return Array.from({ length: count }, (_, i) => {
            const index = Math.floor((i / Math.max(1, count - 1)) * (palette.length - 1));
            return palette[index];
        });
    }
    return Array.from({ length: count }, (_, i) => palette[i % palette.length]);
};

// ─── Number Formatter ────────────────────────────────────────────────

/** Intelligent number formatting with auto-detection */
export const formatNumber = (
    value: number | undefined | null,
    formatting?: FormattingConfig,
    config?: QueryConfig,
    yLabel?: string,
    yKey?: string
): string => {
    if (value === undefined || value === null || isNaN(value)) return '0';

    let effectiveFormat = formatting?.numberFormat;

    // Intelligent Auto-Format
    if (!effectiveFormat || effectiveFormat === 'auto') {
        const metricRef = (config?.metric || yLabel || yKey || '').toLowerCase();
        if (metricRef.includes('count') || metricRef.includes('quantity') || metricRef.includes('volume') || metricRef.includes('users') || metricRef.includes('sessions')) {
            effectiveFormat = value < 1000 ? 'raw' : 'compact';
        } else if (metricRef.includes('sales') || metricRef.includes('revenue') || metricRef.includes('price') || metricRef.includes('cost') || metricRef.includes('amount') || metricRef.includes('profit') || metricRef.includes('margin')) {
            effectiveFormat = 'currency_usd';
        } else if (metricRef.includes('rate') || metricRef.includes('percent') || metricRef.includes('conversion') || metricRef.includes('ratio')) {
            effectiveFormat = 'percent';
        } else {
            effectiveFormat = 'compact';
        }
    }

    const fractionDigits = formatting?.decimals !== undefined ? formatting.decimals : (effectiveFormat === 'currency_usd' || effectiveFormat === 'percent' ? 2 : 0);

    try {
        switch (effectiveFormat) {
            case 'raw':
                return new Intl.NumberFormat('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value);
            case 'currency_usd':
                return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value);
            case 'currency_eur':
                return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value);
            case 'percent': {
                // Scale fractional percents (0.073 → 7.3%) for consistency with charts.
                const pctVal = (Math.abs(value) <= 1 && Math.abs(value) > 0) ? value * 100 : value;
                return pctVal.toFixed(fractionDigits) + '%';
            }
            case 'compact': {
                // Premium compact: one decimal for large values, clean integers below 1000.
                const cd = formatting?.decimals !== undefined ? formatting.decimals : (Math.abs(value) >= 1000 ? 1 : 0);
                return new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short', minimumFractionDigits: 0, maximumFractionDigits: cd }).format(value);
            }
            default:
                return value.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
        }
    } catch {
        return value.toLocaleString();
    }
};

// ─── Date Formatter ──────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format date label strings for chart axes */
export const formatDateLabel = (val: string, format: string = 'auto', config?: QueryConfig): string => {
    if (!val) return val;
    if (format === 'raw') return val;
    if (!val.match(/^\d{4}/)) return val;

    try {
        const parts = val.split(/[-/]/);
        const y = parseInt(parts[0]);
        const m = parseInt(parts[1]) - 1;
        const d = parseInt(parts[2]) || 1;

        if (isNaN(m)) return val;

        if (format === 'auto') {
            const isMonthGrain = (parts.length === 2 && m <= 11) || (!parts[2] && m <= 11);
            const isWeekGrain = m > 11 || (config?.timeGrain as string) === 'week';
            if (isWeekGrain) return `${y}-W${m + 1}`;
            if (isMonthGrain) return `${SHORT_MONTHS[m] || ''} ${y}`;
            return `${SHORT_MONTHS[m] || ''} ${d}, ${y}`;
        }

        switch (format) {
            case 'yyyy-mm-dd': return val;
            case 'mm/dd/yyyy': return `${String(m + 1).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
            case 'month_name_year': return `${MONTHS[m]} ${y}`;
            case 'month_short_year': return `${SHORT_MONTHS[m]} '${String(y).substring(2)}`;
            case 'month_number': return String(m + 1);
            case 'month_name_only': return MONTHS[m];
            default: return val;
        }
    } catch {
        return val;
    }
};
