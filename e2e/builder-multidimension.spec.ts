import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';

test('adding a third grouping dimension automatically shows facet panels', async ({ page }) => {
    const user = { id: 'multidimension-test-user', email: 'multidimension@example.com', name: 'Multidimension Test', role: 'contributor' };
    const token = 'header.' + Buffer.from(JSON.stringify({ userId: user.id })).toString('base64url') + '.signature';
    await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        const body = pathname.endsWith('/auth/login') ? { success: true, token, user }
            : pathname.endsWith('/auth/verify') ? { success: true, valid: true, user }
            : pathname.endsWith('/dashboards') ? { dashboards: [] } : {};
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.addInitScript(() => localStorage.setItem('QuickInsight-onboarding-complete', 'true'));
    await page.addInitScript(() => {
        const original = CanvasRenderingContext2D.prototype.fillText;
        (window as any).__qiValueLabelInks = [];
        CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, ...args: Parameters<typeof original>) {
            if (String(args[0]) === '100' || String(args[0]) === '50') {
                (window as any).__qiValueLabelInks.push(String(this.fillStyle));
            }
            return original.apply(this, args);
        };
    });
    await page.goto('/');
    await page.getByRole('button', { name: /skip tour/i }).click();
    await page.getByLabel('Email Address').fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill('LocalFixtureOnly123');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByRole('button', { name: 'Data Source', exact: true }).click();

    const workbook = XLSX.utils.book_new();
    const rows = ['FY2022-23', 'FY2023-24'].flatMap(period_label =>
        ['Goods', 'Services'].flatMap(trade_scope =>
            ['Import', 'Export'].map(flow_direction => ({
                period_label, trade_scope, flow_direction, value_usd_bn: trade_scope === 'Goods' ? 100 : 50,
            }))));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Fact_Trade_Summary');
    await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').setInputFiles({
        name: 'trade-multidimension-fixture.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    });
    await expect(page.getByRole('heading', { name: 'Dataset Workspace' })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Question Builder', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Watch how Question Builder works' })).toBeVisible();
    await page.getByRole('button', { name: 'Watch how Question Builder works' }).click();
    const guide = page.getByRole('dialog', { name: 'Build a useful visual in under a minute' });
    await expect(guide).toBeVisible();
    await expect(guide.locator('video')).toHaveAttribute('poster', '/tutorials/question-builder-guide-poster.svg');
    await expect(guide.locator('video source')).toHaveAttribute('src', '/tutorials/question-builder-guide.webm');
    await expect(guide.locator('video track[kind="captions"]')).toHaveAttribute('src', '/tutorials/question-builder-guide.vtt');
    await expect.poll(
        () => guide.locator('video').evaluate(video => Number.isFinite((video as HTMLVideoElement).duration) ? Math.round((video as HTMLVideoElement).duration) : 0),
        { timeout: 15000 },
    ).toBeGreaterThanOrEqual(23);
    await page.getByRole('button', { name: 'Close Question Builder video' }).click();
    await expect(guide).toBeHidden();

    await page.locator('.qi-builder-dimension button[aria-haspopup="listbox"]').first().click();
    await page.getByRole('option', { name: 'trade scope', exact: true }).click();
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await page.getByRole('button', { name: /Add Dimension/i }).click();
    await page.getByRole('option', { name: 'flow direction', exact: true }).click();
    await page.getByRole('button', { name: /Add Dimension/i }).click();
    await page.getByRole('option', { name: 'period label', exact: true }).click();

    await expect(page.getByText('Small Multiples', { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.qi-visual-stage span[title="FY2022-23"]')).toBeVisible();
    await expect(page.locator('.qi-visual-stage span[title="FY2023-24"]')).toBeVisible();
    await expect(page.getByText('2 panels', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Labels All', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Labels All', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Labels Off', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Labels Off', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Labels All', exact: true })).toBeVisible();

    // Combined creates four color series. Value labels for the third and
    // fourth series must remain black, not inherit pink/orange bar colors.
    await page.getByRole('button', { name: 'Combined', exact: true }).click();
    await page.locator('.qi-visual-stage button[title="Hide labels"]').click();
    await page.evaluate(() => { (window as any).__qiValueLabelInks = []; });
    await page.locator('.qi-visual-stage button[title="Show labels for all series"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).__qiValueLabelInks.length)).toBeGreaterThanOrEqual(8);
    const inks = await page.evaluate(() => (window as any).__qiValueLabelInks as string[]);
    expect(inks.every(color => color === '#000000' || color === 'rgb(0, 0, 0)')).toBe(true);
});
