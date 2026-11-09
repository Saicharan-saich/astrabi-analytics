import { expect, test, type Page } from '@playwright/test';
import path from 'path';

import { boot, shoot, OUT } from './boot';

/**
 * Records with nothing to add up: a generated appointments file (shaped like
 * the public no-show data, no real patients) is uploaded through the real
 * upload, cleaned in the browser and loaded into DuckDB. The workspace says
 * what kind of data it is, the story counts and compares rates, and a rate
 * query on the yes/no columns runs for real.
 */
const PLACES = ['JARDIM DA PENHA', 'MATA DA PRAIA', 'SANTOS DUMONT', 'ILHA DO PRÍNCIPE', 'CENTRO', 'ITARARÉ', 'JESUS DE NAZARETH', 'MARUÍPE'];

function appointmentsCsv(count = 6000): string {
    let seed = 17;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const lines = ['"PatientId","AppointmentID","Gender","ScheduledDay","AppointmentDay","Age","Neighbourhood","Scholarship","Hipertension","Diabetes","SMS_received","Showed_up","Date.diff"'];
    for (let i = 0; i < count; i++) {
        const wait = i % 3 === 0 ? 0 : Math.floor(rnd() * rnd() * 90);
        const booked = new Date(Date.UTC(2016, 2, 1 + Math.floor(rnd() * 60)));
        const day = new Date(booked.getTime() + wait * 86_400_000);
        const age = Math.floor(rnd() * 90);
        const place = PLACES[Math.floor(rnd() * rnd() * PLACES.length)];
        const missed = rnd() < (wait === 0 ? 0.05 : 0.18 + wait / 250) - age / 1500 + (place === 'SANTOS DUMONT' ? 0.08 : 0);
        const flag = (p: number) => (rnd() < p ? 'TRUE' : 'FALSE');
        lines.push([
            1_000_000 + Math.floor(rnd() * count * 0.6), 5_600_000 + i, `"${rnd() < 0.65 ? 'F' : 'M'}"`,
            booked.toISOString().slice(0, 10), day.toISOString().slice(0, 10), age, `"${place}"`,
            flag(0.1), flag(0.2), flag(0.07), wait > 3 && rnd() < 0.55 ? 'TRUE' : 'FALSE', missed ? 'FALSE' : 'TRUE', wait,
        ].join(','));
    }
    return lines.join('\n');
}

async function go(page: Page, name: string | RegExp) {
    const find = () => page.getByRole('button', typeof name === 'string' ? { name, exact: true } : { name }).first();
    let nav = find();
    if (!(await nav.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'Open navigation', exact: true }).click().catch(() => {});
        nav = find();
    }
    await nav.click();
}

for (const theme of ['light', 'dark'] as const) {
    test(`records data ${theme}`, async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page, theme, 'DASHBOARD');
        const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
        const sent: string[] = [];
        await page.route('**/api/llm/chat', async route => {
            const messages = route.request().postDataJSON()?.messages || [];
            const asked = String(messages.slice(-1)?.[0]?.content || '');
            sent.push(asked);
            if (String(messages[0]?.content || '').includes('assistant in QuickInsight')) {
                await route.fulfill(json({ choices: [{ message: { content: JSON.stringify({ message: 'This file has nothing to add up, so I count appointments and compare the share that did not show up.', suggestions: [], analyze: null }) } }], usage: { total_tokens: 400 } }));
                return;
            }
            // A stand-in for the AI, writing the rate query the prompt teaches.
            const latest = asked.split(/QUESTION|NEW MESSAGE/).pop() || '';
            if (/hypertension/i.test(latest)) {
                await route.fulfill(json({ choices: [{ message: { content: JSON.stringify({ action: 'answer', title: 'Appointments involving each listed condition', question: 'What percentage of appointments involve patients with hypertension, diabetes or a scholarship?', sql: 'SELECT ROUND(100.0 * COUNT_IF("hipertension") / NULLIF(COUNT(*), 0), 1) AS hypertension_rate_pct, ROUND(100.0 * COUNT_IF("diabetes") / NULLIF(COUNT(*), 0), 1) AS diabetes_rate_pct, ROUND(100.0 * COUNT_IF("scholarship") / NULLIF(COUNT(*), 0), 1) AS scholarship_rate_pct, COUNT(*) AS appointment_count FROM "data"', dimensions: [], measures: ['hypertension_rate_pct', 'diabetes_rate_pct', 'scholarship_rate_pct', 'appointment_count'], explanation: 'Worked out the share of appointments with each condition.' }) } }], usage: { total_tokens: 1300 } }));
                return;
            }
            const reply = /sms/i.test(latest)
                ? { action: 'answer', title: "% who didn't show up, with and without an SMS", question: "The % of appointments that didn't show up, with and without an SMS", sql: 'SELECT "sms_received", COUNT(*) AS appointments, ROUND(100.0 * COUNT_IF(NOT "showed_up") / COUNT(*), 1) AS no_show_rate_pct FROM "data" GROUP BY 1 ORDER BY 1', dimensions: ['sms_received'], measures: ['no_show_rate_pct', 'appointments'], explanation: "Counted appointments with and without an SMS and the share of each that didn't show up." }
                : { action: 'answer', title: "% of appointments that didn't show up, by neighbourhood", question: "The % of appointments that didn't show up in each neighbourhood", sql: 'SELECT "neighbourhood", COUNT(*) AS appointments, ROUND(100.0 * COUNT_IF(NOT "showed_up") / COUNT(*), 1) AS no_show_rate_pct FROM "data" GROUP BY 1 HAVING COUNT(*) >= 30 ORDER BY no_show_rate_pct DESC', dimensions: ['neighbourhood'], measures: ['no_show_rate_pct', 'appointments'], explanation: "Counted appointments in each neighbourhood and the share that didn't show up, leaving out neighbourhoods with fewer than 30." };
            await route.fulfill(json({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { total_tokens: 1300 } }));
        });

        // ── upload through the real file input ──
        await go(page, 'Data Source');
        await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').setInputFiles({ name: 'healthcare_noshows.csv', mimeType: 'text/csv', buffer: Buffer.from(appointmentsCsv(), 'utf8') });
        await expect(page.getByRole('heading', { name: 'Dataset Workspace' })).toBeVisible({ timeout: 90000 });
        await page.getByRole('tab', { name: 'Overview', exact: true }).click().catch(() => {});
        const kind = page.locator('.qi-kind:visible').first();
        await kind.waitFor({ timeout: 20000 });
        await expect(kind).toContainText('Records — nothing to add up');
        await expect(kind).toContainText('Dimensional');
        await kind.scrollIntoViewIfNeeded();
        await shoot(page, `80-records-workspace-${theme}`);
        await kind.screenshot({ path: path.join(OUT, `80-records-kind-${theme}.png`) });
        // Two labels (F/M) are a category in words; true/false are yes/no.
        const genderRow = page.locator('tr', { hasText: 'gender' }).first();
        await expect(genderRow).toContainText('Dimension');
        await expect(genderRow).toContainText('Female');
        await expect(page.locator('tr', { hasText: 'showed_up' }).first()).toContainText('Yes/No');
        await page.locator('tr', { hasText: 'neighbourhood' }).first().scrollIntoViewIfNeeded();
        await shoot(page, `80-records-columns-${theme}`);

        // ── the story: counts and rates, no totals ──
        await go(page, /Data Story/);
        await page.locator('.qi-story-slide:visible').first().waitFor({ timeout: 30000 });
        await expect(page.locator('.qi-story-slide').first()).toContainText("didn't show up");
        const slides = await page.locator('.qi-story-dots button').count();
        for (let i = 0; i < slides; i++) {
            await page.waitForTimeout(1000);
            await shoot(page, `81-records-story-${String(i + 1).padStart(2, '0')}-${theme}`);
            await page.keyboard.press('ArrowRight');
        }

        // The story is a full-screen dialog: close it.
        await page.keyboard.press('Escape');
        await page.locator('.qi-story').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

        // ── AI SQL: the kind of data, starter questions, a real rate query ──
        await go(page, 'AI SQL');
        await page.locator('.qi-kind-line:visible').first().waitFor({ timeout: 20000 });
        await shoot(page, `82-records-ai-sql-empty-${theme}`);
        const box = page.getByLabel('Ask a question about your data');
        const ask = async (question: string) => {
            await box.fill(question);
            await box.press('Enter');
            await page.locator('.qi-chat-thinking').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(2500);
        };
        await ask("What % of appointments didn't show up, by neighbourhood?");
        await shoot(page, `83-records-ai-sql-rate-${theme}`);
        await expect(page.locator('.qi-chat-row').last()).toContainText('Santos Dumont');
        await ask('Compare the % that did not show up with and without an SMS');
        await shoot(page, `84-records-ai-sql-sms-${theme}`);
        await expect(page.locator('.qi-chat-row').last()).toContainText('SMS received');
        await expect(page.locator('.qi-chat-row').last()).toContainText('points');

        // Several separate rates: bars with their own values, never a donut of their sum.
        await ask('What percentage of appointments involve patients with hypertension, diabetes or a scholarship?');
        await shoot(page, `85-records-ai-sql-rates-${theme}`);
        const last = page.locator('.qi-chat-row').last();
        await expect(last).toContainText('— out of 6,000 appointments');
        await expect(last).not.toContainText('Total');

        // The answer check: every figure worked out again from the cleaned data.
        const check = last.locator('.qi-check');
        await expect(check).toHaveClass(/is-verified/, { timeout: 15000 });
        await expect(check).toContainText('All 4 figures match a fresh calculation');
        await check.getByRole('button', { name: /How it was checked/ }).click();
        await expect(check).toContainText('Based on all 6,000 appointments');
        await expect(check).toContainText('the share of appointments where hipertension is yes');
        await check.scrollIntoViewIfNeeded();
        await shoot(page, `86-records-answer-check-${theme}`);

        // What the AI was sent: the shape and the storage types, never a value.
        const planner = sent.find(text => text.includes('DATA DESCRIPTION')) || '';
        expect(planner).toContain('DATA SHAPE: records with nothing to add up.');
        expect(planner).toContain('"showed_up": BOOLEAN; yes/no');
        for (const leaked of ['Santos Dumont', 'Jardim', '5600001']) expect(planner).not.toContain(leaked);
    });
}
