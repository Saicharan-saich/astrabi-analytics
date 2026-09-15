/**
 * aiSemanticProfiler.ts — AI-Driven Domain Detection & Semantic Mapping
 *
 * Two-pass LLM profiling:
 *   Pass 1: Domain detection + primary column identification (first 30 columns)
 *   Pass 2: Semantic mapping for remaining columns (batches of 40, locked domain context)
 *
 * NEVER receives raw data — only MaskedColumnProfile from dataMasker.ts.
 * Falls back gracefully if LLM is unavailable.
 */

import { ColumnDefinition, DatasetDomainProfile, ColumnSemantic, ColumnType, MaskedColumnProfile } from '../types';
import { buildMaskedProfiles, profilesToPromptText } from './dataMasker';
import { inferRowGrain } from './rowGrainInference';

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const API_ENDPOINT = `${import.meta.env.VITE_API_URL || 'http://localhost:5002/api'}/ai/profile-dataset`;
const PASS1_MAX_COLUMNS = 30;
const PASS2_BATCH_SIZE = 40;
const TIMEOUT_MS = 15000; // 15s timeout per LLM call

// ═══════════════════════════════════════════════════════════════════
// KNOWN JUNK COLUMN PATTERNS — Auto-hide without LLM
// ═══════════════════════════════════════════════════════════════════

const JUNK_COLUMN_PATTERNS = [
    /^_fivetran/i, /^_sdc_/i, /^_airbyte/i, /^__/,
    /^row_?id$/i, /^row_?num/i, /^row_?hash/i, /^_?hash$/i,
    /^etl_/i, /^dw_/i, /^stg_/i, /^tmp_/i,
    /^created_by$/i, /^updated_by$/i, /^modified_by$/i,
    /^sys_/i, /^meta_/i, /^_?deleted$/i, /^is_?deleted$/i,
];

function isJunkColumn(name: string): boolean {
    return JUNK_COLUMN_PATTERNS.some(p => p.test(name));
}

// ═══════════════════════════════════════════════════════════════════
// PASS 1 PROMPT — Domain Detection + Primary Columns
// ═══════════════════════════════════════════════════════════════════

function buildPass1Prompt(profileText: string, fileName: string): string {
    return `You are an expert Data Architect and Business Analyst. A user uploaded a dataset called "${fileName}".

Below are the column metadata and statistical profiles. NO raw data is included — only column names, types, distribution stats, and pattern hints.

${profileText}

TASKS:
1. Identify the INDUSTRY DOMAIN of this dataset. Choose one:
   Sales, HR, Finance, Healthcare, Inventory, SaaS, Education, Marketing, Logistics, Real_Estate, Manufacturing, Insurance, Hospitality, Retail, Telecom, Agriculture, Energy, Government, Legal, Other

2. Identify a sub-domain if applicable (e.g., "E-Commerce", "Payroll", "Patient Records", "Mutual Funds")

3. Write a 1-sentence summary of what this dataset represents

4. For EACH column, determine:
   - role: "METRIC", "DIMENSION", "DATE", "BOOLEAN", or "ID"
     Use BOOLEAN for columns containing yes/no, true/false, 0/1, active/inactive values.
   - aggregation: "SUM", "AVG", "COUNT", "COUNT_DISTINCT", "MIN", "MAX", or "NONE"
   - format: "currency_usd", "currency_eur", "percent", "raw", "count", or "date_iso"
   - humanLabel: A clean, readable label (e.g., "Monthly Revenue" instead of "rev_monthly_v2")
   - description: One sentence describing what this column represents
   - semanticRole: One of: "primary_metric", "secondary_metric", "primary_dimension", "secondary_dimension", "primary_date", "secondary_date", "identifier", "attribute", "other"
   - isHidden: true if this is a system/junk column that should be hidden from users

5. Rate your confidence from 0.0 to 1.0

RESPOND WITH ONLY VALID JSON matching this exact schema (no markdown fences):
{
  "domain": "string",
  "subDomain": "string or null",
  "summary": "string",
  "confidence": number,
  "themeColor": "hex color string",
  "columnSemantics": {
    "column_name": {
      "role": "METRIC|DIMENSION|DATE|BOOLEAN|ID",
      "aggregation": "SUM|AVG|COUNT|COUNT_DISTINCT|MIN|MAX|NONE",
      "format": "currency_usd|currency_eur|percent|raw|count|date_iso",
      "humanLabel": "string",
      "description": "string",
      "semanticRole": "string",
      "isHidden": boolean
    }
  }
}`;
}

// ═══════════════════════════════════════════════════════════════════
// PASS 2 PROMPT — Remaining columns with locked domain context
// ═══════════════════════════════════════════════════════════════════

function buildPass2Prompt(profileText: string, domain: string, subDomain: string | undefined): string {
    return `You are continuing to map columns for a dataset that has been DEFINITIVELY identified as "${domain}"${subDomain ? ` (${subDomain})` : ''}.

DO NOT reconsider or change the domain. Map the following columns strictly within the "${domain}" context.

${profileText}

For EACH column below, determine:
- role: "METRIC", "DIMENSION", "DATE", "BOOLEAN", or "ID"
  Use BOOLEAN for columns containing yes/no, true/false, 0/1, active/inactive values.
- aggregation: "SUM", "AVG", "COUNT", "COUNT_DISTINCT", "MIN", "MAX", or "NONE"
- format: "currency_usd", "currency_eur", "percent", "raw", "count", or "date_iso"
- humanLabel: Clean readable label
- description: One sentence description
- semanticRole: "primary_metric", "secondary_metric", "primary_dimension", "secondary_dimension", "primary_date", "secondary_date", "identifier", "attribute", or "other"
- isHidden: true if system/junk column

RESPOND WITH ONLY VALID JSON (no markdown fences):
{
  "columnSemantics": {
    "column_name": {
      "role": "...",
      "aggregation": "...",
      "format": "...",
      "humanLabel": "...",
      "description": "...",
      "semanticRole": "...",
      "isHidden": boolean
    }
  }
}`;
}

// ═══════════════════════════════════════════════════════════════════
// BACKEND HEALTH CHECK — Fast pre-flight to avoid slow timeouts
// ═══════════════════════════════════════════════════════════════════

let _backendAvailable: boolean | null = null; // null = not checked yet
let _lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL = 60_000; // Re-check every 60 seconds
const HEALTH_CHECK_TIMEOUT = 2000;    // 2-second fast timeout

async function isBackendAvailable(): Promise<boolean> {
    const now = Date.now();
    if (_backendAvailable !== null && (now - _lastHealthCheck) < HEALTH_CHECK_INTERVAL) {
        return _backendAvailable;
    }

    try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);
        const resp = await fetch(API_ENDPOINT.replace('/api/ai/profile-dataset', '/api/ai/health'), {
            method: 'GET',
            signal: controller.signal,
        }).catch(() => null);
        clearTimeout(tid);

        // Even a 404 means the server IS up (just no /health route)
        _backendAvailable = resp !== null;
    } catch {
        _backendAvailable = false;
    }

    _lastHealthCheck = now;
    if (!_backendAvailable) {
        console.info('[AI Profiler] Backend not available — AI enrichment disabled. Using deterministic classification only.');
    }
    return _backendAvailable;
}

// ═══════════════════════════════════════════════════════════════════
// LLM CALL — with timeout and error handling
// ═══════════════════════════════════════════════════════════════════

async function callLLM(prompt: string): Promise<any> {
    // Fast pre-flight: skip if backend is known to be down
    if (!(await isBackendAvailable())) {
        return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const token = localStorage.getItem('qi_token') || '';
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ prompt }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`LLM API returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data;
    } catch (err: any) {
        clearTimeout(timeoutId);
        // Mark backend as unavailable so future calls skip instantly
        _backendAvailable = false;
        _lastHealthCheck = Date.now();
        if (err.name === 'AbortError') {
            console.info('[AI Profiler] LLM call timed out — using deterministic classification.');
        } else {
            console.info('[AI Profiler] LLM unavailable — using deterministic classification.');
        }
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════
// ROLE RECONCILIATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Reconcile AI-assigned column roles with the deterministic, data-aware ETL
 * classification. The ETL role (col.type) comes from the actual data shape (name
 * patterns + numeric/date parse rates + key uniqueness/sequence) and is reliable.
 * The AI enriches MEANING (domain, labels, descriptions) but must not override the
 * STRUCTURAL role when the data contradicts it.
 *
 * The classic failure this prevents: the AI labels a near-unique TEXT column
 * (person names, emails, cities) as "ID" because each value identifies a row — but
 * a real key is caught by the deterministic classifier via an id-like name and/or a
 * numeric key shape. If the data-aware classifier did not see an ID, it is not one.
 *
 * Mutates `semantics` in place. Pure w.r.t. external state; privacy-safe (operates
 * only on metadata/roles, never raw values).
 */
export function reconcileRolesWithData(
    semantics: Record<string, ColumnSemantic>,
    columns: ColumnDefinition[],
): Record<string, ColumnSemantic> {
    const detRoleByName = new Map(columns.map(c => [c.name, c.type]));
    for (const [colName, s] of Object.entries(semantics)) {
        const detRole = detRoleByName.get(colName);
        if (!detRole || s.isHidden) continue;
        // AI → ID, but the data-aware classifier disagreed: trust the data. Text
        // like names/emails is near-unique yet not a key.
        if (s.role === ColumnType.ID && detRole !== ColumnType.ID) {
            s.role = detRole;
            if (s.aggregation === 'SUM' || s.aggregation === 'AVG') s.aggregation = 'NONE';
        }
        // AI → METRIC on a column the data says is a date/boolean/ID: a
        // non-numeric field cannot be a measure.
        else if (s.role === ColumnType.METRIC
            && (detRole === ColumnType.DATE || detRole === ColumnType.BOOLEAN || detRole === ColumnType.ID)) {
            s.role = detRole;
            s.aggregation = 'NONE';
        }
    }
    return semantics;
}

// ═══════════════════════════════════════════════════════════════════
// PARSE & VALIDATE LLM RESPONSE
// ═══════════════════════════════════════════════════════════════════

function parseProfileResponse(raw: any): Partial<DatasetDomainProfile> | null {
    try {
        // If raw is already an object, use it; if string, parse JSON
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

        if (!data || !data.columnSemantics) {
            console.warn('[AI Profiler] Invalid response structure');
            return null;
        }

        // Validate and normalize column semantics
        const validRoles = new Set(['METRIC', 'DIMENSION', 'DATE', 'BOOLEAN', 'ID', 'UNKNOWN']);
        const validAggs = new Set(['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX', 'NONE']);
        const validFormats = new Set(['currency_usd', 'currency_eur', 'percent', 'raw', 'count', 'date_iso']);

        const columnSemantics: Record<string, ColumnSemantic> = {};
        for (const [colName, sem] of Object.entries(data.columnSemantics)) {
            const s = sem as any;
            columnSemantics[colName] = {
                role: validRoles.has(s.role) ? s.role as ColumnType : ColumnType.UNKNOWN,
                aggregation: validAggs.has(s.aggregation) ? s.aggregation : 'NONE',
                format: validFormats.has(s.format) ? s.format : 'raw',
                humanLabel: s.humanLabel || colName.replace(/_/g, ' '),
                description: s.description || '',
                semanticRole: s.semanticRole || 'other',
                isHidden: s.isHidden === true,
            };
        }

        return {
            domain: data.domain || 'Other',
            subDomain: data.subDomain || undefined,
            summary: data.summary || '',
            confidence: typeof data.confidence === 'number' ? data.confidence : 0.5,
            themeColor: data.themeColor || '#6366f1',
            columnSemantics,
        };
    } catch (err) {
        console.warn('[AI Profiler] Failed to parse LLM response:', err);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN: Profile a dataset with AI (two-pass for wide tables)
// ═══════════════════════════════════════════════════════════════════

export async function profileDatasetWithAI(
    rows: Record<string, any>[],
    columns: ColumnDefinition[],
    fileName: string
): Promise<DatasetDomainProfile | null> {
    try {
        console.log(`[AI Profiler] Starting profiling for "${fileName}" — ${columns.length} columns, ${rows.length} rows`);

        // Step 1: Build masked statistical profiles (PII-safe)
        const maskedProfiles = buildMaskedProfiles(rows, columns);
        if (maskedProfiles.length === 0) {
            console.warn('[AI Profiler] No columns to profile');
            return null;
        }

        // Step 2: Pre-mark known junk columns (no LLM needed)
        const junkColumns = new Set(columns.map(c => c.name).filter(isJunkColumn));
        console.log(`[AI Profiler] Pre-marked ${junkColumns.size} junk columns`);

        // Step 3: PASS 1 — Domain detection with first N columns
        const pass1Profiles = maskedProfiles.slice(0, PASS1_MAX_COLUMNS);
        const pass1Text = profilesToPromptText(pass1Profiles);
        const pass1Prompt = buildPass1Prompt(pass1Text, fileName);

        console.log('[AI Profiler] Pass 1: Detecting domain...');
        const pass1Result = await callLLM(pass1Prompt);
        if (!pass1Result) {
            console.warn('[AI Profiler] Pass 1 failed — falling back to manual mapping');
            return null;
        }

        const pass1Parsed = parseProfileResponse(pass1Result);
        if (!pass1Parsed || !pass1Parsed.domain) {
            console.warn('[AI Profiler] Pass 1 parse failed');
            return null;
        }

        console.log(`[AI Profiler] Domain detected: ${pass1Parsed.domain} (${pass1Parsed.subDomain || 'general'})`);
        console.log(`[AI Profiler] Confidence: ${pass1Parsed.confidence}`);

        // Step 4: PASS 2 — Map remaining columns (if any) with locked domain context
        const allSemantics = { ...pass1Parsed.columnSemantics };

        if (maskedProfiles.length > PASS1_MAX_COLUMNS) {
            const remainingProfiles = maskedProfiles.slice(PASS1_MAX_COLUMNS);
            console.log(`[AI Profiler] Pass 2: Mapping ${remainingProfiles.length} remaining columns...`);

            // Process in batches
            for (let i = 0; i < remainingProfiles.length; i += PASS2_BATCH_SIZE) {
                const batch = remainingProfiles.slice(i, i + PASS2_BATCH_SIZE);
                const batchText = profilesToPromptText(batch);
                const pass2Prompt = buildPass2Prompt(batchText, pass1Parsed.domain!, pass1Parsed.subDomain);

                const pass2Result = await callLLM(pass2Prompt);
                if (pass2Result) {
                    const pass2Parsed = parseProfileResponse(pass2Result);
                    if (pass2Parsed?.columnSemantics) {
                        Object.assign(allSemantics, pass2Parsed.columnSemantics);
                    }
                }
            }
        }

        // Step 5: Apply junk column overrides (deterministic, no LLM needed)
        for (const colName of junkColumns) {
            if (allSemantics[colName]) {
                allSemantics[colName].isHidden = true;
            } else {
                allSemantics[colName] = {
                    role: ColumnType.UNKNOWN,
                    aggregation: 'NONE',
                    format: 'raw',
                    humanLabel: colName.replace(/_/g, ' '),
                    description: 'System/internal column',
                    semanticRole: 'other',
                    isHidden: true,
                };
            }
        }

        // Step 6: Fill any columns not covered by the LLM
        for (const col of columns) {
            if (!allSemantics[col.name]) {
                allSemantics[col.name] = {
                    role: col.type || ColumnType.UNKNOWN,
                    aggregation: col.type === ColumnType.METRIC ? 'SUM' : 'NONE',
                    format: 'raw',
                    humanLabel: col.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                    description: '',
                    semanticRole: 'other',
                    isHidden: isJunkColumn(col.name),
                };
            }
        }

        // Step 6.5: Reconcile AI roles with the deterministic, data-aware classifier.
        reconcileRolesWithData(allSemantics, columns);

        // Step 7: Compute deterministic confidence (not LLM self-reported)
        const totalCols = columns.length;
        const mappedCols = Object.keys(allSemantics).length;
        const coverageScore = totalCols > 0 ? mappedCols / totalCols : 0;
        const unknownCols = Object.values(allSemantics).filter(s => s.role === ColumnType.UNKNOWN).length;
        const unknownPenalty = totalCols > 0 ? (unknownCols / totalCols) * 0.3 : 0;
        const hiddenCols = Object.values(allSemantics).filter(s => s.isHidden).length;
        const visibleCols = totalCols - hiddenCols;
        const metricCount = Object.values(allSemantics).filter(s => s.role === ColumnType.METRIC).length;
        const dimCount = Object.values(allSemantics).filter(s => s.role === ColumnType.DIMENSION || s.role === ColumnType.BOOLEAN).length;
        const hasMinTypes = metricCount > 0 && dimCount > 0 ? 0 : 0.15;
        const computedConfidence = Math.max(0.1, Math.min(1.0,
            coverageScore - unknownPenalty - hasMinTypes
        ));
        console.log(`[AI Profiler] Confidence: ${(computedConfidence * 100).toFixed(0)}% (coverage=${(coverageScore * 100).toFixed(0)}%, unknowns=${unknownCols}, metrics=${metricCount}, dims=${dimCount})`);

        // Step 8: Infer row grain locally. This is structural metadata, so it
        // does not require another model call or expose raw values.
        const inferredGrain = inferRowGrain(
            rows,
            columns,
            fileName,
            pass1Parsed.domain!,
            allSemantics,
        );

        // Step 9: Build the final profile
        const profile: DatasetDomainProfile = {
            domain: pass1Parsed.domain!,
            subDomain: pass1Parsed.subDomain,
            summary: pass1Parsed.summary || '',
            confidence: computedConfidence,
            grain: inferredGrain.label,
            grainConfidence: inferredGrain.confidence,
            grainSource: inferredGrain.source,
            grainEvidence: inferredGrain.evidence,
            themeColor: pass1Parsed.themeColor,
            columnSemantics: allSemantics,
            suggestedQuestionCategories: generateSuggestedCategories(pass1Parsed.domain!),
            detectedAt: Date.now(),
        };

        console.log(`[AI Profiler] ✅ Profiling complete: ${pass1Parsed.domain} — ${Object.keys(allSemantics).length} columns mapped`);
        return profile;

    } catch (err) {
        console.error('[AI Profiler] Unexpected error during profiling:', err);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════
// DOMAIN → SUGGESTED QUESTION CATEGORIES
// ═══════════════════════════════════════════════════════════════════

function generateSuggestedCategories(domain: string): string[] {
    const domainCategories: Record<string, string[]> = {
        'Sales': [
            'Daily Performance', 'Weekly Performance', 'Monthly Performance',
            'Quarterly Performance', 'Yearly Performance', 'Products & Inventory',
            'Customer Intelligence', 'Revenue Diagnostics', 'Growth & Momentum',
        ],
        'HR': [
            'Headcount & Composition', 'Attrition & Retention', 'Compensation & Benefits',
            'Recruitment & Hiring', 'Diversity & Inclusion', 'Performance & Engagement',
        ],
        'Finance': [
            'Revenue & Income', 'Expenses & Costs', 'Profitability & Margins',
            'Cash Flow', 'Budget vs Actual', 'Financial Ratios',
        ],
        'Healthcare': [
            'Patient Volume', 'Length of Stay', 'Readmissions & Outcomes',
            'Cost & Billing', 'Clinical Quality', 'Staff & Capacity',
        ],
        'Inventory': [
            'Stock Levels', 'Inventory Turnover', 'Aging & Obsolescence',
            'Reorder & Replenishment', 'Warehouse Performance', 'Demand Forecasting',
        ],
        'SaaS': [
            'MRR & ARR', 'Churn & Retention', 'Customer Lifetime Value',
            'Expansion Revenue', 'Usage & Engagement', 'Pipeline & Conversion',
        ],
        'Education': [
            'Enrollment & Admissions', 'Academic Performance', 'Attendance & Punctuality',
            'Graduation & Retention', 'Faculty & Staff', 'Financial Aid',
        ],
        'Marketing': [
            'Campaign Performance', 'Conversion & Funnel', 'Customer Acquisition',
            'Channel Analysis', 'Content & Engagement', 'ROI & ROAS',
        ],
    };
    return domainCategories[domain] || ['General Performance', 'Trends & Comparisons', 'Rankings & Distribution'];
}

// ═══════════════════════════════════════════════════════════════════
// INCREMENTAL SYNC — For schema drift detection
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect new columns not in the existing profile and profile them incrementally.
 * Returns updated profile or null if no changes needed.
 */
export async function syncNewColumns(
    existingProfile: DatasetDomainProfile,
    currentColumns: ColumnDefinition[],
    rows: Record<string, any>[]
): Promise<DatasetDomainProfile | null> {
    const existingCols = new Set(Object.keys(existingProfile.columnSemantics));
    const newColumns = currentColumns.filter(c => !existingCols.has(c.name));

    if (newColumns.length === 0) return null;

    console.log(`[AI Profiler] Schema drift: ${newColumns.length} new columns detected`);

    const maskedProfiles = buildMaskedProfiles(rows, newColumns);
    const profileText = profilesToPromptText(maskedProfiles);
    const prompt = buildPass2Prompt(profileText, existingProfile.domain, existingProfile.subDomain);

    const result = await callLLM(prompt);
    if (!result) return null;

    const parsed = parseProfileResponse(result);
    if (!parsed?.columnSemantics) return null;

    // Merge new columns into existing profile
    return {
        ...existingProfile,
        columnSemantics: { ...existingProfile.columnSemantics, ...parsed.columnSemantics },
        detectedAt: Date.now(),
    };
}
