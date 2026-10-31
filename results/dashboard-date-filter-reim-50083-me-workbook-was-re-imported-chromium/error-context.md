# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dashboard-date-filter-reimport.spec.ts >> a date filter recalculates a pinned KPI after the same workbook was re-imported
- Location: e2e/dashboard-date-filter-reimport.spec.ts:4:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator: locator('.qi-kpi-value')
Timeout: 30000ms
- Expected  - 0
+ Received  + 2

  Array [
    "$50.00",
    "$50.00",
+   "$0",
+   "0",
  ]

Call log:
  - Expect "toHaveText" with timeout 30000ms
  - waiting for locator('.qi-kpi-value')
    - locator resolved to 0 elements
    - locator resolved to 1 element
    4 × locator resolved to 3 elements
    57 × locator resolved to 4 elements

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e5]:
    - generic [ref=e6]:
      - generic [ref=e7]:
        - img "QuickInsight" [ref=e10]
        - generic [ref=e11]:
          - generic [ref=e12]: QuickInsight
          - text: Analytics Platform
      - button "Toggle Sidebar" [ref=e13] [cursor=pointer]:
        - img [ref=e14]
    - navigation "Main" [ref=e18]:
      - group "Data" [ref=e19]:
        - generic [ref=e20]: Data
        - generic [ref=e21]:
          - button "Data Source" [ref=e23] [cursor=pointer]:
            - img [ref=e25]
            - generic [ref=e28]: Data Source
            - button "Learn about Data Upload" [ref=e30]:
              - img [ref=e31]
          - button "Dataset Workspace" [ref=e34] [cursor=pointer]:
            - img [ref=e36]
            - generic [ref=e38]: Dataset Workspace
            - button "Learn about Dataset Summary" [ref=e40]:
              - img [ref=e41]
          - button "Derived Columns" [ref=e44] [cursor=pointer]:
            - img [ref=e46]
            - generic [ref=e49]: Derived Columns
            - button "Learn about Derived Columns" [ref=e51]:
              - img [ref=e52]
      - group "Ask" [ref=e54]:
        - generic [ref=e55]: Ask
        - generic [ref=e56]:
          - button "Question Builder" [ref=e58] [cursor=pointer]:
            - img [ref=e60]
            - generic [ref=e63]: Question Builder
            - button "Learn about Question Builder" [ref=e65]:
              - img [ref=e66]
          - button "AI SQL" [ref=e69] [cursor=pointer]:
            - img [ref=e71]
            - generic [ref=e73]: AI SQL
            - button "Learn about AI SQL Chat" [ref=e75]:
              - img [ref=e76]
      - group "Insights" [ref=e78]:
        - generic [ref=e79]: Insights
        - generic [ref=e80]:
          - button "Discover" [ref=e82] [cursor=pointer]:
            - img [ref=e84]
            - generic [ref=e87]: Discover
          - button "Smart Insights" [ref=e89] [cursor=pointer]:
            - img [ref=e91]
            - generic [ref=e93]: Smart Insights
            - button "Learn about AI-Generated Smart Questions" [ref=e95]:
              - img [ref=e96]
          - button "GAFS Challenge" [ref=e99] [cursor=pointer]:
            - img [ref=e101]
            - generic [ref=e103]: GAFS Challenge
            - button "Learn about GAFS Challenge" [ref=e105]:
              - img [ref=e106]
      - button "Data Story New" [ref=e109] [cursor=pointer]:
        - img [ref=e111]
        - generic [ref=e113]: Data Story
        - generic [ref=e114]: New
      - group "Share & monitor" [ref=e115]:
        - generic [ref=e116]: Share & monitor
        - generic [ref=e117]:
          - button "Dashboard" [ref=e119] [cursor=pointer]:
            - img [ref=e121]
            - generic [ref=e123]: Dashboard
            - button "Learn about Dashboard" [ref=e125]:
              - img [ref=e126]
          - button "Monitoring" [ref=e129] [cursor=pointer]:
            - img [ref=e131]
            - generic [ref=e134]: Monitoring
            - button "Learn about Alerts" [ref=e136]:
              - img [ref=e137]
    - generic [ref=e139]:
      - generic [ref=e142]:
        - generic [ref=e145]: FT
        - generic [ref=e146]:
          - generic [ref=e147]: Filter Test
          - generic [ref=e149]:
            - img [ref=e150]
            - text: Contributor
        - button "Change Password" [ref=e153] [cursor=pointer]:
          - img [ref=e154]
        - button "Sign Out" [ref=e157] [cursor=pointer]:
          - img [ref=e158]
      - generic [ref=e161]:
        - generic [ref=e162]: v3.0
        - generic [ref=e163]: ·
        - button "Privacy & Terms" [ref=e164] [cursor=pointer]:
          - img [ref=e165]
          - text: Privacy & Terms
  - generic [ref=e167]:
    - banner [ref=e168]:
      - generic [ref=e170]:
        - generic [ref=e172]: Retail.csv
        - generic [ref=e173]: 4 rows
      - generic [ref=e174]:
        - button "Notifications" [ref=e176] [cursor=pointer]:
          - img [ref=e177]
        - button "Switch to dark mode" [ref=e180] [cursor=pointer]:
          - img [ref=e181]
        - button "Settings" [ref=e183] [cursor=pointer]:
          - img [ref=e184]
        - generic [ref=e187]:
          - generic "Filter Test (CONTRIBUTOR)" [ref=e190]: FT
          - button "Sign Out" [ref=e192] [cursor=pointer]:
            - img [ref=e193]
    - main [ref=e196]:
      - generic [ref=e199]:
        - generic [ref=e200]:
          - button "Retail 2 More options for Retail" [ref=e201] [cursor=pointer]:
            - generic [ref=e202]: Retail
            - generic [ref=e203]: "2"
            - button "More options for Retail" [ref=e204]:
              - img [ref=e205]
          - button "New" [ref=e209] [cursor=pointer]:
            - img [ref=e210]
            - text: New
          - button "Auto-build" [ref=e211] [cursor=pointer]:
            - img [ref=e212]
            - text: Auto-build
        - generic [ref=e215]:
          - generic [ref=e217]:
            - heading "Retail" [level=2] [ref=e218]
            - paragraph [ref=e219]: 2 visuals · Drag to rearrange
            - generic [ref=e220]:
              - img [ref=e221]
              - text: Current dataset · 4 rows
          - generic [ref=e225]:
            - button "Present" [ref=e226] [cursor=pointer]:
              - img [ref=e227]
              - text: Present
            - button "Export" [ref=e230] [cursor=pointer]:
              - img [ref=e231]
              - text: Export
            - button "Clear All" [ref=e235] [cursor=pointer]:
              - img [ref=e236]
              - text: Clear All
        - generic [ref=e239]:
          - button "Global Filters 1" [ref=e240] [cursor=pointer]:
            - img [ref=e241]
            - text: Global Filters
            - generic [ref=e242]: "1"
            - img [ref=e243]
          - generic [ref=e245]:
            - generic [ref=e246]:
              - img [ref=e247]
              - generic [ref=e249]: order_date
              - generic [ref=e250]: 2025 Q3
              - button [ref=e251] [cursor=pointer]:
                - img [ref=e252]
            - button "Clear all" [ref=e255] [cursor=pointer]
        - generic [ref=e256]:
          - generic [ref=e257]:
            - generic [ref=e258]:
              - heading "Total Sales" [level=3] [ref=e260]
              - generic [ref=e261]:
                - button "Global filter ON — click to disable" [ref=e262] [cursor=pointer]:
                  - img [ref=e263]
                - 'button "Labels: All — click to turn off" [ref=e265] [cursor=pointer]':
                  - img [ref=e266]
                - button "Edit in Workbench" [ref=e269] [cursor=pointer]:
                  - img [ref=e270]
                - button "Remove from Dashboard" [ref=e273] [cursor=pointer]:
                  - img [ref=e274]
            - generic [ref=e283]:
              - generic [ref=e284]: $50.00
              - generic [ref=e285]: Total Sales
            - generic [ref=e286]:
              - generic [ref=e287]: Total Sales
              - generic [ref=e288]: 1 rows
          - generic [ref=e290]:
            - generic [ref=e291]:
              - heading "AI Total Sales" [level=3] [ref=e293]
              - generic [ref=e294]:
                - button "Global filter ON — click to disable" [ref=e295] [cursor=pointer]:
                  - img [ref=e296]
                - 'button "Labels: All — click to turn off" [ref=e298] [cursor=pointer]':
                  - img [ref=e299]
                - button "Edit in Workbench" [ref=e302] [cursor=pointer]:
                  - img [ref=e303]
                - button "Remove from Dashboard" [ref=e306] [cursor=pointer]:
                  - img [ref=e307]
            - generic [ref=e316]:
              - generic [ref=e317]: $50.00
              - generic [ref=e318]: Total Sales
            - generic [ref=e319]:
              - generic [ref=e320]: Total Sales
              - generic [ref=e321]: 1 rows
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import { sanitizeDashboard } from '../shared/dashboardPrivacy.mjs';
  3  | 
  4  | test('a date filter recalculates a pinned KPI after the same workbook was re-imported', async ({ page }) => {
  5  |   const user = { id: 'reimport-filter-user', email: 'filter@example.com', name: 'Filter Test', role: 'contributor' };
  6  |   const token = 'header.' + Buffer.from(JSON.stringify({ userId: user.id })).toString('base64url') + '.signature';
  7  |   const dashboard = {
  8  |     id: 'retail-dashboard', name: 'Retail', createdAt: Date.now(),
  9  |     items: [{
  10 |       id: 'total-sales', title: 'Total Sales', width: 'half', datasetId: 'old-upload', datasetName: 'Retail.csv',
  11 |       result: {
  12 |         data: [{ dim: '(Total)', metric: 100 }], xKey: 'dim', yKey: 'metric', yLabel: 'Total Sales',
  13 |         insight: '', sql: '', vis: 'kpiCard',
  14 |         config: { questionId: 'custom_builder', metric: 'sales', dimension: '', aggregation: 'SUM' },
  15 |         queryConfig: { questionId: 'custom_builder', metric: 'sales', dimension: '', aggregation: 'SUM' },
  16 |       },
  17 |     }, {
  18 |       id: 'ai-total-sales', title: 'AI Total Sales', width: 'half', datasetId: 'old-upload', datasetName: 'Retail.csv',
  19 |       result: {
  20 |         data: [{ total_sales: 100 }], xKey: 'total_sales', yKey: 'total_sales', yLabel: 'Total Sales',
  21 |         insight: '', sql: 'SELECT SUM(sales) AS total_sales FROM data', vis: 'kpiCard',
  22 |         config: { questionId: 'ai_sql_test', metric: 'sales', dimension: '', aggregation: 'SUM' },
  23 |         queryConfig: { questionId: 'ai_sql_test', aiSql: 'SELECT SUM(sales) AS total_sales FROM data' },
  24 |         aiSqlRefresh: {
  25 |           version: 1, source: 'ai-sql', question: 'What are total sales?',
  26 |           sql: 'SELECT SUM(sales) AS total_sales FROM data',
  27 |           plan: {
  28 |             intent: 'single_metric', dimensions: [], metrics: [{ field: 'sales', agg: 'sum' }], filters: [],
  29 |             sort: [], limit: null, ambiguous: false, resultGrain: 'one summary row', originalQuestion: 'What are total sales?',
  30 |           },
  31 |           chart: { chartType: 'kpiCard', xKey: 'total_sales', yKey: 'total_sales', useDualAxis: false, reason: 'One total' },
  32 |         },
  33 |       },
  34 |     }],
  35 |     layout: [{ i: 'total-sales', x: 0, y: 0, w: 6, h: 6 }, { i: 'ai-total-sales', x: 6, y: 0, w: 6, h: 6 }],
  36 |     filters: [{ column: 'order_date', values: ['2025'], dateMode: 'calendar', dateSelection: { year: '2025', quarter: '3' } }],
  37 |   };
  38 |   const cloud = sanitizeDashboard(dashboard);
  39 |   await page.route('**/api/**', async route => {
  40 |     const pathname = new URL(route.request().url()).pathname;
  41 |     const body = pathname.endsWith('/auth/login') ? { success: true, token, user }
  42 |       : pathname.endsWith('/auth/verify') ? { success: true, valid: true, user }
  43 |       : pathname.endsWith('/dashboards') ? route.request().method() === 'GET' ? { dashboards: [cloud] } : { success: true }
  44 |       : {};
  45 |     await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body),
  46 |       headers: { 'Access-Control-Allow-Origin': '*' } });
  47 |   });
  48 |   await page.addInitScript(({ dashboard, userId }) => {
  49 |     localStorage.setItem('QuickInsight-onboarding-complete', 'true');
  50 |     localStorage.setItem(`QuickInsight-storage-v4-${userId}`, JSON.stringify({
  51 |       version: 5, state: {
  52 |         activeTab: 'DASHBOARD', dashboards: [dashboard], activeDashboardId: dashboard.id,
  53 |         resetLegacyDashboards: false, deletedDashboardIds: [], theme: 'light',
  54 |       },
  55 |     }));
  56 |   }, { dashboard, userId: user.id });
  57 |   await page.goto('/');
  58 |   await page.evaluate(async userId => {
  59 |     const db = await new Promise<IDBDatabase>((resolve, reject) => {
  60 |       const request = indexedDB.open('QuickInsight-datasets', 1);
  61 |       request.onupgradeneeded = () => request.result.createObjectStore('datasets', { keyPath: 'id' });
  62 |       request.onsuccess = () => resolve(request.result);
  63 |       request.onerror = () => reject(request.error);
  64 |     });
  65 |     await new Promise<void>((resolve, reject) => {
  66 |       const transaction = db.transaction('datasets', 'readwrite');
  67 |       transaction.objectStore('datasets').put({
  68 |         id: 'new-upload', name: 'Retail.csv', ownerId: userId,
  69 |         rows: [
  70 |           { order_date: '2025-06-30', sales: 10 }, { order_date: '2025-07-01', sales: 20 },
  71 |           { order_date: '2025-09-30', sales: 30 }, { order_date: '2025-10-01', sales: 40 },
  72 |         ],
  73 |         totalRows: 4, etlLogs: [],
  74 |         columns: [
  75 |           { name: 'order_date', type: 'DATE', originalType: 'string' },
  76 |           { name: 'sales', type: 'METRIC', originalType: 'number' },
  77 |         ],
  78 |       });
  79 |       transaction.oncomplete = () => resolve();
  80 |       transaction.onerror = () => reject(transaction.error);
  81 |     });
  82 |     db.close();
  83 |   }, user.id);
  84 |   await page.getByRole('button', { name: /skip tour/i }).click();
  85 |   await page.getByLabel('Email Address').fill(user.email);
  86 |   await page.getByLabel('Password', { exact: true }).fill('LocalFixtureOnly123');
  87 |   await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  88 | 
  89 |   await expect(page.getByText('order_date', { exact: true }).last()).toBeVisible();
> 90 |   await expect(page.locator('.qi-kpi-value')).toHaveText(['$50.00', '$50.00'], { timeout: 30_000 });
     |                                               ^ Error: expect(locator).toHaveText(expected) failed
  91 |   await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  92 |   await expect(page.locator('.qi-kpi-value')).toHaveText(['$100.00', '$100.00']);
  93 | });
  94 | 
```