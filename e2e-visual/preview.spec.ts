import { test, type Page } from '@playwright/test';
import path from 'path';

import { boot, shoot, OUT } from './boot';

/** Click across a chart until a mark is hit and the explore menu opens. */
async function openExploreMenu(page: Page, canvas: ReturnType<Page['locator']>) {
    if (!(await canvas.isVisible().catch(() => false))) return false;
    const box = await canvas.boundingBox();
    if (!box) return false;
    const menu = page.locator('.qi-explore-menu');
    for (const fy of [0.75, 0.6, 0.45, 0.85, 0.3]) {
        for (const fx of [0.2, 0.35, 0.5, 0.65, 0.8]) {
            await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
            if (await menu.isVisible().catch(() => false)) return true;
        }
    }
    return false;
}

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
        // Click a bar on a card: cross-filter the whole dashboard.
        for (let i = 0; i < count; i++) {
            if (await openExploreMenu(page, cards.nth(i).locator('canvas').first())) {
                await page.waitForTimeout(300);
                await page.screenshot({ path: path.join(OUT, `16-dashboard-click-menu-${theme}.png`) });
                const filter = page.locator('.qi-explore-menu [role="menuitem"]').filter({ hasText: 'Filter dashboard to' }).first();
                if (await filter.isVisible().catch(() => false)) {
                    await filter.click();
                    await page.waitForTimeout(2500);
                    await shoot(page, `17-dashboard-cross-filtered-${theme}`);
                }
                break;
            }
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

    test(`formatting ${theme}`, async ({ page }) => {
        await boot(page, theme, 'DASHBOARD');
        let nav = page.getByRole('button', { name: 'Question Builder', exact: true }).first();
        if (!(await nav.isVisible().catch(() => false))) {
            await page.getByRole('button', { name: 'Open navigation', exact: true }).click().catch(() => {});
            nav = page.getByRole('button', { name: 'Question Builder', exact: true }).first();
        }
        await nav.click();
        const dimension = page.locator('.qi-builder-dimension button[aria-haspopup="listbox"]').first();
        await dimension.waitFor();
        // Formatting: near-equal bars with value labels, long names, horizontal bars.
        const stage = page.locator('.qi-visual-stage').first();
        const quick = { timeout: 5000 };
        const chooseChart = async (label: string) => {
            await page.locator('.qi-chart-type-trigger').first().click(quick).catch(() => {});
            await page.getByRole('menuitemradio', { name: label, exact: true }).first().click(quick).catch(() => {});
            // Never leave the menu open over the chart.
            if (await page.locator('.qi-chart-menu').isVisible().catch(() => false)) await page.locator('.qi-chart-type-trigger').first().click(quick).catch(() => {});
            await page.waitForTimeout(1500);
        };
        for (const [field, file] of [['city', '28-format-city'], ['product', '29-format-product']] as const) {
            await dimension.click(quick).catch(() => {});
            await page.getByRole('option', { name: field, exact: true }).click(quick).catch(() => {});
            await page.waitForTimeout(2500);
            await chooseChart('Vertical Bar');
            await stage.screenshot({ path: path.join(OUT, `${file}-${theme}.png`), ...quick }).catch(() => {});
        }
        await chooseChart('Horizontal Bar');
        await stage.screenshot({ path: path.join(OUT, `29-format-product-horizontal-${theme}.png`), ...quick }).catch(() => {});
        // The Style panel, then axis titles turned on.
        await chooseChart('Vertical Bar');
        await page.getByRole('button', { name: 'Style', exact: true }).click(quick).catch(() => {});
        await page.waitForTimeout(600);
        await shoot(page, `2A-style-panel-${theme}`);
        const panel = page.locator('.qi-format-panel').first();
        await panel.getByRole('switch', { name: /Axis titles/ }).check({ force: true, ...quick }).catch(() => {});
        await panel.evaluate(element => { element.scrollTop = element.scrollHeight; }).catch(() => {});
        await page.waitForTimeout(800);
        await shoot(page, `2B-style-panel-axes-${theme}`);
        await page.getByRole('button', { name: 'Close chart appearance' }).click(quick).catch(() => {});
        await page.waitForTimeout(800);
        await stage.screenshot({ path: path.join(OUT, `2C-format-axis-titles-${theme}.png`), ...quick }).catch(() => {});
    });

    test(`ai sql answer ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page, theme, 'DASHBOARD');
        // Stand-ins for the two AI calls; everything else runs for real
        // (SQL on the local data, chart choice, insights).
        const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
        await page.route('**/api/ai-sql/resolve-turn', async route => {
            const { currentQuestion } = route.request().postDataJSON();
            await route.fulfill(json({ model: 'stub', usage: { total_tokens: 1 }, resolution: { route: 'analysis', turnType: 'new_question', resolvedQuestion: currentQuestion, confidence: 0.95 } }));
        });
        await page.route('**/api/llm/chat', async route => {
            const asked = JSON.stringify(route.request().postDataJSON()?.messages?.slice(-1));
            const reply = /month/i.test(asked)
                ? { action: 'answer', title: 'Revenue by month', sql: 'SELECT DATE_TRUNC(\'month\', CAST("order_date" AS DATE)) AS month, ROUND(SUM("revenue"), 2) AS total_revenue FROM "data" GROUP BY 1 ORDER BY 1', dimensions: ['month'], measures: ['total_revenue'], explanation: 'Added up revenue for each calendar month.' }
                : { action: 'answer', title: 'Top products by revenue', sql: 'SELECT "product", ROUND(SUM("revenue"), 2) AS total_revenue FROM "data" GROUP BY 1 ORDER BY 2 DESC LIMIT 10', dimensions: ['product'], measures: ['total_revenue'], explanation: 'Added up revenue for each product and kept the top 10.' };
            await route.fulfill(json({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { total_tokens: 100 } }));
        });
        let nav = page.getByRole('button', { name: 'AI SQL', exact: true }).first();
        if (!(await nav.isVisible().catch(() => false))) {
            await page.getByRole('button', { name: 'Open navigation', exact: true }).click().catch(() => {});
            nav = page.getByRole('button', { name: 'AI SQL', exact: true }).first();
        }
        await nav.click();
        const quick = { timeout: 8000 };
        const ask = async (question: string, file: string) => {
            const box = page.getByLabel('Ask a question about your data');
            await box.fill(question, quick).catch(() => {});
            await box.press('Enter', quick).catch(() => {});
            await page.locator('#ai-sql-result-workspace').waitFor(quick).catch(() => {});
            await page.waitForTimeout(2500);
            await shoot(page, `35-ai-sql-answer-${file}-${theme}`);
        };
        await ask('What are my best selling products by revenue?', 'ranking');
        await page.setViewportSize({ width: 900, height: 1100 });
        await page.waitForTimeout(1200);
        await shoot(page, `36-ai-sql-answer-narrow-${theme}`);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.getByRole('button', { name: 'Back', exact: true }).click(quick).catch(() => {});
        await page.waitForTimeout(800);
        await ask('Monthly revenue trend', 'trend');
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
                // Click to explore: menu → break down → trail → rows.
                await dimension.click().catch(() => {});
                await page.getByRole('option', { name: 'category', exact: true }).click().catch(() => {});
                await page.waitForTimeout(2500);
                if (await openExploreMenu(page, page.locator('.qi-visual-stage canvas').first())) {
                    await page.waitForTimeout(300);
                    await page.screenshot({ path: path.join(OUT, `25-builder-click-menu-${theme}.png`) });
                    await page.locator('.qi-explore-menu [role="menuitem"]').filter({ hasText: /^by / }).first().click().catch(() => {});
                    await page.waitForTimeout(2500);
                    await shoot(page, `26-builder-drilled-${theme}`);
                    if (await openExploreMenu(page, page.locator('.qi-visual-stage canvas').first())) {
                        await page.locator('.qi-explore-menu [role="menuitem"]').filter({ hasText: /^See the/ }).first().click().catch(() => {});
                        await page.waitForTimeout(800);
                        await shoot(page, `27-builder-rows-${theme}`);
                        await page.keyboard.press('Escape');
                    }
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
                if (slug === 'columns') {
                    await page.locator('.qi-map:visible .qi-ws-row p').filter({ hasText: /^revenue$/ }).first().click().catch(() => {});
                    await page.waitForTimeout(500);
                    await page.screenshot({ path: path.join(OUT, `57-ws-mapping-row-${theme}.png`) });
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
