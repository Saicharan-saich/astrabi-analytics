export function dashboardFixture(): any {
    return {
        id: 'dashboard-a', name: 'Sales overview', dataset_id: 'sales-data',
        items: [{
            id: 'card-a', title: 'Sales by region', width: 'half',
            datasetId: 'sales-data', datasetName: 'Sales.csv', datasetVersion: 1,
            result: {
                data: Array.from({ length: 175 }, (_, n) => ({ region: 'PRIVATE_CUSTOMER_' + n, sales: n + 1 })),
                xKey: 'region', yKey: 'sales', yLabel: 'Sales',
                sql: 'SELECT region, SUM(sales) AS sales FROM data GROUP BY region',
                insight: 'PRIVATE_NARRATIVE', kpi: 998877, growth: { diff: 887766, pct: 42 },
                validation: { details: 'PRIVATE_VALIDATION' },
                explainability: { rowsProcessed: 175, example: 'PRIVATE_EXAMPLE' },
                vis: 'bar',
                config: { questionId: 'custom_builder', metric: 'sales', dimension: 'region', aggregation: 'SUM', timeGrain: 'Raw Date', analysisType: 'Standard' },
                queryConfig: { questionId: 'custom_builder', metric: 'sales', dimension: 'region', aggregation: 'SUM' },
                formatting: { colorMode: 'vibrant', showDataLabels: true, decimals: 2, tableCalculations: ['percent_of_total'] },
            },
        }],
        layout: [{ i: 'card-a', x: 0, y: 0, w: 6, h: 6 }],
        filters: [{ column: 'region', values: ['North'] }],
        formatting: { colorMode: 'vibrant' },
    };
}
