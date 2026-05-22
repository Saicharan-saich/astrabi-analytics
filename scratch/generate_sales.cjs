// Generate a realistic sales dataset CSV
const fs = require('fs');
const path = require('path');

const products = [
  { name: 'MacBook Pro 16"', category: 'Laptops', unit_price: 2499, cost: 1800 },
  { name: 'Dell XPS 15', category: 'Laptops', unit_price: 1799, cost: 1200 },
  { name: 'ThinkPad X1 Carbon', category: 'Laptops', unit_price: 1649, cost: 1100 },
  { name: 'iPhone 15 Pro', category: 'Phones', unit_price: 1199, cost: 750 },
  { name: 'Samsung Galaxy S24', category: 'Phones', unit_price: 999, cost: 620 },
  { name: 'Google Pixel 8', category: 'Phones', unit_price: 699, cost: 420 },
  { name: 'iPad Air', category: 'Tablets', unit_price: 599, cost: 380 },
  { name: 'Samsung Tab S9', category: 'Tablets', unit_price: 849, cost: 520 },
  { name: 'AirPods Pro', category: 'Accessories', unit_price: 249, cost: 120 },
  { name: 'Sony WH-1000XM5', category: 'Accessories', unit_price: 349, cost: 180 },
  { name: 'Logitech MX Master', category: 'Accessories', unit_price: 99, cost: 45 },
  { name: 'Apple Watch Ultra', category: 'Wearables', unit_price: 799, cost: 450 },
  { name: 'Samsung Galaxy Watch', category: 'Wearables', unit_price: 399, cost: 220 },
  { name: 'LG UltraWide 34"', category: 'Monitors', unit_price: 699, cost: 420 },
  { name: 'Dell U2723QE', category: 'Monitors', unit_price: 619, cost: 370 },
];

const regions = ['North America', 'Europe', 'Asia Pacific', 'Latin America', 'Middle East'];
const channels = ['Online', 'Retail Store', 'Enterprise', 'Reseller'];
const reps = [
  'Sarah Johnson', 'Michael Chen', 'Emma Williams', 'James Rodriguez',
  'Olivia Brown', 'Liam Davis', 'Sophia Martinez', 'Noah Wilson',
  'Ava Taylor', 'Ethan Anderson'
];
const statuses = ['Completed', 'Completed', 'Completed', 'Completed', 'Returned', 'Pending'];

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[rand(0, arr.length - 1)]; }
function pad(n) { return String(n).padStart(2, '0'); }

const rows = [];
const header = 'order_id,order_date,product_name,category,unit_price,cost_price,quantity,discount_pct,region,sales_channel,sales_rep,order_status,customer_segment';

// Generate 2 years of data: 2024-01-01 to 2025-12-31
let orderId = 10001;
for (let year = 2024; year <= 2025; year++) {
  for (let month = 1; month <= 12; month++) {
    // Skip future months in 2025
    if (year === 2025 && month > 5) break;
    const daysInMonth = new Date(year, month, 0).getDate();
    // Seasonal multiplier
    const seasonal = [11,12].includes(month) ? 1.6 : [6,7,8].includes(month) ? 0.8 : 1.0;
    const ordersThisMonth = Math.round(rand(60, 100) * seasonal);
    
    for (let i = 0; i < ordersThisMonth; i++) {
      const day = rand(1, daysInMonth);
      const date = `${year}-${pad(month)}-${pad(day)}`;
      const product = pick(products);
      const qty = rand(1, 8);
      const discount = pick([0, 0, 0, 5, 10, 15, 20]);
      const segment = pick(['Consumer', 'Business', 'Enterprise', 'Government']);
      
      rows.push(`${orderId},${date},${product.name},${product.category},${product.unit_price},${product.cost},${qty},${discount},${pick(regions)},${pick(channels)},${pick(reps)},${pick(statuses)},${segment}`);
      orderId++;
    }
  }
}

const csv = header + '\n' + rows.join('\n');
const outPath = path.join('C:\\Users\\chepu\\OneDrive\\Desktop', 'sales_data_2024_2025.csv');
fs.writeFileSync(outPath, csv, 'utf8');
console.log(`Generated ${rows.length} rows → ${outPath}`);
