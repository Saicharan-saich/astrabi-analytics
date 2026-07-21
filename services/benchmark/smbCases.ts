/**
 * SMB Benchmark — 100 questions on the queries small businesses and independent
 * consultants actually ask.
 * ─────────────────────────────────────────────────────────────────────
 * Two self-contained single-table datasets (the "one big table" shape the app
 * serves): retail/hospitality orders and a consultant's invoices. Questions span
 * the real happy path — totals, counts, averages, group-by breakdowns, top-N /
 * rankings, filters, distinct counts, above/below-average, share-of-total,
 * simple ratios and month/week trends. Gold SQL is plain DuckDB and executes
 * against the dataset for ground truth (execution-based scoring).
 *
 * This is the market-relevant replacement for the academic Spider/BIRD packs:
 * it measures reliability on the questions this product exists to answer.
 */

import type { BenchCase, BenchTable, Difficulty } from './spiderCases';

// ── Dataset 1: retail / hospitality orders ───────────────────────────
const FOOD = ['Beef Burger', 'Margherita Pizza', 'Caesar Salad', 'Pasta Alfredo'];
const BEV = ['Latte', 'Iced Tea', 'Green Smoothie', 'Cappuccino'];
const RETAIL = ['Branded Mug', 'T-Shirt', 'Cap', 'Notebook'];
const CHANNELS = ['Dine-In', 'Takeaway', 'Delivery', 'Online'];
const CATEGORIES = ['Food', 'Beverage', 'Retail'];
const PRODUCTS: Record<string, string[]> = { Food: FOOD, Beverage: BEV, Retail: RETAIL };
const PAY = ['Card', 'Cash', 'Mobile Payment'];
const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TOD = ['Breakfast', 'Lunch', 'Dinner', 'Late Night'];
const REGIONS = ['North', 'South', 'East', 'West'];

function retailRows(): Record<string, any>[] {
    const rows: Record<string, any>[] = [];
    for (let i = 1; i <= 60; i++) {
        const category = CATEGORIES[i % 3];
        const product = PRODUCTS[category][i % 4];
        const quantity = 1 + (i % 4);
        const unit_price = Number((5 + ((i * 3.3) % 40)).toFixed(2));
        const month = 1 + (i % 6);
        const day = 1 + (i % 27);
        rows.push({
            order_id: 1000 + i,
            customer_id: 'C' + String(i % 25).padStart(3, '0'),
            customer_name: `Customer ${i % 25}`,
            order_date: `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
            channel: CHANNELS[i % 4],
            category,
            product,
            quantity,
            unit_price,
            total_price: Number((quantity * unit_price).toFixed(2)),
            payment_method: PAY[i % 3],
            day_of_week: DOW[i % 7],
            time_of_day: TOD[i % 4],
            region: REGIONS[i % 4],
        });
    }
    return rows;
}

// ── Dataset 2: consultant invoices ───────────────────────────────────
const SERVICES = ['Advisory', 'Implementation', 'Training', 'Support'];
const STATUS = ['Paid', 'Pending', 'Overdue'];
const INDUSTRIES = ['Tech', 'Retail', 'Finance', 'Healthcare'];

function invoiceRows(): Record<string, any>[] {
    const rows: Record<string, any>[] = [];
    for (let i = 1; i <= 48; i++) {
        const hours = 2 + (i % 10);
        const rate = 80 + (i % 5) * 20;
        const month = 1 + (i % 6);
        const day = 1 + (i % 27);
        rows.push({
            invoice_id: 5000 + i,
            client_id: 'CL' + String(i % 12).padStart(2, '0'),
            client_name: `Client ${i % 12}`,
            invoice_date: `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
            service_type: SERVICES[i % 4],
            hours,
            rate,
            amount: hours * rate,
            status: STATUS[i % 3],
            industry: INDUSTRIES[i % 4],
        });
    }
    return rows;
}

const retail: BenchTable = { name: 'retail_orders', rows: retailRows() };
const invoices: BenchTable = { name: 'consulting_invoices', rows: invoiceRows() };

// A compact question spec; the shared table + boilerplate is attached below.
interface Q { id: string; q: string; sql: string; d?: Difficulty; o?: boolean; t?: string[]; }

const RETAIL_Q: Q[] = [
    // scalars
    { id: 'r-total-rev', q: 'What is the total revenue?', sql: 'SELECT SUM(total_price) AS revenue FROM retail_orders', d: 'easy', t: ['aggregate'] },
    { id: 'r-order-count', q: 'How many orders are there?', sql: 'SELECT COUNT(*) AS n FROM retail_orders', d: 'easy', t: ['count'] },
    { id: 'r-aov', q: 'What is the average order value?', sql: 'SELECT AVG(total_price) AS aov FROM retail_orders', d: 'easy', t: ['avg'] },
    { id: 'r-total-qty', q: 'What is the total quantity sold?', sql: 'SELECT SUM(quantity) AS q FROM retail_orders', d: 'easy', t: ['aggregate'] },
    { id: 'r-distinct-cust', q: 'How many distinct customers are there?', sql: 'SELECT COUNT(DISTINCT customer_id) AS n FROM retail_orders', d: 'easy', t: ['count_distinct'] },
    { id: 'r-distinct-prod', q: 'How many unique products were sold?', sql: 'SELECT COUNT(DISTINCT product) AS n FROM retail_orders', d: 'easy', t: ['count_distinct'] },
    { id: 'r-avg-unit', q: 'What is the average unit price?', sql: 'SELECT AVG(unit_price) AS p FROM retail_orders', d: 'easy', t: ['avg'] },
    { id: 'r-max-order', q: 'What is the value of the largest single order?', sql: 'SELECT MAX(total_price) AS m FROM retail_orders', d: 'easy', t: ['max'] },
    { id: 'r-min-price', q: 'What is the lowest unit price?', sql: 'SELECT MIN(unit_price) AS m FROM retail_orders', d: 'easy', t: ['min'] },
    // group-by
    { id: 'r-rev-channel', q: 'What is the total revenue by channel?', sql: 'SELECT channel, SUM(total_price) AS revenue FROM retail_orders GROUP BY channel', d: 'medium', t: ['group_by'] },
    { id: 'r-orders-pay', q: 'How many orders were placed with each payment method?', sql: 'SELECT payment_method, COUNT(*) AS n FROM retail_orders GROUP BY payment_method', d: 'medium', t: ['group_by'] },
    { id: 'r-rev-cat', q: 'What is the total revenue for each category?', sql: 'SELECT category, SUM(total_price) AS revenue FROM retail_orders GROUP BY category', d: 'medium', t: ['group_by'] },
    { id: 'r-aov-tod', q: 'What is the average order value by time of day?', sql: 'SELECT time_of_day, AVG(total_price) AS aov FROM retail_orders GROUP BY time_of_day', d: 'medium', t: ['group_by', 'avg'] },
    { id: 'r-rev-region', q: 'What is the total revenue by region?', sql: 'SELECT region, SUM(total_price) AS revenue FROM retail_orders GROUP BY region', d: 'medium', t: ['group_by'] },
    { id: 'r-rev-dow', q: 'What is the total revenue by day of the week?', sql: 'SELECT day_of_week, SUM(total_price) AS revenue FROM retail_orders GROUP BY day_of_week', d: 'medium', t: ['group_by'] },
    { id: 'r-qty-cat', q: 'What is the total quantity sold by category?', sql: 'SELECT category, SUM(quantity) AS q FROM retail_orders GROUP BY category', d: 'medium', t: ['group_by'] },
    { id: 'r-orders-channel', q: 'How many orders were placed through each channel?', sql: 'SELECT channel, COUNT(*) AS n FROM retail_orders GROUP BY channel', d: 'medium', t: ['group_by'] },
    { id: 'r-avgqty-channel', q: 'What is the average quantity per order for each channel?', sql: 'SELECT channel, AVG(quantity) AS aq FROM retail_orders GROUP BY channel', d: 'medium', t: ['group_by', 'avg'] },
    { id: 'r-aov-cat', q: 'What is the average order value by category?', sql: 'SELECT category, AVG(total_price) AS aov FROM retail_orders GROUP BY category', d: 'medium', t: ['group_by', 'avg'] },
    { id: 'r-avgunit-cat', q: 'What is the average unit price by category?', sql: 'SELECT category, AVG(unit_price) AS p FROM retail_orders GROUP BY category', d: 'medium', t: ['group_by', 'avg'] },
    { id: 'r-orders-tod', q: 'How many orders were placed in each time of day?', sql: 'SELECT time_of_day, COUNT(*) AS n FROM retail_orders GROUP BY time_of_day', d: 'medium', t: ['group_by'] },
    { id: 'r-rev-pay', q: 'What is the total revenue by payment method?', sql: 'SELECT payment_method, SUM(total_price) AS revenue FROM retail_orders GROUP BY payment_method', d: 'medium', t: ['group_by'] },
    { id: 'r-qty-prod', q: 'What is the total quantity sold for each product?', sql: 'SELECT product, SUM(quantity) AS q FROM retail_orders GROUP BY product', d: 'medium', t: ['group_by'] },
    { id: 'r-max-channel', q: 'What is the largest order value for each channel?', sql: 'SELECT channel, MAX(total_price) AS m FROM retail_orders GROUP BY channel', d: 'medium', t: ['group_by', 'max'] },
    { id: 'r-rev-channel-cat', q: 'What is the total revenue by channel and category?', sql: 'SELECT channel, category, SUM(total_price) AS revenue FROM retail_orders GROUP BY channel, category', d: 'hard', t: ['group_by'] },
    // ranking / top-N
    { id: 'r-top5-prod', q: 'What are the top 5 products by total revenue?', sql: 'SELECT product, SUM(total_price) AS revenue FROM retail_orders GROUP BY product ORDER BY revenue DESC LIMIT 5', d: 'hard', o: true, t: ['ranking', 'limit'] },
    { id: 'r-best-channel', q: 'Which channel has the highest revenue?', sql: 'SELECT channel FROM retail_orders GROUP BY channel ORDER BY SUM(total_price) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking'] },
    { id: 'r-most-orders-region', q: 'Which region has the most orders?', sql: 'SELECT region FROM retail_orders GROUP BY region ORDER BY COUNT(*) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking'] },
    { id: 'r-top-customer', q: 'Which customer spent the most?', sql: 'SELECT customer_name FROM retail_orders GROUP BY customer_name ORDER BY SUM(total_price) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking'] },
    { id: 'r-best-day', q: 'Which day of the week has the highest revenue?', sql: 'SELECT day_of_week FROM retail_orders GROUP BY day_of_week ORDER BY SUM(total_price) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking'] },
    { id: 'r-best-cat', q: 'Which category generates the most revenue?', sql: 'SELECT category FROM retail_orders GROUP BY category ORDER BY SUM(total_price) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking'] },
    { id: 'r-best-tod-aov', q: 'Which time of day has the highest average order value?', sql: 'SELECT time_of_day FROM retail_orders GROUP BY time_of_day ORDER BY AVG(total_price) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking', 'avg'] },
    { id: 'r-bottom3-prod', q: 'What are the 3 lowest-revenue products?', sql: 'SELECT product, SUM(total_price) AS revenue FROM retail_orders GROUP BY product ORDER BY revenue ASC LIMIT 3', d: 'hard', o: true, t: ['ranking', 'limit'] },
    { id: 'r-top3-cust-orders', q: 'Who are the top 3 customers by number of orders?', sql: 'SELECT customer_name, COUNT(*) AS n FROM retail_orders GROUP BY customer_name ORDER BY n DESC LIMIT 3', d: 'hard', o: true, t: ['ranking', 'limit'] },
    { id: 'r-most-pay', q: 'Which payment method is used most often?', sql: 'SELECT payment_method FROM retail_orders GROUP BY payment_method ORDER BY COUNT(*) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking'] },
    // filters
    { id: 'r-rev-delivery', q: 'What is the total revenue from Delivery orders?', sql: "SELECT SUM(total_price) AS revenue FROM retail_orders WHERE channel = 'Delivery'", d: 'medium', t: ['filter'] },
    { id: 'r-count-dinein', q: 'How many Dine-In orders were there?', sql: "SELECT COUNT(*) AS n FROM retail_orders WHERE channel = 'Dine-In'", d: 'medium', t: ['filter', 'count'] },
    { id: 'r-rev-bev', q: 'What is the total revenue from Beverages?', sql: "SELECT SUM(total_price) AS revenue FROM retail_orders WHERE category = 'Beverage'", d: 'medium', t: ['filter'] },
    { id: 'r-count-cash', q: 'How many orders were paid with Cash?', sql: "SELECT COUNT(*) AS n FROM retail_orders WHERE payment_method = 'Cash'", d: 'medium', t: ['filter', 'count'] },
    { id: 'r-aov-online', q: 'What is the average order value for Online orders?', sql: "SELECT AVG(total_price) AS aov FROM retail_orders WHERE channel = 'Online'", d: 'medium', t: ['filter', 'avg'] },
    { id: 'r-rev-north', q: 'What is the total revenue in the North region?', sql: "SELECT SUM(total_price) AS revenue FROM retail_orders WHERE region = 'North'", d: 'medium', t: ['filter'] },
    { id: 'r-food-monday', q: 'How many Food orders were placed on Mondays?', sql: "SELECT COUNT(*) AS n FROM retail_orders WHERE category = 'Food' AND day_of_week = 'Monday'", d: 'hard', t: ['filter', 'count'] },
    // distinct + filter
    { id: 'r-distinct-cust-delivery', q: 'How many distinct customers ordered via Delivery?', sql: "SELECT COUNT(DISTINCT customer_id) AS n FROM retail_orders WHERE channel = 'Delivery'", d: 'hard', t: ['count_distinct', 'filter'] },
    { id: 'r-distinct-prod-bev', q: 'How many distinct products are in the Beverage category?', sql: "SELECT COUNT(DISTINCT product) AS n FROM retail_orders WHERE category = 'Beverage'", d: 'hard', t: ['count_distinct', 'filter'] },
    { id: 'r-distinct-cust-region', q: 'How many distinct customers are there in each region?', sql: 'SELECT region, COUNT(DISTINCT customer_id) AS n FROM retail_orders GROUP BY region', d: 'hard', t: ['count_distinct', 'group_by'] },
    // above / below average
    { id: 'r-prod-above-avg-price', q: 'Which products have a unit price above the average unit price?', sql: 'SELECT DISTINCT product FROM retail_orders WHERE unit_price > (SELECT AVG(unit_price) FROM retail_orders)', d: 'hard', t: ['above_avg', 'nested'] },
    { id: 'r-orders-above-avg', q: 'How many orders are above the average order value?', sql: 'SELECT COUNT(*) AS n FROM retail_orders WHERE total_price > (SELECT AVG(total_price) FROM retail_orders)', d: 'hard', t: ['above_avg', 'nested'] },
    // share of total
    { id: 'r-pct-bev', q: 'What percentage of total revenue comes from Beverages?', sql: "SELECT ROUND(SUM(CASE WHEN category = 'Beverage' THEN total_price ELSE 0 END) * 100.0 / SUM(total_price), 2) AS pct FROM retail_orders", d: 'hard', t: ['share'] },
    { id: 'r-share-channel', q: 'What share of revenue does each channel represent?', sql: 'SELECT channel, ROUND(SUM(total_price) * 100.0 / (SELECT SUM(total_price) FROM retail_orders), 2) AS pct FROM retail_orders GROUP BY channel', d: 'hard', t: ['share', 'group_by'] },
    // derived ratios
    { id: 'r-items-per-order', q: 'What is the average number of items per order for each channel?', sql: 'SELECT channel, SUM(quantity) * 1.0 / COUNT(DISTINCT order_id) AS items_per_order FROM retail_orders GROUP BY channel', d: 'hard', t: ['derived', 'group_by'] },
    { id: 'r-rev-per-cust', q: 'What is the average revenue per customer?', sql: 'SELECT SUM(total_price) * 1.0 / COUNT(DISTINCT customer_id) AS rev_per_cust FROM retail_orders', d: 'hard', t: ['derived'] },
    // time trends
    { id: 'r-rev-month', q: 'What is the revenue by month?', sql: "SELECT strftime(CAST(order_date AS DATE), '%Y-%m') AS month, SUM(total_price) AS revenue FROM retail_orders GROUP BY month ORDER BY month", d: 'hard', o: true, t: ['time'] },
    { id: 'r-orders-month', q: 'How many orders were placed each month?', sql: "SELECT strftime(CAST(order_date AS DATE), '%Y-%m') AS month, COUNT(*) AS n FROM retail_orders GROUP BY month ORDER BY month", d: 'hard', o: true, t: ['time'] },
    { id: 'r-rev-week', q: 'What is the revenue by week?', sql: 'SELECT WEEK(CAST(order_date AS DATE)) AS wk, SUM(total_price) AS revenue FROM retail_orders GROUP BY wk ORDER BY wk', d: 'hard', o: true, t: ['time'] },
];

const CONSULT_Q: Q[] = [
    { id: 'c-total-billed', q: 'What is the total amount billed?', sql: 'SELECT SUM(amount) AS billed FROM consulting_invoices', d: 'easy', t: ['aggregate'] },
    { id: 'c-inv-count', q: 'How many invoices are there?', sql: 'SELECT COUNT(*) AS n FROM consulting_invoices', d: 'easy', t: ['count'] },
    { id: 'c-total-hours', q: 'How many hours were billed in total?', sql: 'SELECT SUM(hours) AS h FROM consulting_invoices', d: 'easy', t: ['aggregate'] },
    { id: 'c-avg-amount', q: 'What is the average invoice amount?', sql: 'SELECT AVG(amount) AS a FROM consulting_invoices', d: 'easy', t: ['avg'] },
    { id: 'c-distinct-clients', q: 'How many distinct clients are there?', sql: 'SELECT COUNT(DISTINCT client_id) AS n FROM consulting_invoices', d: 'easy', t: ['count_distinct'] },
    { id: 'c-avg-rate', q: 'What is the average hourly rate?', sql: 'SELECT AVG(rate) AS r FROM consulting_invoices', d: 'easy', t: ['avg'] },
    { id: 'c-max-invoice', q: 'What is the largest invoice amount?', sql: 'SELECT MAX(amount) AS m FROM consulting_invoices', d: 'easy', t: ['max'] },
    { id: 'c-min-invoice', q: 'What is the smallest invoice amount?', sql: 'SELECT MIN(amount) AS m FROM consulting_invoices', d: 'easy', t: ['min'] },
    { id: 'c-distinct-services', q: 'How many distinct service types are there?', sql: 'SELECT COUNT(DISTINCT service_type) AS n FROM consulting_invoices', d: 'easy', t: ['count_distinct'] },
    { id: 'c-max-hours', q: 'What is the highest number of hours on a single invoice?', sql: 'SELECT MAX(hours) AS m FROM consulting_invoices', d: 'easy', t: ['max'] },
    // group-by
    { id: 'c-billed-service', q: 'What is the total amount billed by service type?', sql: 'SELECT service_type, SUM(amount) AS billed FROM consulting_invoices GROUP BY service_type', d: 'medium', t: ['group_by'] },
    { id: 'c-inv-status', q: 'How many invoices are in each status?', sql: 'SELECT status, COUNT(*) AS n FROM consulting_invoices GROUP BY status', d: 'medium', t: ['group_by'] },
    { id: 'c-billed-industry', q: 'What is the total amount billed by industry?', sql: 'SELECT industry, SUM(amount) AS billed FROM consulting_invoices GROUP BY industry', d: 'medium', t: ['group_by'] },
    { id: 'c-hours-service', q: 'How many hours were billed for each service type?', sql: 'SELECT service_type, SUM(hours) AS h FROM consulting_invoices GROUP BY service_type', d: 'medium', t: ['group_by'] },
    { id: 'c-avg-service', q: 'What is the average invoice amount by service type?', sql: 'SELECT service_type, AVG(amount) AS a FROM consulting_invoices GROUP BY service_type', d: 'medium', t: ['group_by', 'avg'] },
    { id: 'c-amt-status', q: 'What is the total amount by status?', sql: 'SELECT status, SUM(amount) AS billed FROM consulting_invoices GROUP BY status', d: 'medium', t: ['group_by'] },
    { id: 'c-avg-rate-industry', q: 'What is the average hourly rate by industry?', sql: 'SELECT industry, AVG(rate) AS r FROM consulting_invoices GROUP BY industry', d: 'medium', t: ['group_by', 'avg'] },
    { id: 'c-avg-hours-service', q: 'What is the average hours per invoice by service type?', sql: 'SELECT service_type, AVG(hours) AS h FROM consulting_invoices GROUP BY service_type', d: 'medium', t: ['group_by', 'avg'] },
    { id: 'c-inv-service', q: 'How many invoices are there for each service type?', sql: 'SELECT service_type, COUNT(*) AS n FROM consulting_invoices GROUP BY service_type', d: 'medium', t: ['group_by'] },
    { id: 'c-hours-industry', q: 'How many hours were billed by industry?', sql: 'SELECT industry, SUM(hours) AS h FROM consulting_invoices GROUP BY industry', d: 'medium', t: ['group_by'] },
    { id: 'c-avg-amount-industry', q: 'What is the average invoice amount by industry?', sql: 'SELECT industry, AVG(amount) AS a FROM consulting_invoices GROUP BY industry', d: 'medium', t: ['group_by', 'avg'] },
    { id: 'c-billed-client', q: 'What is the total amount billed to each client?', sql: 'SELECT client_name, SUM(amount) AS billed FROM consulting_invoices GROUP BY client_name', d: 'medium', t: ['group_by'] },
    { id: 'c-distinct-clients-industry', q: 'How many distinct clients are there in each industry?', sql: 'SELECT industry, COUNT(DISTINCT client_id) AS n FROM consulting_invoices GROUP BY industry', d: 'hard', t: ['count_distinct', 'group_by'] },
    // ranking
    { id: 'c-top-client', q: 'Which client has been billed the most?', sql: 'SELECT client_name FROM consulting_invoices GROUP BY client_name ORDER BY SUM(amount) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking'] },
    { id: 'c-best-service', q: 'Which service type generates the most revenue?', sql: 'SELECT service_type FROM consulting_invoices GROUP BY service_type ORDER BY SUM(amount) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking'] },
    { id: 'c-best-industry', q: 'Which industry has the highest total billing?', sql: 'SELECT industry FROM consulting_invoices GROUP BY industry ORDER BY SUM(amount) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking'] },
    { id: 'c-top3-clients', q: 'Who are the top 3 clients by total billing?', sql: 'SELECT client_name, SUM(amount) AS billed FROM consulting_invoices GROUP BY client_name ORDER BY billed DESC LIMIT 3', d: 'hard', o: true, t: ['ranking', 'limit'] },
    { id: 'c-client-most-invoices', q: 'Which client has the most invoices?', sql: 'SELECT client_name FROM consulting_invoices GROUP BY client_name ORDER BY COUNT(*) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking'] },
    { id: 'c-most-status', q: 'Which invoice status is the most common?', sql: 'SELECT status FROM consulting_invoices GROUP BY status ORDER BY COUNT(*) DESC LIMIT 1', d: 'hard', o: true, t: ['ranking'] },
    // filters
    { id: 'c-paid-total', q: 'What is the total amount of paid invoices?', sql: "SELECT SUM(amount) AS billed FROM consulting_invoices WHERE status = 'Paid'", d: 'medium', t: ['filter'] },
    { id: 'c-overdue-count', q: 'How many invoices are overdue?', sql: "SELECT COUNT(*) AS n FROM consulting_invoices WHERE status = 'Overdue'", d: 'medium', t: ['filter', 'count'] },
    { id: 'c-outstanding', q: 'What is the total outstanding amount (pending or overdue)?', sql: "SELECT SUM(amount) AS outstanding FROM consulting_invoices WHERE status IN ('Pending', 'Overdue')", d: 'hard', t: ['filter'] },
    { id: 'c-advisory-billed', q: 'How much was billed for Advisory work?', sql: "SELECT SUM(amount) AS billed FROM consulting_invoices WHERE service_type = 'Advisory'", d: 'medium', t: ['filter'] },
    { id: 'c-paid-tech', q: 'How many paid invoices are in the Tech industry?', sql: "SELECT COUNT(*) AS n FROM consulting_invoices WHERE status = 'Paid' AND industry = 'Tech'", d: 'hard', t: ['filter', 'count'] },
    { id: 'c-avg-paid', q: 'What is the average amount of paid invoices?', sql: "SELECT AVG(amount) AS a FROM consulting_invoices WHERE status = 'Paid'", d: 'medium', t: ['filter', 'avg'] },
    { id: 'c-overdue-industry', q: 'What is the overdue amount by industry?', sql: "SELECT industry, SUM(amount) AS overdue FROM consulting_invoices WHERE status = 'Overdue' GROUP BY industry", d: 'hard', t: ['filter', 'group_by'] },
    // above/below average
    { id: 'c-clients-above-avg', q: 'Which clients have total billing above the average client billing?', sql: 'SELECT client_name FROM consulting_invoices GROUP BY client_name HAVING SUM(amount) > (SELECT AVG(client_total) FROM (SELECT SUM(amount) AS client_total FROM consulting_invoices GROUP BY client_name))', d: 'hard', t: ['above_avg', 'having'] },
    { id: 'c-inv-above-avg', q: 'How many invoices are above the average invoice amount?', sql: 'SELECT COUNT(*) AS n FROM consulting_invoices WHERE amount > (SELECT AVG(amount) FROM consulting_invoices)', d: 'hard', t: ['above_avg', 'nested'] },
    // share / percentage
    { id: 'c-pct-paid', q: 'What percentage of invoices have been paid?', sql: "SELECT ROUND(SUM(CASE WHEN status = 'Paid' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS pct FROM consulting_invoices", d: 'hard', t: ['share'] },
    { id: 'c-pct-advisory', q: 'What percentage of billing comes from Advisory?', sql: "SELECT ROUND(SUM(CASE WHEN service_type = 'Advisory' THEN amount ELSE 0 END) * 100.0 / SUM(amount), 2) AS pct FROM consulting_invoices", d: 'hard', t: ['share'] },
    { id: 'c-share-service', q: 'What share of billing does each service type represent?', sql: 'SELECT service_type, ROUND(SUM(amount) * 100.0 / (SELECT SUM(amount) FROM consulting_invoices), 2) AS pct FROM consulting_invoices GROUP BY service_type', d: 'hard', t: ['share', 'group_by'] },
    // derived
    { id: 'c-rev-per-client', q: 'What is the average revenue per client?', sql: 'SELECT SUM(amount) * 1.0 / COUNT(DISTINCT client_id) AS rev_per_client FROM consulting_invoices', d: 'hard', t: ['derived'] },
    { id: 'c-avg-effective-rate', q: 'What is the overall effective hourly rate (total amount divided by total hours)?', sql: 'SELECT SUM(amount) * 1.0 / NULLIF(SUM(hours), 0) AS effective_rate FROM consulting_invoices', d: 'hard', t: ['derived'] },
    // time
    { id: 'c-billed-month', q: 'What is the amount billed each month?', sql: "SELECT strftime(CAST(invoice_date AS DATE), '%Y-%m') AS month, SUM(amount) AS billed FROM consulting_invoices GROUP BY month ORDER BY month", d: 'hard', o: true, t: ['time'] },
    { id: 'c-inv-month', q: 'How many invoices were issued each month?', sql: "SELECT strftime(CAST(invoice_date AS DATE), '%Y-%m') AS month, COUNT(*) AS n FROM consulting_invoices GROUP BY month ORDER BY month", d: 'hard', o: true, t: ['time'] },
];

function toCase(db: string, table: BenchTable, x: Q): BenchCase {
    return {
        id: `smb-${x.id}`, suite: 'smb', db, question: x.q, goldSQL: x.sql,
        difficulty: x.d || 'medium', tableCount: 1, tables: [table], primaryTable: table.name,
        orderMatters: x.o, tags: x.t || [],
    };
}

export const SMB_CASES: BenchCase[] = [
    ...RETAIL_Q.map(x => toCase('retail_orders', retail, x)),
    ...CONSULT_Q.map(x => toCase('consulting_invoices', invoices, x)),
];
