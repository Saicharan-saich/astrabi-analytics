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

function csatCsv(): Buffer {
    const lines = ['Ticket ID,Support Team,CSAT Score'];
    const teams = ['Support Team A', 'Support Team B', 'Support Team C', 'Specialist Team'];
    for (let i = 0; i < 400; i++) {
        // About 1 in 12 tickets has no rating: a blank cell.
        const score = i % 12 === 0 ? '' : String([5, 5, 4, 5, 3, 5, 4, 5][i % 8]);
        lines.push(`T${2000 + i},${teams[i % 4]},${score}`);
    }
    return Buffer.from(lines.join('\n'));
}

test('ai sql average with blank ratings: no nonsense figures, counts are not percentages', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page, 'dark', 'DASHBOARD');
    await page.route('**/api/llm/chat', async route => {
        const body = route.request().postDataJSON() || {};
        const text = (body.messages || []).map((m: any) => String(m.content)).join('\n');
        if (!/QUESTION\n|NEW MESSAGE\n/.test(text) || !/You are QuickInsight's data analyst/.test(text)) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: '{}', headers: { 'Access-Control-Allow-Origin': '*' } });
        }
        return route.fulfill({
            status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ usage: { total_tokens: 900 }, choices: [{ message: { content: JSON.stringify({
                action: 'answer', title: 'Average customer satisfaction by support team',
                question: 'What is the average customer satisfaction score for each support team?',
                sql: `SELECT "support_team", ROUND(AVG("csat_score"), 2) AS average_csat_score, COUNT("csat_score") AS rated_tickets FROM "data" GROUP BY 1 ORDER BY 2 DESC`,
                dimensions: ['support_team'], measures: ['average_csat_score', 'rated_tickets'], answer: 'average_csat_score',
                explanation: 'Average CSAT score per support team, with how many tickets were rated.',
            }) } }] }),
        });
    });
    await go(page, 'Data Source');
    await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').first().setInputFiles({ name: 'support_csat.csv', mimeType: 'text/csv', buffer: csatCsv() });
    const ready = page.getByRole('dialog', { name: /ready for analysis/ });
    await ready.waitFor({ timeout: 90000 });
    await ready.getByRole('button', { name: 'Close' }).click();
    await go(page, 'AI SQL');
    const box = page.getByLabel('Ask a question about your data');
    await box.fill('What is the average customer satisfaction score by support team?');
    await page.waitForTimeout(300);
    await box.press('Enter');
    await page.locator('.qi-chat-thinking').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
    const thread = page.locator('.qi-chat-thread, .qi-chat').first();
    await expect(thread).toContainText('Average customer satisfaction by support team', { timeout: 30000 });
    // The written answer leads with the average, in plain numbers with 2 decimals.
    await expect(thread).toContainText(/\b4\.\d{2}\b/);
    await expect(thread).not.toContainText(/rated tickets, at \d+%/i);
    await expect(thread).not.toContainText(/\d{3},\d{3},\d{3},\d{3}/); // no 1e300-style numbers from blank slots
    await expect(thread).not.toContainText('Careful with the average');
    await shoot(page, '84-ai-sql-csat-blanks-dark');
});
