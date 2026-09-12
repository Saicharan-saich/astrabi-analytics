import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';

test('multi-sheet subjects remain selectable across pages and reload', async ({ page }) => {
    // All API traffic is mocked: no real account, credentials or data leave this test.
    const user = { id: 'relational-test-user', email: 'relational@example.com', name: 'Relational Test', role: 'contributor' };
    const token = 'header.' + Buffer.from(JSON.stringify({ userId: user.id })).toString('base64url') + '.signature';
    await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        const body = pathname.endsWith('/auth/login') ? { success: true, token, user }
            : pathname.endsWith('/auth/verify') ? { success: true, valid: true, user }
            : pathname.endsWith('/dashboards') ? { dashboards: [] } : {};
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.addInitScript(() => localStorage.setItem('QuickInsight-onboarding-complete', 'true'));
    await page.goto('/');
    await page.getByRole('button', { name: /skip tour/i }).click();
    await page.getByLabel('Email Address').fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill('LocalFixtureOnly123');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByRole('button', { name: 'Data Source', exact: true }).click();

    const workbook = XLSX.utils.book_new();
    const sources = {
        Dim_Period: [{ period_id: 'P1', period_label: '2025' }],
        Fact_Trade: [{ trade_id: 'T1', period_id: 'P1', value: 10 }, { trade_id: 'T2', period_id: 'P1', value: 20 }],
        Fact_Service: [{ service_id: 'S1', period_id: 'P1', value: 5 }],
    };
    for (const [name, rows] of Object.entries(sources)) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
    await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').setInputFiles({
        name: 'relational-fixture.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    });
    const selector = page.getByLabel('Analysis subject or source table');
    await expect(selector).toBeEnabled({ timeout: 30000 });
    await expect(selector.locator('optgroup[label="All source tables (standalone)"] option')).toHaveCount(3);
    await page.getByRole('button', { name: 'Question Builder', exact: true }).click();
    const service = JSON.stringify({ table: 'Fact_Service', standalone: false });
    await selector.selectOption(service);
    await expect(selector).toHaveValue(service);
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('button', { name: 'AI SQL', exact: true }).click();
    await expect(selector).toHaveValue(service);
    const period = JSON.stringify({ table: 'Dim_Period', standalone: true });
    await selector.selectOption(period);
    await expect(selector).toHaveValue(period);
    await page.reload();
    await expect(selector).toHaveValue(period, { timeout: 30000 });
    await expect(selector.locator('optgroup[label="All source tables (standalone)"] option')).toHaveCount(3);
});
