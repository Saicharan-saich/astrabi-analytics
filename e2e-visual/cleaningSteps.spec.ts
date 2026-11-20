import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import { boot, OUT, shoot } from './boot';

/**
 * Your steps: clean by hand with recorded steps, apply them to the whole file,
 * save them in the client's setup, and see them run on next month's file.
 */
async function go(page: Page, name: string) {
    let nav = page.getByRole('button', { name, exact: true }).first();
    if (!(await nav.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'Open navigation', exact: true }).click().catch(() => {});
        nav = page.getByRole('button', { name, exact: true }).first();
    }
    await nav.click();
}

function ordersCsv(month: number): Buffer {
    const lines = ['Order ID,Order Date,Region,Customer,Revenue,Cost'];
    const regions = ['North', 'South', 'N. West', 'NW', 'East'];
    for (let i = 0; i < 50; i++) {
        const customer = i % 10 === 3 ? 'TEST ORDER' : ['Acme Ltd', 'Beta Stores', 'Gamma Co'][i % 3];
        lines.push([`M${month}-${1000 + i}`, `2026-${String(month).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
            regions[i % 5], customer, String(100 + ((i * 7 + month) % 11) * 10), String(40 + (i % 6) * 5)].join(','));
    }
    return Buffer.from(lines.join('\n'));
}

async function upload(page: Page, name: string, csv: Buffer) {
    await go(page, 'Data Source');
    await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').first().setInputFiles({ name, mimeType: 'text/csv', buffer: csv });
    const ready = page.getByRole('dialog', { name: /ready for analysis/ });
    await ready.waitFor({ timeout: 90000 });
    return ready;
}

async function openSteps(page: Page) {
    await go(page, 'Dataset Workspace');
    await page.locator('[role="tablist"]:visible [role="tab"]').filter({ hasText: /^Cleaning$/ }).first().click();
    await page.getByRole('button', { name: 'Your steps', exact: true }).click();
    await page.locator('.qi-steps').first().waitFor({ timeout: 15000 });
}

async function addStep(page: Page, kind: string) {
    const add = page.getByRole('button', { name: /Add the first step|Add a step/ }).first();
    await add.click();
    await page.locator('.qi-steps-palette').getByRole('button', { name: new RegExp(kind) }).click();
    await page.locator('.qi-steps-form').waitFor();
}

// On a failure, keep a picture of where it stopped.
test.afterEach(async ({ page }, info) => {
    if (info.status !== info.expectedStatus) await page.screenshot({ path: path.join(OUT, `zz-failed-steps-${info.title.includes('dark') ? 'dark' : 'light'}.png`), fullPage: true }).catch(() => {});
});

for (const theme of ['light', 'dark'] as const) {
    test(`your steps: clean by hand, apply, save, replay on the next file (${theme})`, async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page, theme, 'DASHBOARD');
        await page.route('**/api/llm/chat', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}', headers: { 'Access-Control-Allow-Origin': '*' } }));

        const ready = await upload(page, 'acme_orders_jan.csv', ordersCsv(1));
        await ready.getByRole('button', { name: 'Close' }).click();
        await openSteps(page);
        await expect(page.locator('.qi-steps-empty')).toContainText('No steps yet');
        await shoot(page, `90-steps-empty-${theme}`);

        // 1. Remove the client's test orders.
        await addStep(page, 'Keep or remove rows');
        await shoot(page, `91-steps-new-${theme}`);
        const form = page.locator('.qi-steps-form');
        await form.getByLabel('Where').selectOption('customer');
        await form.getByLabel('Condition').selectOption('contains');
        await form.getByLabel('Value').fill('test');
        await form.getByLabel('Why is this step needed?').fill("The client's QA team places test orders");
        await expect(form.locator('.qi-steps-effect')).toContainText('5 rows removed');
        await page.screenshot({ path: path.join(OUT, `92-steps-form-${theme}.png`) });
        await form.getByRole('button', { name: 'Add step' }).click();

        // 2. One spelling for North West.
        await addStep(page, 'Group values');
        await form.getByLabel('Column').selectOption('region');
        await form.getByRole('button', { name: /^N\. West/ }).click();
        // The automatic cleaning already wrote 'NW' out as 'Northwest'.
        await form.getByRole('button', { name: /^Northwest/ }).click();
        await form.getByLabel('Count them as').fill('North West');
        await expect(form.locator('.qi-steps-effect')).toContainText('cells grouped');
        await form.getByRole('button', { name: 'Add step' }).click();

        // 3. A profit column.
        await addStep(page, 'Calculate a column');
        await form.getByLabel('Take').selectOption('revenue');
        await form.getByLabel('Then').selectOption('-');
        await form.getByLabel('Another column').selectOption('cost');
        await form.getByLabel('Name of the new column').fill('Profit');
        await form.getByRole('button', { name: 'Add step' }).click();

        const list = page.locator('.qi-steps-list');
        await expect(list).toContainText("Remove rows where 'customer' contains 'test'");
        await expect(list).toContainText("Why: The client's QA team places test orders");
        await expect(list).toContainText("In 'region', count 'N. West', 'Northwest' as 'North West'");
        await expect(list).toContainText("New column 'Profit' = 'revenue' − 'cost'");
        await expect(page.locator('.qi-steps-preview')).toContainText('45 rows');
        await expect(page.locator('.qi-steps-grid th').filter({ hasText: 'profit' })).toHaveCount(1);
        await shoot(page, `93-steps-list-${theme}`);

        // Apply to the whole file; the checklist explains the steps with their reasons.
        await page.getByRole('button', { name: 'Apply to the whole file' }).click();
        await expect(page.getByText('Not applied yet')).toHaveCount(0, { timeout: 30000 });
        await page.getByRole('button', { name: 'Checklist', exact: true }).click();
        const checklist = page.locator('.qi-chk').first();
        await expect(checklist).toContainText("Remove rows where 'customer' contains 'test' (your step)");
        await checklist.getByRole('button', { name: /Remove rows where 'customer' contains 'test'/ }).click();
        await expect(checklist).toContainText("The client's QA team places test orders");
        await shoot(page, `94-steps-in-checklist-${theme}`);

        // Save the setup; February's file gets the same steps on upload.
        await page.getByLabel('Name it for the client and the file').fill('Acme · monthly orders');
        await page.getByRole('button', { name: 'Save as a setup' }).click();
        await expect(page.locator('.qi-setup').first()).toContainText('3 steps');
        const feb = await upload(page, 'acme_orders_feb.csv', ordersCsv(2));
        await expect(feb).toContainText('Cleaned with your saved setup');
        await feb.getByRole('button', { name: 'Close' }).click();
        await openSteps(page);
        await expect(page.locator('.qi-steps-list')).toContainText("New column 'Profit'");
        await expect(page.locator('.qi-steps-list .qi-steps-result').first()).toContainText('5 rows removed');
        await expect(page.locator('.qi-steps-grid th').filter({ hasText: 'profit' })).toHaveCount(1);
        await shoot(page, `95-steps-replayed-${theme}`);
    });
}
