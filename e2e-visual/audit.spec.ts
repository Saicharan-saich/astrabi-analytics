import { test, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { auditLightMode } from './audit';
import { boot, OUT } from './boot';

/** Walk screens and pop-ups in light mode; record dark leftovers and invisible text. */
test('light mode audit', async ({ page }) => {
    test.setTimeout(240_000);
    const report: any[] = [];
    const capture = async (state: string) => {
        await page.waitForTimeout(900);
        await page.screenshot({ path: path.join(OUT, `audit-${state}.png`) });
        report.push(await auditLightMode(page, state));
    };
    const click = async (locator: ReturnType<Page['locator']>) => {
        if (await locator.first().isVisible().catch(() => false)) { await locator.first().click().catch(() => {}); return true; }
        return false;
    };
    const nav = async (label: string) => {
        let button = page.getByRole('button', { name: label, exact: true });
        if (!(await button.first().isVisible().catch(() => false))) {
            await click(page.getByRole('button', { name: 'Open navigation', exact: true }));
            button = page.getByRole('button', { name: label, exact: true });
        }
        return click(button);
    };

    await boot(page, 'light', 'DASHBOARD');
    await capture('dashboard');
    if (await click(page.getByRole('button', { name: /Global Filters/ }))) await capture('dashboard-filters');
    await page.keyboard.press('Escape');
    if (await click(page.getByRole('button', { name: 'Present', exact: true }))) {
        await capture('present');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
    }

    if (await nav('Question Builder')) {
        await capture('builder');
        if (await click(page.locator('.qi-builder-dimension button[aria-haspopup="listbox"]'))) {
            await click(page.getByRole('option', { name: 'category', exact: true }));
            await page.waitForTimeout(2000);
        }
        await capture('builder-result');
        if (await click(page.getByRole('button', { name: 'Options', exact: true }))) await capture('builder-options');
        await click(page.getByRole('button', { name: 'Options', exact: true }));
        if (await click(page.getByRole('button', { name: /Add Filter|Filters \(/ }))) await capture('builder-add-filter');
        await page.keyboard.press('Escape');
        await page.mouse.click(900, 900);
        for (const [name, state] of [['Time', 'builder-time'], ['Compare', 'builder-compare'], ['Calculations', 'builder-calculations'], ['Build', '']] as const) {
            if (await click(page.getByRole('button', { name, exact: true })) && state) await capture(state);
        }
        if (await click(page.getByRole('button', { name: 'Style', exact: true }))) await capture('builder-style');
        await click(page.getByRole('button', { name: 'Close chart appearance', exact: true }));
        if (await click(page.getByRole('button', { name: 'Analytics', exact: true }))) await capture('builder-analytics');
        await page.keyboard.press('Escape');
        if (await click(page.getByRole('button', { name: 'SQL', exact: true }))) await capture('builder-sql');
        if (await click(page.getByRole('button', { name: 'Data', exact: true }))) await capture('builder-data');
    }

    for (const [label, state] of [
        ['AI SQL', 'ai-sql'],
        ['Discover', 'discover'],
        ['Smart Insights', 'smart-insights'],
        ['Derived Columns', 'derived-columns'],
        ['Custom Questions', 'custom-questions'],
        ['Monitoring', 'monitoring'],
        ['User Insights', 'user-insights'],
        ['Benchmark Lab', 'benchmark-lab'],
        ['AI SQL Engines', 'ai-sql-engines'],
        ['Data Source', 'data-source'],
        ['Dataset Workspace', 'dataset-workspace'],
    ] as const) {
        if (await nav(label)) await capture(state);
    }
    for (const [tab, state] of [['Explore Data', 'ws-explore'], ['Cleaned Data', 'ws-cleaned'], ['Data Studio', 'ws-studio'], ['Column Mapping', 'ws-mapping'], ['Schema', 'ws-schema']] as const) {
        if (await click(page.getByRole('button', { name: tab, exact: true }))) await capture(state);
    }
    if (await nav('Manage Users')) { await capture('manage-users'); await page.keyboard.press('Escape'); }

    fs.writeFileSync(path.join(OUT, 'audit-light.json'), JSON.stringify(report, null, 1));
});
