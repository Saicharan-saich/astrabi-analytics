import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import { boot, OUT, shoot } from './boot';

/**
 * Saved cleaning setups: clean a client's file once and save the choices; the
 * next month's file (same columns) is cleaned the same way on upload, and a
 * file that has changed shape is reported.
 */
async function go(page: Page, name: string) {
    let nav = page.getByRole('button', { name, exact: true }).first();
    if (!(await nav.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'Open navigation', exact: true }).click().catch(() => {});
        nav = page.getByRole('button', { name, exact: true }).first();
    }
    await nav.click();
}

function salesCsv(month: number, changed = false): Buffer {
    // Eight columns; the changed export drops Discount and adds Sales Rep (7 of 9 columns shared).
    const header = `Order ID,Order Date,Region,Product,Channel,Quantity,Revenue,${changed ? 'Sales Rep' : 'Discount'}`;
    const lines = [header];
    for (let i = 0; i < 60; i++) {
        const date = `2026-${String(month).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`;
        const last = changed ? ['Ann', 'Bob', 'Cara'][i % 3] : (i % 5 === 0 ? '' : String(2 + (i % 4)));
        lines.push([
            `M${month}-${1000 + i}`, date, ['North', 'South', 'East'][i % 3], ['Desk', 'Chair', 'Lamp', 'Shelf'][i % 4],
            ['Web', 'Store'][i % 2], String(1 + (i % 4)), String(100 + ((i * 7 + month) % 13) * 10), last,
        ].join(','));
    }
    return Buffer.from(lines.join('\n'));
}

async function upload(page: Page, name: string, csv: Buffer, theme: string, shot?: string) {
    await go(page, 'Data Source');
    await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').first().setInputFiles({ name, mimeType: 'text/csv', buffer: csv });
    const ready = page.getByRole('dialog', { name: /ready for analysis/ });
    await ready.waitFor({ timeout: 90000 });
    if (shot) await ready.screenshot({ path: path.join(OUT, `${shot}-${theme}.png`) }).catch(() => {});
    return ready;
}

async function openCleaning(page: Page) {
    await go(page, 'Dataset Workspace');
    await page.locator('[role="tablist"]:visible [role="tab"]').filter({ hasText: /^Cleaning$/ }).first().click();
    await page.locator('.qi-setup').first().waitFor({ timeout: 15000 });
}

for (const theme of ['light', 'dark'] as const) {
    test(`cleaning setups: save once, next file cleaned the same way (${theme})`, async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page, theme, 'DASHBOARD');
        await page.route('**/api/llm/chat', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}', headers: { 'Access-Control-Allow-Origin': '*' } }));

        // January: decide what a blank discount means, then save the setup.
        let ready = await upload(page, 'acme_sales_jan.csv', salesCsv(1), theme);
        await ready.getByRole('button', { name: 'Close' }).click();
        await openCleaning(page);
        await page.getByRole('radio', { name: /Count a blank as 0/ }).first().check();
        await page.getByRole('button', { name: 'Apply changes' }).first().click();
        await expect(page.locator('.qi-chk').first()).toContainText(/Counted 12 blanks in 'discount' as 0/, { timeout: 30000 });
        await page.getByLabel('Name it for the client and the file').fill('Acme · monthly sales');
        await page.getByRole('button', { name: 'Save as a setup' }).click();
        await expect(page.locator('.qi-setup').first()).toContainText("Saved as the setup 'Acme · monthly sales'");
        await expect(page.locator('.qi-setup').first()).toContainText('1 blank-cell choice');
        await shoot(page, `86-setup-saved-${theme}`);

        // February: same columns, cleaned the same way without asking.
        ready = await upload(page, 'acme_sales_feb.csv', salesCsv(2), theme);
        await expect(ready).toContainText('Cleaned with your saved setup');
        await expect(ready).toContainText('Same columns as before, cleaned the same way.');
        await ready.screenshot({ path: path.join(OUT, `87-setup-applied-dialog-${theme}.png`) }).catch(() => {});
        await ready.getByRole('button', { name: 'Close' }).click();
        await openCleaning(page);
        await expect(page.locator('.qi-setup').first()).toContainText("Cleaned with your saved setup 'Acme · monthly sales'");
        await expect(page.locator('.qi-chk').first()).toContainText(/Counted 12 blanks in 'discount' as 0 \(your choice\)/);
        await shoot(page, `88-setup-applied-${theme}`);

        // March: the client's export changed. The setup still applies, and the differences are reported.
        ready = await upload(page, 'acme_sales_mar.csv', salesCsv(3, true), theme);
        await expect(ready).toContainText(/could change the numbers/);
        await ready.getByRole('button', { name: 'Close' }).click();
        await openCleaning(page);
        const card = page.locator('.qi-setup').first();
        await expect(card).toContainText(/'discount' is missing from this file, so the setup's choices for it were skipped/);
        await expect(card).toContainText(/'sales rep' is new/);
        await shoot(page, `89-setup-changed-file-${theme}`);

        // The saved setups list.
        await card.getByRole('button', { name: /Saved setups \(1\)/ }).click();
        await expect(card).toContainText('used 2 times');
        await card.screenshot({ path: path.join(OUT, `89-setup-list-${theme}.png`) }).catch(() => {});
    });
}
