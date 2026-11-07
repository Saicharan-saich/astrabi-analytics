import { test, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { boot, OUT } from './boot';

/**
 * Phone sweep: every screen at iPhone size. For each, a full-page screenshot
 * and a list of elements that stick out past the right edge (the cause of
 * sideways scrolling), ignoring content inside its own scrolling box such as
 * a wide table.
 */
const PHONE = { width: 390, height: 844 };
const SCREENS: [string, string][] = [
    ['DASHBOARD', 'dashboard'], ['UPLOAD', 'data-source'], ['DATASET_SUMMARY', 'dataset-workspace'], ['ETL', 'cleaning'],
    ['DATA', 'data'], ['DERIVED_COLUMNS', 'derived-columns'], ['BUILDER', 'question-builder'], ['AI_SQL', 'ai-sql'],
    ['CUSTOM_QUESTIONS', 'custom-questions'], ['QUICK_INSIGHTS', 'discover'], ['SMART_QUESTIONS', 'smart-questions'],
    ['USER_INSIGHTS', 'smart-insights'], ['GAME', 'challenge'], ['ALERTS', 'alerts'], ['SCHEMA', 'schema'], ['DATA_STUDIO', 'data-studio'],
];

async function overflowReport(page: Page) {
    return page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const scrollsSideways = (el: Element | null): boolean => {
            for (let node = el?.parentElement; node && node !== document.body; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && node.getBoundingClientRect().right <= vw + 1) return true;
            }
            return false;
        };
        const describe = (el: Element) => {
            const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.trim().split(/\s+/).slice(0, 4).join('.') : '';
            return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}`;
        };
        const offenders: { el: string; right: number; width: number; text: string; parent: string }[] = [];
        for (const el of Array.from(document.body.querySelectorAll('*'))) {
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4 || r.right <= vw + 2) continue;
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none' || style.position === 'fixed') continue;
            if (scrollsSideways(el)) continue;
            // Report the outermost element only.
            const parent = el.parentElement;
            if (parent && parent.getBoundingClientRect().right > vw + 2 && !scrollsSideways(parent) && parent !== document.body) continue;
            offenders.push({ el: describe(el), right: Math.round(r.right), width: Math.round(r.width), text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50), parent: parent ? describe(parent) : '' });
        }
        // Where the left margin of the page title comes from.
        const title = Array.from(document.querySelectorAll('.qi-main-frame h1, .qi-main-frame h2')).find(el => (el as HTMLElement).offsetParent !== null);
        const gutter: string[] = [];
        for (let node = title as HTMLElement | null; node && node !== document.body; node = node.parentElement) {
            const st = getComputedStyle(node);
            const bits = [['pl', st.paddingLeft], ['ml', st.marginLeft], ['bl', st.borderLeftWidth]].filter(([, v]) => parseFloat(v) > 0).map(([k, v]) => `${k}${v}`);
            if (bits.length) gutter.push(`${describe(node)} ${bits.join(' ')} @${Math.round(node.getBoundingClientRect().left)}`);
        }
        return { pageWidth: document.documentElement.scrollWidth, viewport: vw, titleLeft: title ? Math.round(title.getBoundingClientRect().left) : null, gutter, offenders: offenders.slice(0, 25) };
    });
}

for (const theme of ['light', 'dark'] as const) {
    test(`mobile sweep ${theme}`, async ({ browser }) => {
        test.setTimeout(900_000);
        const report: Record<string, unknown> = {};
        const open = async (tab: string) => {
            const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
            const page = await context.newPage();
            await boot(page, theme, tab);
            await page.waitForTimeout(1800);
            return { context, page };
        };
        const screens = theme === 'light' ? SCREENS : SCREENS.filter(([tab]) => ['DASHBOARD', 'AI_SQL', 'DATASET_SUMMARY', 'BUILDER'].includes(tab));
        for (const [tab, name] of screens) {
            const { context, page } = await open(tab).catch(() => ({ context: null, page: null } as any));
            if (!page) { report[name] = { error: 'did not open' }; continue; }
            await page.screenshot({ path: path.join(OUT, `m-${name}-${theme}.png`), fullPage: true }).catch(() => {});
            // The screen's own scroll area, scrolled to the end: is everything reachable?
            if (theme === 'light') {
                await page.evaluate(() => {
                    const visible = Array.from(document.querySelectorAll('.qi-main-frame *')).filter(el => {
                        const node = el as HTMLElement; const st = getComputedStyle(node);
                        return node.offsetParent !== null && /(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 40;
                    }) as HTMLElement[];
                    visible.sort((a, b) => b.scrollHeight - a.scrollHeight);
                    if (visible[0]) visible[0].scrollTop = visible[0].scrollHeight;
                    window.scrollTo(0, document.body.scrollHeight);
                });
                await page.waitForTimeout(700);
                await page.screenshot({ path: path.join(OUT, `m-${name}-end-${theme}.png`) }).catch(() => {});
            }
            report[name] = await overflowReport(page).catch(error => ({ error: String(error) }));
            await context.close();
        }
        // The navigation drawer.
        const { context, page } = await open('DASHBOARD');
        await page.getByRole('button', { name: 'Open navigation', exact: true }).click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(OUT, `m-navigation-${theme}.png`) });
        report.navigation = await overflowReport(page);
        await context.close();
        fs.writeFileSync(path.join(OUT, `mobile-report-${theme}.json`), JSON.stringify(report, null, 2));
    });
}

test('mobile sign in', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.addInitScript(() => localStorage.setItem('QuickInsight-onboarding-complete', 'true'));
    await page.goto('/');
    await page.getByRole('button', { name: /skip tour/i }).click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, 'm-sign-in.png'), fullPage: true });
    fs.writeFileSync(path.join(OUT, 'mobile-report-sign-in.json'), JSON.stringify(await overflowReport(page), null, 2));
});

test('mobile ai sql flow', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await boot(page, 'light', 'DASHBOARD');
    // Open the menu and tap AI SQL once: it must open straight away.
    await page.getByRole('button', { name: 'Open navigation', exact: true }).tap({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, 'm-flow-1-menu.png') });
    await page.getByRole('button', { name: 'AI SQL', exact: true }).last().tap({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, 'm-flow-2-ai-sql.png') });
    const menuVisible = await page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible().catch(() => false);
    const dialogOpen = await page.getByRole('dialog').count();
    // Data Source → Connect: the button and the form that opens must fit.
    await page.getByRole('button', { name: 'Open navigation', exact: true }).tap({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Data Source', exact: true }).last().tap({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const connect = page.getByRole('button', { name: 'Connect', exact: true }).first();
    await connect.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'm-flow-3-connect.png') });
    const box = await connect.boundingBox().catch(() => null);
    const select = page.locator('select').filter({ hasText: 'Shopify' }).first();
    await select.selectOption('mssql').catch(() => {});
    await connect.tap({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, 'm-flow-4-connect-form.png') });
    fs.writeFileSync(path.join(OUT, 'mobile-flow-connect.json'), JSON.stringify({ connectButton: box, viewport: PHONE }, null, 2));
    fs.writeFileSync(path.join(OUT, 'mobile-flow.json'), JSON.stringify({ menuVisibleInAiSql: menuVisible, dialogsOpen: dialogOpen }, null, 2));
    await context.close();
});
