/**
 * Smart Insight sends a picture of the chart, which shows numbers and labels,
 * so it asks first and does not claim "no data access".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const panel = readFileSync(join(process.cwd(), 'components', 'AIInsightPanel.tsx'), 'utf8');

describe('chart picture consent', () => {
    it('sends nothing until the person agrees, once or always', () => {
        const fetchStart = panel.indexOf('const fetchInsight = async');
        const firstSend = panel.indexOf('captureChartAsImage(', fetchStart);
        const gate = panel.slice(fetchStart, firstSend);
        expect(gate).toMatch(/if \(!agreedNow && !consented && !hasChartPictureConsent\(\)\) return;/);
        expect(panel).toContain('Send a picture of this chart to the AI?');
        expect(panel).toContain("Don't ask again on this device");
    });

    it('says plainly what the picture contains', () => {
        expect(panel).toContain('the picture includes the numbers and labels');
        expect(panel).not.toMatch(/no data access|ZERO access/i);
    });
});
