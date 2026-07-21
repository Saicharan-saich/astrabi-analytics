/**
 * Deterministic parameter catalog — the admin-facing map of what AI SQL can
 * answer through the hardened Question Builder engine (no LLM SQL) versus what
 * still routes to the AI SQL engine.
 *
 * This is documentation that mirrors services/ai-sql/qbMapper.ts. When you add a
 * knob to the mapper, add it here too so the Parameters page stays truthful.
 */

export interface KnobDoc {
    /** Knob name. */
    name: string;
    /** A natural-language question a user would ask. */
    example: string;
    /** The SQL shape the deterministic engine emits. */
    sqlShape: string;
    /** Grouping for display. */
    group: 'Aggregation' | 'Group-by' | 'Filter' | 'Shape' | 'Ordering';
}

export interface FallbackDoc {
    name: string;
    example: string;
    /** Why the builder has no knob for it (yet) — the honest reason. */
    reason: string;
    /** 'engine' = needs new builder capability; 'wip' = builder can do it but the
     *  wiring is deliberate follow-up work. */
    kind: 'engine-gap' | 'wip';
}

/** Everything the deterministic Question Builder engine can answer today. */
export const DETERMINISTIC_KNOBS: KnobDoc[] = [
    { group: 'Aggregation', name: 'Sum / Average / Min / Max', example: 'What is the total revenue?', sqlShape: 'SELECT SUM(total_price) FROM data' },
    { group: 'Aggregation', name: 'Count', example: 'How many orders are there?', sqlShape: 'SELECT COUNT(*) FROM data' },
    { group: 'Aggregation', name: 'Count distinct', example: 'How many distinct customers ordered?', sqlShape: 'SELECT COUNT(DISTINCT customer_id) FROM data' },
    { group: 'Aggregation', name: 'Multiple metrics', example: 'Total revenue and total quantity by channel', sqlShape: 'SELECT channel, SUM(total_price), SUM(quantity) … GROUP BY channel' },

    { group: 'Group-by', name: 'By category (dimension)', example: 'Revenue by channel', sqlShape: 'SELECT channel, SUM(total_price) … GROUP BY channel' },
    { group: 'Group-by', name: 'By time grain', example: 'Revenue by month', sqlShape: "… GROUP BY DATE_TRUNC('month', order_date)" },
    { group: 'Group-by', name: 'Two dimensions', example: 'Revenue by channel and category', sqlShape: '… GROUP BY channel, category' },

    { group: 'Filter', name: 'Equals / in', example: 'Total revenue from Delivery orders', sqlShape: "WHERE channel IN ('Delivery')" },
    { group: 'Filter', name: 'Exclude (≠ / not in)', example: 'Revenue excluding Online orders', sqlShape: "WHERE channel NOT IN ('Online')" },
    { group: 'Filter', name: 'Date range', example: 'Revenue between two dates', sqlShape: 'WHERE order_date::TIMESTAMP BETWEEN … AND …' },
    { group: 'Filter', name: 'Relative date', example: 'Revenue this month', sqlShape: 'WHERE order_date IN (this month)' },
    { group: 'Filter', name: 'Above / below average', example: 'How many orders are above the average order value?', sqlShape: 'WHERE total_price > (SELECT AVG(total_price) FROM data)' },
    { group: 'Filter', name: 'Post-aggregate threshold (HAVING)', example: 'Channels with revenue over 10,000', sqlShape: 'HAVING SUM(total_price) > 10000' },

    { group: 'Shape', name: 'Top-N / ranking', example: 'Top 5 products by revenue', sqlShape: '… ORDER BY SUM(total_price) DESC LIMIT 5' },
    { group: 'Shape', name: 'Share of total', example: 'What share of revenue does each channel represent?', sqlShape: 'each group ÷ grand total × 100 (% of total)' },
    { group: 'Shape', name: 'Trend over time', example: 'Revenue by month over time', sqlShape: 'time bucket + growth / running total (post-SQL)' },

    { group: 'Ordering', name: 'Sort ascending / descending', example: 'Channels from highest to lowest revenue', sqlShape: 'ORDER BY … DESC' },
    { group: 'Ordering', name: 'Limit', example: 'Show the top 3', sqlShape: 'LIMIT 3' },
];

/** Shapes that still route to the AI SQL engine, with the honest reason. */
export const AI_ROUTED_SHAPES: FallbackDoc[] = [
    { kind: 'wip', name: 'Period comparison', example: 'Revenue this month vs last month', reason: 'The builder has a comparison option, but it rides the post-SQL time-intelligence engine; wiring the builder to own it needs careful de-duplication so growth is not double-counted.' },
    { kind: 'wip', name: 'Growth ranking', example: 'Which products are growing fastest?', reason: 'Built from period comparison + rank; same time-intelligence de-duplication as above.' },
    { kind: 'engine-gap', name: 'Grouped above-average', example: 'Clients billed above the average client', reason: 'Compares a group total to the average of group totals — a nested two-stage query the builder has no knob for.' },
    { kind: 'engine-gap', name: 'Correlation / scatter', example: 'Sales vs profit per order', reason: 'Two raw metrics per row without aggregation; the builder is aggregation-oriented.' },
    { kind: 'engine-gap', name: 'Distribution / histogram', example: 'Distribution of order values', reason: 'Needs value binning; there is no bucket knob.' },
    { kind: 'engine-gap', name: 'Two-stage derived metric', example: 'Average daily sales', reason: 'Aggregate of an aggregate (average of per-day sums) — a second aggregation stage.' },
    { kind: 'engine-gap', name: 'Text contains (LIKE)', example: 'Products whose name contains "Pro"', reason: 'No substring/text-match filter knob.' },
    { kind: 'engine-gap', name: 'Set / anti-join logic', example: 'Customers who bought A but never B', reason: 'Requires NOT EXISTS / relational logic across the grouped set.' },
];

export const DETERMINISTIC_COUNT = DETERMINISTIC_KNOBS.length;
export const AI_ROUTED_COUNT = AI_ROUTED_SHAPES.length;
