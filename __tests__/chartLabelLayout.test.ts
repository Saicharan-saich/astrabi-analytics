import { describe, expect, it } from 'vitest';
import { layoutChartLabels, type ChartLabelBounds, type ChartLabelCandidate } from '../utils/chartLabelLayout';

const bounds: ChartLabelBounds = { left: 0, right: 400, top: 0, bottom: 220 };

function label(overrides: Partial<ChartLabelCandidate> = {}): ChartLabelCandidate {
    return { x: 200, y: 20, width: 64, height: 16, horizontal: false, positive: true, ...overrides };
}

function rectanglesDoNotOverlap(
    first: { x: number; y: number }, second: { x: number; y: number },
    firstSize: ChartLabelCandidate, secondSize: ChartLabelCandidate,
): boolean {
    return Math.abs(first.x - second.x) >= (firstSize.width + secondSize.width) / 2 + 4
        || Math.abs(first.y - second.y) >= (firstSize.height + secondSize.height) / 2 + 4;
}

describe('Cartesian data label placement', () => {
    it('separates currency and percentage labels sharing a mark near the top axis', () => {
        const inputs = [label({ width: 72 }), label({ width: 58 })];
        const [currency, percentage] = layoutChartLabels(inputs, bounds);
        expect(currency).not.toBeNull();
        expect(percentage).not.toBeNull();
        expect(rectanglesDoNotOverlap(currency!, percentage!, inputs[0], inputs[1])).toBe(true);
    });

    it('places multiple mixed-axis measures without overlapping or leaving the plot', () => {
        const inputs = Array.from({ length: 5 }, (_, i) => label({ x: 200 + i * 2, y: 90, width: 56 + i * 3 }));
        const placements = layoutChartLabels(inputs, bounds);
        expect(placements.every(Boolean)).toBe(true);
        placements.forEach((point, index) => {
            expect(point!.x - inputs[index].width / 2).toBeGreaterThanOrEqual(bounds.left);
            expect(point!.x + inputs[index].width / 2).toBeLessThanOrEqual(bounds.right);
            expect(point!.y - inputs[index].height / 2).toBeGreaterThanOrEqual(bounds.top);
            expect(point!.y + inputs[index].height / 2).toBeLessThanOrEqual(bounds.bottom);
            for (let previous = 0; previous < index; previous++) {
                expect(rectanglesDoNotOverlap(point!, placements[previous]!, inputs[index], inputs[previous])).toBe(true);
            }
        });
    });

    it('keeps dense combined-series labels visible in a short plot', () => {
        const shortPlot: ChartLabelBounds = { left: 0, right: 500, top: 0, bottom: 150 };
        const inputs = Array.from({ length: 8 }, (_, i) => label({
            x: 210 + (i % 4) * 22,
            y: i < 4 ? 34 : 85,
            width: 34,
            height: 14,
        }));
        const placements = layoutChartLabels(inputs, shortPlot);
        expect(placements.every(Boolean)).toBe(true);
        placements.forEach((point, index) => {
            for (let previous = 0; previous < index; previous++) {
                expect(rectanglesDoNotOverlap(point!, placements[previous]!, inputs[index], inputs[previous])).toBe(true);
            }
        });
    });

    it('flips a horizontal bar label away from the right edge', () => {
        const [position] = layoutChartLabels([
            label({ x: 385, y: 100, width: 70, horizontal: true }),
        ], bounds);
        expect(position).not.toBeNull();
        expect(position!.x).toBeLessThan(385);
    });

    it('omits labels rather than painting over others in a space too small for all', () => {
        const crowded: ChartLabelBounds = { left: 0, right: 100, top: 0, bottom: 60 };
        const placements = layoutChartLabels(Array.from({ length: 8 }, () => label({ x: 50, y: 20, width: 70 })), crowded);
        expect(placements.filter(Boolean).length).toBeLessThan(8);
        expect(placements.filter(Boolean).length).toBeGreaterThan(0);
    });

    it('keeps dense city labels with their category and separates bar and line values', () => {
        const cityPlot: ChartLabelBounds = { left: 0, right: 900, top: 0, bottom: 190 };
        const inputs = Array.from({ length: 15 }, (_, index) => {
            const center = index * 60 + 30;
            return [
                label({ x: center, y: 55, width: 43, height: 13, minX: center - 29, maxX: center + 29 }),
                label({ x: center, y: 150, width: 33, height: 12, minX: center - 29, maxX: center + 29, preferredDirection: 'below' as const }),
            ];
        }).flat();
        const placements = layoutChartLabels(inputs, cityPlot);
        expect(placements.every(Boolean)).toBe(true);
        placements.forEach((position, index) => {
            expect(position!.x).toBeGreaterThanOrEqual(inputs[index].minX!);
            expect(position!.x).toBeLessThanOrEqual(inputs[index].maxX!);
            for (let previous = 0; previous < index; previous++) {
                expect(rectanglesDoNotOverlap(position!, placements[previous]!, inputs[index], inputs[previous])).toBe(true);
            }
        });
    });
});
