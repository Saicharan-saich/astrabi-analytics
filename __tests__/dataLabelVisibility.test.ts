import { describe, expect, it } from 'vitest';
import type { FormattingConfig } from '../types';
import { effectiveDataLabelMode, shouldRenderDataLabel, toggleDataLabels } from '../utils/dataLabelVisibility';

const formatting = (showDataLabels: boolean, dataLabelMode?: FormattingConfig['dataLabelMode']) =>
    ({ showDataLabels, dataLabelMode } as FormattingConfig);

describe('data label visibility', () => {
    it('enables labels for every series with one click', () => {
        expect(toggleDataLabels(formatting(false, 'off'))).toMatchObject({
            showDataLabels: true, dataLabelMode: 'all',
        });
    });

    it('upgrades a saved first-series-only setting to all series', () => {
        expect(toggleDataLabels(formatting(true, 'primary'))).toMatchObject({
            showDataLabels: true, dataLabelMode: 'all',
        });
    });

    it('turns all labels off on the next click', () => {
        expect(toggleDataLabels(formatting(true, 'all'))).toMatchObject({
            showDataLabels: false, dataLabelMode: 'off',
        });
    });

    it('treats older enabled settings without a mode as all-series labels', () => {
        expect(effectiveDataLabelMode(formatting(true))).toBe('all');
        expect(effectiveDataLabelMode(formatting(false))).toBe('off');
    });

    it('renders both import and export dataset labels in all mode', () => {
        expect(shouldRenderDataLabel('all', 0)).toBe(true);
        expect(shouldRenderDataLabel('all', 1)).toBe(true);
        expect(shouldRenderDataLabel('primary', 1)).toBe(false);
        expect(shouldRenderDataLabel('off', 0)).toBe(false);
    });
});
