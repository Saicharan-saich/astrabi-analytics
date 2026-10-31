import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config';

// TEMP: run one smoke spec and save its failure details for review.
export default defineConfig({
    ...baseConfig,
    testDir: './e2e',
    testMatch: ['**/dashboard-date-filter-reimport.spec.ts'],
    fullyParallel: false,
    workers: 1,
    timeout: 90_000,
    outputDir: 'visual-preview/results',
    reporter: [['list'], ['json', { outputFile: 'visual-preview/report.json' }]],
    use: { ...(baseConfig as any).use, screenshot: 'on', trace: 'off' },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
