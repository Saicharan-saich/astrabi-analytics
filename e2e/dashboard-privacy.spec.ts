import { test, expect } from '@playwright/test';
import { sanitizeDashboard } from '../shared/dashboardPrivacy.mjs';
import { dashboardFixture } from '../__tests__/helpers/dashboardFixture';

async function openDashboard(page: any, withLocalResults: boolean) {
    const local = dashboardFixture();
    let cloud = sanitizeDashboard(local);
    const posts: any[] = [];
    const token = 'header.' + Buffer.from(JSON.stringify({ userId: 'privacy-test-user' })).toString('base64url') + '.signature';
    await page.route('**/api/**', async (route: any) => {
        const req = route.request();
        const url = new URL(req.url());
        let body: any = {};
        if (url.pathname.endsWith('/auth/login')) body = {
            success: true, token, user: { id: 'privacy-test-user', email: 'privacy@example.com', name: 'Privacy Test', role: 'contributor' },
        };
        else if (url.pathname.endsWith('/auth/verify')) body = { success: true, valid: true };
        else if (url.pathname.endsWith('/dashboards')) {
            if (req.method() === 'POST') {
                cloud = req.postDataJSON();
                posts.push(cloud);
                body = { success: true, id: cloud.id };
            } else body = { dashboards: [cloud] };
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body),
            headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.addInitScript(({ local, withLocalResults }: any) => {
        localStorage.setItem('QuickInsight-onboarding-complete', 'true');
        localStorage.setItem('QuickInsight-storage-v4-privacy-test-user', JSON.stringify({
            version: 5, state: {
                activeTab: 'DASHBOARD',
                dashboards: [{ ...local, items: withLocalResults ? local.items : [], createdAt: Date.now() }],
                activeDashboardId: local.id, resetLegacyDashboards: false,
                deletedDashboardIds: [], theme: 'light',
            },
        }));
    }, { local, withLocalResults });
    await page.goto('/');
    await page.getByRole('button', { name: /skip tour/i }).click();
    await page.getByLabel('Email Address').fill('privacy@example.com');
    await page.getByLabel('Password', { exact: true }).fill('TestPass123');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Sales overview\b/ })).toBeVisible();
    return posts;
}

test('full local chart survives login, cloud save and page reload without uploading answers', async ({ page }) => {
    const posts = await openDashboard(page, true);
    await expect(page.getByText('175 rows', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Sales overview\b/ }).dblclick();
    const rename = page.locator('.qi-dashboard-tabs input');
    await rename.fill('Private sales dashboard');
    await rename.press('Enter');
    await expect.poll(() => posts.length).toBeGreaterThan(0);
    expect(JSON.stringify(posts)).not.toContain('PRIVATE_');
    expect(posts[posts.length - 1].items[0].result.data).toEqual([]);
    await page.reload();
    await expect(page.getByRole('button', { name: /^Private sales dashboard\b/ })).toBeVisible();
    await expect(page.getByText('175 rows', { exact: true })).toBeVisible();
});

test('a new device restores the layout and explains that source data is needed', async ({ page }) => {
    await openDashboard(page, false);
    await expect(page.getByText('Open the source data to display this visual', { exact: true })).toBeVisible();
    await expect(page.getByText('Data stays local', { exact: true })).toBeVisible();
    await expect(page.getByText('Sales by region', { exact: true }).first()).toBeVisible();
});
