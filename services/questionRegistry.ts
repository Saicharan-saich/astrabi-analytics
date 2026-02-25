import { QuestionTemplate } from "../types";

// --- DETERMINISTIC QUESTION REGISTRY (HARDENED) ---
export const QUESTION_REGISTRY: QuestionTemplate[] = [

    // ╔══════════════════════════════════════════════╗
    // ║  1. DAILY PERFORMANCE                        ║
    // ╚══════════════════════════════════════════════╝

    // Core Metrics — single scalar value → kpiCard
    { id: 'd_rev', category: 'Daily Performance', question: 'How much revenue did we generate today?', req: ['revenue', 'order_date'], grain: 'day', vis: 'kpiCard', sql: `SELECT SUM(revenue) FROM orders WHERE order_date = CURRENT_DATE` },
    { id: 'd_orders', category: 'Daily Performance', question: 'How many orders were placed today?', req: ['order_id', 'order_date'], grain: 'day', vis: 'kpiCard', sql: `SELECT COUNT(DISTINCT order_id) FROM orders WHERE order_date = CURRENT_DATE` },
    { id: 'd_aov', category: 'Daily Performance', question: 'What is today\'s AOV?', req: ['revenue', 'order_id', 'order_date'], grain: 'day', vis: 'kpiCard', sql: `SELECT SUM(revenue) / COUNT(DISTINCT order_id) FROM orders WHERE order_date = CURRENT_DATE` },
    { id: 'd_units', category: 'Daily Performance', question: 'How many units were sold today?', req: ['quantity', 'order_date'], grain: 'day', vis: 'kpiCard', sql: `SELECT SUM(quantity) FROM line_items WHERE order_date = CURRENT_DATE` },

    // Day over Day Comparisons — two bars (Current vs Previous) → bar
    { id: 'd_vs_y_rev', category: 'Daily Performance', question: 'Revenue vs Yesterday', req: ['revenue', 'order_date'], grain: 'day', vis: 'groupedBar', sql: `...` },
    { id: 'd_vs_y_orders', category: 'Daily Performance', question: 'Orders vs Yesterday', req: ['order_id', 'order_date'], grain: 'day', vis: 'groupedBar', sql: `...` },
    { id: 'd_vs_y_aov', category: 'Daily Performance', question: 'AOV vs Yesterday', req: ['revenue', 'order_id', 'order_date'], grain: 'day', vis: 'groupedBar', sql: `...` },

    // Percent Change — two bars (Current vs Previous) + KPI badge shows % → bar
    { id: 'd_pct_chg_rev', category: 'Daily Performance', question: '% Revenue Change vs Yesterday', req: ['revenue', 'order_date'], grain: 'day', vis: 'bar', sql: `...` },

    // Percent of Total — shares/slices → doughnut/pie
    { id: 'd_pct_total_prod', category: 'Daily Performance', question: '% Revenue by Product Today', req: ['revenue', 'product_name', 'order_date'], grain: 'item', vis: 'doughnut', sql: `...` },
    { id: 'd_pct_total_channel', category: 'Daily Performance', question: '% Sales by Channel Today', req: ['revenue', 'source', 'order_date'], grain: 'any', vis: 'pie', sql: `...` },

    // Rankings — sorted list → horizontalBar
    { id: 'd_top_5_prod', category: 'Daily Performance', question: 'Top 5 products today by revenue', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'horizontalBar', sql: `SELECT product_name, SUM(revenue) FROM order_items WHERE order_date = CURRENT_DATE GROUP BY 1 ORDER BY 2 DESC LIMIT 5` },
    { id: 'd_top_channels', category: 'Daily Performance', question: 'Top Channels Today', req: ['source', 'revenue', 'order_date'], grain: 'any', vis: 'horizontalBar', sql: `...` },

    // Moving Averages & Running Totals — time series → line/area
    { id: 'd_ma_7_rev', category: 'Daily Performance', question: '7-day Moving Average Revenue', req: ['revenue', 'order_date'], grain: 'day', vis: 'line', sql: `...` },
    { id: 'd_run_total_month', category: 'Daily Performance', question: 'Running Total Revenue (MTD)', req: ['revenue', 'order_date'], grain: 'day', vis: 'area', sql: `...` },


    // ╔══════════════════════════════════════════════╗
    // ║  2. WEEKLY PERFORMANCE                       ║
    // ╚══════════════════════════════════════════════╝

    // Core Metrics — single scalar → kpiCard
    { id: 'w_rev', category: 'Weekly Performance', question: 'Revenue this week', req: ['revenue', 'order_date'], grain: 'week', vis: 'kpiCard', sql: `...` },
    { id: 'w_orders', category: 'Weekly Performance', question: 'Orders this week', req: ['order_id', 'order_date'], grain: 'week', vis: 'kpiCard', sql: `...` },
    { id: 'w_aov', category: 'Weekly Performance', question: 'AOV this week', req: ['revenue', 'order_id', 'order_date'], grain: 'week', vis: 'kpiCard', sql: `...` },

    // Week over Week Comparisons — two bars → groupedBar
    { id: 'w_vs_lw_rev', category: 'Weekly Performance', question: 'Revenue vs Last Week', req: ['revenue', 'order_date'], grain: 'week', vis: 'groupedBar', sql: `...` },
    { id: 'w_vs_lw_orders', category: 'Weekly Performance', question: 'Orders vs Last Week', req: ['order_id', 'order_date'], grain: 'week', vis: 'groupedBar', sql: `...` },

    // Growth % — two bars (Current vs Previous) + KPI badge shows % → bar
    { id: 'w_pct_growth_rev', category: 'Weekly Performance', question: 'Weekly Revenue Growth %', req: ['revenue', 'order_date'], grain: 'week', vis: 'bar', sql: `...` },
    { id: 'w_pct_growth_orders', category: 'Weekly Performance', question: 'Weekly Order Growth %', req: ['order_id', 'order_date'], grain: 'week', vis: 'bar', sql: `...` },

    // Percent of Total — shares → doughnut
    { id: 'w_pct_total_channel', category: 'Weekly Performance', question: '% Revenue by Channel (Week)', req: ['source', 'revenue', 'order_date'], grain: 'week', vis: 'doughnut', sql: `...` },

    // Rankings — sorted list → horizontalBar
    { id: 'w_top_prod', category: 'Weekly Performance', question: 'Top selling products this week', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'horizontalBar', sql: `...` },

    // Moving Average — smooth time series → curvedLine
    { id: 'w_ma_4_rev', category: 'Weekly Performance', question: '4-week Moving Average Revenue', req: ['revenue', 'order_date'], grain: 'week', vis: 'curvedLine', sql: `...` },


    // ╔══════════════════════════════════════════════╗
    // ║  3. MONTHLY PERFORMANCE                      ║
    // ╚══════════════════════════════════════════════╝

    // Core Metrics — single scalar → kpiCard
    { id: 'm_rev', category: 'Monthly Performance', question: 'Revenue this month', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: `SELECT SUM(revenue) FROM orders WHERE order_date >= DATE_TRUNC('month', CURRENT_DATE)` },
    { id: 'm_orders', category: 'Monthly Performance', question: 'Orders this month', req: ['order_id', 'order_date'], grain: 'month', vis: 'kpiCard', sql: `SELECT COUNT(DISTINCT order_id) FROM orders WHERE order_date >= DATE_TRUNC('month', CURRENT_DATE)` },
    { id: 'm_aov', category: 'Monthly Performance', question: 'AOV this month', req: ['revenue', 'order_id', 'order_date'], grain: 'month', vis: 'kpiCard', sql: `...` },

    // Month over Month Comparisons — two bars → groupedBar
    { id: 'm_vs_lm_rev', category: 'Monthly Performance', question: 'Revenue vs Last Month', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: `...` },
    { id: 'm_vs_lm_orders', category: 'Monthly Performance', question: 'Orders vs Last Month', req: ['order_id', 'order_date'], grain: 'month', vis: 'groupedBar', sql: `...` },

    // ⏰ Time Intelligence — MTD / PY MTD — single scalar → kpiCard, comparison → groupedBar
    { id: 'm_mtd_rev', category: 'Monthly Performance', question: 'Month-to-Date Revenue', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: `SELECT SUM(revenue) FROM orders WHERE order_date >= DATE_TRUNC('month', CURRENT_DATE) AND order_date <= CURRENT_DATE` },
    { id: 'm_mtd_orders', category: 'Monthly Performance', question: 'Month-to-Date Orders', req: ['order_id', 'order_date'], grain: 'month', vis: 'kpiCard', sql: `SELECT COUNT(DISTINCT order_id) FROM orders WHERE order_date >= DATE_TRUNC('month', CURRENT_DATE) AND order_date <= CURRENT_DATE` },
    { id: 'm_py_mtd_rev', category: 'Monthly Performance', question: 'Same Month Last Year Revenue (PY MTD)', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: `SELECT SUM(revenue) FROM orders WHERE order_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 year') AND order_date <= CURRENT_DATE - INTERVAL '1 year'` },
    { id: 'm_py_mtd_orders', category: 'Monthly Performance', question: 'Same Month Last Year Orders (PY MTD)', req: ['order_id', 'order_date'], grain: 'month', vis: 'kpiCard', sql: `...` },
    { id: 'm_vs_py_mtd_rev', category: 'Monthly Performance', question: 'MTD Revenue vs Same Period Last Year', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: `...` },
    { id: 'm_vs_py_mtd_orders', category: 'Monthly Performance', question: 'MTD Orders vs Same Period Last Year', req: ['order_id', 'order_date'], grain: 'month', vis: 'groupedBar', sql: `...` },

    // Growth % — two bars + KPI badge → bar
    { id: 'm_pct_growth_rev', category: 'Monthly Performance', question: 'MoM Revenue Growth %', req: ['revenue', 'order_date'], grain: 'month', vis: 'bar', sql: `...` },
    { id: 'm_pct_growth_aov', category: 'Monthly Performance', question: 'MoM AOV Growth %', req: ['revenue', 'order_id', 'order_date'], grain: 'month', vis: 'bar', sql: `...` },

    // Percent of Total — shares → treemap
    { id: 'm_pct_total_cat', category: 'Monthly Performance', question: '% Revenue by Category (Month)', req: ['revenue', 'product_name', 'order_date'], grain: 'month', vis: 'treemap', sql: `...` },

    // Rankings — sorted list → horizontalBar
    { id: 'm_top_10_prod', category: 'Monthly Performance', question: 'Top 10 Products (Month)', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'horizontalBar', sql: `...` },
    { id: 'm_top_channel', category: 'Monthly Performance', question: 'Top Marketing Channels (Month)', req: ['source', 'revenue', 'order_date'], grain: 'any', vis: 'horizontalBar', sql: `...` },

    // Trends — time series → line / curvedLine / area
    { id: 'm_ma_3_rev', category: 'Monthly Performance', question: '3-Month Moving Average', req: ['revenue', 'order_date'], grain: 'month', vis: 'curvedLine', sql: `...` },
    { id: 'm_run_total_ytd', category: 'Monthly Performance', question: 'Running Total Revenue (YTD)', req: ['revenue', 'order_date'], grain: 'month', vis: 'area', sql: `...` },
    { id: 'm_trend', category: 'Monthly Performance', question: 'Revenue Trend (Last 12 Months)', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: `...` },


    // ╔══════════════════════════════════════════════╗
    // ║  4. QUARTERLY PERFORMANCE                    ║
    // ╚══════════════════════════════════════════════╝

    // Core Metrics — single scalar → kpiCard
    { id: 'q_rev', category: 'Quarterly Performance', question: 'Revenue this quarter', req: ['revenue', 'order_date'], grain: 'quarter', vis: 'kpiCard', sql: `SELECT SUM(revenue) FROM orders WHERE order_date >= DATE_TRUNC('quarter', CURRENT_DATE)` },
    { id: 'q_orders', category: 'Quarterly Performance', question: 'Orders this quarter', req: ['order_id', 'order_date'], grain: 'quarter', vis: 'kpiCard', sql: `SELECT COUNT(DISTINCT order_id) FROM orders WHERE order_date >= DATE_TRUNC('quarter', CURRENT_DATE)` },
    { id: 'q_aov', category: 'Quarterly Performance', question: 'AOV this quarter', req: ['revenue', 'order_id', 'order_date'], grain: 'quarter', vis: 'kpiCard', sql: `...` },

    // Quarter over Quarter Comparisons
    { id: 'q_vs_lq_rev', category: 'Quarterly Performance', question: 'Revenue vs Last Quarter', req: ['revenue', 'order_date'], grain: 'quarter', vis: 'groupedBar', sql: `...` },
    { id: 'q_vs_lq_orders', category: 'Quarterly Performance', question: 'Orders vs Last Quarter', req: ['order_id', 'order_date'], grain: 'quarter', vis: 'groupedBar', sql: `...` },

    // ⏰ Time Intelligence — QTD / PY QTD
    { id: 'q_qtd_rev', category: 'Quarterly Performance', question: 'Quarter-to-Date Revenue', req: ['revenue', 'order_date'], grain: 'quarter', vis: 'kpiCard', sql: `...` },
    { id: 'q_py_qtd_rev', category: 'Quarterly Performance', question: 'Same Quarter Last Year Revenue (PY QTD)', req: ['revenue', 'order_date'], grain: 'quarter', vis: 'kpiCard', sql: `...` },
    { id: 'q_py_qtd_orders', category: 'Quarterly Performance', question: 'Same Quarter Last Year Orders (PY QTD)', req: ['order_id', 'order_date'], grain: 'quarter', vis: 'kpiCard', sql: `...` },
    { id: 'q_vs_py_qtd_rev', category: 'Quarterly Performance', question: 'QTD Revenue vs Same Quarter Last Year', req: ['revenue', 'order_date'], grain: 'quarter', vis: 'groupedBar', sql: `...` },
    { id: 'q_vs_py_qtd_orders', category: 'Quarterly Performance', question: 'QTD Orders vs Same Quarter Last Year', req: ['order_id', 'order_date'], grain: 'quarter', vis: 'groupedBar', sql: `...` },

    // Growth %
    { id: 'q_pct_growth_rev', category: 'Quarterly Performance', question: 'QoQ Revenue Growth %', req: ['revenue', 'order_date'], grain: 'quarter', vis: 'bar', sql: `...` },

    // Rankings
    { id: 'q_top_prod', category: 'Quarterly Performance', question: 'Top Products this Quarter', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'horizontalBar', sql: `...` },
    { id: 'q_top_channel', category: 'Quarterly Performance', question: 'Top Channels this Quarter', req: ['source', 'revenue', 'order_date'], grain: 'any', vis: 'horizontalBar', sql: `...` },

    // Percent of Total
    { id: 'q_pct_total_prod', category: 'Quarterly Performance', question: '% Revenue by Product (Quarter)', req: ['revenue', 'product_name', 'order_date'], grain: 'quarter', vis: 'treemap', sql: `...` },

    // Trends
    { id: 'q_trend', category: 'Quarterly Performance', question: 'Revenue Trend by Quarter', req: ['revenue', 'order_date'], grain: 'quarter', vis: 'line', sql: `...` },
    { id: 'q_run_total', category: 'Quarterly Performance', question: 'Running Total Revenue (QTD)', req: ['revenue', 'order_date'], grain: 'day', vis: 'area', sql: `...` },


    // ╔══════════════════════════════════════════════╗
    // ║  5. YEARLY PERFORMANCE                       ║
    // ╚══════════════════════════════════════════════╝

    // Core Metrics
    { id: 'ytd_rev', category: 'Yearly Performance', question: 'Year-to-Date Revenue', req: ['revenue', 'order_date'], grain: 'year', vis: 'kpiCard', sql: `...` },
    { id: 'ytd_orders', category: 'Yearly Performance', question: 'Year-to-Date Orders', req: ['order_id', 'order_date'], grain: 'year', vis: 'kpiCard', sql: `...` },
    { id: 'ytd_aov', category: 'Yearly Performance', question: 'Year-to-Date AOV', req: ['revenue', 'order_id', 'order_date'], grain: 'year', vis: 'kpiCard', sql: `...` },

    // Time Intelligence — PY YTD
    { id: 'ytd_py_rev', category: 'Yearly Performance', question: 'Prior Year YTD Revenue', req: ['revenue', 'order_date'], grain: 'year', vis: 'kpiCard', sql: `...` },
    { id: 'ytd_vs_py_ytd_rev', category: 'Yearly Performance', question: 'YTD Revenue vs Prior Year YTD', req: ['revenue', 'order_date'], grain: 'year', vis: 'groupedBar', sql: `...` },
    { id: 'ytd_vs_py_ytd_orders', category: 'Yearly Performance', question: 'YTD Orders vs Prior Year YTD', req: ['order_id', 'order_date'], grain: 'year', vis: 'groupedBar', sql: `...` },

    // Growth %
    { id: 'ytd_pct_growth', category: 'Yearly Performance', question: 'YTD Revenue Growth %', req: ['revenue', 'order_date'], grain: 'year', vis: 'bar', sql: `...` },
    { id: 'ytd_pct_growth_orders', category: 'Yearly Performance', question: 'YTD Order Growth %', req: ['order_id', 'order_date'], grain: 'year', vis: 'bar', sql: `...` },

    // Percent of Total
    { id: 'all_pct_top_10', category: 'Yearly Performance', question: '% Lifetime Revenue from Top 10 Products', req: ['revenue', 'product_name'], grain: 'item', vis: 'treemap', sql: `...` },

    // Rankings
    { id: 'all_best_prod', category: 'Yearly Performance', question: 'Best Selling Products (All Time)', req: ['product_name', 'revenue'], grain: 'item', vis: 'horizontalBar', sql: `...` },
    { id: 'all_top_cust', category: 'Yearly Performance', question: 'Top Customers by Lifetime Value', req: ['customer_name', 'revenue'], grain: 'customer', vis: 'table', sql: `...` },

    // Trends
    { id: 'all_ma_12_rev', category: 'Yearly Performance', question: '12-Month Rolling Revenue', req: ['revenue', 'order_date'], grain: 'month', vis: 'curvedLine', sql: `...` },
    { id: 'all_run_total', category: 'Yearly Performance', question: 'Lifetime Revenue Running Total', req: ['revenue', 'order_date'], grain: 'any', vis: 'area', sql: `...` },


    // ╔══════════════════════════════════════════════╗
    // ║  6. OPERATIONAL                              ║
    // ╚══════════════════════════════════════════════╝

    { id: 'op_track_vs_y', category: 'Operational', question: 'On Track vs Yesterday?', req: ['revenue', 'order_date'], grain: 'day', vis: 'kpiCard', sql: `SELECT CASE WHEN (SELECT SUM(revenue) FROM orders WHERE order_date = CURRENT_DATE) > (SELECT SUM(revenue) FROM orders WHERE order_date = CURRENT_DATE - 1) THEN 'Ahead' ELSE 'Behind' END` },
    { id: 'op_target', category: 'Operational', question: 'Daily Target Achievement', req: ['revenue', 'order_date'], grain: 'day', vis: 'gauge', sql: `SELECT SUM(revenue) / 5000.0 * 100 as pct_target FROM orders WHERE order_date = CURRENT_DATE` },
    { id: 'op_losing_mo', category: 'Operational', question: 'Products Losing Momentum (WoW)', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'table', sql: `SELECT product_name, (SUM(revenue) FILTER(WHERE date >= date('now', '-7 days')) - SUM(revenue) FILTER(WHERE date BETWEEN date('now', '-14 days') AND date('now', '-7 days'))) as diff FROM order_items GROUP BY 1 ORDER BY 2 ASC LIMIT 5` },
    { id: 'op_gaining_share', category: 'Operational', question: 'Channels Gaining Share (WoW)', req: ['source', 'revenue', 'order_date'], grain: 'any', vis: 'table', sql: `SELECT source, (SUM(revenue) FILTER(WHERE date >= date('now', '-7 days')) - SUM(revenue) FILTER(WHERE date BETWEEN date('now', '-14 days') AND date('now', '-7 days'))) as diff FROM orders GROUP BY 1 ORDER BY 2 DESC LIMIT 5` },

    // Rolling Windows & Other
    { id: 'rev_30d', category: 'Operational', question: 'Revenue Last 30 Days', req: ['revenue', 'order_date'], grain: 'day', vis: 'area', sql: `SELECT DATE(order_date), SUM(revenue) FROM orders WHERE order_date >= CURRENT_DATE - INTERVAL '30 days' GROUP BY 1 ORDER BY 1` },
    { id: 'mkt_source', category: 'Operational', question: 'Revenue by Traffic Source', req: ['source', 'revenue'], grain: 'any', vis: 'doughnut', sql: `SELECT source, SUM(revenue) FROM orders GROUP BY 1 ORDER BY 2 DESC` },
    { id: 'cust_new', category: 'Operational', question: 'New Customers Today', req: ['customer_id', 'order_date'], grain: 'customer', vis: 'kpiCard', sql: `SELECT COUNT(DISTINCT customer_id) FROM orders \nWHERE order_date = CURRENT_DATE \nAND customer_id NOT IN (SELECT customer_id FROM orders WHERE order_date < CURRENT_DATE)` },
    { id: 'top_10_prod', category: 'Operational', question: 'Top 10 Products (All Time)', req: ['product_name', 'revenue'], grain: 'item', vis: 'horizontalBar', sql: `SELECT product_name, SUM(revenue) FROM order_items GROUP BY 1 ORDER BY 2 DESC LIMIT 10` },


    // ╔══════════════════════════════════════════════╗
    // ║  7. REVENUE DIAGNOSTICS                      ║
    // ╚══════════════════════════════════════════════╝

    { id: 'diag_drop_vs_y', category: 'Revenue Diagnostics', question: 'Why did sales drop yesterday?', req: ['revenue', 'order_date'], grain: 'day', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'diag_vs_lw', category: 'Revenue Diagnostics', question: 'Why are we down compared to last week?', req: ['revenue', 'order_date'], grain: 'week', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'diag_today_slow', category: 'Revenue Diagnostics', question: 'Why is today slower than usual?', req: ['revenue', 'order_date'], grain: 'day', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'diag_dip_normal', category: 'Revenue Diagnostics', question: 'Is this dip normal or something broke?', req: ['revenue', 'order_date'], grain: 'day', vis: 'line', sql: `...`, evalType: 'trend' },
    { id: 'diag_conv_drop', category: 'Revenue Diagnostics', question: 'Did conversion rate drop?', req: ['order_id', 'customer_id', 'order_date'], grain: 'day', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'diag_aov_lower', category: 'Revenue Diagnostics', question: 'Is AOV lower?', req: ['revenue', 'order_id', 'order_date'], grain: 'day', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'diag_prod_drag', category: 'Revenue Diagnostics', question: 'Is one product dragging everything down?', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'diag_rev_trending', category: 'Revenue Diagnostics', question: 'Is revenue trending down overall?', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: `...`, evalType: 'trend' },
    { id: 'diag_weekend', category: 'Revenue Diagnostics', question: 'Is this just weekend behavior?', req: ['revenue', 'order_date'], grain: 'day', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'diag_repeat_lost', category: 'Revenue Diagnostics', question: 'Did we lose returning customers?', req: ['customer_id', 'order_date'], grain: 'day', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },


    // ╔══════════════════════════════════════════════╗
    // ║  8. GROWTH & MOMENTUM                        ║
    // ╚══════════════════════════════════════════════╝

    { id: 'grow_vs_lm', category: 'Growth & Momentum', question: 'Are we actually growing or just fluctuating?', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: `...`, evalType: 'trend' },
    { id: 'grow_sustainable', category: 'Growth & Momentum', question: 'Is this growth sustainable?', req: ['revenue', 'order_date'], grain: 'month', vis: 'curvedLine', sql: `...`, evalType: 'trend' },
    { id: 'grow_fastest_prod', category: 'Growth & Momentum', question: 'Which product is growing fastest?', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'grow_channel_scale', category: 'Growth & Momentum', question: 'Which channel is scaling?', req: ['source', 'revenue', 'order_date'], grain: 'any', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'grow_repeat_cust', category: 'Growth & Momentum', question: 'Are repeat customers increasing?', req: ['customer_id', 'order_date'], grain: 'month', vis: 'line', sql: `...`, evalType: 'trend' },
    { id: 'grow_more_per_order', category: 'Growth & Momentum', question: 'Are customers buying more per order?', req: ['revenue', 'order_id', 'order_date'], grain: 'month', vis: 'line', sql: `...`, evalType: 'trend' },
    { id: 'grow_acq_accel', category: 'Growth & Momentum', question: 'Is customer acquisition accelerating?', req: ['customer_id', 'order_date'], grain: 'month', vis: 'line', sql: `...`, evalType: 'trend' },
    { id: 'grow_trending_up', category: 'Growth & Momentum', question: 'What\'s trending upward right now?', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: `...`, evalType: 'trend' },
    { id: 'grow_best_campaign', category: 'Growth & Momentum', question: 'Which campaign gave us the biggest lift?', req: ['source', 'revenue', 'order_date'], grain: 'any', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'grow_mom_rev', category: 'Growth & Momentum', question: 'Month over month revenue growth', req: ['revenue', 'order_date'], grain: 'month', vis: 'bar', sql: `...`, evalType: 'comparison' },


    // ╔══════════════════════════════════════════════╗
    // ║  9. PRODUCTS & INVENTORY                     ║
    // ╚══════════════════════════════════════════════╝

    { id: 'prod_losing_mo', category: 'Products & Inventory', question: 'Which product is losing momentum?', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'table', sql: `...`, evalType: 'ranking' },
    { id: 'prod_carrying_rev', category: 'Products & Inventory', question: 'Which product is carrying revenue?', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'prod_top_5_rev', category: 'Products & Inventory', question: 'Top 5 revenue contributors', req: ['product_name', 'revenue'], grain: 'item', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'prod_worst', category: 'Products & Inventory', question: 'Worst performing product', req: ['product_name', 'revenue'], grain: 'item', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'prod_best_convert', category: 'Products & Inventory', question: 'Which products convert best?', req: ['product_name', 'order_id', 'order_date'], grain: 'item', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'prod_pct_rev', category: 'Products & Inventory', question: 'Revenue share by product', req: ['revenue', 'product_name'], grain: 'item', vis: 'doughnut', sql: `...`, evalType: 'percentOfTotal' },
    { id: 'prod_top_10_month', category: 'Products & Inventory', question: 'Top 10 products this month', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'prod_top_10_week', category: 'Products & Inventory', question: 'Top 10 products this week', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'prod_bottom_5', category: 'Products & Inventory', question: 'Bottom 5 products by revenue', req: ['product_name', 'revenue'], grain: 'item', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'prod_new_perf', category: 'Products & Inventory', question: 'Are new products working?', req: ['product_name', 'revenue', 'order_date'], grain: 'item', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },


    // ╔══════════════════════════════════════════════╗
    // ║  10. CHANNELS & MARKETING                    ║
    // ╚══════════════════════════════════════════════╝

    { id: 'ch_top_channel', category: 'Channels & Marketing', question: 'Which ad channel is actually profitable?', req: ['source', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'ch_best_roas', category: 'Channels & Marketing', question: 'Which campaign has best ROAS?', req: ['source', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'ch_paid_converting', category: 'Channels & Marketing', question: 'Is paid traffic converting?', req: ['source', 'order_id', 'order_date'], grain: 'any', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'ch_organic_vs_paid', category: 'Channels & Marketing', question: 'Is organic outperforming paid?', req: ['source', 'revenue', 'order_date'], grain: 'any', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'ch_repeat_buyers', category: 'Channels & Marketing', question: 'Which channel drives repeat buyers?', req: ['source', 'customer_id', 'order_date'], grain: 'any', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'ch_rev_by_source', category: 'Channels & Marketing', question: 'Revenue breakdown by channel', req: ['source', 'revenue'], grain: 'any', vis: 'doughnut', sql: `...`, evalType: 'percentOfTotal' },
    { id: 'ch_best_aov', category: 'Channels & Marketing', question: 'Which traffic source has best AOV?', req: ['source', 'revenue', 'order_id'], grain: 'any', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'ch_week_trend', category: 'Channels & Marketing', question: 'Channel performance this week vs last', req: ['source', 'revenue', 'order_date'], grain: 'week', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },


    // ╔══════════════════════════════════════════════╗
    // ║  11. CUSTOMER INTELLIGENCE                   ║
    // ╚══════════════════════════════════════════════╝

    { id: 'cust_new_vs_repeat', category: 'Customer Intelligence', question: 'Are we getting new customers or just repeat buyers?', req: ['customer_id', 'order_date'], grain: 'month', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'cust_top_spenders', category: 'Customer Intelligence', question: 'Which segment spends most?', req: ['customer_name', 'revenue'], grain: 'customer', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'cust_ltv', category: 'Customer Intelligence', question: 'What\'s our customer lifetime value?', req: ['customer_id', 'revenue'], grain: 'customer', vis: 'kpiCard', sql: `...`, evalType: 'kpi' },
    { id: 'cust_top_country', category: 'Customer Intelligence', question: 'Which country buys the most?', req: ['customer_name', 'revenue'], grain: 'customer', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'cust_count_today', category: 'Customer Intelligence', question: 'How many customers bought today?', req: ['customer_id', 'order_date'], grain: 'day', vis: 'kpiCard', sql: `...`, evalType: 'kpi' },
    { id: 'cust_count_month', category: 'Customer Intelligence', question: 'Total customers this month', req: ['customer_id', 'order_date'], grain: 'month', vis: 'kpiCard', sql: `...`, evalType: 'kpi' },
    { id: 'cust_trend', category: 'Customer Intelligence', question: 'Customer count trend (monthly)', req: ['customer_id', 'order_date'], grain: 'month', vis: 'line', sql: `...`, evalType: 'trend' },
    { id: 'cust_top_10', category: 'Customer Intelligence', question: 'Top 10 customers by revenue', req: ['customer_name', 'revenue'], grain: 'customer', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },


    // ╔══════════════════════════════════════════════╗
    // ║  12. PROFIT & MARGINS                        ║
    // ╚══════════════════════════════════════════════╝

    { id: 'profit_rev_month', category: 'Profit & Margins', question: 'Are we actually profitable?', req: ['revenue', 'order_date'], grain: 'month', vis: 'kpiCard', sql: `...`, evalType: 'kpi' },
    { id: 'profit_trend', category: 'Profit & Margins', question: 'Revenue trend (profitability proxy)', req: ['revenue', 'order_date'], grain: 'month', vis: 'line', sql: `...`, evalType: 'trend' },
    { id: 'profit_top_prod', category: 'Profit & Margins', question: 'Which product has highest revenue?', req: ['product_name', 'revenue'], grain: 'item', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'profit_per_channel', category: 'Profit & Margins', question: 'Revenue per channel', req: ['source', 'revenue'], grain: 'any', vis: 'horizontalBar', sql: `...`, evalType: 'ranking' },
    { id: 'profit_vs_lm', category: 'Profit & Margins', question: 'Revenue this month vs last (margin proxy)', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'profit_scaling', category: 'Profit & Margins', question: 'Are we scaling revenue or just maintaining?', req: ['revenue', 'order_date'], grain: 'month', vis: 'curvedLine', sql: `...`, evalType: 'trend' },


    // ╔══════════════════════════════════════════════╗
    // ║  13. TIME & COMPARISONS                      ║
    // ╚══════════════════════════════════════════════╝

    { id: 'time_vs_lm', category: 'Time & Comparisons', question: 'How are we doing compared to last month?', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'time_wow_same', category: 'Time & Comparisons', question: 'How does this week compare to same week last year?', req: ['revenue', 'order_date'], grain: 'week', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'time_daily_trend', category: 'Time & Comparisons', question: 'What\'s our daily sales trend?', req: ['revenue', 'order_date'], grain: 'day', vis: 'line', sql: `...`, evalType: 'trend' },
    { id: 'time_monthly_target', category: 'Time & Comparisons', question: 'Are we hitting our monthly target?', req: ['revenue', 'order_date'], grain: 'month', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'time_quarter_goal', category: 'Time & Comparisons', question: 'Are we on track for quarter goals?', req: ['revenue', 'order_date'], grain: 'quarter', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'time_weekday_vs_weekend', category: 'Time & Comparisons', question: 'Are weekends stronger than weekdays?', req: ['revenue', 'order_date'], grain: 'day', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'time_yoy_rev', category: 'Time & Comparisons', question: 'Year over year revenue comparison', req: ['revenue', 'order_date'], grain: 'year', vis: 'groupedBar', sql: `...`, evalType: 'comparison' },
    { id: 'time_rev_30d_trend', category: 'Time & Comparisons', question: 'Revenue trend last 30 days', req: ['revenue', 'order_date'], grain: 'day', vis: 'area', sql: `...`, evalType: 'trend' },
];

// --- Ordered Category Bank ---
const CATEGORY_ORDER = [
    'Daily Performance',
    'Weekly Performance',
    'Monthly Performance',
    'Quarterly Performance',
    'Yearly Performance',
    'Operational',
    'Revenue Diagnostics',
    'Growth & Momentum',
    'Products & Inventory',
    'Channels & Marketing',
    'Customer Intelligence',
    'Profit & Margins',
    'Time & Comparisons',
];

// --- Load custom questions from localStorage ---
const CUSTOM_QUESTIONS_KEY = 'astrabi_custom_questions';

export const loadCustomQuestions = (): QuestionTemplate[] => {
    try {
        const raw = localStorage.getItem(CUSTOM_QUESTIONS_KEY);
        if (!raw) return [];
        return JSON.parse(raw);
    } catch { return []; }
};

export const saveCustomQuestion = (q: QuestionTemplate): void => {
    const existing = loadCustomQuestions();
    const idx = existing.findIndex(e => e.id === q.id);
    if (idx >= 0) existing[idx] = q;
    else existing.push(q);
    localStorage.setItem(CUSTOM_QUESTIONS_KEY, JSON.stringify(existing));
};

export const deleteCustomQuestion = (id: string): void => {
    const existing = loadCustomQuestions().filter(q => q.id !== id);
    localStorage.setItem(CUSTOM_QUESTIONS_KEY, JSON.stringify(existing));
};

export const exportCustomQuestions = (): string => {
    return JSON.stringify(loadCustomQuestions(), null, 2);
};

export const importCustomQuestions = (json: string): { success: boolean; count: number; error?: string } => {
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) return { success: false, count: 0, error: 'Invalid format: expected an array' };
        const validated = parsed.filter((q: any) => q.id && q.category && q.question && q.req && q.grain && q.vis);
        localStorage.setItem(CUSTOM_QUESTIONS_KEY, JSON.stringify(validated));
        return { success: true, count: validated.length };
    } catch (e) {
        return { success: false, count: 0, error: String(e) };
    }
};

// --- Build the full merged registry ---
export const getFullRegistry = (): QuestionTemplate[] => {
    return [...QUESTION_REGISTRY, ...loadCustomQuestions()];
};

export const QUESTION_BANK = CATEGORY_ORDER.map(cat => {
    const allQuestions = getFullRegistry();
    const questions = allQuestions
        .filter(q => q.category === cat)
        .map(q => ({ label: q.question, intent: { questionId: q.id } }));
    return { category: cat, questions };
}).filter(c => c.questions.length > 0);

// Also include any custom categories not in CATEGORY_ORDER
export const getFullQuestionBank = () => {
    const allQuestions = getFullRegistry();
    const allCategories = [...new Set(allQuestions.map(q => q.category))];
    const orderedCategories = [
        ...CATEGORY_ORDER,
        ...allCategories.filter(c => !CATEGORY_ORDER.includes(c))
    ];
    return orderedCategories.map(cat => {
        const questions = allQuestions
            .filter(q => q.category === cat)
            .map(q => ({ label: q.question, intent: { questionId: q.id } }));
        return { category: cat, questions };
    }).filter(c => c.questions.length > 0);
};
