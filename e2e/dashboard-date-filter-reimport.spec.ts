import { test, expect } from '@playwright/test';
import { sanitizeDashboard } from '../shared/dashboardPrivacy.mjs';

test('a date filter recalculates a pinned KPI after the same workbook was re-imported', async ({ page }) => {
  const user = { id: 'reimport-filter-user', email: 'filter@example.com', name: 'Filter Test', role: 'contributor' };
  const token = 'header.' + Buffer.from(JSON.stringify({ userId: user.id })).toString('base64url') + '.signature';
  const dashboard = {
    id: 'retail-dashboard', name: 'Retail', createdAt: Date.now(),
    items: [{
      id: 'total-sales', title: 'Total Sales', width: 'half', datasetId: 'old-upload', datasetName: 'Retail.csv',
      result: {
        data: [{ dim: '(Total)', metric: 100 }], xKey: 'dim', yKey: 'metric', yLabel: 'Total Sales',
        insight: '', sql: '', vis: 'kpiCard',
        config: { questionId: 'custom_builder', metric: 'sales', dimension: '', aggregation: 'SUM' },
        queryConfig: { questionId: 'custom_builder', metric: 'sales', dimension: '', aggregation: 'SUM' },
      },
    }, {
      id: 'ai-total-sales', title: 'AI Total Sales', width: 'half', datasetId: 'old-upload', datasetName: 'Retail.csv',
      result: {
        data: [{ total_sales: 100 }], xKey: 'total_sales', yKey: 'total_sales', yLabel: 'Total Sales',
        insight: '', sql: 'SELECT SUM(sales) AS total_sales FROM data', vis: 'kpiCard',
        config: { questionId: 'ai_sql_test', metric: 'sales', dimension: '', aggregation: 'SUM' },
        queryConfig: { questionId: 'ai_sql_test', aiSql: 'SELECT SUM(sales) AS total_sales FROM data' },
        aiSqlRefresh: {
          version: 1, source: 'ai-sql', question: 'What are total sales?',
          sql: 'SELECT SUM(sales) AS total_sales FROM data',
          plan: {
            intent: 'single_metric', dimensions: [], metrics: [{ field: 'sales', agg: 'sum' }], filters: [],
            sort: [], limit: null, ambiguous: false, resultGrain: 'one summary row', originalQuestion: 'What are total sales?',
          },
          chart: { chartType: 'kpiCard', xKey: 'total_sales', yKey: 'total_sales', useDualAxis: false, reason: 'One total' },
        },
      },
    }],
    layout: [{ i: 'total-sales', x: 0, y: 0, w: 6, h: 6 }, { i: 'ai-total-sales', x: 6, y: 0, w: 6, h: 6 }],
    filters: [{ column: 'order_date', values: ['2025'], dateMode: 'calendar', dateSelection: { year: '2025', quarter: '3' } }],
  };
  const cloud = sanitizeDashboard(dashboard);
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname.endsWith('/auth/login') ? { success: true, token, user }
      : pathname.endsWith('/auth/verify') ? { success: true, valid: true, user }
      : pathname.endsWith('/dashboards') ? route.request().method() === 'GET' ? { dashboards: [cloud] } : { success: true }
      : {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body),
      headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.addInitScript(({ dashboard, userId }) => {
    localStorage.setItem('QuickInsight-onboarding-complete', 'true');
    localStorage.setItem(`QuickInsight-storage-v4-${userId}`, JSON.stringify({
      version: 5, state: {
        activeTab: 'DASHBOARD', dashboards: [dashboard], activeDashboardId: dashboard.id,
        resetLegacyDashboards: false, deletedDashboardIds: [], theme: 'light',
      },
    }));
  }, { dashboard, userId: user.id });
  await page.goto('/');
  await page.evaluate(async userId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('QuickInsight-datasets', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('datasets', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('datasets', 'readwrite');
      transaction.objectStore('datasets').put({
        id: 'new-upload', name: 'Retail.csv', ownerId: userId,
        rows: [
          { order_date: '2025-06-30', sales: 10 }, { order_date: '2025-07-01', sales: 20 },
          { order_date: '2025-09-30', sales: 30 }, { order_date: '2025-10-01', sales: 40 },
        ],
        totalRows: 4, etlLogs: [],
        columns: [
          { name: 'order_date', type: 'DATE', originalType: 'string' },
          { name: 'sales', type: 'METRIC', originalType: 'number' },
        ],
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, user.id);
  await page.getByRole('button', { name: /skip tour/i }).click();
  await page.getByLabel('Email Address').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('LocalFixtureOnly123');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();

  await expect(page.getByText('order_date', { exact: true }).last()).toBeVisible();
  await expect(page.locator('.qi-kpi-value')).toHaveText(['$50.00', '$50.00'], { timeout: 30_000 });
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(page.locator('.qi-kpi-value')).toHaveText(['$100.00', '$100.00']);
});
