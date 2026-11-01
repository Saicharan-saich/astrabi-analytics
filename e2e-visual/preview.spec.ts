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

    test(`auto analysis ${theme}`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width: 1440, height: 3400 });
        await boot(page, theme, 'DASHBOARD');
        const nav = async (label: string) => {
            let button = page.getByRole('button', { name: label, exact: true }).first();
            if (!(await button.isVisible().catch(() => false))) {
                const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
                if (await toggle.isVisible().catch(() => false)) await toggle.click();
                button = page.getByRole('button', { name: label, exact: true }).first();
            }
            if (await button.isVisible().catch(() => false)) { await button.click(); return true; }
            return false;
        };
        if (await nav('Discover')) {
            await page.getByText('What the data says').first().waitFor({ timeout: 20_000 }).catch(() => {});
            await shoot(page, `14-discover-report-${theme}`);
            const build = page.getByRole('button', { name: /Build dashboard from this/ }).first();
            if (await build.isVisible().catch(() => false)) {
                await build.click();
                await page.waitForTimeout(3500);
                await shoot(page, `15-auto-dashboard-${theme}`);
            }
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
            if (!(await openNav(label))) continue;
            await shoot(page, `${file}-${theme}`);
            if (file !== '50-dataset-workspace') continue;
            // What we changed: expand a removed-rows item, then reverse a step.
            const panel = page.locator('.qi-clean-panel:visible').first();
            if (await panel.isVisible().catch(() => false)) {
                await panel.getByRole('button', { name: 'Removed 3 duplicate rows' }).click().catch(() => {});
                await panel.screenshot({ path: path.join(OUT, `51-what-we-changed-${theme}.png`) });
                await panel.getByRole('button', { name: 'Keep the copies' }).click().catch(() => {});
                await page.waitForTimeout(4000);
                await shoot(page, `52-after-undo-${theme}`);
            }
            // Every workspace section, full page, for layout review.
            const sections: [string, string][] = [['Overview', 'overview'], ['Data', 'data'], ['Columns', 'columns'], ['Cleaning', 'cleaning']];
            for (const [tab, slug] of sections) {
                const button = page.locator('[role="tablist"]:visible [role="tab"]').filter({ hasText: new RegExp(`^${tab}$`) }).first();
                if (!(await button.isVisible().catch(() => false))) continue;
                await button.click().catch(() => {});
                await page.waitForTimeout(1500);
                await page.screenshot({ path: path.join(OUT, `53-ws-${slug}-${theme}.png`) });
                if (slug === 'overview') {
                    await page.locator('.qi-ws-row:visible').filter({ hasText: 'revenue' }).first().click().catch(() => {});
                    await page.locator('.qi-ws-row:visible').filter({ hasText: 'category' }).first().click().catch(() => {});
                    await page.locator('.qi-ws-card:visible').filter({ hasText: 'What\'s in it' }).first().screenshot({ path: path.join(OUT, `54-ws-columns-open-${theme}.png`) }).catch(() => {});
                }
                if (slug === 'cleaning') {
                    await page.locator('.qi-step:visible button[aria-expanded]').first().click().catch(() => {});
                    await page.waitForTimeout(500);
                    await page.screenshot({ path: path.join(OUT, `55-ws-cleaning-step-${theme}.png`) });
                    await page.getByRole('button', { name: 'Fix by hand' }).click().catch(() => {});
                    await page.waitForTimeout(1200);
                    await page.screenshot({ path: path.join(OUT, `56-ws-fix-by-hand-${theme}.png`) });
                }
            }
        }
    });
}
