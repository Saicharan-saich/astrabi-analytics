/** Deterministic e-commerce fixture used for visual previews (no randomness). */
export const CATEGORIES = ['Electronics', 'Apparel', 'Home & Living', 'Accessories'];
const CITIES = ['London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Bristol', 'Liverpool', 'Edinburgh'];
const VENDORS = ['Northwind', 'Contoso', 'Fabrikam', 'Tailspin'];

export function salesRows(): Record<string, any>[] {
    const rows: Record<string, any>[] = [];
    let n = 0;
    for (let month = 0; month < 27; month++) {
        const d0 = new Date(Date.UTC(2024, month, 1));
        const seasonal = 1 + 0.25 * Math.sin((month % 12) / 12 * 2 * Math.PI) + month * 0.012;
        for (let k = 0; k < 44; k++) {
            n++;
            const category = CATEGORIES[(n * 7 + month) % 4];
            const qty = 1 + ((n * 13) % 5);
            const price = [180, 45, 70, 25][CATEGORIES.indexOf(category)] * (0.8 + ((n * 17) % 40) / 100);
            const revenue = +(qty * price * seasonal).toFixed(2);
            const day = 1 + ((n * 11) % 27);
            rows.push({
                order_id: `ORD-${10000 + n}`,
                order_date: new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), day)).toISOString().slice(0, 10),
                category,
                vendor: VENDORS[(n * 5) % 4],
                city: CITIES[(n * 3 + month) % 8],
                quantity: qty,
                revenue,
                profit: +(revenue * (0.18 + ((n * 7) % 10) / 100) - 4).toFixed(2),
            });
        }
    }
    return rows;
}

const sum = (rows: any[], key: string) => rows.reduce((a, r) => a + r[key], 0);
const quarterOf = (date: string) => `Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1} ${date.slice(0, 4)}`;

export function dashboardFixture() {
    const rows = salesRows();
    const quarters = [...new Set(rows.map(r => quarterOf(r.order_date)))];
    const byQuarter = quarters.map(q => {
        const inQ = rows.filter(r => quarterOf(r.order_date) === q);
        return { quarter: q, revenue: Math.round(sum(inQ, 'revenue')), orders: inQ.length };
    });
    const last = byQuarter[byQuarter.length - 1];
    const prev = byQuarter[byQuarter.length - 2];
    const ordersByCategory = CATEGORIES.map(category => ({ category, orders: rows.filter(r => r.category === category).length }));
    const recentMonths = ['2025-12', '2026-01', '2026-02', '2026-03'];
    const stacked = recentMonths.flatMap(month => CATEGORIES.map(category => ({
        month, category,
        revenue: Math.round(sum(rows.filter(r => r.order_date.startsWith(month) && r.category === category), 'revenue')),
    })));
    const months = [...new Set(rows.map(r => r.order_date.slice(0, 7)))].slice(-12);
    const aov = months.map(month => {
        const inM = rows.filter(r => r.order_date.startsWith(month));
        return { month, avg_order_value: +(sum(inM, 'revenue') / inM.length).toFixed(2) };
    });
    const cities = [...new Set(rows.map(r => r.city))].map(city => ({ city, revenue: Math.round(sum(rows.filter(r => r.city === city), 'revenue')) }))
        .sort((a, b) => b.revenue - a.revenue);

    const card = (id: string, title: string, vis: string, data: any[], xKey: string, yKey: string, yLabel: string, config: any = {}) => ({
        id, title, width: 'half', datasetId: 'visual-sales', datasetName: 'Sales.csv',
        result: {
            data, xKey, yKey, yLabel, vis, insight: '', sql: '',
            config: { questionId: 'custom_builder', metric: yKey, dimension: xKey, aggregation: 'SUM', ...config },
            queryConfig: { questionId: 'custom_builder', metric: yKey, dimension: xKey, aggregation: 'SUM', ...config },
        },
    });

    return {
        id: 'visual-dashboard', name: 'E-commerce insights', createdAt: 1767225600000,
        items: [
            card('rev-orders', 'Revenue and orders over time', 'combo', byQuarter, 'quarter', 'revenue', 'Revenue', { secondaryMetrics: ['orders'] }),
            card('kpi-rev', 'Revenue this quarter', 'kpiCard', [{ dim: last.quarter, metric: last.revenue, previous_value: prev.revenue }], 'dim', 'metric', 'Revenue', { comparison: 'previous_period' }),
            card('orders-cat', 'Total orders by product category', 'doughnut', ordersByCategory, 'category', 'orders', 'Orders'),
            card('rev-cat', 'Revenue by product category', 'stackedBar', stacked, 'month', 'revenue', 'Revenue', { dimension: 'month', secondaryDimensions: ['category'] }),
            card('aov', 'Average order value by month', 'line', aov, 'month', 'avg_order_value', 'Average order value', { aggregation: 'AVG' }),
            card('cities', 'Revenue by city', 'horizontalBar', cities, 'city', 'revenue', 'Revenue'),
        ],
        layout: [
            { i: 'rev-orders', x: 0, y: 0, w: 8, h: 6 },
            { i: 'kpi-rev', x: 8, y: 0, w: 4, h: 6 },
            { i: 'orders-cat', x: 0, y: 6, w: 6, h: 6 },
            { i: 'rev-cat', x: 6, y: 6, w: 6, h: 6 },
            { i: 'aov', x: 0, y: 12, w: 6, h: 6 },
            { i: 'cities', x: 6, y: 12, w: 6, h: 6 },
        ],
        filters: [],
    };
}
