import { test, expect, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';

/** Click across a chart until a mark is hit and the explore menu opens. */
async function clickAMark(page: Page, canvas = page.locator('.qi-visual-stage canvas').first()) {
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    const menu = page.locator('.qi-explore-menu');
    for (const fy of [0.75, 0.6, 0.45, 0.85, 0.3]) {
        for (const fx of [0.2, 0.35, 0.5, 0.65, 0.8]) {
            await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
            if (await menu.isVisible().catch(() => false)) return menu;
        }
    }
    throw new Error('No chart mark could be clicked');
}

test('clicking a bar filters, breaks down and shows the rows behind it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const user = { id: 'explore-test-user', email: 'explore@example.com', name: 'Explore Test', role: 'contributor' };
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

    const rows = ['North', 'South', 'East'].flatMap((region, r) =>
        ['Contoso', 'Fabrikam', 'Tailspin'].flatMap((vendor, v) =>
            [1, 2, 3].map(m => ({
                order_id: `O-${r}${v}${m}`,
                order_date: `2024-0${m}-1${v}`,
                region, vendor,
                revenue: 100 * (r + 1) + 10 * v + m,
            }))));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Orders');
    await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').setInputFiles({
        name: 'explore-fixture.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    });
    await expect(page.getByRole('heading', { name: 'Dataset Workspace' })).toBeVisible({ timeout: 30000 });
    // The "ready" pop-up opens once cleaning finishes; close it to carry on.
    const ready = page.getByRole('dialog', { name: /ready for analysis/ });
    await ready.waitFor({ timeout: 30000 });
    await page.keyboard.press('Escape');
    await expect(ready).toBeHidden();
    await page.getByRole('button', { name: 'Question Builder', exact: true }).click();
    await page.locator('.qi-builder-dimension button[aria-haspopup="listbox"]').first().click();
    await page.getByRole('option', { name: 'region', exact: true }).click();
    await expect(page.getByText(/to filter it, break it down or see its rows/)).toBeVisible({ timeout: 30000 });

    // Click a bar → menu → break it down by vendor.
    let menu = await clickAMark(page);
    const clicked = (await menu.locator('.qi-explore-title').innerText()).trim();
    expect(['North', 'South', 'East']).toContain(clicked);
    await expect(menu.getByRole('menuitem', { name: `Show only ${clicked}` })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'by vendor' }).click();
    const trail = page.getByRole('navigation', { name: 'How you got here' });
    await expect(trail).toBeVisible({ timeout: 30000 });
    await expect(trail.getByRole('button', { name: 'By region' })).toBeVisible();
    await expect(trail.getByText(`${clicked} · by vendor`)).toBeVisible();

    // The rows behind a bar: three months for one region and vendor.
    menu = await clickAMark(page);
    await expect(menu.getByRole('menuitem', { name: 'See the 3 rows' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'See the 3 rows' }).click();
    const drawer = page.getByRole('dialog', { name: /Rows behind/ });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('tbody tr')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // Back up the trail.
    await trail.getByRole('button', { name: 'By region' }).click();
    await expect(trail).toBeHidden({ timeout: 30000 });
    await expect(page.getByText(/to filter it, break it down or see its rows/)).toBeVisible();
});
