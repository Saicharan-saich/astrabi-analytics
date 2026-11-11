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

        // ── what each column means: editable, used for every question ──
        await page.getByRole('tab', { name: 'Columns', exact: true }).click();
        await page.getByLabel('Role of revenue', { exact: true }).waitFor({ timeout: 15000 });
        await page.locator('p', { hasText: /^revenue$/ }).first().click();
        const higher = page.getByLabel('Is a higher revenue better or worse', { exact: true });
        await expect(higher).toBeVisible();
        await expect(higher).toHaveValue('higher');
        await higher.scrollIntoViewIfNeeded();
        await shoot(page, `65-column-meaning-${theme}`);

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

/** A ward's file with an abbreviation (LOS) and an internal code (Bucket): those two ask, the rest are trusted. */
function wardCsv(): Buffer {
    const lines = ['Admitted,Ward,LOS,Bucket,Readmissions'];
    for (let i = 0; i < 90; i++) lines.push(`2026-0${1 + (i % 6)}-${String(1 + (i % 27)).padStart(2, '0')},${['Oak', 'Elm', 'Ash'][i % 3]},${1 + (i % 9)},${['A', 'B', 'C'][i % 3]},${i % 2}`);
    return Buffer.from(lines.join('\n'));
}

for (const theme of ['light', 'dark'] as const) {
    test(`unclear columns ask the user ${theme}`, async ({ page }) => {
        test.setTimeout(150_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page, theme, 'DASHBOARD');
        await go(page, 'Data Source');
        await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').first().setInputFiles({ name: 'ward_stays.csv', mimeType: 'text/csv', buffer: wardCsv() });
        const ready = page.getByRole('dialog', { name: /ready for analysis/ });
        await ready.waitFor({ timeout: 90000 });
        await ready.getByRole('button', { name: 'Close' }).click();
        await page.getByRole('tab', { name: 'Overview', exact: true }).click().catch(() => {});

        const card = page.locator('.qi-colq');
        await expect(card).toBeVisible({ timeout: 20000 });
        await expect(card).toContainText('2 columns need your word');
        await expect(card).toContainText(/\blos\b/i);
        await expect(card).toContainText(/bucket/i);
        await expect(card).not.toContainText(/readmissions/i);
        await card.scrollIntoViewIfNeeded();
        await shoot(page, `66-columns-need-word-${theme}`);

        await card.getByLabel(/^What los means$/i).fill('Length of stay in days');
        await card.getByRole('button', { name: 'Save', exact: true }).first().click();
        await expect(card).toContainText('One column needs your word');
        await expect(card.locator('code')).not.toContainText(/^los$/i);

        // The answer shows as the user's own in the column settings.
        await page.getByRole('tab', { name: 'Columns', exact: true }).click();
        await expect(page.locator('.qi-needs-word').first()).toBeVisible({ timeout: 15000 });
        await shoot(page, `67-needs-word-badge-${theme}`);
    });
}

for (const theme of ['light', 'dark'] as const) {
    test(`column meanings checked online ${theme}`, async ({ page }) => {
        test.setTimeout(150_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page, theme, 'DASHBOARD');
        // A stand-in for the AI's web-checked reply: the abbreviation is settled
        // by the kind of file; the internal code is not.
        const webChecks: any[] = [];
        await page.route('**/api/llm/chat', async route => {
            const body = route.request().postDataJSON() || {};
            if (!body.web_search) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}', headers: { 'Access-Control-Allow-Origin': '*' } });
            webChecks.push(body);
            const content = JSON.stringify({
                about: 'A hospital ward stays record: one row per patient stay',
                columns: {
                    admitted: { meaning: 'The date the patient was admitted to the ward.', good: 'neutral', sure: true, checked: true, source: 'https://www.datadictionary.nhs.uk/admission-date' },
                    ward: { meaning: 'The ward the patient stayed on.', good: 'neutral', words: ['ward'], sure: true, checked: true, source: 'https://www.datadictionary.nhs.uk/ward' },
                    los: { meaning: 'Length of stay: the number of days the patient spent in hospital.', good: 'lower', words: ['length of stay', 'days in hospital'], sure: true, checked: true, source: 'https://www.datadictionary.nhs.uk/length-of-stay' },
                    bucket: { meaning: 'A grouping letter used inside this organisation.', good: 'neutral', sure: false, question: 'What do the bucket letters A, B and C stand for in your ward?', checked: false },
                    readmissions: { meaning: 'Whether the patient was admitted again after going home.', good: 'lower', words: ['readmitted', 'came back'], sure: true, checked: true, source: 'https://www.datadictionary.nhs.uk/readmission' },
                },
            });
            await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ choices: [{ message: { content, annotations: [
                { type: 'url_citation', url_citation: { url: 'https://www.datadictionary.nhs.uk/length-of-stay', title: 'Length of stay - NHS Data Dictionary' } },
            ] } }], usage: { total_tokens: 900 } }) });
        });
        await go(page, 'Data Source');
        await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').first().setInputFiles({ name: 'ward_stays.csv', mimeType: 'text/csv', buffer: wardCsv() });
        const ready = page.getByRole('dialog', { name: /ready for analysis/ });
        await ready.waitFor({ timeout: 90000 });
        await ready.getByRole('button', { name: 'Close' }).click();
        await page.getByRole('tab', { name: 'Overview', exact: true }).click().catch(() => {});

        // Only the internal code still asks; the abbreviation was settled online.
        const card = page.locator('.qi-colq');
        await expect(card).toContainText('One column needs your word', { timeout: 30000 });
        await expect(card).toContainText('We checked every column name online');
        await expect(card.locator('code')).toHaveText(/^bucket$/i);
        await expect(card).toContainText('What do the bucket letters A, B and C stand for in your ward?');
        await card.scrollIntoViewIfNeeded();
        await shoot(page, `68-checked-online-card-${theme}`);

        // What went to the web check: names and how columns are worked out, never a value.
        expect(webChecks.length).toBe(1);
        const sent = webChecks[0].messages.map((m: any) => String(m.content)).join('\n');
        expect(sent).toContain('CHECK THIS ONLINE');
        expect(sent).toMatch(/"los"/i);
        expect(sent).not.toMatch(/\bOak\b|\bElm\b|\bAsh\b/);

        await page.getByRole('tab', { name: 'Columns', exact: true }).click();
        await expect(page.locator('.qi-meanings-about')).toContainText('Column meanings checked online');
        await page.locator('.qi-ws-row', { hasText: /^los/i }).first().click();
        await expect(page.locator('.qi-checked-online').first()).toBeVisible({ timeout: 15000 });
        await expect(page.getByRole('link', { name: 'Length of stay - NHS Data Dictionary' })).toBeVisible();
        await page.locator('.qi-checked-online').first().scrollIntoViewIfNeeded();
        await shoot(page, `69-checked-online-columns-${theme}`);
    });
}
