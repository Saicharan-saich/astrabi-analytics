import { describe, expect, it } from 'vitest';
import { extraTooltipMetricKeys, readableChartTextColor } from '../utils/chartPresentation';

describe('chart presentation', () => {
    it('does not repeat a plotted profit measure in the tooltip details', () => {
        const row = { city: 'Leeds', sales_amount: 69189.07, sum_profit: 20262.95, unplotted_metric: 4 };
        const extras = extraTooltipMetricKeys(
            row,
            ['SUM of sales_amount by city', 'Sum Profit'],
            new Set(['city', 'sales_amount']),
        );
        expect(extras).toEqual(['unplotted_metric']);
    });

    it('replaces unreadable saved text defaults while retaining readable custom colors', () => {
        expect(readableChartTextColor('#000000', true, '#ecf4ff')).toBe('#ecf4ff');
        expect(readableChartTextColor('#ffffff', false, '#172a45')).toBe('#172a45');
        expect(readableChartTextColor('#5bd4c2', true, '#ecf4ff')).toBe('#5bd4c2');
    });
});
