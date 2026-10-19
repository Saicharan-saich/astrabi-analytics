import { describe, expect, it } from 'vitest';
import { querySelectMenuPosition } from '../utils/querySelectPosition';

const viewportWidth = 1000;
const viewportHeight = 700;

describe('QuerySelect menu positioning', () => {
    it('opens above at full height when the requested lower side is cramped', () => {
        const position = querySelectMenuPosition({
            anchor: { top: 570, bottom: 610, left: 40, width: 180, height: 40 },
            viewportWidth, viewportHeight, desiredHeight: 420, preference: 'down',
        });
        expect(position.placement).toBe('up');
        expect(position.detached).toBe(false);
        expect(position.maxHeight).toBe(420);
    });

    it('uses a full-height viewport popover rather than shrinking between scrolls', () => {
        for (const top of [300, 340, 380]) {
            const position = querySelectMenuPosition({
                anchor: { top, bottom: top + 40, left: 40, width: 180, height: 40 },
                viewportWidth, viewportHeight, desiredHeight: 480, preference: 'auto',
            });
            expect(position.detached).toBe(true);
            expect(position.maxHeight).toBe(480);
            expect(position.top).toBeGreaterThanOrEqual(8);
            expect(position.top + position.maxHeight).toBeLessThanOrEqual(viewportHeight - 8);
        }
    });

    it('keeps the menu within a narrow viewport', () => {
        const position = querySelectMenuPosition({
            anchor: { top: 100, bottom: 140, left: 270, width: 210, height: 40 },
            viewportWidth: 320, viewportHeight: 700, desiredHeight: 250, preference: 'auto',
        });
        expect(position.width).toBeLessThanOrEqual(304);
        expect(position.left + position.width).toBeLessThanOrEqual(312);
    });
});
