import { test, expect, Page } from '@playwright/test';

/**
 * Smoke net — proves the shipped bundle actually boots and renders in a real
 * browser (the class of white-screen / broken-import / bad-chunk regression that
 * unit tests can't catch). Runs against the production build via `vite preview`.
 * No backend required: it uses the built-in "Continue as Guest" path.
 */

// External hosts whose load failures are environmental (blocked in CI/sandbox),
// not app bugs — a failed font/CDN fetch must not fail the smoke net.
const EXTERNAL_NOISE = /cdn\.tailwindcss\.com|fonts\.(googleapis|gstatic)\.com|esm\.sh|cdn\.sheetjs\.com|net::ERR_|Failed to load resource/i;

// Fail a test only on genuine app problems: uncaught JS exceptions and
// console.errors that aren't just blocked external resources.
function trackPageErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', e => { if (!EXTERNAL_NOISE.test(e.message)) errors.push(`pageerror: ${e.message}`); });
    page.on('console', m => { if (m.type() === 'error' && !EXTERNAL_NOISE.test(m.text())) errors.push(`console.error: ${m.text()}`); });
    return errors;
}

test('app boots through the pre-login tour without crashing', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto('/');

    await expect(page).toHaveTitle(/QuickInsight/i);
    await expect(page.getByRole('button', { name: /skip tour/i })).toBeVisible();
    await page.getByRole('button', { name: /skip tour/i }).click();
    await expect(page.getByRole('button', { name: /continue as guest/i })).toBeVisible();

    // The primary authentication controls must remain discoverable to keyboard,
    // screen-reader and browser password-manager users.
    await expect(page.getByLabel('Email Address')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show password' })).toBeVisible();

    // No uncaught/console errors during initial render or tour transition.
    expect(errors, `page errors on boot:\n${errors.join('\n')}`).toEqual([]);
});

test('guest login renders the app shell', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /skip tour/i }).click();
    await page.getByRole('button', { name: /continue as guest/i }).click();

    // Past auth, the login form's guest button should be gone and the app
    // chrome should be mounted. Assert we left the login screen.
    await expect(page.getByRole('button', { name: /continue as guest/i })).toHaveCount(0, { timeout: 15_000 });
    // The app root should still have visible content (not a blank screen).
    await expect(page.locator('body')).not.toBeEmpty();
});
