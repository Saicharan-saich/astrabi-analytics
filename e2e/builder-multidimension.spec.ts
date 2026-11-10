import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';

test('adding a third grouping dimension automatically shows facet panels', async ({ page }) => {
    // Canvas labels are asserted after rendering; reduced motion removes
    // timing differences between local Chromium and slower CI runners.
    await page.emulateMedia({ reducedMotion: 'reduce' });
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
            // Value labels are bold; axis ticks that also read 50/100 are not.
            // value_usd_bn is in dollars, so labels read $100 / $50.
            if (/^\$?(100|50)$/.test(String(args[0])) && /bold/.test(this.font)) {
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
    if (await page.getByTitle('Switch to light mode').isVisible()) {
        await page.getByTitle('Switch to light mode').click();
    }
    await page.getByRole('button', { name: 'Data Source', exact: true }).click();

    const workbook = XLSX.utils.book_new();
    const rows = ['FY2022-23', 'FY2023-24'].flatMap(period_label =>
        ['Goods', 'Services'].flatMap(trade_scope =>
            ['Import', 'Export'].map(flow_direction => ({
                period_label, trade_scope, flow_direction, value_usd_bn: trade_scope === 'Goods' ? 100 : 50,
                cost_usd_bn: trade_scope === 'Goods' ? 70 : 30,
            }))));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Fact_Trade_Summary');
    await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').setInputFiles({
        name: 'trade-multidimension-fixture.xlsx',
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

    const splitter = page.getByRole('separator', { name: 'Resize Question Builder and visual result' });
    const builderDock = page.locator('#qi-builder-panel');
    await expect(splitter).toBeVisible();
    const originalWidth = (await builderDock.boundingBox())!.width;
    await splitter.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await builderDock.boundingBox())!.width).toBeGreaterThan(originalWidth + 8);
    // The panel animates its width; grab the divider only once it has stopped moving.
    let settledX = -1;
    await expect.poll(async () => {
        const x = (await splitter.boundingBox())!.x;
        const settled = Math.abs(x - settledX) < 0.5;
        settledX = x;
        return settled;
    }, { intervals: [150] }).toBe(true);
    const grip = (await splitter.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 100, grip.y + grip.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await builderDock.boundingBox())!.width).toBeGreaterThan(originalWidth + 50);
    await splitter.dblclick();
    await expect.poll(async () => (await builderDock.boundingBox())!.width).toBeCloseTo(originalWidth, 0);
    await page.getByRole('button', { name: 'Hide Builder', exact: true }).click();
    await expect(splitter).toBeHidden();
    await page.getByRole('button', { name: 'Show Builder', exact: true }).click();
    await expect(splitter).toBeVisible();
    await expect.poll(async () => (await builderDock.boundingBox())!.width).toBeCloseTo(originalWidth, 0);

    await expect(page.getByRole('button', { name: 'Watch how Question Builder works' })).toBeVisible();
    await page.getByRole('button', { name: 'Watch how Question Builder works' }).click();
    const guide = page.getByRole('dialog', { name: /Build a useful visual in under two minutes/i });
    await expect(guide).toBeVisible();
    await expect(guide.locator('video')).toHaveAttribute('poster', '/tutorials/question-builder-guide-poster.png');
    await expect(guide.locator('video source')).toHaveAttribute('src', '/tutorials/question-builder-guide.webm');
    await expect(guide.locator('video track[kind="captions"]')).toHaveAttribute('src', '/tutorials/question-builder-guide.vtt');
    await expect.poll(
        () => guide.locator('video').evaluate(video => Number.isFinite((video as HTMLVideoElement).duration) ? Math.round((video as HTMLVideoElement).duration) : 0),
        { timeout: 15000 },
    ).toBeGreaterThanOrEqual(90);
    await page.getByRole('button', { name: 'Close Question Builder video' }).click();
    await expect(guide).toBeHidden();

    const undo = page.getByRole('button', { name: 'Undo last Question Builder change' });
    await expect(undo).toBeDisabled();

    await page.locator('.qi-builder-dimension button[aria-haspopup="listbox"]').first().click();
    await page.getByRole('option', { name: 'trade scope', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Visual', exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Style', exact: true }).click();
    const appearance = page.locator('.qi-format-panel');
    const colourMeaning = appearance.getByRole('group', { name: 'Colour meaning' });
    await expect(colourMeaning.getByRole('button', { name: 'Auto', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await colourMeaning.getByRole('button', { name: 'Low → high' }).click();
    await expect(colourMeaning.getByRole('button', { name: 'Low → high' })).toHaveAttribute('aria-pressed', 'true');
    await colourMeaning.getByRole('button', { name: 'Categories' }).click();
    await expect(colourMeaning.getByRole('button', { name: 'Categories' })).toHaveAttribute('aria-pressed', 'true');
    await colourMeaning.getByRole('button', { name: 'Auto', exact: true }).click();
    await page.getByRole('button', { name: 'Close chart appearance' }).click();
    const commandbar = page.locator('.qi-builder-commandbar');
    await expect.poll(() => commandbar.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2);
    await splitter.focus();
    await page.keyboard.press('End');
    await expect.poll(() => commandbar.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2);
    await expect(commandbar.getByRole('button', { name: 'Pin', exact: true })).toBeVisible();
    await splitter.dblclick();
    await expect(undo).toBeDisabled();
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    const optionsPanel = page.locator('.qi-builder-options-panel');
    await optionsPanel.getByRole('button', { name: /Add Metric/i }).click();
    await page.getByRole('option', { name: 'cost usd bn', exact: true }).click();
    await optionsPanel.getByRole('button', { name: 'Remove additional metric cost usd bn' }).click();
    await expect(page.getByRole('button', { name: 'Remove additional metric cost usd bn' })).toHaveCount(0);
    await optionsPanel.getByRole('button', { name: /Add Metric/i }).click();
    await expect(page.getByRole('option', { name: 'cost usd bn', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Add Dimension/i }).click();
    await page.getByRole('option', { name: 'flow direction', exact: true }).click();
    await optionsPanel.getByRole('button', { name: 'Remove additional dimension flow direction' }).click();
    await expect(page.getByRole('button', { name: 'Remove additional dimension flow direction' })).toHaveCount(0);
    await optionsPanel.getByRole('button', { name: /Add Dimension/i }).click();
    await page.getByRole('option', { name: 'flow direction', exact: true }).click();
    await expect(undo).toBeEnabled({ timeout: 30000 });
    await page.getByRole('button', { name: /Add Dimension/i }).click();
    await page.getByRole('option', { name: 'period label', exact: true }).click();

    await expect(page.getByText('Small Multiples', { exact: true })).toBeVisible({ timeout: 30000 });
    await undo.click();
    await expect(page.getByText('Small Multiples', { exact: true })).toBeHidden({ timeout: 30000 });
    await page.getByRole('button', { name: 'Options', exact: true }).click();
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
    // Combined opens as stacked bars (totals labelled); the per-series label
    // colours are checked on the grouped view, where every bar has a label.
    await page.locator('.qi-visual-stage button[title^="Grouped bars"]').click();
    await expect(page.locator('.qi-visual-stage button[title^="Grouped bars"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.qi-visual-stage button[title="Hide labels"]').click();
    await page.evaluate(() => { (window as any).__qiValueLabelInks = []; });
    await page.locator('.qi-visual-stage button[title="Show labels for all series"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).__qiValueLabelInks.length)).toBeGreaterThanOrEqual(8);
    const inks = await page.evaluate(() => (window as any).__qiValueLabelInks as string[]);
    expect(inks.every(color => color === '#000000' || color === 'rgb(0, 0, 0)'), `Light label colors: ${inks.join(', ')}`).toBe(true);

    await page.getByTitle('Switch to dark mode').click();
    await expect(page.locator('.qi-visual[data-appearance="dark"]')).toBeVisible();
    await page.locator('.qi-visual-stage button[title="Hide labels"]').click();
    await page.evaluate(() => { (window as any).__qiValueLabelInks = []; });
    await page.locator('.qi-visual-stage button[title="Show labels for all series"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).__qiValueLabelInks.length)).toBeGreaterThanOrEqual(8);
    const darkInks = await page.evaluate(() => (window as any).__qiValueLabelInks as string[]);
    // One shared label colour (never a series colour), light enough to read on the dark stage.
    expect(new Set(darkInks).size, `Dark label colors: ${darkInks.join(', ')}`).toBe(1);
    const luminance = (hex: string) => {
        const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i) || [];
        return m.length ? (0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)) / 255 : 0;
    };
    expect(luminance(darkInks[0]), `Dark label color ${darkInks[0]}`).toBeGreaterThan(0.6);
    const stageBackground = await page.locator('.qi-visual-stage').evaluate(el => getComputedStyle(el).backgroundColor);
    const [r, g, b] = (stageBackground.match(/\d+/g) || ['255', '255', '255']).map(Number);
    expect((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, `Stage background ${stageBackground}`).toBeLessThan(0.2);
});
