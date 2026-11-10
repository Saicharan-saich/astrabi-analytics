import { expect, test, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';

import { boot, shoot } from './boot';

/**
 * A first-time owner's path: a store with no direct connection explains how
 * to export the orders; a workbook with one table split across monthly
 * sheets, a summary and notes is read correctly and the pop-up says how; and
 * an empty Question Builder explains itself and offers one-click starts.
 */
function monthlyWorkbook(): Buffer {
    let seed = 5;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const book = XLSX.utils.book_new();
    const month = (m: number, n: number) => [['Date', 'Product', 'Store', 'Qty', 'Revenue'],
        ...Array.from({ length: n }, (_, i) => [new Date(Date.UTC(2026, m, 1 + (i % 27))), ['Flat White', 'Croissant', 'Bacon Roll'][i % 3], i % 2 ? 'Station' : 'High Street', 1 + (i % 3), Math.round(rnd() * 2000) / 100])];
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Store', 'Total Revenue'], ['Station', 1250.4], ['High Street', 990.1], ['Total', 2240.5]]), 'Summary');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(month(7, 120), { cellDates: true }), 'Aug');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(month(8, 130), { cellDates: true }), 'Sep');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(month(9, 140), { cellDates: true }), 'Oct');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['How to use this workbook'], ['Add each day of sales to the sheet for that month.'], ['Revenue includes VAT and is after discounts.']]), 'Notes');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

async function go(page: Page, name: string) {
    let nav = page.getByRole('button', { name, exact: true }).first();
    if (!(await nav.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'Open navigation', exact: true }).click().catch(() => {});
        nav = page.getByRole('button', { name, exact: true }).first();
    }
    await nav.click();
}

for (const theme of ['light', 'dark'] as const) {
    test(`guided first steps ${theme}`, async ({ page }) => {
        test.setTimeout(180_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page, theme, 'DASHBOARD');

        // ── a store with no direct connection: how to bring the orders in ──
        await go(page, 'Data Source');
        await page.locator('select').filter({ hasText: 'Shopify' }).first().selectOption('shopify');
        await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
        const guide = page.getByRole('dialog', { name: 'Bring in your Shopify orders' });
        await expect(guide).toBeVisible();
        await expect(guide).toContainText("A direct Shopify connection isn't available yet");
        await expect(guide).toContainText('open Orders and click Export');
        await shoot(page, `61-shopify-guide-${theme}`);
        await guide.getByRole('button', { name: 'Not now' }).click();
        await expect(guide).toBeHidden();

        // ── a workbook: three monthly sheets, a summary and notes ──
        await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').first().setInputFiles({ name: 'cafe_sales_2026.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: monthlyWorkbook() });
        const ready = page.getByRole('dialog', { name: /ready for analysis/ });
        await ready.waitFor({ timeout: 90000 });
        await expect(ready).toContainText('390 rows');
        await expect(ready).toContainText('Aug, Sep and Oct had the same columns, so they were put back together as one table');
        await expect(ready).toContainText('Kept for reference, not used for answers: Summary (a summary made from the records), Notes (written notes)');
        await shoot(page, `62-workbook-ready-${theme}`);
        await ready.getByRole('button', { name: 'Close' }).click();

        // ── an empty Question Builder explains itself ──
        await go(page, 'Question Builder');
        const start = page.locator('.qi-builder-start:visible');
        await expect(start).toContainText('Build a chart in three clicks');
        await expect(start.getByRole('button', { name: 'Revenue month by month' })).toBeVisible();
        await shoot(page, `63-builder-start-${theme}`);
        await start.getByRole('button', { name: 'Revenue by product' }).click();
        await expect(page.locator('.qi-builder-headline-title:visible')).toBeVisible({ timeout: 20000 });
        await shoot(page, `64-builder-starter-result-${theme}`);
    });
}
