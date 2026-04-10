import { Dataset, ColumnType, AggregationType, TimeGrain } from '../types';

export interface NLQParseResult {
    metric: string;
    dimension: string;
    aggregation: AggregationType;
    timeGrain: TimeGrain;
    timeFilter?: string;
    filters: Record<string, string[]>;
    measureFilters: { column: string; operator: string; value: number }[];
    dateFilters: { column: string; timeGrain: string; values: string[] }[];
    limit?: number;
    sort?: 'desc' | 'asc' | 'oldest' | 'newest';
    confidence: number;
    explanation: string[];
    tableCalculations: string[];  // detected table calcs: 'running_total', 'percent_of_total', etc.
    movingAvgWindow?: number;     // window size for moving average (extracted from query like '4 week moving average')
    comparison?: {
        type: 'period_vs_period';
        periodA: string;   // time filter key for first period, e.g. 'this_week'
        periodB: string;   // time filter key for second period, e.g. 'last_7_days'
        labelA: string;    // display label, e.g. 'This Week'
        labelB: string;    // e.g. 'Last Week'
    };
    derivedMetric?: {
        id: string;          // e.g. 'aov', 'margin'
        label: string;       // 'Average Order Value'
        numerator: string;   // column role e.g. 'revenue'
        denominator: string; // column role e.g. 'order_id'
        isCount?: boolean;   // true = COUNT(DISTINCT denom) instead of SUM
        multiply?: number;   // e.g. 100 for percentage result
    };
    havingFilter?: {
        operator: '>' | '<' | '>=' | '<=';
        value: number;
    };
    excludeFilters: Record<string, string[]>;
    secondDimension?: string;
    secondaryMetrics?: string[]; // Additional metrics detected (e.g., "sales and profit" → secondary: ['profit'])
}

// ─── STOP WORDS ──────────────────────────────────────────────
// Words that should NEVER be matched to column names
const STOP_WORDS = new Set([
    'show', 'me', 'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to',
    'for', 'with', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
    'should', 'may', 'might', 'can', 'could', 'must', 'not', 'no', 'nor',
    'but', 'yet', 'so', 'if', 'then', 'else', 'when', 'where', 'how',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'my', 'your', 'our', 'their', 'its', 'all', 'each', 'every', 'both',
    'give', 'get', 'got', 'make', 'see', 'look', 'find', 'tell', 'let',
    'per', 'by', 'also', 'just', 'only', 'very', 'really', 'please',
    'chart', 'graph', 'table', 'display', 'visualize', 'plot', 'draw',
    'wise', 'based', 'over', 'time', 'trend', 'breakdown', 'compare',
    'data', 'result', 'results', 'report', 'analysis', 'view',
]);

// ─── COLUMN SYNONYM MAP ─────────────────────────────────────
// Maps common English words to possible column name variations.
// When a user says "sales", we also try to match columns named
// "revenue", "amount", "total_sales", etc.
const COLUMN_SYNONYMS: Record<string, string[]> = {
    // Revenue / Sales
    'sales': ['revenue', 'sales', 'amount', 'total sales', 'total amount', 'gross', 'income', 'turnover', 'proceeds', 'earning', 'earnings'],
    'revenue': ['revenue', 'sales', 'amount', 'total sales', 'total amount', 'gross', 'income', 'turnover'],
    'income': ['revenue', 'income', 'sales', 'earnings', 'amount'],
    'turnover': ['revenue', 'turnover', 'sales', 'amount'],
    'earning': ['revenue', 'earnings', 'profit', 'income'],
    'earnings': ['revenue', 'earnings', 'profit', 'income'],
    'money': ['revenue', 'amount', 'sales', 'price', 'cost'],
    // Profit
    'profit': ['profit', 'margin', 'net', 'net revenue', 'gross profit', 'earnings', 'net income'],
    'margin': ['profit', 'margin', 'gross margin', 'net margin'],
    'net': ['profit', 'net', 'net revenue', 'net income'],
    // Orders
    'orders': ['order', 'orders', 'order id', 'transaction', 'transactions', 'purchase'],
    'order': ['order', 'orders', 'order id', 'transaction'],
    'transactions': ['order', 'orders', 'transaction', 'transactions'],
    'purchases': ['order', 'orders', 'purchase', 'purchases'],
    // Quantity
    'units': ['quantity', 'qty', 'units', 'unit', 'items', 'volume', 'pieces'],
    'quantity': ['quantity', 'qty', 'units', 'volume'],
    'items': ['quantity', 'items', 'units', 'line items'],
    'volume': ['quantity', 'volume', 'units'],
    // Price/Cost
    'price': ['price', 'unit price', 'cost', 'amount', 'rate'],
    'cost': ['cost', 'price', 'expense', 'cogs'],
    'discount': ['discount', 'savings', 'rebate'],
    // Customers
    'customers': ['customer', 'customers', 'customer id', 'client', 'buyer', 'user'],
    'customer': ['customer', 'customers', 'customer id', 'client', 'buyer'],
    'clients': ['customer', 'client', 'clients'],
    'buyers': ['customer', 'buyer', 'buyers'],
    // Dimensions - Geography
    'region': ['region', 'regions', 'area', 'territory', 'zone', 'location', 'geo', 'geography', 'state', 'country', 'city'],
    'location': ['region', 'location', 'city', 'state', 'country', 'address', 'area'],
    'city': ['city', 'location', 'region', 'metro'],
    'state': ['state', 'region', 'province', 'location'],
    'country': ['country', 'region', 'nation', 'location'],
    'area': ['region', 'area', 'territory', 'zone'],
    // Dimensions - Product
    'product': ['product', 'products', 'product name', 'item', 'items', 'sku', 'merchandise', 'goods'],
    'products': ['product', 'products', 'product name', 'item'],
    'item': ['product', 'item', 'items', 'product name', 'sku'],
    'sku': ['sku', 'product', 'item', 'product id'],
    // Dimensions - Category
    'category': ['category', 'categories', 'type', 'segment', 'group', 'class', 'product category', 'sub category'],
    'segment': ['segment', 'category', 'type', 'group'],
    'type': ['type', 'category', 'segment', 'kind'],
    'group': ['group', 'category', 'segment', 'class'],
    // Dimensions - Channel/Source
    'channel': ['channel', 'source', 'traffic source', 'medium', 'platform', 'marketing channel', 'origin'],
    'source': ['source', 'channel', 'traffic source', 'origin', 'medium'],
    'platform': ['platform', 'channel', 'source', 'medium'],
    // Dimensions - Other
    'brand': ['brand', 'manufacturer', 'vendor', 'supplier', 'maker'],
    'supplier': ['supplier', 'vendor', 'manufacturer', 'brand'],
    'vendor': ['vendor', 'supplier', 'manufacturer'],
    'department': ['department', 'dept', 'division', 'team'],
    'status': ['status', 'state', 'condition', 'stage'],
    'priority': ['priority', 'urgency', 'importance', 'level'],
    'shipping': ['shipping', 'ship mode', 'delivery', 'fulfillment', 'shipment'],
    'payment': ['payment', 'payment method', 'pay', 'billing'],
    // Date
    'date': ['date', 'order date', 'created', 'timestamp', 'day', 'created at'],
};

/**
 * Expands a user token into synonyms that might match column names.
 * e.g., 'sales' → ['sales', 'revenue', 'amount', ...]
 */
const expandWithSynonyms = (token: string): string[] => {
    const expanded = [token];
    if (COLUMN_SYNONYMS[token]) {
        expanded.push(...COLUMN_SYNONYMS[token]);
    }
    return [...new Set(expanded)];
};

// ─── AGGREGATION KEYWORDS ────────────────────────────────────
// NOTE: 'highest' and 'lowest' are NOT here — they are ranking signals,
// not aggregation. "Which product has highest sales" = SUM + sort desc + limit 1,
// NOT MAX(sales). Handling is in Step 10e below.
const AGG_KEYWORDS: Record<string, AggregationType> = {
    'total': AggregationType.SUM,
    'sum': AggregationType.SUM,
    'average': AggregationType.AVG,
    'avg': AggregationType.AVG,
    'mean': AggregationType.AVG,
    'count': AggregationType.COUNT,
    'number': AggregationType.COUNT,
    'maximum': AggregationType.MAX,
    'max': AggregationType.MAX,
    'minimum': AggregationType.MIN,
    'min': AggregationType.MIN,
};

// ─── TABLE CALCULATION PATTERNS ──────────────────────────────
// Detects table calculation keywords in user queries
const TABLE_CALC_PATTERNS: { calc: string; regex: RegExp; label: string }[] = [
    { calc: 'running_total', regex: /\b(?:running\s*total|cumulative|running\s*sum|accumulated|progressive\s*total|cum(?:ulative)?\s*(?:sum|total))\b/, label: 'Running Total' },
    { calc: 'percent_of_total', regex: /(?:^|\s|%)(?:%\s*of\s*total|percent(?:age)?\s*of\s*total|share\s*of\s*total|proportion|pct\s*of\s*total|as\s*(?:a\s*)?%|as\s*percent|contribution|share|breakdown|mix|split|composition)\b/, label: '% of Total' },
    { calc: 'rank_desc', regex: /\b(?:rank(?:ing|ed)?|top\s*rank|best\s*to\s*worst|rank\s*(?:by|from)\s*(?:high|top|best))\b/, label: 'Rank (Descending)' },
    { calc: 'rank_asc', regex: /\b(?:rank\s*(?:asc|ascending|low(?:est)?\s*to\s*high(?:est)?|bottom\s*up|worst\s*to\s*best))\b/, label: 'Rank (Ascending)' },
    { calc: 'moving_avg', regex: /\b(?:moving\s*average|rolling\s*average|rolling\s*avg|moving\s*avg|smoothed|moving\s*mean|rolling\s*mean)\b/, label: 'Moving Average' },
    { calc: 'pct_diff_from_prev', regex: /(?:^|\s|%)(?:%\s*(?:change|diff(?:erence)?)|percent(?:age)?\s*(?:change|diff(?:erence)?)|pct\s*(?:change|diff)|growth\s*rate|rate\s*of\s*change)\b/, label: '% Change from Previous' },
    { calc: 'diff_from_prev', regex: /\b(?:diff(?:erence)?\s*(?:from|vs|versus)?\s*prev(?:ious)?|change\s*from\s*prev(?:ious)?|absolute\s*(?:change|diff(?:erence)?)|delta)\b/, label: 'Difference from Previous' },
    { calc: 'percentile', regex: /\b(?:percentile|p(?:50|75|90|95|99)|stat(?:istical)?\s*percentile)\b/, label: 'Percentile' },
];

// ─── DERIVED METRIC PATTERNS ─────────────────────────────────
// Maps common business terms to computed formulas
const DERIVED_METRICS: { regex: RegExp; id: string; label: string; numerator: string; denominator: string; isCount?: boolean; multiply?: number }[] = [
    { regex: /\b(?:aov|average\s+order\s+value)\b/, id: 'aov', label: 'Average Order Value', numerator: 'revenue', denominator: 'order_id', isCount: true },
    { regex: /\b(?:profit\s+margin|margin\s*%?)\b/, id: 'margin', label: 'Profit Margin %', numerator: 'profit', denominator: 'revenue', multiply: 100 },
    { regex: /\b(?:revenue\s+per\s+unit|price\s+per\s+(?:unit|item)|sales\s+per\s+unit)\b/, id: 'rev_per_unit', label: 'Revenue per Unit', numerator: 'revenue', denominator: 'quantity' },
    { regex: /\b(?:cost\s+per\s+order)\b/, id: 'cost_per_order', label: 'Cost per Order', numerator: 'cost', denominator: 'order_id', isCount: true },
    { regex: /\b(?:units?\s+per\s+order|items?\s+per\s+order)\b/, id: 'units_per_order', label: 'Units per Order', numerator: 'quantity', denominator: 'order_id', isCount: true },
    { regex: /\b(?:discount\s+(?:rate|%|percent(?:age)?))\b/, id: 'discount_rate', label: 'Discount Rate %', numerator: 'discount', denominator: 'revenue', multiply: 100 },
];

// ─── TIME INTELLIGENCE SHORTCUTS ─────────────────────────────
const TIME_INTELLIGENCE: { regex: RegExp; comparison?: { periodA: string; periodB: string; labelA: string; labelB: string }; timeFilter?: string }[] = [
    { regex: /\b(?:yoy|year\s+over\s+year)\b/, comparison: { periodA: 'this_year', periodB: 'last_year', labelA: 'This Year', labelB: 'Last Year' } },
    { regex: /\b(?:mom|month\s+over\s+month)\b/, comparison: { periodA: 'this_month', periodB: 'last_30_days', labelA: 'This Month', labelB: 'Last Month' } },
    { regex: /\b(?:wow|week\s+over\s+week)\b/, comparison: { periodA: 'this_week', periodB: 'last_7_days', labelA: 'This Week', labelB: 'Last Week' } },
    { regex: /\b(?:qoq|quarter\s+over\s+quarter)\b/, comparison: { periodA: 'this_quarter', periodB: 'last_90_days', labelA: 'This Quarter', labelB: 'Last Quarter' } },
    { regex: /\b(?:mtd|month\s+to\s+date)\b/, timeFilter: 'this_month' },
    { regex: /\b(?:ytd|year\s+to\s+date)\b/, timeFilter: 'this_year' },
    { regex: /\b(?:qtd|quarter\s+to\s+date)\b/, timeFilter: 'this_quarter' },
];

// ─── TIME GRAIN PATTERNS ─────────────────────────────────────
// Ordered from most specific to least; first match wins
const GRAIN_PATTERNS: { grain: string; regex: RegExp }[] = [
    { grain: 'day', regex: /\b(?:daily|day[\s-]*wise|per\s*day|by\s*day)\b/ },
    { grain: 'week', regex: /\b(?:weekly|week[\s-]*wise|per\s*week|by\s*week)\b/ },
    { grain: 'month', regex: /\b(?:monthly|month[\s-]*wise|per\s*month|by\s*month)\b/ },
    { grain: 'quarter', regex: /\b(?:quarterly|quarter[\s-]*wise|per\s*quarter|by\s*quarter)\b/ },
    { grain: 'year', regex: /\b(?:yearly|year[\s-]*wise|per\s*year|by\s*year)\b/ },
];

const GRAIN_MAP: Record<string, TimeGrain> = {
    'day': TimeGrain.DAY,
    'week': TimeGrain.WEEK,
    'month': TimeGrain.MONTH,
    'quarter': TimeGrain.QUARTER,
    'year': TimeGrain.YEAR,
};

// ─── NORMALIZE COLUMN NAME ───────────────────────────────────
const normalizeCol = (s: string): string =>
    s.toLowerCase().replace(/[_\-\s]+/g, ' ').trim();

// ─── FUZZY MATCH ─────────────────────────────────────────────
const levenshtein = (a: string, b: string): number => {
    const m: number[][] = [];
    for (let i = 0; i <= b.length; i++) m[i] = [i];
    for (let j = 0; j <= a.length; j++) m[0][j] = j;
    for (let i = 1; i <= b.length; i++)
        for (let j = 1; j <= a.length; j++)
            m[i][j] = b[i - 1] === a[j - 1]
                ? m[i - 1][j - 1]
                : Math.min(m[i - 1][j - 1], m[i][j - 1], m[i - 1][j]) + 1;
    return m[b.length][a.length];
};

interface ColMatch {
    column: string;       // original column name
    score: number;        // 0-1 match confidence
    startIdx: number;     // start token index in query
    endIdx: number;       // end token index (exclusive)
    phrase: string;       // the matched phrase from query
}

/**
 * Scans the query tokens for substrings that match a column name.
 * Uses synonym expansion so "sales" can match a "Revenue" column,
 * "region" can match a "State" or "Territory" column, etc.
 * Returns ALL matches found, ranked by score (best first).
 */
const findAllColumnMatches = (tokens: string[], columns: string[]): ColMatch[] => {
    const matches: ColMatch[] = [];

    for (const col of columns) {
        const normCol = normalizeCol(col);
        const colWords = normCol.split(' ');
        const colLen = colWords.length;

        for (let i = 0; i <= tokens.length - 1; i++) {
            // Try matching phrases of length colLen, colLen-1, ... 1
            for (let phraseLen = Math.min(colLen + 1, tokens.length - i); phraseLen >= 1; phraseLen--) {
                const phrase = tokens.slice(i, i + phraseLen).join(' ');

                // Skip if phrase is entirely stop words
                const phraseTokens = phrase.split(' ');
                if (phraseTokens.every(t => STOP_WORDS.has(t))) continue;

                // Exact match on normalized form
                if (phrase === normCol) {
                    matches.push({ column: col, score: 1.0, startIdx: i, endIdx: i + phraseLen, phrase });
                    break;
                }

                // Substring containment (one contains the other)
                if (normCol.includes(phrase) && phrase.length >= 3) {
                    const containScore = phrase.length / normCol.length;
                    if (containScore >= 0.5) {
                        matches.push({ column: col, score: 0.7 + containScore * 0.2, startIdx: i, endIdx: i + phraseLen, phrase });
                        break;
                    }
                }
                if (phrase.includes(normCol) && normCol.length >= 3) {
                    matches.push({ column: col, score: 0.85, startIdx: i, endIdx: i + phraseLen, phrase });
                    break;
                }

                // Levenshtein (only for single tokens vs single-word columns, or same-length phrases)
                if (phraseLen === colLen && phrase.length >= 3 && normCol.length >= 3) {
                    const dist = levenshtein(phrase, normCol);
                    const maxLen = Math.max(phrase.length, normCol.length);
                    const score = 1 - (dist / maxLen);
                    if (score >= 0.7) {
                        matches.push({ column: col, score, startIdx: i, endIdx: i + phraseLen, phrase });
                        break;
                    }
                }

                // ─── SYNONYM EXPANSION MATCHING ──────────────────
                // If direct match failed, try synonym expansions.
                // e.g., user says "sales" but column is "Revenue"
                if (phraseLen === 1 && !STOP_WORDS.has(phrase)) {
                    const synonyms = expandWithSynonyms(phrase);
                    for (const syn of synonyms) {
                        if (syn === phrase) continue; // already tried
                        const normSyn = normalizeCol(syn);
                        // Exact synonym match
                        if (normSyn === normCol) {
                            matches.push({ column: col, score: 0.92, startIdx: i, endIdx: i + 1, phrase: `${phrase}→${col}` });
                            break;
                        }
                        // Synonym substring match
                        if (normCol.includes(normSyn) && normSyn.length >= 3) {
                            const synScore = normSyn.length / normCol.length;
                            if (synScore >= 0.4) {
                                matches.push({ column: col, score: 0.75 + synScore * 0.15, startIdx: i, endIdx: i + 1, phrase: `${phrase}→${col}` });
                                break;
                            }
                        }
                        if (normSyn.includes(normCol) && normCol.length >= 3) {
                            matches.push({ column: col, score: 0.80, startIdx: i, endIdx: i + 1, phrase: `${phrase}→${col}` });
                            break;
                        }
                        // Fuzzy synonym match
                        if (normSyn.length >= 3 && normCol.length >= 3) {
                            const dist = levenshtein(normSyn, normCol);
                            const maxLen = Math.max(normSyn.length, normCol.length);
                            const fScore = 1 - (dist / maxLen);
                            if (fScore >= 0.75) {
                                matches.push({ column: col, score: fScore * 0.85, startIdx: i, endIdx: i + 1, phrase: `${phrase}→${col}` });
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    // Sort by score descending, then by phrase length descending (prefer longer matches)
    matches.sort((a, b) => b.score - a.score || (b.endIdx - b.startIdx) - (a.endIdx - a.startIdx));

    // ─── NAME PREFERENCE: prefer _name over _id columns ────────
    // When user says "product", prefer "product_name" over "product_id"
    for (const m of matches) {
        const normCol = normalizeCol(m.column);
        if (normCol.endsWith('name') || normCol.endsWith('_name') || normCol.includes(' name')) {
            m.score = Math.min(1.0, m.score + 0.05); // Boost name columns
        } else if (normCol.endsWith('_id') || normCol.endsWith(' id') || normCol === 'id') {
            m.score = Math.max(0, m.score - 0.08); // Penalize ID columns
        }
    }

    // Re-sort after name-preference adjustment
    matches.sort((a, b) => b.score - a.score || (b.endIdx - b.startIdx) - (a.endIdx - a.startIdx));
    return matches;
};

// ─── MAIN PARSER ─────────────────────────────────────────────
export const parseNLQ = (query: string, dataset: Dataset): NLQParseResult => {
    // ── Step 0: Input Sanitization ────────────────────────────
    // Guard against null/undefined/empty input
    if (!query || typeof query !== 'string') {
        return {
            metric: '', dimension: '', aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW, filters: {}, measureFilters: [],
            dateFilters: [], confidence: 0, explanation: ['Empty or invalid query.'],
            tableCalculations: [], excludeFilters: {},
        };
    }

    // Cap input length to prevent abuse (500 chars is generous for NLQ)
    const cappedQuery = query.slice(0, 500);

    // Strip control characters (keep printable ASCII, Unicode letters/numbers, and basic punctuation)
    const sanitizedQuery = cappedQuery.replace(/[\x00-\x1F\x7F]/g, '');

    // ── Step 0b: Normalize ───────────────────────────────────
    const cleanQuery = sanitizedQuery.toLowerCase().replace(/[.,?!;:'"]/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = cleanQuery.split(' ');
    const explanation: string[] = [];

    const result: NLQParseResult = {
        metric: '',
        dimension: '',
        aggregation: AggregationType.SUM,
        timeGrain: TimeGrain.RAW,
        filters: {},
        measureFilters: [],
        dateFilters: [],
        confidence: 1.0,
        explanation: [],
        tableCalculations: [],
        excludeFilters: {},
    };

    // ── Step 1: Classify columns ─────────────────────────────
    const metricCols = dataset.columns
        .filter(c => c.type === ColumnType.METRIC)
        .map(c => c.name);

    const dimCols = dataset.columns
        .filter(c => c.type === ColumnType.DIMENSION || c.type === ColumnType.ID)
        .map(c => c.name);

    // Robust date column detection: explicit type OR name heuristic
    let dateCols = dataset.columns
        .filter(c => c.type === ColumnType.DATE)
        .map(c => c.name);
    if (dateCols.length === 0) {
        dateCols = dataset.columns
            .filter(c => /date|_dt$|_at$/i.test(c.name))
            .map(c => c.name);
        if (dateCols.length > 0) {
            explanation.push(`Inferred date column: **${dateCols[0]}** (from name pattern)`);
        }
    }

    // All searchable columns (exclude IDs for fuzzy search)
    const allCols = dataset.columns.filter(c => c.type !== ColumnType.ID).map(c => c.name);

    // ── Step 2: Detect Aggregation ───────────────────────────
    for (const token of tokens) {
        if (AGG_KEYWORDS[token]) {
            result.aggregation = AGG_KEYWORDS[token];
            if (token !== 'total') { // "total" is so common, don't log unless needed
                explanation.push(`Aggregation: **${result.aggregation}**`);
            }
            break;
        }
    }
    // Special: "how many" -> COUNT
    if (cleanQuery.includes('how many')) {
        result.aggregation = AggregationType.COUNT;
        explanation.push(`Aggregation: **COUNT** (from "how many")`);
    }

    // ── Step 3: Detect Time Grain ────────────────────────────
    // This must happen BEFORE dimension detection so we know whether to
    // override the dimension to a time grain bucket.
    let detectedGrain: string | null = null;
    for (const gp of GRAIN_PATTERNS) {
        if (gp.regex.test(cleanQuery)) {
            detectedGrain = gp.grain;
            result.timeGrain = GRAIN_MAP[gp.grain];
            explanation.push(`Time grain: **${gp.grain}** (from "${cleanQuery.match(gp.regex)?.[0]}")`);
            break;
        }
    }

    // ── Step 3b: Detect Table Calculations ───────────────────
    // Scan for patterns like "running total", "% of total", "rank", etc.
    for (const pattern of TABLE_CALC_PATTERNS) {
        if (pattern.regex.test(cleanQuery)) {
            result.tableCalculations.push(pattern.calc);
            explanation.push(`Table calculation: **${pattern.label}** detected`);

            // Extract moving average window size from query (e.g., '4 week', '3 month', '5 period')
            if (pattern.calc === 'moving_avg') {
                const windowMatch = cleanQuery.match(/(\d+)\s*(?:week|month|day|period|point|quarter|year)/i);
                if (windowMatch) {
                    result.movingAvgWindow = parseInt(windowMatch[1], 10);
                    explanation.push(`Moving average window: **${result.movingAvgWindow}** periods`);
                }
            }
        }
    }

    // ── Step 4: Extract Date values ──────────────────────────
    // Years like 2014, 2023 etc.
    const yearRegex = /\b((?:19|20)\d{2})\b/g;
    const yearMatches = [...cleanQuery.matchAll(yearRegex)].map(m => m[1]);
    const detectedYears = [...new Set(yearMatches)];

    // Quarters like "quarter 1", "q1", "Q2"
    const qMatch = cleanQuery.match(/\bquarter\s*(\d)\b|\bq(\d)\b/);
    const detectedQuarter = qMatch ? (qMatch[1] || qMatch[2]) : null;

    // Named months
    const MONTH_MAP: Record<string, string> = {
        'january': '01', 'jan': '01', 'february': '02', 'feb': '02',
        'march': '03', 'mar': '03', 'april': '04', 'apr': '04',
        'may': '05', 'june': '06', 'jun': '06', 'july': '07', 'jul': '07',
        'august': '08', 'aug': '08', 'september': '09', 'sep': '09',
        'october': '10', 'oct': '10', 'november': '11', 'nov': '11',
        'december': '12', 'dec': '12',
    };
    let detectedMonth: string | null = null;
    for (const [name, num] of Object.entries(MONTH_MAP)) {
        if (cleanQuery.includes(name)) {
            detectedMonth = num;
            break;
        }
    }

    // Also detect numeric month patterns like "month 1", "month 12"
    if (!detectedMonth) {
        const numericMonthMatch = cleanQuery.match(/\bmonth\s+(\d{1,2})\b/);
        if (numericMonthMatch) {
            const mNum = parseInt(numericMonthMatch[1], 10);
            if (mNum >= 1 && mNum <= 12) {
                detectedMonth = mNum.toString().padStart(2, '0');
            }
        }
    }

    // ── Step 4b-pre: Detect COMPARISON patterns ──────────────
    // If the query has "X compared to Y" / "X vs Y" / "X versus Y" / "X against Y",
    // extract both time periods and skip the single time-filter path.
    const comparisonSeparators = /\s+(?:compared\s+to|vs\.?|versus|against|and)\s+/i;
    const comparisonMatch = cleanQuery.match(comparisonSeparators);

    // Helper: resolve a text fragment to a time-filter key and label
    const resolveTimePeriod = (text: string): { key: string; label: string } | null => {
        const t = text.trim().toLowerCase();
        const periodMap: { regex: RegExp; key: string; label: string; dynamic?: (m: RegExpMatchArray) => { key: string; label: string } }[] = [
            { regex: /\btoday\b/, key: 'today', label: 'Today' },
            { regex: /\byesterday\b/, key: 'yesterday', label: 'Yesterday' },
            { regex: /\bthis\s+week\b/, key: 'this_week', label: 'This Week' },
            { regex: /\bthis\s+month\b/, key: 'this_month', label: 'This Month' },
            { regex: /\bthis\s+quarter\b/, key: 'this_quarter', label: 'This Quarter' },
            { regex: /\bthis\s+year\b/, key: 'this_year', label: 'This Year' },
            { regex: /\blast\s+week\b/, key: 'last_7_days', label: 'Last Week' },
            { regex: /\blast\s+month\b/, key: 'last_30_days', label: 'Last Month' },
            { regex: /\blast\s+quarter\b/, key: 'last_90_days', label: 'Last Quarter' },
            { regex: /\blast\s+year\b/, key: 'last_year', label: 'Last Year' },
            { regex: /\blast\s+(\d+)\s*days?\b/, key: '', label: '', dynamic: (m) => ({ key: `last_${m[1]}_days`, label: `Last ${m[1]} Days` }) },
            { regex: /\blast\s+(\d+)\s*weeks?\b/, key: '', label: '', dynamic: (m) => ({ key: `last_${m[1]}_weeks`, label: `Last ${m[1]} Weeks` }) },
            { regex: /\blast\s+(\d+)\s*months?\b/, key: '', label: '', dynamic: (m) => ({ key: `last_${m[1]}_months`, label: `Last ${m[1]} Months` }) },
        ];
        for (const p of periodMap) {
            const m = t.match(p.regex);
            if (m) {
                if (p.dynamic) return p.dynamic(m);
                return { key: p.key, label: p.label };
            }
        }
        return null;
    };

    if (comparisonMatch && comparisonMatch.index !== undefined) {
        const beforeSep = cleanQuery.substring(0, comparisonMatch.index);
        const afterSep = cleanQuery.substring(comparisonMatch.index + comparisonMatch[0].length);

        const periodA = resolveTimePeriod(beforeSep);
        const periodB = resolveTimePeriod(afterSep);

        if (periodA && periodB) {
            result.comparison = {
                type: 'period_vs_period',
                periodA: periodA.key,
                periodB: periodB.key,
                labelA: periodA.label,
                labelB: periodB.label,
            };
            explanation.push(`Comparison: **${periodA.label}** vs **${periodB.label}**`);
            // Don't set timeFilter — we handle both periods in NLQView
        }
    }

    // ── Step 4b-pre2: Time Intelligence Shortcuts ──────────
    // YoY, MoM, WoW, QoQ → auto-set comparison
    // MTD, YTD, QTD → auto-set time filter
    if (!result.comparison) {
        for (const ti of TIME_INTELLIGENCE) {
            if (ti.regex.test(cleanQuery)) {
                if (ti.comparison) {
                    result.comparison = {
                        type: 'period_vs_period',
                        ...ti.comparison,
                    };
                    explanation.push(`Time intelligence: **${ti.comparison.labelA}** vs **${ti.comparison.labelB}**`);
                } else if (ti.timeFilter) {
                    result.timeFilter = ti.timeFilter;
                    explanation.push(`Time filter: **${ti.timeFilter.replace(/_/g, ' ')}** (shortcut)`);
                }
                break;
            }
        }
    }

    // ── Step 4c: Detect Derived Metrics ────────────────────
    // AOV, profit margin, revenue per unit, etc.
    for (const dm of DERIVED_METRICS) {
        if (dm.regex.test(cleanQuery)) {
            // Resolve numerator and denominator to actual column names
            const numCol = allCols.find(c => normalizeCol(c).includes(dm.numerator)) || dm.numerator;
            const denCol = allCols.find(c => normalizeCol(c).includes(dm.denominator)) || dm.denominator;
            result.derivedMetric = { id: dm.id, label: dm.label, numerator: numCol, denominator: denCol, isCount: dm.isCount, multiply: dm.multiply };
            explanation.push(`Derived metric: **${dm.label}** (${numCol} / ${denCol}${dm.multiply ? ' × ' + dm.multiply : ''})`);
            break;
        }
    }

    // ── Step 4d: Percentage Question Detection ──────────────
    const pctQuestionRx = /\b(?:what\s+percent(?:age)?|what\s+share|what\s+fraction|how\s+much\s+of|what\s+portion|percent(?:age)?\s+of\s+total|revenue\s+share|sales\s+share|breakdown\s+by\s+percent)\b/;
    if (pctQuestionRx.test(cleanQuery) && !result.tableCalculations.includes('percent_of_total')) {
        result.tableCalculations.push('percent_of_total');
        explanation.push(`Auto table calc: **% of Total** (percentage question detected)`);
    }

    // ── Step 4b: Detect Relative Time Filters ────────────────
    // Only apply single time-filter if no comparison was detected
    // Patterns: "last 7 days", "last 30 days", "last week", "this month", "today", "yesterday"
    const relativeTimePatterns: { regex: RegExp; value: string | ((m: RegExpMatchArray) => string) }[] = [
        { regex: /\blast\s+(\d+)\s*days?\b/, value: (m) => `last_${m[1]}_days` },
        { regex: /\blast\s+(\d+)\s*weeks?\b/, value: (m) => `last_${m[1]}_weeks` },
        { regex: /\blast\s+(\d+)\s*months?\b/, value: (m) => `last_${m[1]}_months` },
        { regex: /\blast\s+(\d+)\s*years?\b/, value: (m) => `last_${m[1]}_years` },
        { regex: /\btoday\b/, value: 'today' },
        { regex: /\byesterday\b/, value: 'yesterday' },
        { regex: /\bthis\s+week\b/, value: 'this_week' },
        { regex: /\bthis\s+month\b/, value: 'this_month' },
        { regex: /\bthis\s+quarter\b/, value: 'this_quarter' },
        { regex: /\bthis\s+year\b/, value: 'this_year' },
        { regex: /\blast\s+week\b/, value: 'last_7_days' },
        { regex: /\blast\s+month\b/, value: 'last_30_days' },
        { regex: /\blast\s+quarter\b/, value: 'last_90_days' },
        { regex: /\blast\s+year\b/, value: 'last_year' },
    ];

    if (!result.comparison && !result.timeFilter) {
        for (const rtp of relativeTimePatterns) {
            const rtMatch = cleanQuery.match(rtp.regex);
            if (rtMatch) {
                result.timeFilter = typeof rtp.value === 'function' ? rtp.value(rtMatch) : rtp.value;
                explanation.push(`Time filter: **${result.timeFilter.replace(/_/g, ' ')}**`);
                break;
            }
        }
    }

    // Build date filters (only if no relative time filter was set)
    if (!result.timeFilter && dateCols.length > 0 && (detectedYears.length > 0 || detectedQuarter || detectedMonth)) {
        const dateCol = dateCols[0];

        if (detectedYears.length > 0 && detectedQuarter && detectedMonth) {
            // Year + Quarter + Month — use the most specific: year-month
            const vals = detectedYears.map(y => `${y}-${detectedMonth}`);
            result.dateFilters.push({ column: dateCol, timeGrain: 'month', values: vals });
            explanation.push(`Date filter: **${dateCol}** in **${vals.join(', ')}** (month from Q${detectedQuarter})`);
        } else if (detectedYears.length > 0 && detectedQuarter) {
            // Year + Quarter combination
            const vals = detectedYears.map(y => `${y}-Q${detectedQuarter}`);
            result.dateFilters.push({ column: dateCol, timeGrain: 'quarter', values: vals });
            explanation.push(`Date filter: **${dateCol}** in **${vals.join(', ')}**`);
        } else if (detectedYears.length > 0 && detectedMonth) {
            // Year + Month combination
            const vals = detectedYears.map(y => `${y}-${detectedMonth}`);
            result.dateFilters.push({ column: dateCol, timeGrain: 'month', values: vals });
            explanation.push(`Date filter: **${dateCol}** in **${vals.join(', ')}**`);
        } else if (detectedYears.length > 0) {
            // Just years
            result.dateFilters.push({ column: dateCol, timeGrain: 'year', values: detectedYears });
            explanation.push(`Date filter: **${dateCol}** in year(s) **${detectedYears.join(', ')}**`);
        }
    }

    // ── Step 5: Detect Metric ────────────────────────────────
    // Scan tokens for column names; metrics are prioritized for numeric columns
    const usedTokenRanges: [number, number][] = [];
    const isTokenUsed = (start: number, end: number) =>
        usedTokenRanges.some(([s, e]) => start < e && end > s);

    // First, find metric
    const metricMatches = findAllColumnMatches(tokens, metricCols.length > 0 ? metricCols : allCols);
    let bestMetric: ColMatch | null = null;

    // De-duplicate: for same column, prefer the SHORTEST phrase (fewest tokens consumed)
    // This prevents "customers sales" from eating the "customers" token when "sales" alone suffices
    const bestPerColumn = new Map<string, ColMatch>();
    for (const m of metricMatches) {
        const existing = bestPerColumn.get(m.column);
        if (!existing) {
            bestPerColumn.set(m.column, m);
        } else {
            // Prefer higher score first, then shorter phrase (fewer tokens consumed)
            const mSpan = m.endIdx - m.startIdx;
            const eSpan = existing.endIdx - existing.startIdx;
            if (m.score > existing.score || (m.score === existing.score && mSpan < eSpan)) {
                bestPerColumn.set(m.column, m);
            }
        }
    }
    const dedupedMetricMatches = [...bestPerColumn.values()].sort((a, b) =>
        b.score - a.score || (a.endIdx - a.startIdx) - (b.endIdx - b.startIdx)
    );

    for (const m of dedupedMetricMatches) {
        if (!isTokenUsed(m.startIdx, m.endIdx)) {
            // Prefer columns that are actual metrics
            const colDef = dataset.columns.find(c => c.name === m.column);
            if (colDef && colDef.type === ColumnType.METRIC) {
                bestMetric = m;
                break;
            }
            if (!bestMetric) bestMetric = m;
        }
    }

    if (bestMetric) {
        result.metric = bestMetric.column;
        usedTokenRanges.push([bestMetric.startIdx, bestMetric.endIdx]);
        explanation.push(`Metric: **${bestMetric.column}** (matched "${bestMetric.phrase}")`);

        // ── Capture secondary metrics (e.g., "sales and profit") ──
        // Continue scanning deduped metric matches for additional unique metrics
        const secondaryMetrics: string[] = [];
        for (const m of dedupedMetricMatches) {
            if (m.column === bestMetric.column) continue; // Skip primary
            if (secondaryMetrics.includes(m.column)) continue; // Skip duplicates
            if (isTokenUsed(m.startIdx, m.endIdx)) continue; // Skip already-used tokens
            // Verify it's an actual METRIC column
            const colDef = dataset.columns.find(c => c.name === m.column);
            if (!colDef || colDef.type !== ColumnType.METRIC) continue;
            secondaryMetrics.push(m.column);
            usedTokenRanges.push([m.startIdx, m.endIdx]);
            if (secondaryMetrics.length >= 3) break; // Cap at 3 secondary metrics
        }
        if (secondaryMetrics.length > 0) {
            result.secondaryMetrics = secondaryMetrics;
            explanation.push(`Secondary metrics: **${secondaryMetrics.join(', ')}**`);
        }
    } else if (result.aggregation === AggregationType.COUNT) {
        result.metric = 'count';
        explanation.push(`Metric: **count** (record count)`);
    } else {
        result.metric = metricCols[0] || allCols[0] || 'count';
        explanation.push(`Metric: **${result.metric}** (default — no explicit metric found)`);
        result.confidence -= 0.15;
    }

    // ── Step 6: Detect Dimension ─────────────────────────────
    // Look for "by [dimension]" pattern first (strongest signal)
    // Stop at known keywords AND dimension column names to prevent over-capture
    const dimStopWords = dimCols.map(d => d.toLowerCase().replace(/_/g, ' ')).join('|');
    const byPatternRegex = new RegExp(`\\bby\\s+(\\w[\\w\\s]*?)(?:\\s+(?:for|in|from|where|and|show|with|greater|less|over|above|below|month|week|day|year|quarter|wise|chart|graph|>|<|=|${dimStopWords})\\b|$)`);
    const byPatternMatch = cleanQuery.match(byPatternRegex);

    // Also detect "[dimension] wise" pattern (e.g., "region wise", "product wise")
    const wisePatternMatch = cleanQuery.match(/\b(\w+)\s+wise\b/);

    let bestDim: ColMatch | null = null;

    if (byPatternMatch) {
        const afterBy = byPatternMatch[1].trim();
        const afterByTokens = afterBy.split(/\s+/);
        const dimMatches = findAllColumnMatches(afterByTokens, [...dimCols, ...dateCols]);
        for (const m of dimMatches) {
            if (!isTokenUsed(m.startIdx, m.endIdx)) {
                bestDim = m;
                break;
            }
        }
    }

    // "X wise" fallback — treat "region wise" as "by region"
    // BUT skip if X is a metric word (e.g., "sales wise" = sorting by sales, not grouping)
    if (!bestDim && wisePatternMatch) {
        const beforeWise = wisePatternMatch[1].trim();
        // Skip time grains
        if (!['day', 'week', 'month', 'quarter', 'year'].includes(beforeWise)) {
            // Check if the word before "wise" matches a metric column — if so, skip it
            const isMetricWord = metricCols.some(mc => {
                const normMc = normalizeCol(mc);
                return normMc === beforeWise || normMc.includes(beforeWise) || beforeWise.includes(normMc);
            });
            // Also check synonym expansions for metric-like words
            const metricSynonyms = ['sales', 'revenue', 'profit', 'income', 'amount', 'cost', 'price',
                'orders', 'quantity', 'units', 'margin', 'discount', 'earning', 'earnings', 'turnover'];
            const isMetricSynonym = metricSynonyms.includes(beforeWise);

            if (!isMetricWord && !isMetricSynonym) {
                const wiseTokens = [beforeWise];
                const dimMatches = findAllColumnMatches(wiseTokens, [...dimCols, ...dateCols]);
                for (const m of dimMatches) {
                    bestDim = m;
                    break;
                }
            }
        }
    }

    // Fallback: search all tokens for dimension columns
    // BUT skip matches where the next token is a data value for that column
    // (e.g., "state alabama" = filter intent, not grouping intent)
    if (!bestDim) {
        const dimMatches = findAllColumnMatches(tokens, dimCols);
        for (const m of dimMatches) {
            if (!isTokenUsed(m.startIdx, m.endIdx)) {
                // Check if this looks like a "[dim] [value]" filter pattern
                const nextIdx = m.endIdx;
                if (nextIdx < tokens.length) {
                    const nextToken = tokens[nextIdx];
                    // Skip stop words and check if next word is a data value
                    if (!STOP_WORDS.has(nextToken) && !/^\d+$/.test(nextToken) && !/^(19|20)\d{2}$/.test(nextToken)) {
                        const colToCheck = m.column;
                        const isDataValue = findDimensionForValue(nextToken, dataset, [colToCheck]);
                        // Also check if synonym-resolved column has the value
                        const allMatchedCols = dimMatches.filter(dm => dm.startIdx === m.startIdx).map(dm => dm.column);
                        const isValueInAnyMatch = allMatchedCols.some(c => findDimensionForValue(nextToken, dataset, [c]));
                        if (isDataValue || isValueInAnyMatch) {
                            // Next token is a data value for this column → filter pattern, skip
                            continue;
                        }
                    }
                }
                bestDim = m;
                break;
            }
        }
    }

    // Fallback 1.5: Entity-word dimension detection
    // Words like "customers", "products", "regions" are clearly dimension-intent words.
    // Explicitly search for them against ALL non-metric columns.
    if (!bestDim) {
        const ENTITY_WORDS: Record<string, string[]> = {
            'customer': ['customer', 'cust', 'client', 'buyer', 'name', 'person'],
            'customers': ['customer', 'cust', 'client', 'buyer', 'name', 'person'],
            'product': ['product', 'prod', 'item', 'sku', 'merchandise', 'name'],
            'products': ['product', 'prod', 'item', 'sku', 'merchandise', 'name'],
            'region': ['region', 'state', 'city', 'country', 'area', 'territory', 'location', 'geo'],
            'regions': ['region', 'state', 'city', 'country', 'area', 'territory', 'location'],
            'category': ['category', 'cat', 'segment', 'type', 'group', 'sub category'],
            'categories': ['category', 'cat', 'segment', 'type', 'group'],
            'channel': ['channel', 'source', 'medium', 'platform', 'traffic'],
            'channels': ['channel', 'source', 'medium', 'platform'],
            'supplier': ['supplier', 'vendor', 'manufacturer', 'brand'],
            'brand': ['brand', 'manufacturer', 'vendor', 'supplier'],
            'department': ['department', 'dept', 'division', 'team'],
            'city': ['city', 'metro', 'location', 'region'],
            'state': ['state', 'province', 'region', 'location'],
            'country': ['country', 'nation', 'region', 'location'],
            'segment': ['segment', 'category', 'type', 'group', 'class'],
        };
        const nonMetricCols = dataset.columns
            .filter(c => c.type !== ColumnType.METRIC && c.type !== ColumnType.DATE)
            .map(c => c.name);

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (STOP_WORDS.has(token) || isTokenUsed(i, i + 1)) continue;
            const entityVariants = ENTITY_WORDS[token];
            if (!entityVariants) continue;

            // Try to find a matching column using these entity variants
            for (const col of nonMetricCols) {
                const normCol = normalizeCol(col);
                for (const variant of entityVariants) {
                    if (normCol === variant || normCol.includes(variant) || variant.includes(normCol)) {
                        bestDim = { column: col, score: 0.85, startIdx: i, endIdx: i + 1, phrase: `${token}→${col}` };
                        break;
                    }
                }
                if (bestDim) break;
            }
            if (bestDim) break;
        }
    }

    // Fallback 2: broaden to ALL non-metric columns (catches anything remaining)
    if (!bestDim) {
        const nonMetricCols = dataset.columns
            .filter(c => c.type !== ColumnType.METRIC)
            .map(c => c.name);
        const dimMatches = findAllColumnMatches(tokens, nonMetricCols);
        for (const m of dimMatches) {
            if (!isTokenUsed(m.startIdx, m.endIdx)) {
                // Don't pick date columns if we have other matches
                const colDef = dataset.columns.find(c => c.name === m.column);
                if (colDef?.type !== ColumnType.DATE) {
                    bestDim = m;
                    break;
                }
            }
        }
    }

    if (bestDim) {
        result.dimension = bestDim.column;
        usedTokenRanges.push([bestDim.startIdx, bestDim.endIdx]);
        explanation.push(`Dimension: **${bestDim.column}** (matched "${bestDim.phrase}")`);
    }

    // ── Step 7: Apply Time Grain to Dimension ────────────────
    // CRITICAL: evaluateLocally expects dimension to LITERALLY be 'month',
    // 'year', etc. for time-based grouping, NOT the column name.
    if (detectedGrain) {
        // If user asked for time grain, override dimension to the grain name
        // This tells evaluateLocally to do time-bucket grouping
        const oldDim = result.dimension;
        result.dimension = detectedGrain; // e.g. 'month', 'year'
        if (oldDim && oldDim !== detectedGrain) {
            // The old dimension becomes a categorical filter if it looks intentional
            // "Sales by region month wise" -> group by month, but user mentioned region
            explanation.push(`Dimension overridden to **${detectedGrain}** for time-series grouping`);
            // Don't auto-add as filter — user might have just said "by region" loosely
        } else if (!oldDim) {
            explanation.push(`Dimension set to **${detectedGrain}** (time grain)`);
        }
    } else if (!result.dimension && dateCols.length > 0) {
        // No dimension found at all — default to first date column's raw output
        result.dimension = dateCols[0];
        explanation.push(`Dimension: **${dateCols[0]}** (default date column)`);
        result.confidence -= 0.1;
    } else if (!result.dimension) {
        // No dimension, no date columns
        const firstDim = dimCols[0];
        if (firstDim) {
            result.dimension = firstDim;
            explanation.push(`Dimension: **${firstDim}** (default)`);
            result.confidence -= 0.15;
        }
    }

    // ── Step 8: Measure Filters ──────────────────────────────
    const measurePatterns = [
        { regex: /(?:greater\s+than|more\s+than|over|above|>)\s*(\d[\d,]*(?:\.\d+)?)/g, op: '>' },
        { regex: /(?:less\s+than|under|below|<)\s*(\d[\d,]*(?:\.\d+)?)/g, op: '<' },
        { regex: /(?:>=|at\s+least)\s*(\d[\d,]*(?:\.\d+)?)/g, op: '>=' },
        { regex: /(?:<=|at\s+most|up\s+to)\s*(\d[\d,]*(?:\.\d+)?)/g, op: '<=' },
        { regex: /(?:equal\s+to|equals|exactly|=)\s*(\d[\d,]*(?:\.\d+)?)/g, op: '=' },
        { regex: /(?:not\s+equal\s+to|!=)\s*(\d[\d,]*(?:\.\d+)?)/g, op: '!=' },
    ];

    for (const mp of measurePatterns) {
        let m;
        while ((m = mp.regex.exec(cleanQuery)) !== null) {
            const val = parseFloat(m[1].replace(/,/g, ''));
            if (!isNaN(val)) {
                result.measureFilters.push({ column: result.metric, operator: mp.op, value: val });
                explanation.push(`Measure filter: **${result.metric} ${mp.op} ${val}**`);
            }
        }
    }

    // ── Step 9: Categorical Filters ──────────────────────────
    // Enhanced: handles "category Furniture", "segment Consumer",
    // "for category Furniture and segment Consumer", multi-word values,
    // and standalone value lookups.
    const DATE_GRAIN_WORDS = new Set([
        'year', 'years', 'month', 'months', 'week', 'weeks', 'day', 'days',
        'quarter', 'quarters', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly',
        'the', 'each', 'every', 'wise', 'last', 'next', 'this', 'all',
        'today', 'yesterday', 'tomorrow',
    ]);
    const FILTER_SKIP_WORDS = new Set([
        'and', 'or', 'the', 'for', 'by', 'in', 'from', 'with', 'where', 'on', 'at',
        'to', 'of', 'show', 'me', 'give', 'get', 'display', 'total', 'average', 'sum',
        'count', 'max', 'min', 'sales', 'revenue', 'profit', 'quantity', 'discount',
    ]);

    // Helper: add a filter value to a dimension, avoiding duplicates
    const addFilter = (dim: string, val: string) => {
        const normalVal = val.charAt(0).toUpperCase() + val.slice(1).toLowerCase(); // Title case
        if (!result.filters[dim]) result.filters[dim] = [];
        // Check both original and title case to avoid duplicates
        if (!result.filters[dim].some(v => v.toLowerCase() === val.toLowerCase())) {
            result.filters[dim].push(normalVal);
            explanation.push(`Filter: **${dim}** = "**${normalVal}**"`);
        }
    };

    // ─── STEP 9: FILTER EXTRACTION ─────────────────────────────────────
    // Simple approach: scan words, find dimension names, capture following data values.
    const dimColsLower = dimCols.map(d => ({ name: d, lower: d.toLowerCase().replace(/_/g, ' ') }));
    const queryWords = cleanQuery.split(/\s+/);
    const multiValueFilterDims: string[] = [];

    const singularize = (w: string): string => {
        if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y'; // categories → category
        if (w.endsWith('sses') && w.length > 5) return w.slice(0, -2);      // addresses → address
        if (w.endsWith('xes') && w.length > 4) return w.slice(0, -2);       // boxes → box
        if (w.endsWith('shes') && w.length > 5) return w.slice(0, -2);      // dishes → dish
        if (w.endsWith('ches') && w.length > 5) return w.slice(0, -2);      // watches → watch
        if (w.endsWith('zes') && w.length > 4) return w.slice(0, -2);       // quizzes → quiz (after sses)
        if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1); // states → state
        return w;
    };

    const filterStopWords = new Set(['compare', 'comparison', 'growth', 'difference', 'versus',
        'vs', 'between', 'by', 'for', 'from', 'with', 'in', 'show', 'both', 'their', 'me']);

    for (let wi = 0; wi < queryWords.length; wi++) {
        const word = queryWords[wi];
        const wordSingular = singularize(word);

        // Match to a dimension column
        const matchedCol = dimColsLower.find(d => d.lower === word || d.lower === wordSingular);
        if (!matchedCol) continue;

        console.log(`[NLQ Filter] wi=${wi} word="${word}" matched dim="${matchedCol.name}" (lower="${matchedCol.lower}")`);

        // Capture data values after the dimension name
        const values: string[] = [];
        let j = wi + 1;
        while (j < queryWords.length) {
            let w = queryWords[j].replace(/,$/, '');
            // Skip connectors
            if (w === 'and' || w === 'or' || w === 'the') { console.log(`[NLQ Filter]   j=${j} "${w}" → connector skip`); j++; continue; }
            // Stop at keywords
            if (filterStopWords.has(w)) { console.log(`[NLQ Filter]   j=${j} "${w}" → stop keyword`); break; }
            if (/^(19|20)\d{2}$/.test(w)) { console.log(`[NLQ Filter]   j=${j} "${w}" → year stop`); break; }
            // Stop at other dimension or metric columns
            if (dimColsLower.some(d => (d.lower === w || singularize(w) === d.lower) && d.name !== matchedCol.name)) { console.log(`[NLQ Filter]   j=${j} "${w}" → other dim stop`); break; }
            if (metricCols.some(mc => mc.toLowerCase() === w)) { console.log(`[NLQ Filter]   j=${j} "${w}" → metric stop`); break; }

            // Check if it's a real data value
            const found = findDimensionForValue(w, dataset, [matchedCol.name]);
            console.log(`[NLQ Filter]   j=${j} "${w}" → findDimensionForValue=${found}`);
            if (found) {
                values.push(w);
                j++;
                continue;
            }
            break;
        }

        console.log(`[NLQ Filter] values for "${matchedCol.name}":`, values);
        if (values.length > 0) {
            for (const v of values) addFilter(matchedCol.name, v);
            if (values.length > 1) multiValueFilterDims.push(matchedCol.name);
            wi = j - 1;
        }
    }

    // Strategy B: "for [value]" pattern — catches values without explicit dimension prefix
    // e.g., "for Furniture", "for West"
    const forRegex = /\bfor\s+(?:the\s+)?(\w[\w\s]*?)(?:\s+(?:and|or|by|in|for|from|with)\b|$)/g;
    let forMatch;
    while ((forMatch = forRegex.exec(cleanQuery)) !== null) {
        const segment = forMatch[1].trim();
        const segWords = segment.split(/\s+/);

        for (const candidate of segWords) {
            const candLower = candidate.toLowerCase();
            if (DATE_GRAIN_WORDS.has(candLower)) continue;
            if (FILTER_SKIP_WORDS.has(candLower)) continue;
            if (STOP_WORDS.has(candLower)) continue;
            if (/^\d+$/.test(candidate)) continue;
            if (/^(19|20)\d{2}$/.test(candidate)) continue;
            // Skip if it's a dimension name (handled in Strategy A)
            if (dimColsLower.some(d => d.lower === candLower)) continue;
            // Skip if it was already added as a filter
            const alreadyFiltered = Object.values(result.filters).some(vals =>
                vals.some(v => v.toLowerCase() === candLower)
            );
            if (alreadyFiltered) continue;

            // Try to find which dimension this value belongs to by scanning data
            const matchedDimCol = findDimensionForValue(candidate, dataset, dimCols);
            if (matchedDimCol) {
                addFilter(matchedDimCol, candidate);
            }
        }
    }

    // Strategy C: Scan for "and [dim] [value]" chains that Strategy A might miss
    // e.g., "... and category Furniture" after another filter
    const andChainRegex = /\band\s+(\w+)\s+(\w[\w\s]*?)(?:\s+(?:and|or|by|for|from|with)\b|$)/g;
    let andMatch;
    while ((andMatch = andChainRegex.exec(cleanQuery)) !== null) {
        const possibleDim = andMatch[1].toLowerCase();
        const possibleVal = andMatch[2].trim().split(/\s+/)[0]; // First word after dim

        const matchedDim = dimColsLower.find(d => d.lower === possibleDim);
        if (matchedDim && possibleVal && !DATE_GRAIN_WORDS.has(possibleVal.toLowerCase()) && !FILTER_SKIP_WORDS.has(possibleVal.toLowerCase())) {
            addFilter(matchedDim.name, possibleVal);
        }
    }

    // ── Step 9.5: Comparison Intent & Smart Dimension Override ──
    // Detect: "compare", "growth", "difference", "vs", "versus", "between"
    // When combined with multi-value filter → group BY that dimension for side-by-side comparison
    const comparisonIntentRx = /\b(?:compar(?:e|ison|ing)|growth|differ(?:ence|ent)|versus|vs|between|side\s*by\s*side|head\s*to\s*head)\b/;
    const hasComparisonIntent = comparisonIntentRx.test(cleanQuery);

    // Also detect implicit comparison: multi-value filter on a dim + no explicit dimension set
    const hasMultiValueFilter = multiValueFilterDims.length > 0 ||
        Object.values(result.filters).some(vals => vals.length > 1);

    if (hasMultiValueFilter) {
        // Find the dimension with multiple filter values
        let multiValDim = multiValueFilterDims[0] ||
            Object.entries(result.filters).find(([_, vals]) => vals.length > 1)?.[0];

        if (multiValDim) {
            // Smart dimension override: group BY the multi-value filter dimension
            // so the chart shows side-by-side bars for each filtered value
            const oldDim = result.dimension;
            result.dimension = multiValDim;
            explanation.push(`Dimension overridden to **${multiValDim}** (multi-value filter → side-by-side comparison)`);

            // If comparison intent detected, add table calculation
            if (hasComparisonIntent) {
                if (!result.tableCalculations.includes('diff_from_prev') && !result.tableCalculations.includes('pct_change')) {
                    // Check if user specifically asked for percentage/growth
                    const wantsPercent = /\b(?:percent(?:age)?|%|growth|rate)\b/.test(cleanQuery);
                    const calcType = wantsPercent ? 'pct_change' : 'diff_from_prev';
                    result.tableCalculations.push(calcType);
                    explanation.push(`Table calc: **${wantsPercent ? 'Percent Change' : 'Difference'}** (comparison intent detected)`);
                }
            }
        }
    }

    // ── Step 10: Sorting & Limits ────────────────────────
    const topBottomMatch = cleanQuery.match(/\b(?:top|best|highest)\s+(\d+)\b/);
    const bottomMatch = cleanQuery.match(/\b(?:bottom|worst|lowest)\s+(\d+)\b/);

    if (topBottomMatch) {
        result.limit = parseInt(topBottomMatch[1], 10);
        result.sort = 'desc';
        explanation.push(`Limit: **Top ${result.limit}** (descending)`);
    } else if (bottomMatch) {
        result.limit = parseInt(bottomMatch[1], 10);
        result.sort = 'asc';
        explanation.push(`Limit: **Bottom ${result.limit}** (ascending)`);
    }

    // Extended sort patterns: natural language sort
    if (cleanQuery.includes('ascending') || cleanQuery.includes(' asc')) {
        result.sort = 'asc';
    } else if (cleanQuery.includes('descending') || cleanQuery.includes(' desc')) {
        result.sort = 'desc';
    } else if (/\b(?:highest\s+to\s+lowest|high\s+to\s+low|largest\s+to\s+smallest)\b/.test(cleanQuery)) {
        result.sort = 'desc';
    } else if (/\b(?:lowest\s+to\s+highest|low\s+to\s+high|smallest\s+to\s+largest)\b/.test(cleanQuery)) {
        result.sort = 'asc';
    } else if (/\b(?:cheapest|least\s+(?:sold|popular|revenue|profitable)|smallest|slowest|fewest)\b/.test(cleanQuery)) {
        result.sort = 'asc';
    } else if (/\b(?:most\s+expensive|most\s+(?:sold|popular|revenue|profitable)|biggest|fastest|most)\b/.test(cleanQuery)) {
        result.sort = 'desc';
    } else if (/\b(?:best\s+selling|top\s+selling)\b/.test(cleanQuery)) {
        result.sort = 'desc';
    } else if (/\b(?:worst\s+selling|least\s+selling)\b/.test(cleanQuery)) {
        result.sort = 'asc';
    }

    // ── Step 10e: Ranking Detection (highest/lowest) ─────────
    // "Which X has the highest/lowest Y?" is a RANKING question, not MIN/MAX.
    // Correct behavior: SUM(Y) GROUP BY X ORDER BY ASC/DESC LIMIT 1
    // This was previously broken: "highest" → MAX, "lowest" → MIN
    const rankingHighPattern = /\b(?:which|what)\b.*\b(?:highest|most|biggest|largest|greatest|best)\b/;
    const rankingLowPattern = /\b(?:which|what)\b.*\b(?:lowest|least|smallest|fewest|worst)\b/;

    if (rankingHighPattern.test(cleanQuery)) {
        result.sort = 'desc';
        if (!result.limit) result.limit = 1;
        // Override aggregation back to SUM if it was set to MAX by mistake
        if (result.aggregation === AggregationType.MAX) {
            result.aggregation = AggregationType.SUM;
        }
        explanation.push(`Ranking: **highest** detected → SUM + ORDER DESC LIMIT ${result.limit}`);
    } else if (rankingLowPattern.test(cleanQuery)) {
        result.sort = 'asc';
        if (!result.limit) result.limit = 1;
        // Override aggregation back to SUM if it was set to MIN by mistake
        if (result.aggregation === AggregationType.MIN) {
            result.aggregation = AggregationType.SUM;
        }
        explanation.push(`Ranking: **lowest** detected → SUM + ORDER ASC LIMIT ${result.limit}`);
    }

    // ── Step 10b: HAVING filter (post-aggregation) ──────────
    const havingPatterns: { regex: RegExp; op: '>' | '<' | '>=' | '<=' }[] = [
        { regex: /\b(?:with|where|having)\s+.*?\b(?:over|above|more\s+than|greater\s+than|exceeding|>)\s+([\d,]+)/i, op: '>' },
        { regex: /\b(?:with|where|having)\s+.*?\b(?:under|below|less\s+than|fewer\s+than|<)\s+([\d,]+)/i, op: '<' },
        { regex: /\b(?:with|where|having)\s+.*?\b(?:at\s+least|minimum|>=)\s+([\d,]+)/i, op: '>=' },
        { regex: /\b(?:with|where|having)\s+.*?\b(?:at\s+most|maximum|<=)\s+([\d,]+)/i, op: '<=' },
    ];
    for (const hp of havingPatterns) {
        const hm = cleanQuery.match(hp.regex);
        if (hm) {
            result.havingFilter = { operator: hp.op, value: parseFloat(hm[1].replace(/,/g, '')) };
            explanation.push(`HAVING filter: metric **${hp.op} ${result.havingFilter.value.toLocaleString()}**`);
            break;
        }
    }

    // ── Step 10c: Exclusion Filters ──────────────────────
    const excludeRx = /\b(?:exclud(?:e|ing)|without|not\s+in|except(?:\s+from)?|other\s+than|besides)\s+(\w+(?:\s+(?:and|,)\s+\w+)*)/i;
    const excludeMatch = cleanQuery.match(excludeRx);
    if (excludeMatch) {
        const excludeVals = excludeMatch[1].split(/\s+(?:and|,)\s+/).map(v => v.trim()).filter(Boolean);
        if (excludeVals.length > 0) {
            // Find which dimension these values belong to
            const excDim = result.dimension || dimCols[0];
            if (excDim) {
                result.excludeFilters[excDim] = excludeVals;
                explanation.push(`Exclude filter: **${excDim}** NOT IN (${excludeVals.join(', ')})`);
            }
        }
    }

    // ── Step 10d: Second Dimension Detection ───────────────
    // Detect "by X and Y" patterns for multi-dimension grouping
    if (result.dimension) {
        const byAndMatch = cleanQuery.match(/\bby\s+(\w+)\s+and\s+(\w+)\b/);
        if (byAndMatch) {
            const dim2Token = byAndMatch[2];
            const dim2Matches = findAllColumnMatches([dim2Token], [...dimCols, ...dateCols]);
            if (dim2Matches.length > 0 && dim2Matches[0].column !== result.dimension) {
                result.secondDimension = dim2Matches[0].column;
                explanation.push(`Second dimension: **${result.secondDimension}**`);
            }
        }
    }

    // ── Step 11: Chart type hints ────────────────────────────
    // (Not stored in NLQParseResult but noted for explanation)
    if (cleanQuery.includes('bar chart') || cleanQuery.includes('bar graph')) {
        explanation.push(`Chart hint: **Bar**`);
    } else if (cleanQuery.includes('line chart') || cleanQuery.includes('line graph') || cleanQuery.includes('trend')) {
        explanation.push(`Chart hint: **Line** (time series)`);
    } else if (cleanQuery.includes('pie chart') || cleanQuery.includes('pie graph')) {
        explanation.push(`Chart hint: **Pie**`);
    }

    // ── Step 12: Confidence ──────────────────────────────────
    if (result.metric) result.confidence = Math.min(result.confidence, 1.0);
    if (!result.dimension) result.confidence -= 0.2;
    result.confidence = Math.max(0.1, Math.min(1.0, result.confidence));

    result.explanation = explanation;
    return result;
};

// ─── HELPER: Find which dimension column contains a given value ───
function findDimensionForValue(
    value: string,
    dataset: Dataset,
    dimCols: string[]
): string | null {
    const lowerVal = value.toLowerCase();
    // Sample first 200 rows for performance
    const sampleSize = Math.min(200, dataset.rows.length);

    for (const col of dimCols) {
        for (let i = 0; i < sampleSize; i++) {
            const cellVal = String(dataset.rows[i]?.[col] || '').toLowerCase();
            // Exact match only (case-insensitive) — no substring matching
            // This prevents "states" from matching "United States" in the country column
            if (cellVal === lowerVal) {
                return col;
            }
        }
    }
    return null;
}
