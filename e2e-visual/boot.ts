import type { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { dashboardFixture, salesRows, secondDashboardFixture } from './fixtures';

export const OUT = path.resolve('visual-preview');
fs.mkdirSync(OUT, { recursive: true });

const user = { id: 'visual-user', email: 'visual@example.com', name: 'Alex Morgan', role: 'admin' };
const token = 'header.' + Buffer.from(JSON.stringify({ userId: user.id })).toString('base64url') + '.signature';

export async function boot(page: Page, theme: 'light' | 'dark', activeTab: string) {
    const dashboard = dashboardFixture();
    const second = secondDashboardFixture();
    await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        const body = pathname.endsWith('/auth/login') ? { success: true, token, user }
            : pathname.endsWith('/auth/verify') ? { success: true, valid: true, user }
            : pathname.endsWith('/dashboards') ? (route.request().method() === 'GET' ? { dashboards: [] } : { success: true })
            : {};
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.addInitScript(({ dashboard, second, userId, theme, activeTab }) => {
        localStorage.setItem('QuickInsight-onboarding-complete', 'true');
        localStorage.setItem(`QuickInsight-storage-v4-${userId}`, JSON.stringify({
            version: 5, state: { activeTab, dashboards: [dashboard, second], activeDashboardId: dashboard.id, resetLegacyDashboards: false, deletedDashboardIds: [], theme },
        }));
    }, { dashboard, second, userId: user.id, theme, activeTab });
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
                id: 'visual-sales', name: 'Sales.csv', ownerId: userId, rows, totalRows: rows.length, etlLogs: [],
                columns: [
                    { name: 'order_id', type: 'ID', originalType: 'string' },
                    { name: 'order_date', type: 'DATE', originalType: 'string' },
                    { name: 'category', type: 'DIMENSION', originalType: 'string' },
                    { name: 'vendor', type: 'DIMENSION', originalType: 'string' },
                    { name: 'city', type: 'DIMENSION', originalType: 'string' },
                    { name: 'quantity', type: 'METRIC', originalType: 'number' },
                    { name: 'revenue', type: 'METRIC', originalType: 'number' },
                    { name: 'profit', type: 'METRIC', originalType: 'number' },
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

