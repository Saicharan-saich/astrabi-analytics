import { it } from 'vitest';
import { questionFromWords } from '../services/builderFromWords';
import { runETLPipeline } from '../services/etlPipeline';
it('probe', () => {
  const items = [['Classic Burger','Mains',14],['Steak Frites','Mains',22],['Fries','Sides',4],['Fresh Lemonade','Drinks',3.5]] as const;
  const raw = Array.from({ length: 400 }, (_, i) => { const [item, cat, p] = items[i % 4]; return { 'Order ID': `R${i}`, 'Order Date': `2026-0${1 + (i % 9)}-1${i % 9}`, Location: ['Leeds','York','Hull'][i % 3], 'Service Type': ['Dine-In','Delivery'][i % 2], 'Menu Category': cat, 'Menu Item': item, Quantity: 1 + (i % 3), 'Gross Sales': p * (1 + (i % 3)), 'Food Cost': p * 0.3, 'Customer Rating': 3 + (i % 3) }; });
  const out = runETLPipeline(raw, 'r.csv');
  const ds: any = { id: 'r', name: 'r.csv', rows: out.rows, columns: out.columns };
  for (const q of ['sales by location', 'gross sales by month', 'top 5 menu items by sales', 'average rating by service type', 'sales in Leeds last 3 months', 'how many orders by location', 'revenue by month for delivery', 'lowest 3 items by quantity', 'sales by location and service type', 'sales this month vs last month', 'total sales', 'which location sells the most burgers', 'food cost by category excluding drinks', 'sales and food cost by month', 'monthly sales in 2026', 'sales last month', 'sales in march', 'q2 sales by store', 'how many customers', 'sales by item year on year', 'what is the trend of ratings', 'show me profit by zebra']) {
    const r = questionFromWords(ds, q, '2026-09-20');
    console.log(`${q.padEnd(42)} → ${JSON.stringify(r.config)} | ${r.understood.map(u => u.text).join(' · ')}${r.unused.length ? ` | UNUSED: ${r.unused.join(',')}` : ''}`);
  }
});
