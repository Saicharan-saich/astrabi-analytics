import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Resolve the pre-installed Chromium (browsers are provisioned under
// PLAYWRIGHT_BROWSERS_PATH; we do not download at install time). Falls back to
// Playwright's own resolution if the glob finds nothing.
function resolveChromium(): string | undefined {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    try {
        const dir = fs.readdirSync(base).find(d => d.startsWith('chromium-'));
        if (dir) {
            const exe = path.join(base, dir, 'chrome-linux', 'chrome');
            if (fs.existsSync(exe)) return exe;
        }
    } catch { /* fall through */ }
    return undefined;
}

const PORT = 4173;

export default defineConfig({
    testDir: './e2e',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: 'retain-on-failure',
        launchOptions: { executablePath: resolveChromium() },
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    // Build then serve the production bundle — the smoke net runs against the
    // real shipped artifact, not the dev server.
    webServer: {
        command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
    },
});
