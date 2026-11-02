import { describe, expect, it } from 'vitest';
import { approximateMeasure, fitAxisLabel, readableInkOn, truncateToWidth } from '../utils/axisLabels';

// 10 px per character keeps the arithmetic obvious.
const measure = (text: string) => text.length * 10;

describe('axis label fitting', () => {
    it('keeps a label that fits on one line', () => {
        expect(fitAxisLabel('Ford', 100, measure)).toBe('Ford');
    });

    it('wraps a long name onto two lines instead of hiding it', () => {
        expect(fitAxisLabel('Mercedes Benz', 90, measure)).toEqual(['Mercedes', 'Benz']);
    });

    it('shortens the last line when two lines are not enough', () => {
        const lines = fitAxisLabel('Wireless Noise Cancelling Headphones', 100, measure) as string[];
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe('Wireless');
        expect(lines[1].endsWith('…')).toBe(true);
        expect(measure(lines[1])).toBeLessThanOrEqual(100);
    });

    it('shortens a single long word', () => {
        const text = truncateToWidth('Volkswagenwerk', 60, measure);
        expect(text.endsWith('…')).toBe(true);
        expect(measure(text)).toBeLessThanOrEqual(60);
    });

    it('uses one line when asked (horizontal bars)', () => {
        expect(fitAxisLabel('Home & Living Accessories', 120, measure, 1)).toMatch(/…$/);
    });

    it('measures roughly without a canvas', () => {
        expect(approximateMeasure(10)('abcd')).toBeCloseTo(22.4);
    });
});

describe('label ink on a bar', () => {
    it('uses dark text on pale bars and light text on dark bars', () => {
        expect(readableInkOn('#d1fae5')).toBe('#111827');
        expect(readableInkOn('#065f46')).toBe('#ffffff');
        expect(readableInkOn('rgba(30, 64, 175, 1)')).toBe('#ffffff');
    });

    it('returns null for colours it cannot read', () => {
        expect(readableInkOn(undefined)).toBeNull();
        expect(readableInkOn('url(#g)')).toBeNull();
    });
});
