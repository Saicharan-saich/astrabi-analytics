import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config';

/**
 * Visual preview — captures design-review screenshots of key screens with a
 * seeded, fully local dashboard (no backend, no AI calls). Run with:
 *   npx playwright test -c playwright.visual.config.ts
 * Screenshots are written to visual-preview/ (gitignored).
 */
export default defineConfig({
    ...baseConfig,
    testDir: './e2e-visual',
    fullyParallel: false,
    workers: 1,
    timeout: 120_000,
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
});
