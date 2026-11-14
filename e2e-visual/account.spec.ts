import { expect, test } from '@playwright/test';

import { boot, shoot, watchSecurityPolicy } from './boot';

/**
 * Accounts a paying customer can look after alone: forgotten password,
 * choosing a new one from the emailed link, and "Your account" (password,
 * download my data, delete my account).
 */
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });

test('forgotten password and reset link', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await watchSecurityPolicy(page);
    const sent: string[] = [];
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url()).pathname;
        if (url.endsWith('/auth/forgot-password')) { sent.push(route.request().postDataJSON()?.email); return route.fulfill(json({ success: true, message: 'If that email has an account, a reset link is on its way.' })); }
        return route.fulfill(json({}));
    });
    await page.goto('/');
    await page.getByRole('button', { name: /skip tour/i }).click();
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    await page.getByLabel('Email Address').fill('owner@shop.co.uk');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('a reset link is on its way');
    expect(sent).toEqual(['owner@shop.co.uk']);
    await shoot(page, '73-forgot-password-light');

    // The emailed link opens straight on "choose a new password", without the tour.
    await page.goto('/?reset=abcdefghijklmnopqrstuvwxyz0123456789');
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await page.getByLabel('New password').fill('a brand new password');
    await page.getByLabel('Type it again').fill('a different one');
    await page.getByRole('button', { name: 'Save and sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('do not match');
    await shoot(page, '74-reset-password-light');
});

test('the site sends its security headers', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response!.headers();
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
});

for (const theme of ['light', 'dark'] as const) {
    test(`your account dialog ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page, theme, 'DASHBOARD');
        await page.getByRole('button', { name: 'Your account' }).first().click();
        const dialog = page.getByRole('dialog', { name: 'Your account' });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('Download my data');
        // Plan, trial and payment (Stripe) sit in the same place.
        await expect(dialog.getByRole('heading', { name: 'Solo plan' })).toBeVisible();
        await expect(dialog).toContainText('Free trial: 10 days left.');
        await expect(dialog).toContainText('AI questions today: 3 of 50.');
        await expect(dialog.getByRole('button', { name: /Choose Solo/ })).toBeVisible();
        await expect(dialog.getByRole('button', { name: /Choose Team/ })).toHaveCount(0); // coming soon
        await shoot(page, `76-your-plan-${theme}`);
        await dialog.getByRole('button', { name: /Delete my account/ }).first().click();
        await expect(dialog).toContainText("It can't be undone");
        await expect(dialog.getByRole('button', { name: 'Delete my account' }).last()).toBeDisabled();
        await shoot(page, `75-your-account-${theme}`);
    });
}

for (const theme of ['light', 'dark'] as const) {
    test(`plans and prices before signing in ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await watchSecurityPolicy(page);
        await page.route('**/api/**', route => route.fulfill(json({})));
        await page.goto('/');
        await page.getByRole('button', { name: /skip tour/i }).click();
        if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'));
        await page.getByRole('button', { name: 'Plans & prices' }).click();
        const dialog = page.getByRole('dialog', { name: 'Plans and prices' });
        await expect(dialog).toContainText('14-day free trial of Solo');
        await expect(dialog.getByRole('heading', { name: 'Free' })).toBeVisible();
        await expect(dialog).toContainText('Price coming soon');
        await expect(dialog).toContainText('Coming soon');
        // No accuracy figure is claimed anywhere on the page.
        await expect(dialog).not.toContainText('%');
        await shoot(page, `77-plans-and-prices-${theme}`);
        await dialog.getByRole('button', { name: 'Start free' }).click();
        await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    });
}
