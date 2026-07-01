import { describe, it, expect } from 'vitest';
import {
    isSequentialData,
    lightenColor,
    selectPalette,
    generateColors,
    formatNumber,
    formatDateLabel,
    PALETTES,
} from '../utils/chartUtils';

describe('isSequentialData', () => {
    it('detects date-like keys', () => {
        expect(isSequentialData('order_date', [{ order_date: '2025-01-01' }])).toBe(true);
        expect(isSequentialData('month', [{ month: '2025-03' }])).toBe(true);
    });

    it('returns false for categorical keys', () => {
        expect(isSequentialData('category', [{ category: 'A' }])).toBe(false);
    });
});

describe('lightenColor', () => {
    it('returns a hex string', () => {
        const result = lightenColor('#336699', 20);
        expect(result).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    it('lightens the color', () => {
        const original = '#000000';
        const lightened = lightenColor(original, 50);
        // Should not be the same as original
        expect(lightened).not.toBe(original);
    });
});

describe('selectPalette', () => {
    it('returns an array of color strings', () => {
        const palette = selectPalette(undefined, 'category', [{ category: 'A' }]);
        expect(Array.isArray(palette)).toBe(true);
        expect(palette.length).toBeGreaterThan(0);
    });

    it('uses formatting colorMode when provided', () => {
        const palette = selectPalette({ colorMode: 'monochrome' } as any, 'category', []);
        expect(Array.isArray(palette)).toBe(true);
    });
});

describe('generateColors', () => {
    it('returns correct number of colors', () => {
        const palette = PALETTES.vibrant;
        const colors = generateColors(5, palette, false);
        expect(colors.length).toBe(5);
    });
});

describe('formatNumber', () => {
    it('formats integer correctly', () => {
        const result = formatNumber(1234);
        expect(result).toContain('1');
    });

    it('formats percent correctly', () => {
        const result = formatNumber(0.45, { numberFormat: 'percent' } as any);
        expect(result).toContain('45');
    });

    it('handles null/undefined gracefully', () => {
        expect(formatNumber(null as any)).toBe('0');
        expect(formatNumber(undefined)).toBe('0');
    });
});

describe('formatDateLabel', () => {
    it('returns formatted date for auto mode', () => {
        const result = formatDateLabel('2025-03-15', 'auto');
        expect(result.length).toBeGreaterThan(0);
    });

    it('handles week grain format', () => {
        // 2025-W12 should pass through
        const result = formatDateLabel('2025-W12', 'auto');
        expect(result).toContain('W');
    });
});
