import { expect, test, type Page } from '@playwright/test';

import { boot, shoot } from './boot';

/**
 * A support file keeps "SLA Met" as Yes/No text and dates as text. The AI
 * writes COUNT_IF("sla_met") and DATE_TRUNC on the text date, which DuckDB
 * refuses as written; the app fits the query to the stored types before it
 * runs, so the answer appears with no second (repair) AI call.
 */
async function go(page: Page, name: string) {
    let nav = page.getByRole('button', { name, exact: true }).first();
    if (!(await nav.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'Open navigation', exact: true }).click().catch(() => {});
        nav = page.getByRole('button', { name, exact: true }).first();
    }
    await nav.click();
}

function supportCsv(): Buffer {
    const lines = ['Ticket ID,Opened Date,Channel,First Response Minutes,SLA Met,Reopened'];
    for (let i = 0; i < 240; i++) {
        const month = String((i % 12) + 1).padStart(2, '0');
        lines.push(`T${1000 + i},2025-${month}-${String((i % 27) + 1).padStart(2, '0')},${['Email', 'Phone', 'Chat'][i % 3]},${(i * 7) % 180},${i % 4 === 0 ? 'No' : 'Yes'},${i % 5 === 0 ? 'Yes' : 'No'}`);
    }
    return Buffer.from(lines.join('\n'));
}

test('ai sql query fitted to yes/no text and text dates', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page, 'light', 'DASHBOARD');
    const asked: string[] = [];
    await page.route('**/api/llm/chat', async route => {
        const body = route.request().postDataJSON() || {};
        const text = (body.messages || []).map((m: any) => String(m.content)).join('\n');
        if (!/QUESTION\n|NEW MESSAGE\n/.test(text) || !/You are QuickInsight's data analyst/.test(text)) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: '{}', headers: { 'Access-Control-Allow-Origin': '*' } });
        }
        asked.push(text);
        return route.fulfill({
            status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ usage: { total_tokens: 900 }, choices: [{ message: { content: JSON.stringify({
                action: 'answer', title: 'SLA met rate by month', question: 'What share of tickets met the SLA each month?',
                sql: `SELECT DATE_TRUNC('month', "opened_date") AS month, ROUND(100.0 * COUNT_IF("sla_met") / COUNT(*), 1) AS sla_met_rate_pct, COUNT_IF("reopened") AS reopened_tickets FROM "data" GROUP BY 1 ORDER BY 1`,
                dimensions: ['month'], measures: ['sla_met_rate_pct', 'reopened_tickets'], answer: 'sla_met_rate_pct',
                explanation: 'Share of tickets that met the SLA, by the month they were opened.',
            }) } }] }),
        });
    });
    await go(page, 'Data Source');
    await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').first().setInputFiles({ name: 'support_tickets.csv', mimeType: 'text/csv', buffer: supportCsv() });
    const ready = page.getByRole('dialog', { name: /ready for analysis/ });
    await ready.waitFor({ timeout: 90000 });
    await ready.getByRole('button', { name: 'Close' }).click();
    await go(page, 'AI SQL');
    const box = page.getByLabel('Ask a question about your data');
    await box.fill('What is the SLA met rate by month?');
    await page.waitForTimeout(300);
    await box.press('Enter');
    await page.locator('.qi-chat-thinking').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
    const thread = page.locator('.qi-chat-thread, .qi-chat').first();
    await expect(thread).toContainText('SLA met rate by month', { timeout: 30000 });
    await expect(thread).not.toContainText('could not run on your data');
    // One AI call: the query was fitted locally, not sent back for repair.
    expect(asked.length).toBe(1);
    await shoot(page, '79-ai-sql-yes-no-text-light');
});
