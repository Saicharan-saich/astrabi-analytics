/**
 * PageInfoButton.tsx — Reusable "ℹ️" button that shows what each page does.
 * 
 * Usage: <PageInfoButton pageKey="ETL" />
 * Renders a small info icon that opens a modal with page explanation.
 */
import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { Info, X, Lightbulb, ArrowRight } from 'lucide-react';

export type PageKey =
    | 'UPLOAD' | 'COLUMN_MAPPING' | 'DASHBOARD' | 'BUILDER' | 'WORKBENCH'
    | 'DATA' | 'ETL' | 'SCHEMA' | 'CONNECTORS' | 'NLQ' | 'AI_SQL'
    | 'CUSTOM_QUESTIONS' | 'DATASET_SUMMARY' | 'SMART_QUESTIONS' | 'ALERTS'
    | 'VISUAL_PREVIEW' | 'DERIVED_COLUMNS' | 'USER_INSIGHTS' | 'BENCHMARK' | 'AI_SQL_ENGINES' | 'GAME';

interface PageInfo {
    title: string;
    description: string;
    features: string[];
    tips?: string[];
}

const PAGE_INFO: Record<PageKey, PageInfo> = {
    UPLOAD: {
        title: 'Data Upload',
        description: 'Import your data into QuickInsight. Upload CSV or Excel files directly from your computer, or connect to a live database for real-time analytics.',
        features: [
            'Drag & drop CSV/Excel files',
            'Connect to PostgreSQL or MySQL databases',
            'Auto-detects column types, dates, and formats',
            'Handles large datasets efficiently',
        ],
        tips: [
            'Ensure your CSV has headers in the first row',
            'Date columns work best in YYYY-MM-DD format',
            'Use live connections for data that changes frequently',
        ],
    },
    COLUMN_MAPPING: {
        title: 'Column Mapping',
        description: 'Review and refine how QuickInsight understands each column in your data. The system auto-classifies columns as metrics, dimensions, dates, or identifiers — you can adjust these here.',
        features: [
            'Auto-classification of column roles (metric, dimension, date, ID)',
            'Set default aggregation per column (SUM, AVG, COUNT, etc.)',
            'Add human-readable labels and descriptions',
            'Mark columns as hidden to exclude from analysis',
        ],
        tips: [
            'Revenue and sales columns should be METRIC with SUM aggregation',
            'Names, categories, and regions should be DIMENSION',
            'Correct mappings here improve AI question accuracy dramatically',
        ],
    },
    DASHBOARD: {
        title: 'Dashboard',
        description: 'Your personal analytics command center. Pin any chart from the Question Builder, NLQ, or AI SQL to build a custom dashboard. Drag, resize, and arrange cards to tell your data story.',
        features: [
            'Drag-and-drop card layout with auto-save',
            'Pin charts from any query interface',
            'Global filters that cascade across all cards',
            'Presentation mode for meetings and reports',
            'Cloud-synced — accessible from any device',
        ],
        tips: [
            'Click the pin icon on any chart to add it here',
            'Drag card edges to resize them',
            'Use presentation mode for clean, full-screen viewing',
        ],
    },
    BUILDER: {
        title: 'Question Builder',
        description: 'A visual, no-code query designer. Pick your metric, choose how to aggregate it, select a dimension to group by, and see the chart instantly. No SQL or formulas needed.',
        features: [
            'Pick metric + aggregation (SUM, AVG, COUNT, etc.)',
            'Choose dimension and time grain (day, week, month, quarter)',
            'Add filters with auto-populated values',
            'Secondary metrics with dual Y-axis support',
            'Secondary dimensions for multi-level breakdowns',
            'Sort, limit, and time comparison controls',
        ],
        tips: [
            'Start with a metric (what to measure) and a dimension (how to group it)',
            'Use secondary metrics for dual-axis charts (e.g., revenue + profit margin)',
            'Time comparisons show period-over-period changes',
        ],
    },
    WORKBENCH: {
        title: 'Workbench',
        description: 'Your main workspace combining the Question Builder with chart visualization. Build queries visually and see results side-by-side.',
        features: [
            'Split-view: query builder + chart output',
            'Instant chart updates as you change parameters',
            'Pin results directly to dashboard',
            'Export data and charts',
        ],
    },
    DATA: {
        title: 'Data Explorer',
        description: 'Browse your raw data in a spreadsheet-like view. Search, sort, and filter rows to understand your dataset before building charts.',
        features: [
            'Spreadsheet-style data grid',
            'Column sorting and filtering',
            'Search across all columns',
            'Row count and data type indicators',
        ],
        tips: [
            'Use this to verify data quality before analysis',
            'Sort by a column to quickly spot outliers or gaps',
        ],
    },
    ETL: {
        title: 'ETL Pipeline & Data Cleaning',
        description: 'Review the automated data cleaning that happened on upload, and use interactive tools to further clean your data. ETL stands for Extract, Transform, Load — the process of preparing raw data for analysis.',
        features: [
            'Automated 7-layer cleaning pipeline (structural normalization, null handling, type detection)',
            'Data Cleaning Studio with 8 interactive tools',
            'Duplicate detection & removal',
            'Missing value imputation (mean, median, mode, custom)',
            'String normalization (trim, case, dedup spaces)',
            'Outlier detection (IQR, Z-score) with cap/remove/flag',
            'Find & replace (text + regex)',
            'Column split & merge operations',
            'Data quality scoring with per-column reports',
        ],
        tips: [
            'Check the Data Quality tab first to see overall health',
            'Fix string inconsistencies (e.g., "New York" vs "new york") before building charts',
            'Use outlier detection on revenue/quantity columns to catch data entry errors',
        ],
    },
    SCHEMA: {
        title: 'Schema View',
        description: 'A technical view of your dataset\'s structure. See every column\'s data type, role, and statistics at a glance.',
        features: [
            'Column name, type, and role overview',
            'Null counts and completeness percentages',
            'Distinct value counts',
            'Statistical summaries for numeric columns',
        ],
    },
    CONNECTORS: {
        title: 'Database Connectors',
        description: 'Connect QuickInsight to your live databases for real-time analytics. Queries run directly against your database — no data copying needed.',
        features: [
            'PostgreSQL and MySQL support',
            'Secure encrypted connections',
            'Save connection credentials for quick access',
            'Switch between import (static) and live (real-time) modes',
        ],
        tips: [
            'Use live connections when your data changes frequently',
            'Import mode is faster for static analysis (data is cached locally)',
        ],
    },
    NLQ: {
        title: 'Natural Language Query',
        description: 'Ask questions about your data in plain English. Type what you want to know, and QuickInsight will generate the chart automatically.',
        features: [
            'Type questions in everyday English',
            'AI understands intent (trend, ranking, comparison, distribution)',
            'Auto-selects the best chart type for the answer',
            'View the generated SQL for transparency',
            'Pin results to dashboard with one click',
        ],
        tips: [
            'Be specific: "Top 5 products by revenue this year" works better than "show products"',
            'Include time context: "monthly", "last quarter", "this year"',
            'Try comparison questions: "Compare sales across regions"',
        ],
    },
    AI_SQL: {
        title: 'AI SQL Chat',
        description: 'Ask questions about your data in plain English. Every question is answered on its own — nothing is carried over from previous questions, so each answer depends only on what you just asked.',
        features: [
            'Conversational, multi-turn data exploration',
            'Schema-aware SQL generation',
            'Confidence scoring on every answer',
            'Full SQL transparency — see exactly what query ran',
            'Export results and pin charts to dashboard',
        ],
        tips: [
            'Start with a broad question, then drill down with follow-ups',
            'Try "Now filter to just Q4" or "Add profit margin to that"',
            'Check the confidence score — higher means more reliable',
        ],
    },
    CUSTOM_QUESTIONS: {
        title: 'Custom Questions',
        description: 'Save your most important questions and re-run them anytime. Build a library of go-to analytics that you or your team can access quickly.',
        features: [
            'Save frequently-asked questions',
            'One-click re-execution',
            'Organize questions by category',
            'Share questions across your team',
        ],
    },
    DATASET_SUMMARY: {
        title: 'Dataset Summary',
        description: 'A high-level overview of your entire dataset. See key statistics, distributions, and patterns at a glance before diving into specific questions.',
        features: [
            'Row and column counts',
            'Statistical summaries (min, max, mean, median)',
            'Data completeness overview',
            'Automatic insight highlights',
        ],
    },
    SMART_QUESTIONS: {
        title: 'AI-Generated Smart Questions',
        description: 'QuickInsight analyzes your dataset and suggests the most interesting questions to ask. These are AI-generated based on your data\'s structure and statistical properties — no typing required.',
        features: [
            'AI analyzes your schema and data patterns',
            'Generates contextually relevant questions',
            'Questions grouped by category (trends, rankings, comparisons)',
            'One-click execution — just click a question to see the answer',
        ],
        tips: [
            'This is the fastest way to explore a new dataset',
            'Click any suggested question to instantly generate a chart',
            'Pin the best insights to your dashboard',
        ],
    },
    ALERTS: {
        title: 'Alerts',
        description: 'Set up threshold-based alerts on your key metrics. Get notified when important numbers cross boundaries — like revenue dropping below target or inventory running low.',
        features: [
            'Threshold-based alerting (above/below a value)',
            'Configure alerts on any metric column',
            'Alert history and status tracking',
            'Automatic evaluation against your data',
        ],
        tips: [
            'Set alerts on your most critical KPIs (revenue, order count, etc.)',
            'Use "below" alerts for metrics that shouldn\'t drop (revenue, customers)',
            'Use "above" alerts for metrics that shouldn\'t spike (costs, error rates)',
        ],
    },
    VISUAL_PREVIEW: {
        title: 'Visual Preview',
        description: 'Preview how your chart will look with different visualization types. Experiment with bar, line, pie, donut, and more before pinning to your dashboard.',
        features: [
            'Preview multiple chart types side-by-side',
            'Instant switching between visualization styles',
            'Fine-tune chart appearance',
            'Select the best visual for your data story',
        ],
    },
    DERIVED_COLUMNS: {
        title: 'Derived Columns',
        description: 'Create new calculated columns from your existing data — without writing code. Build metrics like profit margin, average order value, or custom ratios.',
        features: [
            'Mathematical operations (revenue − cost = profit)',
            'Percentage calculations (profit ÷ revenue × 100)',
            'Conditional logic (IF/THEN)',
            'String and date transformations',
            'Use derived columns in all queries and charts',
        ],
        tips: [
            'Common derived columns: profit margin, year-over-year change, running total',
            'Derived columns appear as regular columns in the Question Builder',
        ],
    },
    USER_INSIGHTS: {
        title: 'User Insights',
        description: 'Analytics about how your team uses QuickInsight. Track which questions are asked most, feature adoption, and usage patterns.',
        features: [
            'Most-asked questions and query patterns',
            'Feature usage breakdown',
            'User activity timeline',
            'Adoption metrics',
        ],
    },
    BENCHMARK: {
        title: 'AI SQL Benchmark Lab',
        description: 'Run versioned, execution-based AI SQL evaluations against frozen local datasets and gold outputs. This page is available only to administrators.',
        features: [
            'Three curated compatibility suites with 50 questions each',
            'Gold SQL and frozen outputs verified locally in DuckDB-WASM',
            'Result-equivalence scoring rather than brittle SQL text matching',
            'Accuracy, valid SQL, safety, latency, token, model, and repair evidence',
            'JSON and CSV evidence exports for reproducible reporting',
        ],
        tips: [
            'Run the 5-question-per-suite smoke test before spending tokens on all 150 questions',
            'Use the exported suite version and methodology label whenever reporting a score',
        ],
    },
    AI_SQL_ENGINES: {
        title: 'AI SQL Engines',
        description: 'Admin-only global controls for optional AI SQL understanding, verification, repair, and result-quality stages.',
        features: [
            'Production and LLM-led operating profiles',
            'Per-stage switches with plain-language explanations',
            'Globally persisted settings applied to every new question',
            'Locked privacy, read-only safety, and local DuckDB execution',
        ],
        tips: [
            'Keep Production selected for normal use',
            'Use non-production combinations only for controlled diagnosis or ablation experiments',
        ],
    },
    GAME: {
        title: 'GAFS Challenge',
        description: 'Every chart is 4 steps: split it up, add something up, keep only the rows you want, put them in order. That is GAFS, and it is what Question Builder does. Learn it by helping a small farm work out which of its products makes money.',
        features: [
            'Story mode: 6 short chapters on Sam\'s farm, in plain English',
            'One step per chapter, building up to all 4',
            'Every chart is the real answer, worked out from his year of sales',
            'Wrong answers tell you why, instead of just buzzing',
            'Quick practice: 10 timed questions once the 4 steps make sense',
        ],
        tips: [
            'G — Grouping: split it up by what? e.g. one bar per product',
            'A — Aggregating: which number? e.g. add up the money',
            'F — Filtering: which rows? e.g. winter months only',
            'S — Sorting: in what order? e.g. biggest first, top 5',
        ],
    },
};

interface PageInfoButtonProps {
    pageKey: PageKey;
    className?: string;
}

export const PageInfoButton: React.FC<PageInfoButtonProps> = ({ pageKey, className = '' }) => {
    const [isOpen, setIsOpen] = useState(false);
    const info = PAGE_INFO[pageKey];
    if (!info) return null;

    return (
        <>
            {/* ── Info Icon Button ── */}
            <button
                onClick={() => setIsOpen(true)}
                className={`group relative p-1.5 rounded-lg hover:bg-indigo-50 transition-all duration-200 ${className}`}
                title={`Learn about ${info.title}`}
            >
                <Info className="w-4 h-4 text-slate-400 group-hover:text-indigo-500 transition-colors" />
            </button>

            {/* ── Info Modal (portaled to body) ── */}
            {isOpen && ReactDOM.createPortal(
                <div
                    className="fixed inset-0 z-[99999] flex items-center justify-center"
                    style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
                    onClick={() => setIsOpen(false)}
                >
                    <div
                        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-[90vw] max-w-lg max-h-[80vh] overflow-hidden"
                        style={{ animation: 'scaleIn 0.2s ease-out' }}
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-purple-50">
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl shadow-lg shadow-indigo-200">
                                    <Info className="w-5 h-5 text-white" />
                                </div>
                                <div>
                                    <h3 className="text-lg font-bold text-slate-900">{info.title}</h3>
                                    <p className="text-xs text-slate-500">Page Guide</p>
                                </div>
                            </div>
                            <button
                                onClick={() => setIsOpen(false)}
                                className="p-2 rounded-xl bg-slate-100 hover:bg-red-100 text-slate-400 hover:text-red-600 transition-all duration-200 shadow-sm"
                                title="Close"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="px-6 py-5 overflow-y-auto max-h-[60vh] space-y-5">
                            {/* Description */}
                            <p className="text-sm text-slate-700 leading-relaxed">{info.description}</p>

                            {/* Features */}
                            <div>
                                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">What you can do here</h4>
                                <ul className="space-y-1.5">
                                    {info.features.map((feat, i) => (
                                        <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
                                            <ArrowRight className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                                            {feat}
                                        </li>
                                    ))}
                                </ul>
                            </div>

                            {/* Tips */}
                            {info.tips && info.tips.length > 0 && (
                                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <Lightbulb className="w-4 h-4 text-amber-600" />
                                        <h4 className="text-xs font-bold text-amber-700 uppercase tracking-wider">Pro Tips</h4>
                                    </div>
                                    <ul className="space-y-1.5">
                                        {info.tips.map((tip, i) => (
                                            <li key={i} className="text-xs text-amber-700 leading-relaxed">
                                                💡 {tip}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </>
    );
};
