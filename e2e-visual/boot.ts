import type { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { dashboardFixture, galleryDashboardFixture, salesRows, secondDashboardFixture } from './fixtures';

export const OUT = path.resolve('visual-preview');
fs.mkdirSync(OUT, { recursive: true });

const user = { id: 'visual-user', email: 'visual@example.com', name: 'Alex Morgan', role: 'admin' };
const token = 'header.' + Buffer.from(JSON.stringify({ userId: user.id })).toString('base64url') + '.signature';

export async function boot(page: Page, theme: 'light' | 'dark', activeTab: string) {
    const dashboard = dashboardFixture();
    const second = secondDashboardFixture();
    const gallery = galleryDashboardFixture();
    await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        const body = pathname.endsWith('/auth/login') ? { success: true, token, user }
            : pathname.endsWith('/auth/verify') ? { success: true, valid: true, user }
            : pathname.endsWith('/dashboards') ? (route.request().method() === 'GET' ? { dashboards: [] } : { success: true })
            : {};
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.addInitScript(({ dashboard, second, gallery, userId, theme, activeTab }) => {
        localStorage.setItem('QuickInsight-onboarding-complete', 'true');
        localStorage.setItem(`QuickInsight-storage-v4-${userId}`, JSON.stringify({
            version: 5, state: { activeTab, dashboards: [dashboard, second, gallery], activeDashboardId: dashboard.id, resetLegacyDashboards: false, deletedDashboardIds: [], theme },
        }));
    }, { dashboard, second, gallery, userId: user.id, theme, activeTab });
    await page.goto('/');
    await page.evaluate(async ({ userId, rows }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('QuickInsight-datasets', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('datasets', { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('datasets', 'readwrite');
            tx.objectStore('datasets').put({
                id: 'visual-sales', name: 'Sales.csv', ownerId: userId, rows, rawRows: rows, timeContext: { minDate: '2024-01-01', maxDate: '2024-12-31', defaultAnchorDate: '2024-12-31', anchorDateColumn: 'order_date', dateColumnMaxDates: { order_date: '2024-12-31' } }, domainProfile: { domain: 'Sales', summary: 'Orders by product, vendor and city.', confidence: 0.86, grain: 'Order', grainConfidence: 0.9, grainSource: 'unique_identifier', columnSemantics: {}, detectedAt: 1 }, totalRows: rows.length, etlLogs: [
                    { step: 'Null Token Standardization', stepNumber: 2, status: 'applied', timestamp: 1, details: 'Converted 14 null token(s) (N/A, null, -, etc.) to NULL in 2 column(s).', affectedColumns: ['vendor', 'city'], affectedRows: 14 },
                    { step: 'Duplicate Row Removal', stepNumber: 1, status: 'applied', timestamp: 1, details: "Removed 3 exact duplicate row(s). 'order_id' is unique once copies are removed, so the repeats were re-exported copies.", rowsBefore: rows.length + 5, rowsAfter: rows.length + 2, removedRowSamples: rows.slice(0, 3), affectedColumns: ['order_id'], revert: { option: 'keepDuplicateRows', value: true, label: 'Keep the copies' } },
                    { step: 'Total Row Removal', stepNumber: 1, status: 'applied', timestamp: 1, details: 'Removed 2 total/subtotal row(s) — their figures equal the rows they total, so keeping them would double-count.', rowsBefore: rows.length + 2, rowsAfter: rows.length, revert: { option: 'keepTotalRows', value: true, label: 'Keep these rows' } },
                    { step: 'Units Removed', stepNumber: 5, status: 'applied', timestamp: 1, details: "Column 'quantity': read numbers written with text (units seen: units (6)).", affectedColumns: ['quantity'] },
                    { step: 'Category Canonicalization', stepNumber: 5, status: 'applied', timestamp: 1, details: `Column 'city': merged 2 spelling variant(s) into canonical forms (9 cell(s)). "new york" → "New York"`, affectedColumns: ['city'], affectedRows: 9, revert: { option: 'keepCategorySpellings', value: true, label: 'Keep original spellings' } },
                    { step: 'Coercion Loss Flag', stepNumber: 6, status: 'info', timestamp: 1, details: `Column 'revenue': 2 non-empty value(s) could not be parsed as numbers and were dropped (e.g. "TBC", "see note"). These are excluded from sums/averages — review them.`, affectedColumns: ['revenue'], affectedRows: 2 },
                    { step: 'Ambiguous Date Flag', stepNumber: 6, status: 'info', timestamp: 1, details: "Column 'order_date': dates such as 03/04/2025 could be day/month or month/day, and nothing in the file decides it. They were read as day/month (DD/MM).", affectedColumns: ['order_date'], revert: { option: 'dateOrder', value: 'month_first', label: 'Read as month/day' } },
                    { step: 'Final Summary', stepNumber: 7, status: 'applied', timestamp: 1, details: 'done', rowsBefore: rows.length + 5, rowsAfter: rows.length },
                ],
                columns: [
                    { name: 'order_id', type: 'ID', originalType: 'string' },
                    { name: 'order_date', type: 'DATE', originalType: 'string' },
                    { name: 'category', type: 'DIMENSION', originalType: 'string' },
                    { name: 'vendor', type: 'DIMENSION', originalType: 'string' },
                    { name: 'city', type: 'DIMENSION', originalType: 'string' },
                    { name: 'product', type: 'DIMENSION', originalType: 'string' },
                    { name: 'country', type: 'DIMENSION', originalType: 'string' },
                    { name: 'funnel_stage', type: 'DIMENSION', originalType: 'string' },
                    { name: 'quantity', type: 'METRIC', originalType: 'number' },
                    { name: 'revenue', type: 'METRIC', originalType: 'number', currency: 'GBP' },
                    { name: 'profit', type: 'METRIC', originalType: 'number', currency: 'GBP' },
                ],
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    }, { userId: user.id, rows: salesRows() });
    if (theme === 'light') {
        await page.getByRole('button', { name: /skip tour/i }).waitFor();
        await page.screenshot({ path: path.join(OUT, `01-tour-${theme}.png`) });
    }
    await page.getByRole('button', { name: /skip tour/i }).click();
    if (theme === 'light') await page.screenshot({ path: path.join(OUT, `00-login-${theme}.png`) });
    await page.getByLabel('Email Address').fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill('LocalFixtureOnly123');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.waitForTimeout(2500);
    // Dismiss any first-run dialogs that would cover the screen.
    for (const name of [/skip/i, /got it/i, /close/i, /not now/i, /dismiss/i]) {
        const button = page.getByRole('button', { name }).first();
        if (await button.isVisible().catch(() => false)) await button.click().catch(() => {});
    }
}

export async function shoot(page: Page, name: string) {
    await page.waitForTimeout(1800); // let chart entrance animations finish
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

