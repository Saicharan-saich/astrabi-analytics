import { test, type Page } from '@playwright/test';
import path from 'path';

import { boot, shoot, OUT } from './boot';

for (const theme of ['light', 'dark'] as const) {
    test(`dashboard ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1700 });
        await boot(page, theme, 'DASHBOARD');
        await shoot(page, `10-dashboard-${theme}`);
        const cards = page.locator('.react-grid-item');
        const count = await cards.count();
        for (let i = 0; i < count; i++) {
            await cards.nth(i).screenshot({ path: path.join(OUT, `11-card-${i + 1}-${theme}.png`) }).catch(() => {});
        }
    });

    test(`chart gallery ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 3000 });
        await boot(page, theme, 'DASHBOARD');
        const tab = page.getByRole('button', { name: /^Chart gallery/ }).first();
        if (await tab.isVisible().catch(() => false)) await tab.click();
        await page.waitForTimeout(3500); // cards re-run and the map loads its shapes
        await shoot(page, `12-gallery-${theme}`);
        const cards = page.locator('.react-grid-item');
        const count = await cards.count();
        for (let i = 0; i < count; i++) {
            await cards.nth(i).screenshot({ path: path.join(OUT, `13-gallery-card-${String(i + 1).padStart(2, '0')}-${theme}.png`) }).catch(() => {});
        }
    });

    test(`workspaces ${theme}`, async ({ page }) => {
        await boot(page, theme, 'DASHBOARD');
        const openNav = async (label: string) => {
            let nav = page.getByRole('button', { name: label, exact: true }).first();
            if (!(await nav.isVisible().catch(() => false))) {
                const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
                if (await toggle.isVisible().catch(() => false)) await toggle.click();
                nav = page.getByRole('button', { name: label, exact: true }).first();
            }
            if (!(await nav.isVisible().catch(() => false))) return false;
            await nav.click();
            return true;
        };

        if (await openNav('Question Builder')) {
            await shoot(page, `20-question-builder-${theme}`);
            const dimension = page.locator('.qi-builder-dimension button[aria-haspopup="listbox"]').first();
            if (await dimension.isVisible().catch(() => false)) {
                await dimension.click();
                await shoot(page, `21-builder-dropdown-${theme}`);
                await page.getByRole('option', { name: 'category', exact: true }).click().catch(() => {});
                await page.waitForTimeout(2500);
                await shoot(page, `22-builder-result-${theme}`);
                // Every "Views" chip, so each suggested chart is checked.
                const chips = page.locator('.qi-chart-suggestion');
                const chipCount = await chips.count();
                for (let i = 0; i < chipCount; i++) {
                    await chips.nth(i).click().catch(() => {});
                    await shoot(page, `23-builder-view-${i + 1}-${theme}`);
                }
                for (const field of ['country', 'funnel_stage']) {
                    await dimension.click().catch(() => {});
                    await page.getByRole('option', { name: new RegExp(`^${field.replace('_', '[_ ]')}$`, 'i') }).first().click().catch(() => {});
                    await page.waitForTimeout(2500);
                    await shoot(page, `24-builder-${field}-${theme}`);
                }
            }
        }
        for (const [label, file] of [
            ['AI SQL', '30-ai-sql'],
            ['Discover', '40-discover'],
            ['Dataset Workspace', '50-dataset-workspace'],
            ['Data Source', '60-data-source'],
        ] as const) {
            if (await openNav(label)) await shoot(page, `${file}-${theme}`);
        }
    });
}
