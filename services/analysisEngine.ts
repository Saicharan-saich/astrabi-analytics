// --- REFACTORED: analysisEngine.ts ---
// Re-exports from extracted modules for backward compatibility
import { AggregationType, AnalysisResult, AnalysisType, ColumnDefinition, ColumnProfile, ColumnType, Dataset, ETLLog, QueryConfig, TimeContext, TimeGrain, SchemaType, CanonicalMapping, QuestionTemplate, QuestionGrain } from "../types";
import * as XLSX from 'xlsx';

// Re-export from extracted modules
export { QUESTION_REGISTRY, QUESTION_BANK, getFullQuestionBank, getFullRegistry } from './questionRegistry';
export { getDates, excelDateToJSDate } from './dateHelpers';
export { evaluateLocally, validateRequirements, validateGrainSafety } from './evaluateLocally';

import { QUESTION_REGISTRY, getFullRegistry } from './questionRegistry';
import { getDates, excelDateToJSDate } from './dateHelpers';
import { evaluateLocally, validateRequirements } from './evaluateLocally';
import { validateAnalysis } from './analysisValidator';

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

    const dq = getFullRegistry().find(q => q.id === query.questionId);

    const activeQ = dq || {
        id: 'custom_builder',
        category: 'Custom',
        question: `Analysis of ${query.metric} by ${query.dimension}`,
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

    const { data, xKey, yKey, kpi, growth, sql: generatedSQL } = evaluateLocally(activeQ as any, dataset.rows, mapping, dates, query);

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
): { rows: any[], logs: ETLLog[], columns: ColumnDefinition[], timeContext?: TimeContext } => {
    const result = runETLPipeline(rawData, fileName, columnTypeOverrides);
    return {
        rows: result.rows,
        logs: result.logs,
        columns: result.columns,
        timeContext: result.timeContext,
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
    const heuristics: Record<string, string[]> = {
        'revenue': ['total_sales', 'net_sales', 'amount', 'price', 'revenue', 'sales', 'value'],
        'order_date': ['created_at', 'order_date', 'date'],
        'order_id': ['order_id', 'id', 'order_number', 'order id'],
        'product_name': ['product_name', 'product_title', 'product', 'item_name', 'item_title', 'product_description'],
        'quantity': ['quantity', 'qty'],
        'customer_id': ['customer_id', 'email'],
        'customer_name': ['customer_name', 'customer', 'client_name', 'full_name', 'name'],
        'source': ['source', 'utm_source'],
        'campaign': ['campaign', 'utm_campaign'],
        'discount': ['discount', 'discount_amount'],
        'stock': ['inventory', 'stock', 'qty_on_hand']
    };

    Object.entries(heuristics).forEach(([role, candidates]) => {
        // 1. Try Exact Match First (Best)
        let match = columns.find(c => {
            const lowerC = c.toLowerCase();
            return candidates.includes(lowerC);
        });

        // 2. Try Prefix Match (Fallback) — INVALIDATE IDs for Name roles
        if (!match) {
            match = columns.find(c => {
                const lowerC = c.toLowerCase();
                // Prevent 'product_id' from matching 'product_name' by checking strict exclusion
                if (role.endsWith('_name') && (lowerC.endsWith('_id') || lowerC.endsWith(' id') || lowerC === 'id')) {
                    return false;
                }
                return candidates.some(cand => cand.length >= 3 && lowerC.startsWith(cand));
            });
        }

        if (match) fields[role] = match;
    });

    // ── POST-PROCESSING: For name roles, ensure we never resolve to an ID column ──
    // If a _name role resolved to _id column, try to find a better match
    for (const role of Object.keys(fields)) {
        if (role.endsWith('_name') || role === 'customer_name' || role === 'product_name') {
            const resolvedCol = fields[role];
            if (resolvedCol) {
                const lowerCol = resolvedCol.toLowerCase();
                if (lowerCol.endsWith('_id') || lowerCol.endsWith(' id') || lowerCol === 'id') {
                    // Try to find a name/title column for the same entity
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

/**
 * Detect join relationships between selected tables.
 * Uses FK metadata first, then falls back to same-name column matching.
 */
export const buildJoinStrategy = (
    selectedTables: string[],
    tableColumns: Record<string, ColumnInfo[]>,
    foreignKeys: ForeignKeyInfo[]
): JoinEdge[] => {
    const edges: JoinEdge[] = [];
    const added = new Set<string>();

    // 1. FK-based joins
    for (const fk of foreignKeys) {
        if (selectedTables.includes(fk.fromTable) && selectedTables.includes(fk.toTable)) {
            const key = `${fk.fromTable}.${fk.fromColumn}->${fk.toTable}.${fk.toColumn}`;
            if (!added.has(key)) {
                edges.push({ leftTable: fk.fromTable, rightTable: fk.toTable, leftColumn: fk.fromColumn, rightColumn: fk.toColumn, type: 'fk' });
                added.add(key);
            }
        }
    }

    // 2. Name-match fallback for unconnected tables
    const connectedTables = new Set<string>();
    edges.forEach(e => { connectedTables.add(e.leftTable); connectedTables.add(e.rightTable); });

    const unconnected = selectedTables.filter(t => !connectedTables.has(t));
    const connected = selectedTables.filter(t => connectedTables.has(t));

    // If no FK edges at all, start from first table
    const base = connected.length > 0 ? connected : [selectedTables[0]];
    const remaining = connected.length > 0 ? unconnected : selectedTables.slice(1);

    for (const tbl of remaining) {
        const tblCols = (tableColumns[tbl] || []).map(c => c.name.toLowerCase());
        let bestMatch: { baseTable: string; col: string; tblCol: string } | null = null;

        for (const bTbl of [...base, ...edges.map(e => e.rightTable)]) {
            const baseCols = (tableColumns[bTbl] || []).map(c => c.name.toLowerCase());
            // Find matching column names (common pattern: id, _id suffix)
            for (const bc of baseCols) {
                if (tblCols.includes(bc) && (bc.endsWith('id') || bc.endsWith('_id') || bc === 'id')) {
                    bestMatch = { baseTable: bTbl, col: bc, tblCol: bc };
                    break;
                }
            }
            if (bestMatch) break;
            // Also check for table_name + 'id' pattern
            for (const bc of baseCols) {
                if (tblCols.includes(bc)) {
                    bestMatch = { baseTable: bTbl, col: bc, tblCol: bc };
                    break;
                }
            }
            if (bestMatch) break;
        }

        if (bestMatch) {
            edges.push({
                leftTable: bestMatch.baseTable, rightTable: tbl,
                leftColumn: bestMatch.col, rightColumn: bestMatch.tblCol,
                type: 'name_match'
            });
        }
    }

    return edges;
};

/**
 * Join multiple tables into a single master table using left joins.
 * Follows the join edges to merge data.
 */
export const autoJoinDatasets = (
    tables: Record<string, any[]>,
    joinEdges?: JoinEdge[]
): { mergedRows: any[]; joinLogs: string[] } => {
    const keys = Object.keys(tables);
    if (keys.length === 0) return { mergedRows: [], joinLogs: ['No tables to join'] };
    if (keys.length === 1) return { mergedRows: tables[keys[0]] || [], joinLogs: [`Single table: ${keys[0]} (${(tables[keys[0]] || []).length} rows)`] };

    const logs: string[] = [];

    // If no join edges provided, try simple name-based matching
    if (!joinEdges || joinEdges.length === 0) {
        // Fallback: find shared column names
        const allCols = keys.map(k => ({ table: k, cols: new Set(Object.keys(tables[k][0] || {})) }));
        let merged = [...tables[keys[0]]];
        logs.push(`Base table: ${keys[0]} (${merged.length} rows)`);

        for (let i = 1; i < keys.length; i++) {
            const rightTable = keys[i];
            const rightRows = tables[rightTable] || [];
            const leftCols = new Set(Object.keys(merged[0] || {}));
            const rightCols = Object.keys(rightRows[0] || {});
            const sharedCol = rightCols.find(c => leftCols.has(c) && (c.toLowerCase().endsWith('id') || c.toLowerCase().includes('_id')));

            if (sharedCol) {
                const rightMap = new Map<string, any>();
                rightRows.forEach(r => rightMap.set(String(r[sharedCol]), r));
                merged = merged.map(row => {
                    const match = rightMap.get(String(row[sharedCol]));
                    if (match) {
                        const prefixed: any = {};
                        for (const [k, v] of Object.entries(match)) {
                            if (k === sharedCol) continue;
                            prefixed[leftCols.has(k) ? `${rightTable}_${k}` : k] = v;
                        }
                        return { ...row, ...prefixed };
                    }
                    return row;
                });
                logs.push(`LEFT JOIN ${rightTable} ON ${sharedCol} → ${merged.length} rows`);
            } else {
                logs.push(`SKIP ${rightTable} — no matching join column found`);
            }
        }
        return { mergedRows: merged, joinLogs: logs };
    }

    // Use provided join edges
    const joined = new Set<string>();
    // Find the root table (appears as leftTable most often or is first edge's leftTable)
    const rootTable = joinEdges[0]?.leftTable || keys[0];
    let merged = [...(tables[rootTable] || [])];
    joined.add(rootTable);
    logs.push(`Base table: ${rootTable} (${merged.length} rows)`);

    // Process edges in order
    for (const edge of joinEdges) {
        const rightName = joined.has(edge.leftTable) ? edge.rightTable : edge.leftTable;
        const leftCol = joined.has(edge.leftTable) ? edge.leftColumn : edge.rightColumn;
        const rightCol = joined.has(edge.leftTable) ? edge.rightColumn : edge.leftColumn;

        if (joined.has(rightName)) continue;

        const rightRows = tables[rightName] || [];
        if (rightRows.length === 0) { logs.push(`SKIP ${rightName} — empty table`); continue; }

        const leftColsSet = new Set(Object.keys(merged[0] || {}));
        const rightMap = new Map<string, any>();
        rightRows.forEach(r => rightMap.set(String(r[rightCol]), r));

        const beforeCount = merged.length;
        merged = merged.map(row => {
            const match = rightMap.get(String(row[leftCol]));
            if (match) {
                const prefixed: any = {};
                for (const [k, v] of Object.entries(match)) {
                    if (k === rightCol) continue;
                    prefixed[leftColsSet.has(k) ? `${rightName}_${k}` : k] = v;
                }
                return { ...row, ...prefixed };
            }
            return row;
        });

        joined.add(rightName);
        logs.push(`LEFT JOIN ${rightName} ON ${leftCol} = ${rightCol} (${edge.type}) → ${merged.length} rows`);
    }

    return { mergedRows: merged, joinLogs: logs };
};

export const parseCSV = (text: string): any[] => {
    const lines = text.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
        const v = line.split(',');
        return headers.reduce((acc, h, i) => ({ ...acc, [h]: v[i]?.trim() }), {});
    });
};

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