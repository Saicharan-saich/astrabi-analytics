import { expect, test, type Page } from '@playwright/test';
import { boot, shoot } from './boot';

/**
 * Azure data pipeline: the engineer connects a client's Azure storage once and
 * shares it; the client's uploads then go through their Data Factory pipeline
 * (straight between the browser and Azure) before QuickInsight cleans them.
 */
async function go(page: Page, name: string) {
    let nav = page.getByRole('button', { name, exact: true }).first();
    if (!(await nav.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'Open navigation', exact: true }).click().catch(() => {});
        nav = page.getByRole('button', { name, exact: true }).first();
    }
    await nav.click();
}

const PIPE = { id: 'pl_acme12345', name: 'Acme Ltd', account: 'acmedata', container: 'sales', incoming: 'incoming/', cleaned: 'cleaned/', routeUploads: true };
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*' };

for (const theme of ['light', 'dark'] as const) {
    test(`azure pipeline: the engineer connects and shares a client's storage (${theme})`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width: 1440, height: 1100 });
        let added: any = null; let shared: any = null;
        await boot(page, theme, 'DASHBOARD', {
            api: (pathname, method, body) => {
                if (pathname.endsWith('/azure-pipelines') && method === 'GET') return { pipelines: added ? [{ ...PIPE, ...added, mine: true, userIds: shared || [] }] : [] };
                if (pathname.endsWith('/azure-pipelines') && method === 'POST') { added = JSON.parse(body || '{}'); return { success: true, pipeline: { ...PIPE, mine: true, userIds: [] } }; }
                if (pathname.endsWith('/test')) return { ok: true, message: 'Connected. 2 files in incoming/, 1 cleaned file ready to open in cleaned/.' };
                if (pathname.endsWith('/users') && method === 'PUT') { shared = JSON.parse(body || '{}').userIds; return { success: true, userIds: shared }; }
                if (pathname.endsWith('/admin/users')) return { success: true, users: [{ id: 'acme-1', name: 'Acme Ltd', email: 'finance@acme.example', role: 'contributor' }] };
                if (pathname.endsWith('/files')) return { files: [{ path: 'cleaned/orders_oct.csv', name: 'orders_oct.csv', size: 4200, modified: Date.UTC(2026, 9, 31, 9) }] };
                return undefined;
            },
        });
        await go(page, 'Data Source');
        const panel = page.getByRole('region', { name: 'Azure data pipeline' });
        await panel.getByRole('button', { name: 'Add a pipeline' }).click();
        const form = panel.getByRole('form', { name: 'Add an Azure data pipeline' });
        await form.getByLabel('Name').fill('Acme Ltd');
        await form.getByLabel('Storage account').fill('acmedata');
        await form.getByLabel('Container').fill('sales');
        await form.getByLabel('Access key', { exact: true }).fill(Buffer.alloc(64, 3).toString('base64'));
        await panel.getByRole('button', { name: 'What to set up in Azure' }).click();
        await shoot(page, `95-azure-add-${theme}`);
        await form.getByRole('button', { name: 'Add pipeline' }).click();
        await expect(panel).toContainText('acmedata/sales');
        expect(added).toMatchObject({ name: 'Acme Ltd', account: 'acmedata', container: 'sales', incoming: 'incoming/', cleaned: 'cleaned/', routeUploads: true });

        await panel.getByRole('button', { name: 'Test' }).click();
        await expect(panel).toContainText('Connected. 2 files in incoming/');
        await panel.getByRole('button', { name: 'Share Acme Ltd with accounts' }).click();
        await panel.getByRole('checkbox').first().check();
        await panel.getByRole('button', { name: 'Share with 1 account' }).click();
        await expect(panel).toContainText('shared with 1 account');
        expect(shared).toEqual(['acme-1']);
        await panel.getByRole('button', { name: 'Cleaned files' }).click();
        await expect(panel).toContainText('orders_oct.csv');
        await shoot(page, `95-azure-shared-${theme}`);
    });

    test(`azure pipeline: the client's upload goes through their pipeline first (${theme})`, async ({ page }) => {
        test.setTimeout(180_000);
        await page.setViewportSize({ width: 1440, height: 1000 });
        const uploadedAt = Date.now();
        let sentToAzure = '';
        let polls = 0;
        await boot(page, theme, 'DASHBOARD', {
            role: 'contributor',
            api: (pathname, method) => {
                if (pathname.endsWith('/azure-pipelines') && method === 'GET') return { pipelines: [PIPE] };
                if (pathname.endsWith('/upload-link')) return { url: 'https://acmedata.blob.core.windows.net/sales/incoming/20261122-131501-orders_nov.csv?sv=x&sig=w', path: 'incoming/20261122-131501-orders_nov.csv', startedAt: uploadedAt };
                if (pathname.endsWith('/files')) return { files: ++polls < 2 ? [] : [{ path: 'cleaned/orders_nov.csv', name: 'orders_nov.csv', size: 300, modified: uploadedAt + 30_000 }] };
                if (pathname.endsWith('/download-link')) return { url: 'https://acmedata.blob.core.windows.net/sales/cleaned/orders_nov.csv?sv=x&sig=r' };
                if (pathname.endsWith('/llm/chat')) return {};
                return undefined;
            },
        });
        await page.route('https://acmedata.blob.core.windows.net/**', async route => {
            const req = route.request();
            if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors, body: '' });
            if (req.method() === 'PUT') { sentToAzure = req.postDataBuffer()?.toString('utf8') || ''; return route.fulfill({ status: 201, headers: cors, body: '' }); }
            // What the client's pipeline wrote: tidy names, no test orders.
            const lines = ['order_id,order_date,region,revenue'];
            for (let i = 0; i < 40; i++) lines.push(`N${100 + i},2026-11-${String((i % 27) + 1).padStart(2, '0')},${['North', 'South'][i % 2]},${120 + i}`);
            return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'text/csv' }, body: lines.join('\n') });
        });
        await go(page, 'Data Source');
        await expect(page.getByRole('region', { name: 'Azure data pipeline' })).toContainText('Your data team’s pipeline');
        const raw = 'Order ID,Order Date,Region,Revenue\nN100,22/11/2026,north ,"£120"\n';
        await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').first().setInputFiles({ name: 'orders_nov.csv', mimeType: 'text/csv', buffer: Buffer.from(raw) });
        const run = page.getByRole('dialog', { name: /in Acme Ltd’s pipeline/ });
        await expect(run).toContainText('Your pipeline cleans it');
        await expect(run).toContainText('never passes through QuickInsight’s server');
        await shoot(page, `95-azure-waiting-${theme}`);
        const ready = page.getByRole('dialog', { name: /ready for analysis/ });
        await ready.waitFor({ timeout: 90000 });
        expect(sentToAzure).toBe(raw);
        await expect(page.getByText('orders_nov.csv').first()).toBeVisible();
        await expect(page.getByText('40 rows').first()).toBeVisible();
    });
}
