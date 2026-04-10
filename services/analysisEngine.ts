// --- REFACTORED: analysisEngine.ts ---
// Re-exports from extracted modules for backward compatibility
import { AggregationType, AnalysisResult, AnalysisType, ColumnDefinition, ColumnProfile, ColumnType, Dataset, ETLLog, QueryConfig, TimeContext, TimeGrain, SchemaType, CanonicalMapping, QuestionTemplate, QuestionGrain } from "../types";
import * as XLSX from 'xlsx';

// Re-export from extracted modules
export { QUESTION_REGISTRY, QUESTION_BANK, getFullQuestionBank, getFullRegistry, getFullQuestionBankForDomain } from './questionRegistry';
export { getDates, excelDateToJSDate } from './dateHelpers';
export { evaluateLocally, validateRequirements, validateGrainSafety } from './evaluateLocally';

import { QUESTION_REGISTRY, getFullRegistry } from './questionRegistry';
import { getDates, excelDateToJSDate } from './dateHelpers';
import { evaluateLocally, validateRequirements } from './evaluateLocally';
import { validateAnalysis } from './analysisValidator';
import { executeSQL } from './sqlExecutor';

// --- EXECUTION ENGINE ---
export const runAnalysis = (dataset: Dataset, query: QueryConfig): AnalysisResult => {
    const mapping = resolveMapping(dataset);
    if (query.semanticRoles) {
        Object.assign(mapping.fields, query.semanticRoles);
    }

    const dates = getDates(query.asOfDate || new Date().toISOString());

    if (!query.questionId) {
        return { data: [], xKey: '', yKey: '', yLabel: '', insight: '', sql: '', config: query };
    }

    // ===== DIRECT AI SQL EXECUTION =====
    // If the query has aiSql, execute it directly via alasql — bypass evaluateLocally entirely
    if ((query as any).aiSql) {
        const aiSql = (query as any).aiSql;
        console.log('[runAnalysis] Direct AI SQL execution:', aiSql);
        const sqlResult = executeSQL(dataset.rows, aiSql);

        if (sqlResult.error) {
            return { data: [], xKey: '', yKey: '', yLabel: 'Error', insight: '', sql: aiSql, config: query, error: `SQL Error: ${sqlResult.error}` };
        }

        // Derive xKey (dimension) and yKey (metric) from result columns
        const cols = sqlResult.columns;
        let xKey = cols[0] || '';
        let yKey = cols.length > 1 ? cols[1] : cols[0] || '';

        // If there are aliases like "total_profit", "total_sales", use them
        const numericCols = cols.filter(c => {
            const firstVal = sqlResult.data[0]?.[c];
            return typeof firstVal === 'number';
        });
        const textCols = cols.filter(c => {
            const firstVal = sqlResult.data[0]?.[c];
            return typeof firstVal === 'string';
        });

        if (textCols.length > 0 && numericCols.length > 0) {
            xKey = textCols[0];
            yKey = numericCols[0];
        }

        // Determine visualization type
        let vis: any = 'bar';
        if (sqlResult.data.length === 1 && cols.length === 1) vis = 'kpiCard';
        else if (cols.length === 1) vis = 'table';

        return {
            data: sqlResult.data, xKey, yKey,
            yLabel: query.questionId || 'AI Query',
            insight: `AI SQL Query Result`,
            sql: aiSql, // Show the ORIGINAL AI SQL
            config: query,
            vis,
            kpi: sqlResult.data.length === 1 ? sqlResult.data[0][yKey] : undefined,
        };
    }

    // For 'custom_builder', NEVER look up registry — always use a fresh question definition.
    // This prevents saved AI SQL questions (stored in localStorage) from leaking into the Question Builder.
    const dq = query.questionId === 'custom_builder' ? undefined : getFullRegistry().find(q => q.id === query.questionId);

    const activeQ = dq || {
        id: 'custom_builder',
        category: 'Custom',
        question: query.metric
            ? `${query.aggregation || 'Sum'} of ${query.metric}${query.dimension ? ` by ${query.dimension}` : ''}`
            : 'Custom Analysis',
        req: [],
        grain: 'any',
        vis: 'bar',
        sql: ''
    };

    if (!dq && !query.metric) return { data: [], xKey: '', yKey: '', yLabel: 'Error', insight: '', sql: '', config: query, error: "Question definition not found." };

    const reqCheck = validateRequirements(activeQ as QuestionTemplate, mapping);
    if (activeQ.id !== 'custom_builder' && !reqCheck.valid) {
        return {
            data: [], xKey: '', yKey: '', yLabel: 'Error', insight: '', config: query,
            error: reqCheck.error,
            sql: `-- Validation Failed\n-- ${reqCheck.error}`
        };
    }

    let sql = activeQ.sql || `-- Dynamic SQL generated for ${activeQ.id}`;

    const { data, xKey, yKey, kpi, growth, sql: generatedSQL } = evaluateLocally(activeQ as any, dataset.rows, mapping, dates, query, dataset.name, dataset.dimDate);

    // INJECT DATE FILTERS INTO SQL PREVIEW
    let finalSQL = generatedSQL || sql;
    if (query.dateFilters && query.dateFilters.length > 0) {
        const whereClauses = query.dateFilters.map((df: any) => {
            const valStr = df.values.map((v: string) => `'${v}'`).join(', ');
            return `${df.column} IN (${valStr})`;
        });

        const filterStr = whereClauses.join(' AND ');

        if (finalSQL.includes('WHERE')) {
            finalSQL = finalSQL.replace('WHERE', `WHERE ${filterStr} AND`);
        } else if (finalSQL.includes('GROUP BY')) {
            finalSQL = finalSQL.replace('GROUP BY', `WHERE ${filterStr}\nGROUP BY`);
        } else if (finalSQL.includes('ORDER BY')) {
            finalSQL = finalSQL.replace('ORDER BY', `WHERE ${filterStr}\nORDER BY`);
        } else {
            finalSQL += `\nWHERE ${filterStr}`;
        }
    }

    // Heuristic for Custom Visualization
    let visuals = activeQ.vis || 'bar';
    if (activeQ.id === 'custom_builder') {
        const d = query.dimension;
        const lowerD = (d || '').toLowerCase();

        // No dimension = scalar KPI → show as card
        if (!d || d === '') {
            visuals = 'kpiCard';
        } else if (['day', 'week', 'month', 'year'].includes(d) || query.timeFilter?.startsWith('last_')) {
            visuals = 'line';
        } else if (d === 'status' || d === 'source') {
            visuals = 'pie';
        } else if (['country', 'state', 'city', 'region', 'province', 'territory'].includes(lowerD) || lowerD.includes('location') || lowerD.includes('geo')) {
            // Auto-detect geographic dimensions — use bar chart (map is unreliable)
            visuals = 'bar';
        } else {
            visuals = 'bar';
        }
    }

    // ─── VALIDATOR: Pre-execution ─────────────────────────────────
    const preValidation = validateAnalysis.pre(dataset, query);

    // ─── VALIDATOR: SQL validation ───────────────────────────────
    const sqlValidation = validateAnalysis.sql(finalSQL, dataset);

    const analysisResult: AnalysisResult = {
        data, xKey, yKey, yLabel: activeQ.question, kpi,
        insight: `${activeQ.question}`,
        sql: finalSQL,
        config: query,
        vis: visuals as any,
        growth
    };

    // ─── VALIDATOR: Post-execution ───────────────────────────────
    const postValidation = validateAnalysis.post(analysisResult, dataset);

    analysisResult.validation = {
        pre: preValidation,
        sql: sqlValidation,
        post: postValidation
    };

    return analysisResult;
};

// --- ETL & UTILS ---
export const inferColumnType = (key: string, sampleValues: any[]): ColumnType => {
    const lower = key.toLowerCase().trim();

    // 1. FORCE ID - Comprehensive ID patterns
    const idPatterns = [
        'id', 'row_id', 'record_id', 'pk', 'key',
        '_id', '_key', '_code', '_number', '_num',
        'sku', 'upc', 'barcode', 'isbn', 'ean',
        'zip', 'zipcode', 'postal', 'postcode',
        'ssn', 'ein', 'tin', 'vat',
        'guid', 'uuid', 'hash',
        'reference', 'ref_', 'confirmation',
        'tracking', 'serial', 'license'
    ];

    if (idPatterns.some(pattern =>
        lower === pattern ||
        lower.endsWith(pattern) ||
        lower.startsWith(pattern + '_') ||
        lower.includes('_' + pattern + '_')
    )) return ColumnType.ID;

    // 2. FORCE DATE - Comprehensive date/time patterns
    const datePatterns = [
        'date', 'time', 'timestamp', 'datetime',
        'day', 'week', 'month', 'quarter', 'year',
        'created', 'updated', 'modified', 'deleted',
        'start', 'end', 'begin', 'finish',
        'due', 'expiry', 'expires', 'expired',
        'birth', 'dob', 'anniversary',
        'scheduled', 'published', 'posted'
    ];

    if (datePatterns.some(pattern => lower.includes(pattern))) {
        return ColumnType.DATE;
    }

    // 3. FORCE DIMENSION - Geographic, categorical, and descriptive data (CHECK BEFORE METRICS)
    const dimensionKeywords = [
        // Geographic
        'country', 'state', 'province', 'region', 'city', 'town',
        'continent', 'territory', 'district', 'county', 'area',
        'location', 'address', 'street', 'avenue', 'road',

        // Categorical
        'category', 'type', 'kind', 'class', 'group', 'segment',
        'status', 'stage', 'phase', 'level', 'tier',
        'priority', 'severity', 'urgency',

        // Descriptive
        'name', 'title', 'description', 'label', 'tag',
        'color', 'style', 'model', 'version',
        'brand', 'manufacturer', 'vendor', 'supplier',

        // Currency/Financial descriptors (not amounts)
        'currency', 'currency_code', 'payment_method', 'payment_type',

        // Boolean-like (treat as dimensions for grouping)
        'is_', 'has_', 'can_', 'should_', 'flag', 'active', 'enabled',

        // Modes/Methods
        'mode', 'method', 'via', 'channel'
    ];

    if (dimensionKeywords.some(k => lower.includes(k))) {
        return ColumnType.DIMENSION;
    }

    // 3.5 BOOLEAN DATA CHECK — must run BEFORE metric keywords to catch columns like 'returned' (0/1)
    const validForBool = sampleValues.filter(v => v !== null && v !== '' && v !== undefined);
    if (validForBool.length > 0) {
        const booleanValues = validForBool.filter(v => {
            const str = String(v).toLowerCase().trim();
            return ['true', 'false', '1', '0', 'yes', 'no', 't', 'f', 'y', 'n'].includes(str);
        });
        // Also check if the column has only 2 distinct values (strong boolean signal)
        const distinctValues = new Set(validForBool.map(v => String(v).toLowerCase().trim()));
        const isBinaryColumn = distinctValues.size <= 2;

        if (booleanValues.length / validForBool.length > 0.8 || (isBinaryColumn && booleanValues.length > 0)) {
            return ColumnType.DIMENSION; // Booleans are categorical, not metrics
        }
    }

    // 4. FORCE METRIC - Comprehensive numeric/financial patterns
    const metricKeywords = [
        // Financial
        'price', 'cost', 'amount', 'total', 'subtotal', 'grand_total',
        'revenue', 'sales', 'income', 'earnings', 'profit', 'loss',
        'margin', 'markup', 'discount', 'rebate', 'refund',
        'tax', 'vat', 'duty', 'fee', 'charge', 'surcharge',
        'balance', 'credit', 'debit', 'payment', 'deposit',
        'budget', 'forecast', 'target', 'quota', 'goal',
        'value', 'worth', 'valuation', 'appraisal',

        // Quantities
        'quantity', 'qty', 'count', 'number_of', 'num_of',
        'units', 'items', 'pieces', 'volume', 'weight',
        'length', 'width', 'height', 'depth', 'size',
        'capacity', 'limit', 'maximum', 'minimum',

        // Metrics & KPIs
        'rate', 'ratio', 'percentage', 'percent', 'pct',
        'score', 'rating', 'rank', 'index', 'factor',
        'growth', 'change', 'delta', 'variance', 'deviation',
        'average', 'mean', 'median',
        'sum', 'total', 'aggregate',

        // Business metrics
        'conversion', 'retention', 'churn', 'attrition',
        'engagement', 'reach', 'impressions', 'clicks',
        'views', 'visits', 'sessions', 'users', 'customers',
        'orders', 'transactions', 'bookings', 'reservations',

        // Inventory & Operations
        'stock', 'inventory', 'on_hand', 'available',
        'shipped', 'delivered', 'returned', 'damaged',
        'lead_time', 'cycle_time', 'duration', 'elapsed',

        // HR & People
        'salary', 'wage', 'compensation', 'bonus', 'commission',
        'hours', 'overtime', 'pto', 'vacation', 'sick_days',
        'headcount', 'fte', 'employees', 'staff'
    ];

    if (metricKeywords.some(k => lower.includes(k))) {
        return ColumnType.METRIC;
    }

    // 5. DATA CONTENT ANALYSIS
    const valid = sampleValues.filter(v => v !== null && v !== '' && v !== undefined);
    if (valid.length === 0) return ColumnType.DIMENSION; // Default to dim if empty

    const numCount = valid.filter(v => {
        const s = String(v).replace(/[$,\s%]/g, ''); // Remove currency, pct, whitespace
        return !isNaN(Number(s)) && s.trim() !== '';
    }).length;

    const numericRatio = numCount / valid.length;

    // If >90% numeric, treat as metric (unless it looked like an ID earlier, which is already handled)
    if (numericRatio > 0.9) return ColumnType.METRIC;

    return ColumnType.DIMENSION;
};

// --- Delegated to etlPipeline.ts ---
import { runETLPipeline } from './etlPipeline';

export const runAutomatedETL = (
    rawData: any[],
    fileName: string,
    columnTypeOverrides?: Record<string, ColumnType>
): { rows: any[], logs: ETLLog[], columns: ColumnDefinition[], timeContext?: TimeContext, dimDate?: import('../types').DimDateRow[] } => {
    const result = runETLPipeline(rawData, fileName, columnTypeOverrides);
    return {
        rows: result.rows,
        logs: result.logs,
        columns: result.columns,
        timeContext: result.timeContext,
        dimDate: result.dimDate,
    };
};

export const autoPickConfig = (dataset: Dataset, intent: any, asOfDate?: string): QueryConfig => {
    return {
        questionId: intent?.questionId,
        asOfDate,
        metric: '', dimension: '', aggregation: AggregationType.SUM, timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD
    };
};

export const resolveMapping = (dataset: Dataset): CanonicalMapping => {
    const columns = dataset.columns.map(c => c.name);
    const fields: Record<string, string> = {};

    // ═══════════════════════════════════════════════════════════════════
    // FAST PATH: Use AI Domain Profile if available (100% accurate)
    // This completely bypasses the regex synonym dictionary below.
    // The AI profile is generated once at upload time by aiSemanticProfiler.ts
    // ═══════════════════════════════════════════════════════════════════
    if (dataset.domainProfile?.columnSemantics) {
        const semantics = dataset.domainProfile.columnSemantics;
        console.log(`[resolveMapping] Using AI domain profile: ${dataset.domainProfile.domain}`);

        for (const [colName, sem] of Object.entries(semantics)) {
            if (sem.isHidden) continue; // Skip junk columns

            // Map by semanticRole to canonical field names
            if (sem.semanticRole === 'primary_metric') {
                if (!fields['revenue']) fields['revenue'] = colName;
            } else if (sem.semanticRole === 'secondary_metric') {
                // Map to known secondary metric roles
                const lowerLabel = sem.humanLabel.toLowerCase();
                if (lowerLabel.includes('profit') || lowerLabel.includes('margin')) {
                    if (!fields['profit']) fields['profit'] = colName;
                } else if (lowerLabel.includes('cost') || lowerLabel.includes('expense')) {
                    if (!fields['cost']) fields['cost'] = colName;
                } else if (lowerLabel.includes('discount') || lowerLabel.includes('rebate')) {
                    if (!fields['discount']) fields['discount'] = colName;
                } else if (lowerLabel.includes('quantity') || lowerLabel.includes('count') || lowerLabel.includes('units')) {
                    if (!fields['quantity']) fields['quantity'] = colName;
                } else if (lowerLabel.includes('stock') || lowerLabel.includes('inventory')) {
                    if (!fields['stock']) fields['stock'] = colName;
                } else if (lowerLabel.includes('rating') || lowerLabel.includes('score')) {
                    if (!fields['rating']) fields['rating'] = colName;
                }
            } else if (sem.semanticRole === 'primary_date') {
                if (!fields['order_date']) fields['order_date'] = colName;
            } else if (sem.semanticRole === 'secondary_date') {
                if (!fields['ship_date']) fields['ship_date'] = colName;
            } else if (sem.semanticRole === 'primary_dimension') {
                if (!fields['product_name']) fields['product_name'] = colName;
            } else if (sem.semanticRole === 'secondary_dimension') {
                // Map to known secondary dimension roles
                const lowerLabel = sem.humanLabel.toLowerCase();
                if (lowerLabel.includes('customer') || lowerLabel.includes('client') || lowerLabel.includes('patient') || lowerLabel.includes('employee')) {
                    if (!fields['customer_name']) fields['customer_name'] = colName;
                } else if (lowerLabel.includes('category') || lowerLabel.includes('department') || lowerLabel.includes('ward')) {
                    if (!fields['category']) fields['category'] = colName;
                } else if (lowerLabel.includes('region') || lowerLabel.includes('area') || lowerLabel.includes('territory')) {
                    if (!fields['region']) fields['region'] = colName;
                } else if (lowerLabel.includes('channel') || lowerLabel.includes('source') || lowerLabel.includes('medium')) {
                    if (!fields['source']) fields['source'] = colName;
                } else if (lowerLabel.includes('campaign') || lowerLabel.includes('promotion')) {
                    if (!fields['campaign']) fields['campaign'] = colName;
                } else if (lowerLabel.includes('segment') || lowerLabel.includes('tier')) {
                    if (!fields['segment']) fields['segment'] = colName;
                } else if (lowerLabel.includes('city') || lowerLabel.includes('town')) {
                    if (!fields['city']) fields['city'] = colName;
                } else if (lowerLabel.includes('state') || lowerLabel.includes('province')) {
                    if (!fields['state']) fields['state'] = colName;
                } else if (lowerLabel.includes('country') || lowerLabel.includes('nation')) {
                    if (!fields['country']) fields['country'] = colName;
                } else if (lowerLabel.includes('status') || lowerLabel.includes('stage')) {
                    if (!fields['status']) fields['status'] = colName;
                }
            } else if (sem.semanticRole === 'identifier') {
                const lowerLabel = sem.humanLabel.toLowerCase();
                if (lowerLabel.includes('order') || lowerLabel.includes('transaction') || lowerLabel.includes('invoice')) {
                    if (!fields['order_id']) fields['order_id'] = colName;
                } else if (lowerLabel.includes('product') || lowerLabel.includes('item') || lowerLabel.includes('sku')) {
                    if (!fields['product_id']) fields['product_id'] = colName;
                } else if (lowerLabel.includes('customer') || lowerLabel.includes('client') || lowerLabel.includes('patient') || lowerLabel.includes('employee')) {
                    if (!fields['customer_id']) fields['customer_id'] = colName;
                }
            }
        }

        console.log('[resolveMapping] AI Semantic roles:', fields);
        return { schemaType: 'flat', fields, missingFields: [] };
    }

    // ═══════════════════════════════════════════════════════════════════
    // FALLBACK: COMPREHENSIVE SYNONYM DICTIONARY — Covers global naming conventions
    // Each role maps to an array of synonyms (lowercase). The engine will
    // match exact, stem, token, contains, and prefix to find the best fit.
    // ═══════════════════════════════════════════════════════════════════
    const heuristics: Record<string, string[]> = {
        'revenue': [
            // English
            'revenue', 'sales', 'sale', 'total_sales', 'net_sales', 'gross_sales',
            'amount', 'total_amount', 'net_amount', 'gross_amount', 'transaction_amount',
            'sale_amount', 'sales_amount', 'sale_amt', 'sales_amt', 'amt',
            'price', 'unit_price', 'selling_price', 'sale_price', 'list_price',
            'total_price', 'extended_price', 'line_total', 'order_total',
            'value', 'total_value', 'order_value', 'transaction_value', 'purchase_amount',
            'income', 'total_income', 'gross_income', 'net_income',
            'turnover', 'total_turnover', 'gross_turnover',
            'proceeds', 'receipts', 'total_receipts',
            'billing', 'billed_amount', 'invoice_amount', 'invoice_total',
            'gmv', 'gross_merchandise_value', 'merchandise_value',
            'rev', 'total_rev', 'net_rev', 'gross_rev',
            'total', 'grand_total', 'subtotal', 'sub_total',
            'payment', 'payment_amount', 'pay_amount', 'pay_amt',
            'spend', 'total_spend', 'expenditure',
            'earnings', 'total_earnings',
            'money', 'cash', 'dollars', 'usd', 'gbp', 'eur',
            'topline', 'top_line',
            // Abbreviated
            'tot_sales', 'tot_amt', 'tot_rev', 'ttl_sales', 'ttl_amt',
            'sls', 'sls_amt', 'sl_amt', 'rev_amt',
        ],
        'profit': [
            'profit', 'net_profit', 'gross_profit', 'total_profit',
            'margin', 'net_margin', 'gross_margin', 'profit_margin',
            'earnings', 'net_earnings', 'operating_income', 'operating_profit',
            'ebitda', 'ebit', 'bottom_line', 'pnl', 'p_and_l',
            'contribution', 'contribution_margin',
            'surplus', 'gain', 'net_gain',
            'prof', 'prft', 'mrgn',
        ],
        'cost': [
            'cost', 'total_cost', 'unit_cost', 'cogs', 'cost_of_goods',
            'cost_of_goods_sold', 'cost_price', 'purchase_price', 'buying_price',
            'expense', 'expenses', 'total_expense', 'operating_expense',
            'opex', 'capex', 'overhead', 'cost_amount', 'cost_amt',
        ],
        'discount': [
            'discount', 'discount_amount', 'discount_amt', 'disc', 'disc_amt',
            'discount_pct', 'discount_percent', 'discount_rate', 'rebate',
            'markdown', 'allowance', 'deduction', 'promo_discount',
            'coupon', 'coupon_amount', 'voucher', 'voucher_amount',
        ],
        'order_date': [
            'order_date', 'orderdate', 'date', 'transaction_date', 'txn_date',
            'purchase_date', 'sale_date', 'saledate', 'sales_date',
            'created_at', 'created_date', 'creation_date', 'create_date',
            'invoice_date', 'billing_date', 'booking_date', 'record_date',
            'entry_date', 'posted_date', 'posting_date', 'effective_date',
            'order_dt', 'txn_dt', 'trans_date', 'trans_dt',
            'dt', 'ord_date', 'ord_dt',
            'event_date', 'activity_date', 'interaction_date',
            'period', 'period_date', 'report_date', 'reporting_date',
        ],
        'ship_date': [
            'ship_date', 'shipped_date', 'shipping_date', 'delivery_date',
            'dispatch_date', 'fulfillment_date', 'fulfilled_date',
            'ship_dt', 'delivery_dt', 'dispatch_dt', 'shipdate',
            'received_date', 'arrival_date', 'eta', 'delivered_date',
            'completion_date', 'close_date',
        ],
        'order_id': [
            'order_id', 'orderid', 'order_number', 'order_no', 'order_num',
            'transaction_id', 'txn_id', 'invoice_id', 'invoice_number',
            'invoice_no', 'receipt_id', 'receipt_no', 'ticket_id',
            'confirmation_number', 'reference_number', 'ref_no', 'ref_id',
            'po_number', 'purchase_order', 'booking_id', 'booking_no',
            'ord_id', 'ord_no', 'sale_id', 'sales_id',
        ],
        'product_name': [
            'product_name', 'product', 'product_title', 'product_label',
            'item_name', 'item', 'item_title', 'item_description',
            'product_description', 'sku_name', 'sku_description',
            'goods', 'merchandise', 'article', 'article_name',
            'prod_name', 'prod', 'prod_desc', 'item_desc',
            'material', 'material_name', 'material_description',
            'offering', 'service_name', 'service',
        ],
        'product_id': [
            'product_id', 'productid', 'sku', 'sku_id', 'sku_code',
            'item_id', 'item_code', 'item_number', 'item_no',
            'upc', 'ean', 'asin', 'barcode', 'part_number', 'part_no',
            'prod_id', 'prod_code', 'article_id', 'article_no',
            'material_id', 'material_no', 'catalog_id',
        ],
        'quantity': [
            'quantity', 'qty', 'units', 'unit_count', 'count',
            'items_sold', 'units_sold', 'qty_sold', 'quantity_sold',
            'order_quantity', 'order_qty', 'sales_qty', 'sale_qty',
            'volume', 'pcs', 'pieces', 'num_items', 'number_of_items',
            'item_count', 'total_qty', 'total_quantity',
            'demand', 'ordered', 'shipped_qty', 'delivered_qty',
        ],
        'customer_id': [
            'customer_id', 'customerid', 'cust_id', 'custid', 'client_id',
            'buyer_id', 'account_id', 'acct_id', 'user_id', 'userid',
            'member_id', 'memberid', 'subscriber_id', 'patron_id',
            'shopper_id', 'consumer_id', 'party_id',
            'email', 'email_address', 'customer_email',
        ],
        'customer_name': [
            'customer_name', 'customer', 'client_name', 'client',
            'buyer_name', 'buyer', 'account_name', 'account',
            'full_name', 'name', 'contact_name', 'contact',
            'first_name', 'last_name', 'person_name', 'person',
            'member_name', 'member', 'subscriber_name',
            'cust_name', 'cust', 'patron_name', 'patron',
            'user_name', 'username', 'display_name',
        ],
        'category': [
            'category', 'product_category', 'item_category',
            'sub_category', 'subcategory', 'sub category',
            'department', 'division', 'section',
            'class', 'classification', 'group', 'product_group',
            'type', 'product_type', 'item_type',
            'family', 'product_family', 'product_line', 'line',
            'cat', 'categ', 'prod_cat', 'main_category',
            'tier', 'level', 'hierarchy',
        ],
        'segment': [
            'segment', 'customer_segment', 'market_segment',
            'tier', 'customer_tier', 'loyalty_tier',
            'cohort', 'customer_cohort', 'customer_type', 'customer_group',
            'persona', 'demographic', 'psychographic',
            'classification', 'rating', 'grade', 'rank',
            'buyer_type', 'account_type',
        ],
        'source': [
            'source', 'utm_source', 'traffic_source', 'acquisition_source',
            'lead_source', 'referral_source', 'origin', 'referral',
            'acquisition_channel', 'marketing_source',
            'src', 'ref', 'referrer',
        ],
        'channel': [
            'channel', 'sales_channel', 'distribution_channel',
            'marketing_channel', 'medium', 'utm_medium',
            'platform', 'marketplace', 'storefront', 'store',
            'outlet', 'venue', 'touchpoint', 'point_of_sale', 'pos',
        ],
        'campaign': [
            'campaign', 'campaign_name', 'campaign_id',
            'utm_campaign', 'promo', 'promotion', 'promotion_name',
            'ad_campaign', 'marketing_campaign', 'initiative',
        ],
        'region': [
            'region', 'area', 'territory', 'zone', 'geography', 'geo',
            'market', 'market_area', 'sales_region', 'sales_territory',
            'district', 'division', 'locale', 'location',
        ],
        'city': [
            'city', 'city_name', 'metro', 'metro_area', 'town',
            'municipality', 'urban_area', 'locality',
        ],
        'state': [
            'state', 'state_name', 'province', 'province_name',
            'county', 'county_name', 'prefecture',
            'administrative_area', 'admin_area',
        ],
        'country': [
            'country', 'country_name', 'nation', 'country_code',
            'iso_country', 'territory',
        ],
        'ship_mode': [
            'ship_mode', 'shipping_mode', 'shipping_method', 'delivery_method',
            'shipment_type', 'shipping_type', 'freight_type',
            'carrier', 'shipping_carrier', 'courier',
            'delivery_type', 'fulfillment_method', 'ship_method',
            'shipping', 'transport', 'transport_mode',
        ],
        'stock': [
            'inventory', 'stock', 'qty_on_hand', 'quantity_on_hand',
            'stock_level', 'stock_qty', 'available_qty',
            'on_hand', 'warehouse_qty', 'supply',
            'stock_count', 'inventory_level', 'inventory_count',
        ],
        'rating': [
            'rating', 'review_rating', 'score', 'stars',
            'customer_rating', 'product_rating', 'satisfaction',
            'nps', 'net_promoter_score', 'feedback_score',
            'quality_score', 'avg_rating', 'average_rating',
        ],
        'status': [
            'status', 'order_status', 'shipment_status', 'delivery_status',
            'payment_status', 'fulfillment_status', 'state',
            'condition', 'stage', 'phase', 'progress',
        ],
    };

    // ═══════════════════════════════════════════════════════════════════
    // MATCHING ENGINE — Multi-strategy scoring
    // ═══════════════════════════════════════════════════════════════════

    // Simple stemmer: reduce common suffixes for fuzzy matching
    const stem = (word: string): string => {
        if (word.length <= 3) return word;
        if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
        if (word.endsWith('tion')) return word.slice(0, -4);
        if (word.endsWith('ment')) return word.slice(0, -4);
        if (word.endsWith('ness')) return word.slice(0, -4);
        if (word.endsWith('ing')) return word.slice(0, -3);
        if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
        if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
        if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
        return word;
    };

    // Tokenize a column name: split on _, -, spaces, camelCase
    const tokenize = (name: string): string[] => {
        return name
            .replace(/([a-z])([A-Z])/g, '$1_$2')  // camelCase → snake_case
            .toLowerCase()
            .split(/[_\-\s.]+/)
            .filter(t => t.length > 0);
    };

    // Score how well a column matches a set of synonyms
    const scoreMatch = (colName: string, synonyms: string[]): number => {
        const lowerCol = colName.toLowerCase();
        const colTokens = tokenize(colName);
        const colStems = colTokens.map(stem);
        const colJoined = colTokens.join('');  // e.g., "sale_amt" → "saleamt"

        let bestScore = 0;

        for (const syn of synonyms) {
            const synTokens = tokenize(syn);
            const synStems = synTokens.map(stem);
            const synJoined = synTokens.join('');

            // Strategy 1: EXACT MATCH (score=100)
            if (lowerCol === syn || colJoined === synJoined) {
                return 100;
            }

            // Strategy 2: STEM EXACT MATCH — "sales" stem matches "sale" (score=90)
            if (colStems.join('') === synStems.join('')) {
                bestScore = Math.max(bestScore, 90);
                continue;
            }

            // Strategy 3: TOKEN MATCH — all synonym tokens found in column tokens (score=80)
            const allSynTokensFound = synTokens.every(st =>
                colTokens.some(ct => ct === st || stem(ct) === stem(st))
            );
            if (allSynTokensFound && synTokens.length > 0) {
                // Bonus for longer match (more specific)
                const specificity = synTokens.length / Math.max(colTokens.length, 1);
                bestScore = Math.max(bestScore, 70 + Math.round(specificity * 10));
                continue;
            }

            // Strategy 4: CONTAINS — column contains synonym or vice versa (score=60)
            if (syn.length >= 3 && (lowerCol.includes(syn) || syn.includes(lowerCol))) {
                bestScore = Math.max(bestScore, 60);
                continue;
            }

            // Strategy 5: STEM CONTAINS — stemmed tokens overlap (score=50)
            const stemOverlap = synStems.filter(ss => colStems.includes(ss)).length;
            if (stemOverlap > 0) {
                const overlapRatio = stemOverlap / synStems.length;
                bestScore = Math.max(bestScore, 40 + Math.round(overlapRatio * 20));
                continue;
            }

            // Strategy 6: PREFIX MATCH (score=40)
            if (syn.length >= 3 && lowerCol.startsWith(syn)) {
                bestScore = Math.max(bestScore, 40);
            }
        }

        return bestScore;
    };

    // For each semantic role, find the best matching column
    Object.entries(heuristics).forEach(([role, synonyms]) => {
        let bestCol = '';
        let bestScore = 0;

        for (const col of columns) {
            // Skip columns already assigned to a higher-priority role
            // (revenue is highest priority for metrics)
            const score = scoreMatch(col, synonyms);

            // Prevent _name roles from matching _id columns
            if (role.endsWith('_name') || role === 'customer_name' || role === 'product_name') {
                const lc = col.toLowerCase();
                if (lc.endsWith('_id') || lc.endsWith('id') || lc === 'id') {
                    continue;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestCol = col;
            }
        }

        // Only accept matches above a minimum confidence threshold
        if (bestCol && bestScore >= 40) {
            fields[role] = bestCol;
        }
    });

    // ── POST-PROCESSING ──
    // If a _name role resolved to _id column, try to find a better match
    for (const role of Object.keys(fields)) {
        if (role.endsWith('_name') || role === 'customer_name' || role === 'product_name') {
            const resolvedCol = fields[role];
            if (resolvedCol) {
                const lowerCol = resolvedCol.toLowerCase();
                if (lowerCol.endsWith('_id') || lowerCol.endsWith(' id') || lowerCol === 'id') {
                    const entityBase = lowerCol.replace(/_?id$/i, '').replace(/ ?id$/i, '');
                    const nameCol = columns.find(c => {
                        const lc = c.toLowerCase();
                        return (lc.includes(entityBase) && (lc.includes('name') || lc.includes('title') || lc.includes('label'))) ||
                            (lc === entityBase && !lc.endsWith('id'));
                    });
                    if (nameCol) {
                        fields[role] = nameCol;
                    }
                }
            }
        }
    }

    console.log('[resolveMapping] Semantic roles:', fields);
    return { schemaType: 'flat', fields, missingFields: [] };
};

export interface ColumnInfo {
    name: string;
    dataType: string;
    isNullable: boolean;
    isPK: boolean;
    maxLength: number;
}

export interface ForeignKeyInfo {
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
}

export interface JoinEdge {
    leftTable: string;
    rightTable: string;
    leftColumn: string;
    rightColumn: string;
    type: 'fk' | 'name_match';
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  FACT TABLE DETECTION — Retail Data Modelling Conventions       ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Score a table name against known fact table name patterns.
 * Higher score = more likely to be a fact table.
 * Rule: NEVER start joins from stores, products, employees, categories.
 * ALWAYS start from transaction_items, transactions, order_items, etc.
 */
const FACT_TABLE_PATTERNS: { pattern: RegExp; score: number }[] = [
    // Most granular facts first (line items)
    { pattern: /transaction_?items?|order_?items?|order_?lines?|line_?items?|sale_?items?|invoice_?items?|invoice_?lines?/i, score: 100 },
    // Standard fact tables
    { pattern: /^transactions?$|^orders?$|^sales?$|^invoices?$/i, score: 80 },
    { pattern: /^purchases?$|^receipts?$|^bookings?$/i, score: 75 },
    // Inventory / movement facts
    { pattern: /inventory_?movements?|stock_?movements?|inventory_?transactions?/i, score: 70 },
    // Broader fact-like tables
    { pattern: /facts?_|_facts?|measurements?|events?_log|activity/i, score: 60 },
    // Dimension table negative signals — we penalize these
    { pattern: /^stores?$|^products?$|^customers?$|^employees?$|^categor/i, score: -50 },
    { pattern: /^suppliers?$|^vendors?$|^staff$|^users?$|^regions?$|^zones?$/i, score: -40 },
];

/**
 * Detect the best fact table to use as the join root from a list of table names.
 * Returns the table name with the highest fact score, using column count as a tiebreaker
 * (more columns often means more granular / fact-like).
 */
export const detectFactTable = (
    selectedTables: string[],
    tableColumns: Record<string, ColumnInfo[]>
): string => {
    let bestTable = selectedTables[0];
    let bestScore = -Infinity;

    for (const tbl of selectedTables) {
        let score = 0;
        for (const { pattern, score: s } of FACT_TABLE_PATTERNS) {
            if (pattern.test(tbl)) { score += s; }
        }
        // Use column count as tiebreaker — more columns = more likely to be a fact
        const colCount = (tableColumns[tbl] || []).length;
        score += colCount * 0.5;

        if (score > bestScore) {
            bestScore = score;
            bestTable = tbl;
        }
    }

    console.log(`[JoinStrategy] Fact table detected: ${bestTable} (score=${bestScore.toFixed(1)}`);
    return bestTable;
};

/**
 * Detect the best fact table from actual data tables (using row counts).
 * Used inside autoJoinDatasets where we have real data, not just column metadata.
 */
export const detectFactTableFromData = (
    tables: Record<string, any[]>
): string => {
    const names = Object.keys(tables);
    if (names.length === 0) return '';
    if (names.length === 1) return names[0];

    let bestTable = names[0];
    let bestScore = -Infinity;

    for (const tbl of names) {
        let score = 0;
        for (const { pattern, score: s } of FACT_TABLE_PATTERNS) {
            if (pattern.test(tbl)) { score += s; }
        }
        // Row count is a strong signal — facts have more rows than dimensions
        const rowCount = (tables[tbl] || []).length;
        score += rowCount * 0.1;

        if (score > bestScore) {
            bestScore = score;
            bestTable = tbl;
        }
    }

    console.log(`[JoinStrategy] Fact table detected from data: ${bestTable} (score=${bestScore.toFixed(1)}, rows=${(tables[bestTable] || []).length})`);
    return bestTable;
};

/**
 * Detect join relationships between selected tables.
 *
 * FIXED: Uses fact-table-first strategy.
 * The fact table (transaction_items, transactions, orders, etc.) is always
 * the root of the join tree. Dimension tables (stores, products, categories)
 * are joined to it, not the other way around.
 *
 * Correct join path for retail:
 *   transaction_items → transactions → stores (via store_id)
 *   transaction_items → products → product_categories (via product_id)
 *
 * Uses FK metadata first, then falls back to same-name column matching.
 */
export const buildJoinStrategy = (
    selectedTables: string[],
    tableColumns: Record<string, ColumnInfo[]>,
    foreignKeys: ForeignKeyInfo[]
): JoinEdge[] => {
    if (selectedTables.length === 0) return [];
    if (selectedTables.length === 1) return [];

    const edges: JoinEdge[] = [];
    const added = new Set<string>();

    // ── Detect the fact table — this becomes the root ──
    const factTable = detectFactTable(selectedTables, tableColumns);
    const dimensionTables = selectedTables.filter(t => t !== factTable);

    // ── Step 1: FK-based joins (reorient to start from fact table) ──
    for (const fk of foreignKeys) {
        const fromIncluded = selectedTables.includes(fk.fromTable);
        const toIncluded = selectedTables.includes(fk.toTable);
        if (!fromIncluded || !toIncluded) continue;

        // Normalise FK direction: the FK with more rows should be on the left.
        // If this FK goes from a dimension to the fact table, flip it so the
        // fact table is on the left (the base).
        let leftTable = fk.fromTable;
        let rightTable = fk.toTable;
        let leftColumn = fk.fromColumn;
        let rightColumn = fk.toColumn;

        // If the FK source is a dimension and target is the fact table, flip
        if (rightTable === factTable || detectFactTable([leftTable], tableColumns) !== leftTable) {
            // flip only if the right table is the detected fact — otherwise keep as-is
            // We never flip FKs whose source is already the most fact-like table.
        }

        const key = `${leftTable}.${leftColumn}->${rightTable}.${rightColumn}`;
        const keyFlipped = `${rightTable}.${rightColumn}->${leftTable}.${leftColumn}`;
        if (!added.has(key) && !added.has(keyFlipped)) {
            edges.push({ leftTable, rightTable, leftColumn, rightColumn, type: 'fk' });
            added.add(key);
        }
    }

    // ── Step 2: Build the join order — fact table as root ──
    // We will BFS from the fact table outward, connecting dimension tables.
    const joined = new Set<string>([factTable]);
    const orderedEdges: JoinEdge[] = [];

    // First, find which FK edges already touch the fact table
    const factEdges = edges.filter(
        e => e.leftTable === factTable || e.rightTable === factTable
    );
    for (const e of factEdges) {
        // Reorient so fact table is always on the left
        if (e.rightTable === factTable) {
            orderedEdges.push({
                leftTable: e.rightTable,
                rightTable: e.leftTable,
                leftColumn: e.rightColumn,
                rightColumn: e.leftColumn,
                type: e.type,
            });
        } else {
            orderedEdges.push(e);
        }
        joined.add(e.leftTable === factTable ? e.rightTable : e.leftTable);
    }

    // Then BFS for remaining tables connected through already-joined tables
    let changed = true;
    while (changed) {
        changed = false;
        for (const e of edges) {
            const leftJoined = joined.has(e.leftTable);
            const rightJoined = joined.has(e.rightTable);
            if (leftJoined && !rightJoined) {
                orderedEdges.push(e);
                joined.add(e.rightTable);
                changed = true;
            } else if (rightJoined && !leftJoined) {
                orderedEdges.push({
                    leftTable: e.rightTable, rightTable: e.leftTable,
                    leftColumn: e.rightColumn, rightColumn: e.leftColumn,
                    type: e.type,
                });
                joined.add(e.leftTable);
                changed = true;
            }
        }
    }

    // ── Step 3: Name-match fallback — iterative multi-pass BFS ──
    // Single-pass won't work for chains like: transaction_items → transactions → stores
    // because stores can only be found after transactions is already in `joined`.
    // We loop repeatedly until nothing new can be connected.
    const pendingNM = new Set(selectedTables.filter(t => !joined.has(t)));
    let nmProgress = true;

    while (nmProgress && pendingNM.size > 0) {
        nmProgress = false;

        for (const tbl of [...pendingNM]) {
            const tblCols = (tableColumns[tbl] || []).map(c => c.name.toLowerCase());
            let bestMatch: { baseTable: string; col: string; tblCol: string; score: number } | null = null;

            // Search through ALL already-joined tables for a matching column
            for (const bTbl of [...joined]) {
                const baseCols = (tableColumns[bTbl] || []).map(c => c.name.toLowerCase());

                for (const bc of baseCols) {
                    if (!tblCols.includes(bc)) continue;

                    // Score match quality: prefer _id columns (FK-like)
                    const matchScore =
                        (bc.endsWith('_id') || bc === 'id') ? 10 :
                            bc.endsWith('id') ? 8 :
                                bc.endsWith('_code') || bc.endsWith('_key') ? 6 : 2;

                    if (!bestMatch || matchScore > bestMatch.score) {
                        bestMatch = { baseTable: bTbl, col: bc, tblCol: bc, score: matchScore };
                    }
                }
            }

            if (bestMatch) {
                orderedEdges.push({
                    leftTable: bestMatch.baseTable, rightTable: tbl,
                    leftColumn: bestMatch.col, rightColumn: bestMatch.tblCol,
                    type: 'name_match',
                });
                joined.add(tbl);
                pendingNM.delete(tbl);
                nmProgress = true;
                console.log(`[JoinStrategy] Name-match: ${bestMatch.baseTable}.${bestMatch.col} → ${tbl}.${bestMatch.tblCol}`);
            }
        }
    }

    for (const tbl of pendingNM) {
        console.warn(`[JoinStrategy] Could not connect table: ${tbl} — no matching column found`);
    }

    console.log(`[JoinStrategy] Join path (root=${factTable}):`, orderedEdges.map(e =>
        `${e.leftTable}.${e.leftColumn} → ${e.rightTable}.${e.rightColumn} [${e.type}]`
    ).join(' | '));

    return orderedEdges;
};

/**
 * Join multiple tables into a single master table using LEFT JOIN cascade.
 *
 * FIXED: The base table is now the FACT table (highest row count / matching
 * fact table name patterns), not whichever table happens to be first in the list.
 *
 * Correct retail join order:
 *   transaction_items (FACT - base)
 *       ↓ transaction_id
 *   transactions
 *       ↓ store_id         ↓ cashier_id
 *   stores             employees
 *       ↓ product_id
 *   products
 *       ↓ category_id
 *   product_categories
 *
 * This guarantees the result has N rows = fact table grain (e.g. ~200 rows),
 * NOT 2 rows (stores) or 20 rows (products).
 */
export const autoJoinDatasets = (
    tables: Record<string, any[]>,
    joinEdges?: JoinEdge[]
): { mergedRows: any[]; joinLogs: string[] } => {
    const keys = Object.keys(tables);
    if (keys.length === 0) return { mergedRows: [], joinLogs: ['No tables to join'] };
    if (keys.length === 1) return { mergedRows: tables[keys[0]] || [], joinLogs: [`Single table: ${keys[0]} (${(tables[keys[0]] || []).length} rows)`] };

    const logs: string[] = [];

    // ── Detect the fact table — this is always the LEFT/base of the join ──
    const factTable = detectFactTableFromData(tables);

    // ── No join edges provided: use fact-first name-match fallback ──
    if (!joinEdges || joinEdges.length === 0) {
        const remainingTables = keys.filter(k => k !== factTable);
        let merged = [...(tables[factTable] || [])];
        logs.push(`Base table (FACT): ${factTable} (${merged.length} rows)`);

        for (const rightTable of remainingTables) {
            const rightRows = tables[rightTable] || [];
            if (rightRows.length === 0) {
                logs.push(`SKIP ${rightTable} — empty table`);
                continue;
            }

            const leftCols = new Set(Object.keys(merged[0] || {}));
            const rightCols = Object.keys(rightRows[0] || {});

            // Find the best shared ID column
            // Priority: _id suffix > id suffix > any shared column
            let sharedCol: string | undefined;
            sharedCol = rightCols.find(c =>
                leftCols.has(c) && c.toLowerCase().endsWith('_id')
            );
            if (!sharedCol) {
                sharedCol = rightCols.find(c =>
                    leftCols.has(c) && c.toLowerCase().endsWith('id')
                );
            }
            if (!sharedCol) {
                sharedCol = rightCols.find(c => leftCols.has(c));
            }

            if (sharedCol) {
                // Build a lookup map from the dimension table (1:1 or many:1)
                const rightMap = new Map<string, any>();
                rightRows.forEach(r => rightMap.set(String(r[sharedCol!]), r));

                const beforeCount = merged.length;
                merged = merged.map(row => {
                    const match = rightMap.get(String(row[sharedCol!]));
                    if (match) {
                        const enriched: any = {};
                        for (const [k, v] of Object.entries(match)) {
                            if (k === sharedCol) continue;
                            enriched[leftCols.has(k) ? `${rightTable}_${k}` : k] = v;
                        }
                        return { ...row, ...enriched };
                    }
                    return row;
                });
                logs.push(`LEFT JOIN ${rightTable} ON ${sharedCol} → ${merged.length} rows (was ${beforeCount})`);
            } else {
                logs.push(`SKIP ${rightTable} — no shared ID column with ${factTable}`);
            }
        }
        return { mergedRows: merged, joinLogs: logs };
    }

    // ── Use provided join edges (from buildJoinStrategy) ──
    // The edges are already ordered correctly (fact-first) by buildJoinStrategy.
    // We pick the root from the first edge's leftTable, but re-check against
    // the detected fact table to be safe.
    const edgeRoot = joinEdges[0]?.leftTable || factTable;

    // Use whichever of the two has more rows as the true root
    const edgeRootRows = (tables[edgeRoot] || []).length;
    const factRows = (tables[factTable] || []).length;
    const rootTable = factRows >= edgeRootRows ? factTable : edgeRoot;

    let merged = [...(tables[rootTable] || [])];
    const joined = new Set<string>([rootTable]);
    logs.push(`Base table (FACT): ${rootTable} (${merged.length} rows)`);

    // Process edges in topological order
    // We do multiple passes to handle cases where an edge references a not-yet-joined table
    const pending = [...joinEdges];
    let maxPasses = pending.length + 1;

    while (pending.length > 0 && maxPasses-- > 0) {
        let progress = false;

        for (let i = pending.length - 1; i >= 0; i--) {
            const edge = pending[i];

            // Determine which side is already joined (the left in our result set)
            let leftCol: string;
            let rightName: string;
            let rightCol: string;

            if (joined.has(edge.leftTable) && !joined.has(edge.rightTable)) {
                leftCol = edge.leftColumn;
                rightName = edge.rightTable;
                rightCol = edge.rightColumn;
            } else if (joined.has(edge.rightTable) && !joined.has(edge.leftTable)) {
                // Flip the edge — the right table is already joined, left is the new one
                leftCol = edge.rightColumn;
                rightName = edge.leftTable;
                rightCol = edge.leftColumn;
            } else {
                // Both sides already joined or neither — skip for now
                if (joined.has(edge.leftTable) && joined.has(edge.rightTable)) {
                    pending.splice(i, 1); // already done
                }
                continue;
            }

            const rightRows = tables[rightName] || [];
            if (rightRows.length === 0) {
                logs.push(`SKIP ${rightName} — empty table`);
                pending.splice(i, 1);
                progress = true;
                continue;
            }

            const leftColsSet = new Set(Object.keys(merged[0] || {}));

            // Build a 1-to-1 lookup map from the dimension/right table
            const rightMap = new Map<string, any>();
            rightRows.forEach(r => rightMap.set(String(r[rightCol]), r));

            const beforeCount = merged.length;
            merged = merged.map(row => {
                const match = rightMap.get(String(row[leftCol]));
                if (match) {
                    const enriched: any = {};
                    for (const [k, v] of Object.entries(match)) {
                        if (k === rightCol) continue;
                        enriched[leftColsSet.has(k) ? `${rightName}_${k}` : k] = v;
                    }
                    return { ...row, ...enriched };
                }
                return row;
            });

            joined.add(rightName);
            logs.push(`LEFT JOIN ${rightName} ON ${leftCol} = ${rightCol} [${edge.type}] → ${merged.length} rows (was ${beforeCount})`);
            pending.splice(i, 1);
            progress = true;
        }

        if (!progress) break; // No more progress possible
    }

    // Log any tables that couldn't be joined
    for (const edge of pending) {
        logs.push(`WARN: Could not join ${edge.leftTable} ↔ ${edge.rightTable} — orphaned edge`);
    }

    return { mergedRows: merged, joinLogs: logs };
};

export const parseCSV = (text: string): any[] => {
    const lines = text.trim().split('\n');
    const headers = parseCSVLine(lines[0]);
    return lines.slice(1)
        .filter(line => line.trim() !== '')
        .map(line => {
            const v = parseCSVLine(line);
            return headers.reduce((acc, h, i) => ({ ...acc, [h]: v[i]?.trim() ?? '' }), {});
        });
};

/** Parse a single CSV line respecting quoted fields (RFC 4180) */
function parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                // Check for escaped quote ("")
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++; // skip next quote
                } else {
                    inQuotes = false; // end of quoted field
                }
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                fields.push(current.trim());
                current = '';
            } else if (ch === '\r') {
                // skip carriage return
            } else {
                current += ch;
            }
        }
    }
    fields.push(current.trim());
    return fields;
}

export const parseExcel = async (file: File): Promise<any[]> => {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = (e) => {
            // cellDates: true → dates arrive as JS Date objects instead of serial numbers
            const wb = XLSX.read(e.target?.result, { type: 'binary', cellDates: true });
            resolve(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]));
        };
        reader.readAsBinaryString(file);
    });
};

/**
 * Parse ALL sheets from an Excel file.
 * Returns { sheetCount, sheets: Record<sheetName, rows[]> }
 */
export const parseExcelMultiSheet = async (file: File): Promise<{ sheetCount: number; sheets: Record<string, any[]> }> => {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = (e) => {
            // cellDates: true → dates arrive as JS Date objects instead of serial numbers
            const wb = XLSX.read(e.target?.result, { type: 'binary', cellDates: true });
            const sheets: Record<string, any[]> = {};
            for (const name of wb.SheetNames) {
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[name]);
                if (rows.length > 0) {
                    sheets[name] = rows;
                }
            }
            resolve({ sheetCount: wb.SheetNames.length, sheets });
        };
        reader.readAsBinaryString(file);
    });
};

export const getSampleData = () => `order_id,order_date,product_name,quantity,revenue
101,2025-02-20,Laptop,1,1200
102,2025-02-20,Mouse,2,50`;

export interface TableInfo {
    name: string;
    rows: number;
    category: string;
    columns?: ColumnInfo[];
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5002/api';

export const connectToDatabase = async (config: {
    host: string;
    port: string;
    database: string;
    username?: string;
    password?: string;
    useWindowsAuth: boolean;
    dbType?: 'mssql' | 'postgres';
    ssl?: boolean;
}): Promise<{ success: boolean; connectionId?: string; error?: string }> => {
    try {
        const endpoint = config.dbType === 'postgres' ? `${API_BASE_URL}/pg/connect` : `${API_BASE_URL}/connect`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        // Handle non-OK responses gracefully
        if (!response.ok) {
            const text = await response.text();
            try {
                const data = JSON.parse(text);
                return { success: false, error: data.error || `Server error (${response.status})` };
            } catch {
                return { success: false, error: `Backend returned ${response.status}: ${text.slice(0, 200) || 'No response body'}` };
            }
        }

        return await response.json();
    } catch (error: any) {
        // Network error — backend not running
        if (error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError') || error.message?.includes('ECONNREFUSED')) {
            return {
                success: false,
                error: `Cannot reach backend API at ${API_BASE_URL}. Make sure the backend server is running: cd backend && node server.js`
            };
        }
        return { success: false, error: error.message };
    }
};

// Helper to determine API prefix from connectionId
const getApiPrefix = (connectionId: string) => connectionId.startsWith('pg_') ? '/pg' : '';

export const getMockDatabaseSchema = async (connectionId: string): Promise<TableInfo[]> => {
    try {
        const prefix = getApiPrefix(connectionId);
        const response = await fetch(`${API_BASE_URL}${prefix}/schema`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connectionId })
        });
        const data = await response.json();
        return data.success ? data.tables : [];
    } catch (error) {
        console.error('Schema fetch error:', error);
        return [];
    }
};

export const fetchTableColumns = async (connectionId: string, table: string): Promise<ColumnInfo[]> => {
    try {
        const prefix = getApiPrefix(connectionId);
        const response = await fetch(`${API_BASE_URL}${prefix}/columns`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connectionId, table })
        });
        const data = await response.json();
        return data.success ? data.columns : [];
    } catch (error) {
        console.error('Column fetch error:', error);
        return [];
    }
};

export const fetchForeignKeys = async (connectionId: string): Promise<ForeignKeyInfo[]> => {
    try {
        const prefix = getApiPrefix(connectionId);
        const response = await fetch(`${API_BASE_URL}${prefix}/foreign-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connectionId })
        });
        const data = await response.json();
        return data.success ? data.relationships : [];
    } catch (error) {
        console.error('FK fetch error:', error);
        return [];
    }
};

export const getMockConnectorData = async (connectionId?: string, tables?: string[]): Promise<any> => {
    // If no connectionId, return mock data for non-database connectors (Shopify, etc.)
    if (!connectionId) {
        return [
            { order_id: 'ORD-001', order_date: '2025-01-15', total: 150.00, customer_id: 'CUST-101', status: 'shipped' },
            { order_id: 'ORD-002', order_date: '2025-01-16', total: 250.50, customer_id: 'CUST-102', status: 'processing' },
            { order_id: 'ORD-003', order_date: '2025-01-16', total: 45.00, customer_id: 'CUST-103', status: 'shipped' },
            { order_id: 'ORD-004', order_date: '2025-01-17', total: 1200.00, customer_id: 'CUST-101', status: 'shipped' }
        ];
    }

    // Real database query
    try {
        const response = await fetch(`${API_BASE_URL}/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connectionId, tables: tables || [] })
        });
        const data = await response.json();
        return data.success ? data.data : {};
    } catch (error) {
        console.error('Query error:', error);
        return {};
    }
};

export const generateColumnProfile = (rows: any[], columns: ColumnDefinition[]): ColumnProfile[] => {
    if (!rows || rows.length === 0) return [];
    return columns.map(col => {
        const values = rows.map(r => r[col.name]);
        const nonNulls = values.filter(v => v !== null && v !== undefined && v !== '');
        const distinct = new Set(nonNulls.map(v => String(v)));
        let stats: any = {};
        if (col.type === ColumnType.METRIC) {
            const nums = nonNulls.map(n => Number(n)).filter(n => !isNaN(n));
            if (nums.length) {
                stats.min = Math.min(...nums);
                stats.max = Math.max(...nums);
                stats.avg = nums.reduce((a, b) => a + b, 0) / nums.length;
            }
        }
        const counts: Record<string, number> = {};
        nonNulls.forEach(v => { const s = String(v); counts[s] = (counts[s] || 0) + 1; });
        const topValues = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([value, count]) => ({ value, count }));
        return {
            name: col.name, type: col.type, uniqueCount: distinct.size, nullCount: values.length - nonNulls.length, topValues, ...stats
        };
    });
};