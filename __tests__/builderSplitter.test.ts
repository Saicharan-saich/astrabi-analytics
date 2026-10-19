import { describe, expect, it } from 'vitest';
import { builderSplitMaximum, clampBuilderSplit } from '../utils/builderSplitter';

describe('Question Builder resizable split', () => {
    it('keeps both panes usable in a normal desktop workspace', () => {
        expect(clampBuilderSplit(550, 1200)).toBe(550);
        expect(clampBuilderSplit(200, 1200)).toBe(320);
        expect(clampBuilderSplit(900, 1200)).toBe(680);
    });

    it('protects the result pane when the workspace narrows', () => {
        expect(builderSplitMaximum(900)).toBe(396);
        expect(clampBuilderSplit(550, 900)).toBe(396);
        expect(clampBuilderSplit(380, 760)).toBe(320);
    });

    it('ignores an invalid persisted width', () => {
        expect(clampBuilderSplit(Number.NaN, 1200)).toBe(380);
    });
});
