import { describe, expect, it } from 'vitest';
import { fitPieLabelText, layoutPieLabelRows } from '../utils/pieLabelLayout';

describe('pie and doughnut outside labels', () => {
    it('keeps labels inside a crowded short canvas without collisions', () => {
        const rows = Array.from({ length: 16 }, (_, index) => ({ index, preferredY: 30 + index * 5, weight: 16 - index }));
        const positions = layoutPieLabelRows(rows, 160);
        expect(positions.length).toBeLessThan(rows.length);
        const byY = [...positions].sort((a, b) => a.y - b.y);
        expect(byY[0].y).toBeGreaterThanOrEqual(14);
        expect(byY[byY.length - 1].y).toBeLessThanOrEqual(146);
        for (let index = 1; index < byY.length; index++) {
            expect(byY[index].y - byY[index - 1].y).toBeGreaterThanOrEqual(20);
        }
        expect(positions.map(position => position.index)).toContain(0);
    });

    it('truncates a long category label to available width', () => {
        const measure = (text: string) => text.length * 8;
        const fitted = fitPieLabelText('Long product category: 28.4%', 80, measure);
        expect(fitted.endsWith('28.4%')).toBe(true);
        expect(measure(fitted)).toBeLessThanOrEqual(80);
        expect(fitPieLabelText('Very long category: 28.4%', 48, measure)).toBe('28.4%');
        expect(fitPieLabelText('Short', 80, measure)).toBe('Short');
        expect(fitPieLabelText('Anything', 4, measure)).toBe('');
    });
});
