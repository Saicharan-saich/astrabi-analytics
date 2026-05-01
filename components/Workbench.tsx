import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    Play, Pin, BarChart2, LineChart as LineChartIcon, TrendingUp, PieChart as PieIcon,
    Activity, Grid, Palette, ChevronLeft, ChevronRight, X, Sparkles,
    MessageSquare, Settings, Share2, Download, Maximize2, RotateCcw, RefreshCw,
    Globe, LayoutGrid, Circle, Hexagon, ScatterChart, CircleDot, Disc, ChevronDown, Code, TrendingDown,
    HelpCircle, AlertTriangle, ChevronUp, Minimize2, Table2, PanelTopClose, Eye, EyeOff,
    Search, FileDown, Clipboard, CheckCircle2, MousePointerClick, Sliders, Hash, ArrowUpDown, Calendar
} from 'lucide-react';
import { Dataset, ColumnType, AggregationType, QueryConfig, AnalysisResult, TimeGrain, AnalysisType, ChartConfig, FormattingConfig } from '../types';
import { runAnalysis, QUESTION_BANK, autoPickConfig, resolveMapping, QUESTION_REGISTRY, getFullQuestionBank, getFullRegistry, getFullQuestionBankForDomain } from '../services/analysisEngine';
import { QuestionBuilder } from './QuestionBuilder';
import { ChartVisualization } from './ChartVisualization';
import { QuestionCustomizer } from './QuestionCustomizer';
import { ResultsTable } from './ResultsTable';
import { Tooltip as InfoTooltip } from './Tooltip';
import { getCalculationDisplayName, applyMultipleCalculations, type TableCalculation, type CalculatedColumn } from '../utils/tableCalculations';
import { AIInsightPanel } from './AIInsightPanel';
import { AISQLChat } from './AISQLChat';
import { generateDynamicLabel } from '../services/workbenchLogic'; // Fix #6: Use extracted pure function


interface WorkbenchProps {
    dataset: Dataset;
    initialConfig?: QueryConfig;
    initialResult?: AnalysisResult;
    onPin: (title: string, result: AnalysisResult) => void;
    onStateChange?: (config: QueryConfig | undefined, result: AnalysisResult | undefined) => void;
    formatting?: FormattingConfig;
    onUpdateFormatting?: (config: FormattingConfig) => void;
    pinLabel?: string;
}

const COLORS = ['#0f766e', '#0d9488', '#14b8a6', '#2dd4bf', '#5eead4'];

export const Workbench: React.FC<WorkbenchProps> = ({ dataset, initialConfig, initialResult, onPin, onStateChange, formatting, onUpdateFormatting, pinLabel }) => {
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [activeCategory, setActiveCategory] = useState<string | null>(getFullQuestionBank()[0]?.category);
    const [questionSearch, setQuestionSearch] = useState('');
    const [showAllQuestions, setShowAllQuestions] = useState(false);

    // 10 curated default questions — adapts to detected domain
    const DEFAULT_QUESTION_IDS = useMemo(() => {
        const detectedDomain = dataset?.domainProfile?.domain;
        if (!detectedDomain || detectedDomain === 'Sales' || detectedDomain === 'Retail') {
            // Sales defaults
            return new Set([
                'd_ma_7_rev', 'd_run_total_month', 'd_pct_chg_rev', 'w_vs_lw_rev',
                'w_pct_growth_rev', 'd_pct_total_prod', 'd_top_5_prod',
                'd_vs_y_rev', 'w_pct_growth_orders', 'd_pct_total_channel',
            ]);
        }
        // Non-Sales domain: use the first 10 questions from the domain question bank
        const domainBank = getFullQuestionBankForDomain(detectedDomain);
        const domainQIds: string[] = [];
        for (const cat of domainBank) {
            for (const q of cat.questions) {
                if (domainQIds.length < 10) domainQIds.push(q.intent.questionId);
            }
        }
        return new Set(domainQIds);
    }, [dataset?.domainProfile?.domain]);
    const [copiedSql, setCopiedSql] = useState(false);
    const [isFormatPanelOpen, setIsFormatPanelOpen] = useState(false);
    const [isAnalyticsPanelOpen, setIsAnalyticsPanelOpen] = useState(false);
    const [isAIInsightOpen, setIsAIInsightOpen] = useState(false);
    const chartContainerRef = useRef<HTMLDivElement>(null);

    // State
    const [config, setConfig] = useState<QueryConfig | undefined>(initialConfig);
    const [result, setResult] = useState<AnalysisResult | undefined>(initialResult);
    const [viewMode, setViewMode] = useState<'bank' | 'builder' | 'customizer'>('bank');
    const [error, setError] = useState<string | null>(null);
    const [semanticOverrides, setSemanticOverrides] = useState<Record<string, string>>({});
    const [filters, setFilters] = useState<Record<string, Set<string>>>({});
    // anchor_date: defaults to MAX of the anchor date column (defaultAnchorDate)
    const [anchorColumn, setAnchorColumn] = useState<string>(
        dataset.timeContext?.anchorDateColumn || ''
    );
    const [asOfDate, setAsOfDate] = useState<string>(
        dataset.timeContext?.defaultAnchorDate || dataset.timeContext?.maxDate || new Date().toISOString().split('T')[0]
    );
    const [isUserOverride, setIsUserOverride] = useState(false);
    const [originalQuestionTemplate, setOriginalQuestionTemplate] = useState<string>('');

    // Controls allowed in the Simplified View (customizer)
    const [allowedCustomizerControls, setAllowedCustomizerControls] = useState<string[]>(['metric', 'aggregation', 'dimension', 'time', 'sort', 'limit', 'filters']);

    const [showGrowthPct, setShowGrowthPct] = useState(false); // Growth Toggle State

    const [activeTab, setActiveTab] = useState<'visual' | 'filter'>('visual');

    // Builder collapse + content tabs for focus mode
    const [isBuilderCollapsed, setIsBuilderCollapsed] = useState(false);
    const [contentTab, setContentTab] = useState<'visual' | 'sql' | 'data'>('visual');

    // ── DYNAMIC CONTROLS ──
    const [topN, setTopN] = useState<number>(0); // 0 = use question default
    const [secondaryMetric, setSecondaryMetric] = useState<string>(''); // For multi-metric overlay
    const [periodScope, setPeriodScope] = useState<string>(''); // '' = use question default, or WTD/MTD/QTD/YTD
    const [periodGrain, setPeriodGrain] = useState<string>(''); // '' = default for scope, or day/week/month/quarter/year
    const [whatIfPct, setWhatIfPct] = useState<number>(0); // -50 to +100 percent offset

    // Default grain per period scope
    const defaultGrainForScope: Record<string, string> = { WTD: 'day', MTD: 'week', QTD: 'month', YTD: 'month' };
    const [isWhatIfActive, setIsWhatIfActive] = useState(false);
    const [isAISQLOpen, setIsAISQLOpen] = useState(false);

    // Semantic Mapping for Mad-lib
    const defaultMapping = useMemo(() => resolveMapping(dataset).fields, [dataset]);


    // Builder Control State
    const [builderState, setBuilderState] = useState({
        metric: initialConfig?.questionId === 'custom_builder' ? initialConfig?.metric || '' : '',
        aggregation: initialConfig?.aggregation || AggregationType.SUM,
        dimension: initialConfig?.questionId === 'custom_builder' ? initialConfig?.dimension || '' : '',
        timeFilter: initialConfig?.questionId === 'custom_builder' ? initialConfig?.timeFilter || '' : '',
        limit: initialConfig?.questionId === 'custom_builder' ? initialConfig?.limit || 0 : 0,
        sort: (initialConfig?.questionId === 'custom_builder' ? initialConfig?.sort || 'desc' : 'desc') as 'desc' | 'asc'
    });

    // Date filters from AI-saved custom questions (preserved across customizer re-runs)
    const [customDateFilters, setCustomDateFilters] = useState<any[]>([]);
    // AI SQL from saved custom questions (preserved across customizer re-runs)
    const [customAiSql, setCustomAiSql] = useState<string | null>(null);

    // Current Question
    const [currentQuestionLabel, setCurrentQuestionLabel] = useState<string>(initialConfig?.questionLabel || 'Select a question');
    const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(initialConfig?.questionId || null);

    // Active question's required roles for column override
    const activeQuestionReq = useMemo(() => {
        if (!currentQuestionId) return [];
        const registry = getFullRegistry();
        const qDef = registry.find(q => q.id === currentQuestionId);
        return qDef?.req || [];
    }, [currentQuestionId]);

    // Chart Type Selection
    const [chartType, setChartType] = useState<any>(initialConfig?.chartType || 'bar');

    // Helper: determine if question is a Top/Bottom N question (MUST come after currentQuestionId)
    const isTopNQuestion = useMemo(() => {
        if (!currentQuestionId) return false;
        return currentQuestionId.includes('top') || currentQuestionId.includes('best') ||
            currentQuestionId.includes('bottom') || currentQuestionId.includes('worst') ||
            currentQuestionId.includes('_pct_total_') || currentQuestionId.includes('pct_rev');
    }, [currentQuestionId]);

    // Helper: determine if question is a running total question
    const isRunningTotalQuestion = useMemo(() => {
        if (!currentQuestionId) return false;
        return currentQuestionId.includes('_run_');
    }, [currentQuestionId]);

    // Initialize or Re-initialize when initialConfig changes (e.g. Edit Mode)
    useEffect(() => {
        if (initialConfig) {
            // Sync UI state BEFORE running analysis (handleRunAnalysis reads these)
            if (initialConfig.chartType) setChartType(initialConfig.chartType);
            if (initialConfig.questionLabel) setCurrentQuestionLabel(initialConfig.questionLabel);
            if (initialConfig.questionId) setCurrentQuestionId(initialConfig.questionId);

            // Switch to appropriate view mode
            if (initialConfig.questionId === 'custom_builder') {
                setViewMode('builder');
                setBuilderState({
                    metric: initialConfig.metric || '',
                    aggregation: initialConfig.aggregation || AggregationType.SUM,
                    dimension: initialConfig.dimension || '',
                    timeFilter: initialConfig.timeFilter || '',
                    limit: initialConfig.limit || 0,
                    sort: (initialConfig.sort || 'desc') as 'desc' | 'asc'
                });
            } else {
                setViewMode('bank');
            }

            // Use setTimeout to ensure chartType state has been applied before handleRunAnalysis reads it
            setTimeout(() => handleRunAnalysis(initialConfig), 0);
        }

        // Always reset AS OF date when dataset changes — user override only persists within the same dataset
        const tc = dataset.timeContext;
        if (tc) {
            setAnchorColumn(tc.anchorDateColumn || '');
            setAsOfDate(tc.defaultAnchorDate || tc.maxDate || new Date().toISOString().split('T')[0]);
            setIsUserOverride(false); // Reset override on dataset change
        }
    }, [dataset.id, initialConfig]); // Track initialConfig to fire on Edit Mode entry

    // Dedicated effect: sync asOfDate when ETL populates timeContext (async)
    // This fires AFTER the dataset useEffect above, when timeContext becomes available
    useEffect(() => {
        const tc = dataset.timeContext;
        if (tc && !isUserOverride) {
            const newDate = tc.defaultAnchorDate || tc.maxDate || '';
            if (newDate) {
                setAnchorColumn(tc.anchorDateColumn || '');
                setAsOfDate(newDate);
            }
        }
    }, [dataset.timeContext]);

    // User manually changes AS OF date
    const handleAsOfDateChange = (date: string) => {
        setAsOfDate(date);
        setIsUserOverride(true);
    };

    // Reset AS OF date back to dataset_max_date
    const handleAsOfDateReset = () => {
        const defaultDate = dataset.timeContext?.defaultAnchorDate || dataset.timeContext?.maxDate || new Date().toISOString().split('T')[0];
        setAsOfDate(defaultDate);
        setIsUserOverride(false);
    };

    // When user changes anchor column, recompute AS OF date AND re-run analysis
    const handleAnchorColumnChange = (col: string) => {
        setAnchorColumn(col);
        const maxForCol = dataset.timeContext?.dateColumnMaxDates?.[col];
        if (maxForCol && !isUserOverride) setAsOfDate(maxForCol);

        // Map the new column to the 'order_date' semantic role so evaluateLocally uses it
        const newOverrides = { ...semanticOverrides, order_date: col };
        setSemanticOverrides(newOverrides);

        // Re-run analysis immediately with the updated overrides
        if (config) {
            const newAsOf = (maxForCol && !isUserOverride) ? maxForCol : asOfDate;
            handleRunAnalysis({
                ...config,
                asOfDate: newAsOf,
                semanticRoles: newOverrides
            });
        }
    };

    const handleRunAnalysis = (config: QueryConfig) => {
        // Reset AI insight panel when switching questions
        setIsAIInsightOpen(false);

        // Embed UI state into config for persistence
        // Prefer chartType from config (e.g. from edit mode) over potentially stale state
        const effectiveChartType = (config as any).chartType || chartType;
        const fullConfig: any = {
            ...config,
            chartType: effectiveChartType,
            questionLabel: (config as any).questionLabel || currentQuestionLabel
        };

        // ── INJECT DYNAMIC CONTROLS ──
        if (!('limit' in config) && topN > 0) fullConfig.limit = topN;
        const activeScope = 'periodScope' in config ? (config as any).periodScope : periodScope;
        if (activeScope) {
            (fullConfig as any).periodScope = activeScope;
            // Pass the grain (user override or default for this scope)
            const activeGrain = (config as any).periodGrain || periodGrain || defaultGrainForScope[activeScope] || 'day';
            (fullConfig as any).periodGrain = activeGrain;
            if (fullConfig.questionLabel && /\b(WTD|MTD|QTD|YTD)\b/.test(fullConfig.questionLabel)) {
                fullConfig.questionLabel = fullConfig.questionLabel.replace(/\b(WTD|MTD|QTD|YTD)\b/g, activeScope);
                setCurrentQuestionLabel(fullConfig.questionLabel);
            }
        }

        setConfig(fullConfig);
        console.log('[Workbench handleRunAnalysis] FINAL config:', JSON.stringify({
            questionId: fullConfig.questionId,
            metric: fullConfig.metric,
            dimension: fullConfig.dimension,
            timeFilter: fullConfig.timeFilter,
            sort: fullConfig.sort,
            limit: fullConfig.limit,
            comparison: fullConfig.comparison,
            periodScope: (fullConfig as any).periodScope,
            dateFilters: fullConfig.dateFilters
        }));
        try {
            let analysisResult = runAnalysis(dataset, {
                ...fullConfig,
                asOfDate: config.asOfDate || asOfDate,
                // CRITICAL FIX: Use filters from config if present, otherwise state filters
                filters: config.filters || Object.fromEntries(
                    Object.entries(filters).map(([k, v]) => [k, Array.from(v as Set<string>)])
                ),
                measureFilters: config.measureFilters || [],
                dateFilters: config.dateFilters || [], // PASS DATE FILTERS
                // Prefer semanticRoles from config (for fresh overrides) over stale state
                semanticRoles: (config as any).semanticRoles || semanticOverrides
            });

            // ── WHAT-IF: Apply metric multiplier to results ──
            if (isWhatIfActive && whatIfPct !== 0 && analysisResult.data && analysisResult.data.length > 0) {
                const multiplier = 1 + (whatIfPct / 100);
                const yKey = analysisResult.yKey;
                const projectedData = analysisResult.data.map((row: any) => ({
                    ...row,
                    [yKey]: typeof row[yKey] === 'number' ? row[yKey] * multiplier : row[yKey],
                    _original: row[yKey] // Keep original for reference
                }));
                analysisResult = {
                    ...analysisResult,
                    data: projectedData,
                    kpi: typeof analysisResult.kpi === 'number' ? analysisResult.kpi * multiplier : analysisResult.kpi,
                    yLabel: `${analysisResult.yLabel} (What-If ${whatIfPct > 0 ? '+' : ''}${whatIfPct}%)`
                };
            }

            setResult(analysisResult);
            setError(null);

            // Apply the recommended chart type from the question registry
            // Only auto-set if not explicitly overridden by the user (e.g., via Edit Mode or chart picker)
            if (analysisResult.vis && !(config as any).chartType) {
                setChartType(analysisResult.vis);
            }

            // Notify parent of state change
            if (onStateChange) {
                onStateChange(fullConfig, analysisResult);
            }
        } catch (err) {
            setError(String(err));
            console.error(err);
        }
    };

    // Sync Chart Type changes to Config persistence
    const handleChartTypeChange = (type: any) => {
        setChartType(type);
        if (config) {
            const newConfig = { ...config, chartType: type };
            setConfig(newConfig);
            if (onStateChange) onStateChange(newConfig, result);
        }
    };

    // Handler specifically for the Question Builder
    const handleBuilderRun = (builderConfig: any) => {
        setError(null);
        setCurrentQuestionLabel(`${builderConfig.metric} by ${builderConfig.dimension}`);
        setCurrentQuestionId('custom_builder');

        // Persist builder state for restoration
        setBuilderState({
            metric: builderConfig.metric,
            aggregation: builderConfig.aggregation,
            dimension: builderConfig.dimension,
            timeFilter: builderConfig.timeFilter,
            limit: builderConfig.limit,
            sort: builderConfig.sort
        });

        console.log('[handleBuilderRun] comparison from builder:', builderConfig.comparison, '| comparisonGrain:', builderConfig.comparisonGrain);

        // Convert builder config to proper QueryConfig with custom_builder ID
        const queryConfig: QueryConfig = {
            questionId: 'custom_builder',
            metric: builderConfig.metric,
            dimension: builderConfig.dimension,
            aggregation: builderConfig.aggregation || AggregationType.SUM,
            timeGrain: builderConfig.timeGrain || TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: asOfDate,
            filters: builderConfig.filters || {},
            measureFilters: builderConfig.measureFilters || [],
            dateFilters: builderConfig.dateFilters || [],
            timeFilter: builderConfig.timeFilter,
            limit: builderConfig.limit,
            sort: builderConfig.sort,
            // CRITICAL: Forward comparison fields from builder (or explicitly clear them)
            comparison: builderConfig.comparison || undefined,
            comparisonGrain: builderConfig.comparison ? builderConfig.comparisonGrain : undefined,
            comparisonOffset: builderConfig.comparison ? builderConfig.comparisonOffset : undefined,
            ...(secondaryMetric ? { secondaryMetrics: [secondaryMetric], axisMode: 'auto' as const } : {}),
            // Also forward secondary metrics from builder if present
            ...(builderConfig.secondaryMetrics?.length > 0 ? {
                secondaryMetrics: builderConfig.secondaryMetrics,
                axisMode: builderConfig.axisMode || 'auto',
                secondaryMetricVisuals: builderConfig.secondaryMetricVisuals
            } : {})
        };

        handleRunAnalysis(queryConfig);
    };


    // Extract columns for inference
    const availableMetrics = useMemo(() => dataset.columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name), [dataset]);
    const availableDims = useMemo(() => dataset.columns.filter(c => c.type === ColumnType.DIMENSION).map(c => c.name), [dataset]);

    const handleQuestionClick = (q: any) => {
        try {
            const config = autoPickConfig(dataset, q.intent, asOfDate);
            setCurrentQuestionLabel(q.label);
            setOriginalQuestionTemplate(q.label); // Store the original for smart substitution
            setCurrentQuestionId(q.intent.questionId);
            setPeriodScope(''); // Reset period scope when switching questions
            setPeriodGrain('');
            setError('');
            setResult(undefined);

            // Find the actual question template to extract its requirements
            const questionDef = getFullRegistry().find(qt => qt.id === q.intent.questionId);
            // Also check custom questions from localStorage (AI-saved questions)
            const customQuestions = JSON.parse(localStorage.getItem('astrabi_custom_questions') || '[]');
            const customDef = customQuestions.find((cq: any) =>
                cq.question === q.label || cq.questionId === q.intent.questionId
            );
            console.log('[Workbench] Custom question lookup:', { label: q.label, found: !!customDef, metric: customDef?.metric, dim: customDef?.dimension });

            // Set custom date filters from AI-saved question (preserved across customizer re-runs)
            const savedDateFilters = (customDef && customDef.dateFilters && customDef.dateFilters.length > 0)
                ? customDef.dateFilters.map((df: any) => ({ column: df.column, timeGrain: 'day', values: df.values }))
                : [];
            setCustomDateFilters(savedDateFilters);

            // Store AI SQL for direct execution (preserved across customizer re-runs)
            setCustomAiSql(customDef?.aiSql || null);

            // Extract metric and dimension from the question's requirements
            let inferredMetric = '';
            let inferredDim = '';
            let inferredAgg = AggregationType.SUM;

            // For AI-saved custom questions, use stored metric/dimension directly
            if (customDef && customDef.metric) {
                inferredMetric = customDef.metric;
                inferredDim = customDef.dimension || '';
                if (customDef.aggregation === 'avg') inferredAgg = AggregationType.AVG;
                else if (customDef.aggregation === 'count_distinct') inferredAgg = AggregationType.COUNT_DISTINCT;
                else if (customDef.aggregation === 'count') inferredAgg = AggregationType.COUNT;
                else inferredAgg = AggregationType.SUM;
            } else if (questionDef && questionDef.req) {
                // Find metric requirement (revenue, quantity, stock, etc.)
                // Also check for ID columns if the question implies counting entities (orders, customers)
                const metricReq = questionDef.req.find(r =>
                    ['revenue', 'quantity', 'stock', 'order_id', 'customer_id', 'id'].some(k => r.includes(k))
                );

                if (metricReq) {
                    // Smart Alias Matching
                    const aliases: Record<string, string[]> = {
                        revenue: ['revenue', 'sales', 'amount', 'price', 'value'],
                        quantity: ['quantity', 'units', 'qty', 'volume', 'count'],
                        stock: ['stock', 'inventory', 'on_hand'],
                        order_id: ['order_id', 'order', 'id'],
                        customer_id: ['customer_id', 'customer', 'user']
                    };

                    // Determine keys to search for
                    // If metricReq is specifically 'order_id' or 'customer_id', prioritize finding that precise column
                    let keywords = [metricReq];
                    for (const [key, val] of Object.entries(aliases)) {
                        if (metricReq.includes(key)) {
                            keywords = val;
                            break;
                        }
                    }

                    // Search in ALL columns, not just metrics, because ID columns are valid for COUNT
                    const allCols = dataset.columns.map(c => c.name);
                    inferredMetric = allCols.find(m => keywords.some(k => m.toLowerCase().includes(k))) || '';
                }

                // 3. Infer Aggregation
                // inferredAgg = AggregationType.SUM; // Already defaulted
                const questionId = q.intent.questionId;
                if (questionId.includes('_aov')) inferredAgg = AggregationType.AVG;
                else if (questionId.includes('count') || questionId.includes('orders')) inferredAgg = AggregationType.COUNT_DISTINCT;
                else if (questionId.includes('units')) inferredAgg = AggregationType.SUM;
                // Default to SUM for revenue/sales

                // 4. Infer Dimension (Basic Heuristic) (product_name, source, campaign, etc.)
                if (questionDef.req) {
                    const dimReq = questionDef.req.find(r => ['product_name', 'source', 'campaign'].includes(r));
                    if (dimReq) {
                        const aliases: Record<string, string[]> = {
                            product_name: ['product_name', 'product', 'item', 'sku'],
                            source: ['source', 'channel', 'medium', 'referrer'],
                            campaign: ['campaign', 'promo', 'ad']
                        };
                        const keywords = aliases[dimReq] || [dimReq];
                        inferredDim = availableDims.find(d => keywords.some(k => d.toLowerCase().includes(k))) || '';
                    }
                }
            }

            if (!inferredDim) {
                // If the question explicitly asks for a trend or breakdown, we might infer a dimension
                // But for "How much...", we want a scalar.
                // We should NOT default to 'day' just because the ID starts with 'd_' 
                // because 'd_' usually means 'Daily Performance' (a category), not 'Group by Day'.

                // Only infer dimension if the question text implies it
                const qLabel = q.label.toLowerCase();
                if (qLabel.includes(' by ') || qLabel.includes(' per ') || qLabel.includes(' trend')) {
                    if (q.intent.questionId.startsWith('d_')) inferredDim = 'day';
                    else if (q.intent.questionId.startsWith('w_')) inferredDim = 'week';
                    else if (q.intent.questionId.startsWith('m_')) inferredDim = 'month';
                    else {
                        inferredDim = availableDims.find(d => d.toLowerCase().includes('product') || d.toLowerCase().includes('source') || d.toLowerCase().includes('category')) || availableDims[0] || '';
                    }
                }
            }



            // Helper to infer time filter for Builder
            const inferTimeFilter = (_id: string) => {
                // Questions have their own built-in time scoping (e.g., d_ = today, w_ = this week).
                // The time period dropdown should start as "Default" (empty) so the question
                // runs with its natural behavior first. User can then manually override.
                return '';
            };


            // Setup Builder State
            const builderConfig = {
                metric: inferredMetric,
                aggregation: inferredAgg,
                dimension: inferredDim,
                timeFilter: inferTimeFilter(q.intent.questionId),
                limit: (customDef && customDef.limit) || 0,
                sort: (customDef && customDef.sort) || 'desc'
            };
            setBuilderState(builderConfig as any);

            // Determine allowed controls based on the NATURE of the question
            // User wants ONLY the parameters present in the original question

            // For scalar questions (no dimension): only metric and time
            // For grouped questions: metric, time, dimension, sort, limit

            const allowed: string[] = ['metric', 'time', 'filters']; // Always allowed for all questions

            // If the question inherently has a dimension (Group By), allow modifying it, plus Sort/Limit
            // But NEVER show aggregation - it's implicit in the question
            if (inferredDim) {
                allowed.push('dimension');
                allowed.push('sort');
                allowed.push('limit');
            }

            // Note: We deliberately exclude 'aggregation' to keep it simple
            // Aggregation is implicit in the question ("How much" = SUM)

            setAllowedCustomizerControls(allowed);

            // Switch View to Customizer (Simplified View)
            setViewMode('customizer');

            // Force reset formatting to 'auto' to ensure intelligent formatting applies
            if (onUpdateFormatting && formatting) {
                onUpdateFormatting({ ...formatting, numberFormat: 'auto' });
            }

            // Run the actual CLICKED question logic
            // If custom question has aiSql, pass it directly for alasql execution
            const runConfig = {
                ...config,
                metric: inferredMetric || config.metric,
                dimension: inferredDim || config.dimension,
                aggregation: inferredAgg || config.aggregation,
                limit: (customDef && customDef.limit) || config.limit,
                sort: (customDef && customDef.sort) || config.sort,
                ...(customDef && customDef.aiSql ? { aiSql: customDef.aiSql } : {}),
            };
            console.log('[Workbench] Running with config:', { metric: runConfig.metric, dimension: runConfig.dimension, aiSql: !!(runConfig as any).aiSql });
            handleRunAnalysis(runConfig);
        } catch (err: any) {
            setError(err.message);
        }
    };


    // generateDynamicLabel — Fix #6: now imported from ../services/workbenchLogic

    // Handler for Question Customizer updates (keeps Simplified View but runs dynamic logic)
    const handleCustomizerRun = (customConfig: any) => {
        console.log('[Workbench] ========== CUSTOMIZER RUN START ==========');
        console.log('[Workbench] customConfig received:', JSON.stringify({
            metric: customConfig.metric,
            dimension: customConfig.dimension,
            timeFilter: customConfig.timeFilter,
            sort: customConfig.sort,
            limit: customConfig.limit
        }));
        console.log('[Workbench] periodScope state:', periodScope);

        setError(null);

        // Dynamically update label so it never disappears or becomes stale
        const newLabel = generateDynamicLabel(customConfig, originalQuestionTemplate);
        setCurrentQuestionLabel(newLabel);

        // Preserve the original questionId for specialized question types that have
        // dedicated logic in evaluateLocally (moving averages, running totals,
        // comparisons, percent-of-total, trends, operational).
        // These handlers compute results that custom_builder cannot replicate
        // (e.g., windowed averages, cumulative sums, period-vs-period diffs).
        // Only fall back to custom_builder for simple KPI/scalar questions.
        const specialPatterns = ['_ma_', '_run_', '_vs_', '_pct_', 'trend', 'op_', '_mtd_', '_py_', '_growth_', '_aov'];
        const isSpecialized = currentQuestionId && specialPatterns.some(p => currentQuestionId.includes(p));
        const preservedQuestionId = isSpecialized ? currentQuestionId : 'custom_builder';
        console.log(`[Workbench] ROUTING → ${preservedQuestionId} (${isSpecialized ? 'specialized handler' : 'generic handler'})`);

        // Update Builder State so switching to Full Builder works seamlessly
        setBuilderState({
            metric: customConfig.metric,
            aggregation: customConfig.aggregation,
            dimension: customConfig.dimension,
            timeFilter: customConfig.timeFilter,
            limit: customConfig.limit,
            sort: customConfig.sort
        });

        // Determine if this is effectively a scalar question based on the requested dimension
        const hasDimension = !!customConfig.dimension;

        const queryConfig: QueryConfig = {
            questionId: preservedQuestionId,
            metric: customConfig.metric,
            dimension: customConfig.dimension, // Trust the customizer (Trend toggle sets 'day', Total sets '')
            aggregation: customConfig.aggregation || AggregationType.SUM,
            timeGrain: TimeGrain.RAW, // RAW for scalar, otherwise use the timeGrain
            analysisType: AnalysisType.STANDARD,
            asOfDate: asOfDate,
            filters: customConfig.filters || {},
            measureFilters: customConfig.measureFilters || [],
            dateFilters: (customConfig.dateFilters && customConfig.dateFilters.length > 0) ? customConfig.dateFilters : customDateFilters,
            // Only inject AI SQL for custom_builder questions, NOT for specialized handlers
            ...(customAiSql && preservedQuestionId === 'custom_builder' ? { aiSql: customAiSql } : {}),
            timeFilter: customConfig.timeFilter,
            limit: hasDimension ? customConfig.limit : 0, // No limit for scalar
            sort: hasDimension ? customConfig.sort : 'desc', // Sort doesn't matter for scalar
            // Carry forward analytics settings (comparison, etc.) from current config
            comparison: (config as any)?.comparison || 'none',
            // Moving average window size from customizer
            maWindow: customConfig.maWindow,
            // Secondary metric for multi-metric overlay
            ...(secondaryMetric ? { secondaryMetrics: [secondaryMetric], axisMode: 'auto' as const } : {}),
        } as any;

        // Propagate periodScope so WTD/MTD/QTD/YTD buttons aren't overridden
        // BUT if the user explicitly set a timeFilter from the dropdown, clear periodScope
        // to prevent double-filtering (e.g., 'This Quarter' + stale 'WTD' = only 1 week)
        if (customConfig.timeFilter && customConfig.timeFilter !== '') {
            setPeriodScope('');
            setPeriodGrain('');
        } else if (periodScope) {
            (queryConfig as any).periodScope = periodScope;
        }

        // Stay in 'customizer' mode
        setViewMode('customizer');

        handleRunAnalysis(queryConfig);
    };

    const handleOverrideChange = (role: string, column: string) => {
        const newOverrides = { ...semanticOverrides, [role]: column };
        setSemanticOverrides(newOverrides);
        if (currentQuestionId) {
            // Pass newOverrides directly — don't rely on semanticOverrides state
            // which hasn't flushed yet due to React setState batching
            handleRunAnalysis({
                ...(config || {}),
                questionId: currentQuestionId,
                asOfDate,
                semanticRoles: newOverrides,
                metric: config?.metric || '', dimension: config?.dimension || '',
                aggregation: config?.aggregation || AggregationType.SUM,
                timeGrain: config?.timeGrain || TimeGrain.RAW,
                analysisType: config?.analysisType || AnalysisType.STANDARD
            });
        }
    };

    const toggleFilter = (col: string, val: string) => {
        setFilters(prev => {
            const newFilters = { ...prev };
            const currentSet = newFilters[col] || new Set();
            if (currentSet.has(val)) {
                currentSet.delete(val);
            } else {
                currentSet.add(val);
            }
            if (currentSet.size === 0) {
                delete newFilters[col];
            } else {
                newFilters[col] = currentSet;
            }
            return newFilters;
        });
        if (config) handleRunAnalysis(config);
    };

    // Helper to get dropdowns based on active semantic roles in the query
    const renderMadLibDropdowns = () => {
        // If we have a result, we know what roles were used (from mapping)
        // We display dropdowns for 'revenue', 'quantity', 'product_name', 'source', 'country' if they appear in defaultMapping
        // This allows the user to swap them.

        const rolesToExpose = ['revenue', 'quantity', 'product_name', 'source', 'country', 'campaign', 'customer_id'];

        return rolesToExpose.map(role => {
            // Only show if this role implies a column exists or is needed
            const currentVal = semanticOverrides[role] || defaultMapping[role];
            if (!currentVal && !['revenue', 'product_name'].includes(role)) return null; // Always show rev/prod as examples

            const isMetric = ['revenue', 'quantity', 'cost', 'discount'].includes(role);
            const options = isMetric ? availableMetrics : availableDims;
            const label = role.replace('_', ' ');

            return (
                <div key={role} className="flex items-center space-x-2 bg-slate-100 rounded px-2 py-1">
                    <span className="text-xs font-semibold text-slate-400 uppercase">{label}</span>
                    <div className="relative group">
                        <select
                            className="appearance-none bg-transparent text-indigo-700 font-bold pr-4 focus:outline-none cursor-pointer text-sm"
                            value={currentVal || ''}
                            onChange={(e) => handleOverrideChange(role, e.target.value)}
                        >
                            {options.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                    </div>
                </div>
            );
        });
    };

    return (
        <div className="flex h-full bg-slate-50 overflow-hidden relative">
            {/* LEFT SIDEBAR TOGGLE (Mobile/Desktop) */}
            <div className={`absolute left-0 top-1/2 -translate-y-1/2 z-20 transition-all duration-300 ${isSidebarOpen ? 'left-64' : 'left-0'}`}>
                <button
                    onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                    className="bg-indigo-600 border border-indigo-700 shadow-lg p-1.5 rounded-r-lg hover:bg-indigo-700 text-white transition-colors"
                    title={isSidebarOpen ? "Collapse Sidebar" : "Expand Sidebar"}
                >
                    {isSidebarOpen ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                </button>
            </div>

            {/* LEFT SIDEBAR */}
            <div className={`${isSidebarOpen ? 'w-64' : 'w-0'} transition-all duration-300 bg-white border-r border-slate-200 flex-shrink-0 flex flex-col overflow-y-auto overflow-x-hidden`}>
                <div className="p-4 border-b border-slate-100 bg-slate-50 min-w-[16rem]">
                    <InfoTooltip text="Pre-built questions organized by category. Click any question to instantly run it against your data. Questions auto-adapt to your column names." position="right">
                        <h3 className="font-bold text-slate-800 flex items-center text-sm">
                            <HelpCircle className="w-4 h-4 mr-2 text-indigo-500" />
                            Question Bank
                        </h3>
                    </InfoTooltip>
                    {/* Question Search */}
                    <div className="relative mt-3">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                        <input
                            type="text"
                            value={questionSearch}
                            onChange={(e) => setQuestionSearch(e.target.value)}
                            placeholder="Search questions..."
                            className="w-full pl-8 pr-7 py-2 text-xs text-slate-800 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 transition-colors placeholder:text-slate-400"
                        />
                        {questionSearch && (
                            <button onClick={() => setQuestionSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                                <X className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                    {/* Default / All Toggle */}
                    <div className="flex items-center mt-2">
                        <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200 w-full">
                            <button
                                onClick={() => setShowAllQuestions(false)}
                                className={`flex-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all ${!showAllQuestions
                                    ? 'bg-white text-indigo-700 shadow-sm'
                                    : 'text-slate-400 hover:text-slate-600'
                                    }`}
                            >
                                Default (10)
                            </button>
                            <button
                                onClick={() => setShowAllQuestions(true)}
                                className={`flex-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all ${showAllQuestions
                                    ? 'bg-white text-indigo-700 shadow-sm'
                                    : 'text-slate-400 hover:text-slate-600'
                                    }`}
                            >
                                All
                            </button>
                        </div>
                    </div>
                </div>
                <div className="p-2 space-y-1 min-w-[16rem]">
                    {getFullQuestionBankForDomain(dataset?.domainProfile?.domain).map((cat) => {
                        const searchLower = questionSearch.toLowerCase();
                        let filteredQs = questionSearch
                            ? cat.questions.filter(q => q.label.toLowerCase().includes(searchLower))
                            : cat.questions;
                        // Apply default filter when not showing all
                        if (!showAllQuestions && !questionSearch) {
                            filteredQs = filteredQs.filter(q => DEFAULT_QUESTION_IDS.has(q.intent.questionId));
                        }
                        if (filteredQs.length === 0) return null;
                        const isExpanded = questionSearch ? true : activeCategory === cat.category;
                        return (
                            <div key={cat.category} className="border border-slate-100 rounded-lg overflow-hidden mb-2">
                                <button onClick={() => setActiveCategory(activeCategory === cat.category ? null : cat.category)} className="w-full flex items-center justify-between p-3 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 uppercase tracking-wider">
                                    <span>{cat.category}</span>
                                    <span className="flex items-center gap-1.5">
                                        <span className="text-[10px] text-slate-400 font-normal normal-case">{filteredQs.length}</span>
                                        <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                    </span>
                                </button>
                                {isExpanded && (
                                    <div className="bg-slate-50 p-2 space-y-1 border-t border-slate-100">
                                        {filteredQs.map((q, i) => (
                                            <button
                                                key={i}
                                                onClick={() => handleQuestionClick(q)}
                                                className={`w-full text-left p-2 text-xs rounded transition-colors ${currentQuestionLabel === q.label ? 'bg-indigo-100 text-indigo-700 font-medium' : 'hover:bg-indigo-50 text-slate-600'}`}
                                            >
                                                {q.label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* CENTER */}
            <div className="flex-1 flex flex-col h-full overflow-hidden relative min-w-0">

                {/* MAD-LIB BUILDER — Collapsible */}
                <div className={`z-10 bg-white border-b border-slate-200 transition-all duration-300 ${isBuilderCollapsed ? 'max-h-0 overflow-hidden border-b-0' : 'max-h-[500px] overflow-visible'}`}>
                    <div className="flex items-start">
                        <div className="flex-1 ml-4 sm:ml-0 transition-all">
                            {viewMode === 'customizer' ? (
                                <QuestionCustomizer
                                    dataset={dataset}
                                    onRun={handleCustomizerRun}
                                    initialMetric={builderState.metric}
                                    initialAggregation={builderState.aggregation}
                                    initialDimension={builderState.dimension}
                                    initialTimeFilter={builderState.timeFilter}
                                    initialLimit={builderState.limit}
                                    initialSort={builderState.sort}
                                    asOfDate={asOfDate}
                                    onDateChange={handleAsOfDateChange}
                                    anchorColumn={anchorColumn}
                                    onAnchorColumnChange={handleAnchorColumnChange}
                                    questionLabel={currentQuestionLabel}
                                    allowedControls={allowedCustomizerControls}
                                    questionReq={activeQuestionReq}
                                    columnMapping={defaultMapping}
                                    semanticOverrides={semanticOverrides}
                                    onColumnOverrideChange={handleOverrideChange}
                                />
                            ) : (
                                <QuestionBuilder
                                    dataset={dataset}
                                    onRun={handleBuilderRun}
                                    initialMetric={builderState.metric}
                                    initialAggregation={builderState.aggregation}
                                    initialDimension={builderState.dimension}
                                    initialTimeFilter={builderState.timeFilter}
                                    initialLimit={builderState.limit}
                                    initialSort={builderState.sort}
                                    asOfDate={asOfDate}
                                    onDateChange={(date) => {
                                        handleAsOfDateChange(date);
                                        if (config) handleRunAnalysis({ ...config, asOfDate: date });
                                    }}
                                    anchorColumn={anchorColumn}
                                    onAnchorColumnChange={handleAnchorColumnChange}
                                />
                            )}
                        </div>

                    </div>
                </div>

                <div className="bg-white border-b border-slate-200 px-3 py-1.5 shrink-0">
                    {/* Controls (wrapping) */}
                    <div className="flex items-center gap-2 flex-wrap">
                        <button
                            onClick={() => setIsBuilderCollapsed(!isBuilderCollapsed)}
                            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold transition-all shrink-0 ${isBuilderCollapsed
                                ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100'
                                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                }`}
                            title={isBuilderCollapsed ? 'Show Query Builder' : 'Hide Query Builder'}
                        >
                            {isBuilderCollapsed ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                            {isBuilderCollapsed ? 'Show Builder' : 'Hide Builder'}
                        </button>

                        {/* AI SQL Generator Toggle */}
                        <button
                            onClick={() => setIsAISQLOpen(!isAISQLOpen)}
                            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold transition-all shrink-0 ${isAISQLOpen
                                ? 'bg-violet-500 text-white shadow-sm hover:bg-violet-600'
                                : 'bg-violet-50 text-violet-600 ring-1 ring-violet-200 hover:bg-violet-100'
                                }`}
                            title="AI SQL Generator — generate SQL from natural language"
                        >
                            <Sparkles className="w-4 h-4" />
                            AI SQL
                        </button>

                        <div className="w-px h-4 bg-slate-200 shrink-0" />

                        {/* Content Tabs */}
                        {result && !error && (
                            <>
                                {(['visual', 'sql', 'data'] as const).map(tab => (
                                    <button
                                        key={tab}
                                        onClick={() => setContentTab(tab)}
                                        className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold transition-all shrink-0 ${contentTab === tab
                                            ? 'bg-slate-800 text-white shadow-sm'
                                            : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                                            }`}
                                    >
                                        {tab === 'visual' && <BarChart2 className="w-4 h-4" />}
                                        {tab === 'sql' && <Code className="w-4 h-4" />}
                                        {tab === 'data' && <Table2 className="w-4 h-4" />}
                                        {tab === 'visual' ? 'Visual' : tab === 'sql' ? 'SQL' : 'Data'}
                                    </button>
                                ))}
                            </>
                        )}

                        {/* X/Y Axis Toggles + Y-Axis Format */}
                        {result && !error && contentTab === 'visual' && formatting && onUpdateFormatting && (
                            <div className="flex items-center gap-1.5 ml-2 shrink-0 border border-slate-300 rounded-lg px-2 py-0.5 bg-white">
                                <span className="text-xs text-slate-900 font-bold mr-0.5">Axis:</span>
                                <button
                                    onClick={() => onUpdateFormatting({ ...formatting, showXAxis: !(formatting.showXAxis ?? formatting.showAxis ?? false) })}
                                    className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all border ${(formatting.showXAxis ?? formatting.showAxis ?? false)
                                        ? 'bg-indigo-100 text-indigo-700 border-indigo-300'
                                        : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-100'
                                        }`}
                                    title="Toggle X-Axis visibility"
                                >X</button>
                                <button
                                    onClick={() => onUpdateFormatting({ ...formatting, showYAxis: !(formatting.showYAxis ?? formatting.showAxis ?? false) })}
                                    className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all border ${(formatting.showYAxis ?? formatting.showAxis ?? false)
                                        ? 'bg-indigo-100 text-indigo-700 border-indigo-300'
                                        : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-100'
                                        }`}
                                    title="Toggle Y-Axis visibility"
                                >Y</button>
                                <select
                                    value={formatting.yAxisFormat || 'compact'}
                                    onChange={(e) => onUpdateFormatting({ ...formatting, yAxisFormat: e.target.value as any })}
                                    className="px-2 py-1 rounded-md text-xs font-bold border border-slate-300 bg-white text-slate-900 hover:bg-slate-100 transition-all cursor-pointer"
                                    title="Y-axis number format"
                                >
                                    <option value="compact">K/M/B</option>
                                    <option value="full">Full</option>
                                    <option value="short_currency">$K/$M</option>
                                </select>
                            </div>
                        )}

                        {/* ── SECONDARY METRIC (+ Metric) ── */}
                        {result && !error && contentTab === 'visual' && (
                            <div className="flex items-center gap-1 ml-2 shrink-0">
                                <select
                                    value={secondaryMetric}
                                    onChange={(e) => {
                                        setSecondaryMetric(e.target.value);
                                        // Re-run analysis with the new secondary metric
                                        if (result?.config) {
                                            const updatedConfig = {
                                                ...result.config,
                                                secondaryMetrics: e.target.value ? [e.target.value] : undefined,
                                                axisMode: e.target.value ? 'auto' as const : undefined,
                                            };
                                            console.log('[Workbench] Adding secondary metric:', e.target.value, 'config:', JSON.stringify({ metric: updatedConfig.metric, dimension: updatedConfig.dimension, secondaryMetrics: updatedConfig.secondaryMetrics }));
                                            handleRunAnalysis(updatedConfig);
                                        } else {
                                            console.warn('[Workbench] Cannot add secondary metric: result.config is null');
                                        }
                                    }}
                                    className="px-2.5 py-1 rounded-lg text-xs font-bold border border-slate-300 bg-white text-slate-900 hover:bg-slate-100 transition-all cursor-pointer max-w-[130px]"
                                    title="Add a secondary metric to overlay on chart"
                                >
                                    <option value="">+ Metric</option>
                                    {availableMetrics
                                        .filter(m => m !== (result?.config?.metric || builderState.metric))
                                        .map(m => (
                                            <option key={m} value={m}>{m}</option>
                                        ))
                                    }
                                </select>
                            </div>
                        )}

                        {/* ── TOP N CONTROL ── */}
                        {result && !error && contentTab === 'visual' && isTopNQuestion && (
                            <div className="flex items-center gap-1.5 ml-2 bg-amber-50 px-2.5 py-1 rounded-lg border border-amber-200 shrink-0">
                                <Hash className="w-3.5 h-3.5 text-amber-600" />
                                <span className="text-xs text-amber-700 font-semibold">Top</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={50}
                                    value={topN || ''}
                                    placeholder="N"
                                    onChange={(e) => {
                                        const v = parseInt(e.target.value) || 0;
                                        setTopN(v);
                                        if (v > 0 && config) {
                                            setTimeout(() => handleRunAnalysis({ ...config, limit: v }), 100);
                                        }
                                    }}
                                    className="w-10 px-1.5 py-0.5 text-xs font-bold text-center rounded border border-amber-300 bg-white text-slate-800 focus:ring-1 focus:ring-amber-400 focus:outline-none"
                                />
                                <button
                                    onClick={() => {
                                        if (config) {
                                            const newSort = config.sort === 'asc' ? 'desc' : 'asc';
                                            handleRunAnalysis({ ...config, sort: newSort });
                                        }
                                    }}
                                    className={`px-1 py-0.5 rounded text-[10px] font-bold transition-all border ${config?.sort === 'asc'
                                        ? 'bg-amber-200 text-amber-800 border-amber-400'
                                        : 'bg-white text-amber-600 border-amber-300 hover:bg-amber-100'
                                        }`}
                                    title={config?.sort === 'asc' ? 'Showing Bottom N — click for Top N' : 'Showing Top N — click for Bottom N'}
                                >
                                    <ArrowUpDown className="w-3 h-3" />
                                </button>
                            </div>
                        )}

                        {/* ── PERIOD SCOPE SELECTOR ── */}
                        {result && !error && contentTab === 'visual' && isRunningTotalQuestion && (
                            <div className="flex items-center gap-1 ml-2 bg-teal-50 px-2 py-1 rounded-lg border border-teal-200 shrink-0">
                                <Calendar className="w-3 h-3 text-teal-600" />
                                {(['WTD', 'MTD', 'QTD', 'YTD'] as const).map(p => (
                                    <button
                                        key={p}
                                        onClick={() => {
                                            const newScope = periodScope === p ? '' : p;
                                            const newGrain = newScope ? defaultGrainForScope[newScope] || 'day' : '';
                                            setPeriodScope(newScope);
                                            setPeriodGrain(newGrain);
                                            if (config) {
                                                setTimeout(() => handleRunAnalysis({ ...config, ...({ periodScope: newScope, periodGrain: newGrain } as any) }), 100);
                                            }
                                        }}
                                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition-all border ${periodScope === p
                                            ? 'bg-teal-500 text-white border-teal-600'
                                            : 'bg-white text-teal-600 border-teal-200 hover:bg-teal-100'
                                            }`}
                                    >{p}</button>
                                ))}
                                {/* Grain selector — compact dropdown when a scope is active */}
                                {periodScope && (
                                    <select
                                        value={periodGrain || defaultGrainForScope[periodScope] || 'day'}
                                        onChange={(e) => {
                                            const grain = e.target.value;
                                            setPeriodGrain(grain);
                                            if (config) {
                                                setTimeout(() => handleRunAnalysis({ ...config, ...({ periodScope, periodGrain: grain } as any) }), 100);
                                            }
                                        }}
                                        className="px-1 py-0.5 rounded text-[10px] font-bold border border-indigo-300 bg-white text-indigo-700 focus:ring-1 focus:ring-indigo-400 focus:outline-none cursor-pointer"
                                        title="Group data by time grain"
                                    >
                                        <option value="day">Day</option>
                                        <option value="week">Week</option>
                                        <option value="month">Month</option>
                                        <option value="quarter">Quarter</option>
                                        <option value="year">Year</option>
                                    </select>
                                )}
                            </div>
                        )}

                        {/* ── WHAT-IF SLIDER ── */}
                        {result && !error && contentTab === 'visual' && (
                            <div className="flex items-center gap-1.5 ml-2 shrink-0">
                                <button
                                    onClick={() => {
                                        const newState = !isWhatIfActive;
                                        setIsWhatIfActive(newState);
                                        if (!newState) {
                                            setWhatIfPct(0);
                                            if (config) setTimeout(() => handleRunAnalysis(config), 100);
                                        }
                                    }}
                                    className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-all border ${isWhatIfActive
                                        ? 'bg-purple-100 text-purple-700 border-purple-300'
                                        : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-100'
                                        }`}
                                    title="What-If Analysis: adjust metric by a percentage"
                                >
                                    <Sliders className="w-3.5 h-3.5" />
                                    What-If
                                </button>
                                {isWhatIfActive && (
                                    <div className="flex items-center gap-1.5 bg-purple-50 px-2 py-1 rounded-lg border border-purple-200">
                                        <input
                                            type="range"
                                            min={-50}
                                            max={100}
                                            step={5}
                                            value={whatIfPct}
                                            onChange={(e) => {
                                                const v = parseInt(e.target.value);
                                                setWhatIfPct(v);
                                                if (config) setTimeout(() => handleRunAnalysis(config), 150);
                                            }}
                                            className="w-16 h-1 accent-purple-600"
                                        />
                                        <span className={`text-[10px] font-bold min-w-[2.5rem] text-center ${whatIfPct > 0 ? 'text-green-600' : whatIfPct < 0 ? 'text-red-500' : 'text-slate-500'
                                            }`}>
                                            {whatIfPct > 0 ? '+' : ''}{whatIfPct}%
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Row 2: KPI + Action Buttons (always visible) */}
                    {result && !error && (
                        <div className="flex items-center gap-2 mt-1.5 overflow-x-auto">
                            <div className="flex items-center gap-2 text-sm min-w-0 shrink">
                                <span className="text-slate-400 font-medium hidden xl:inline truncate max-w-[200px]">{result.yLabel}</span>
                                <span className="font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-teal-500 text-base whitespace-nowrap">
                                    {showGrowthPct && result.growth
                                        ? `${result.growth.pct.toFixed(1)}%`
                                        : (result.kpi ?? result.data.reduce((acc: number, row: any) => acc + (Number(row[result.yKey]) || 0), 0))?.toLocaleString(undefined, { maximumFractionDigits: 2 })
                                    }
                                </span>
                                <span className="bg-indigo-100 text-indigo-800 text-[10px] px-1.5 py-0.5 rounded-full font-bold whitespace-nowrap">
                                    {result.data.length} rows
                                </span>
                                {result.growth && (
                                    <button onClick={() => setShowGrowthPct(!showGrowthPct)} className="text-indigo-500 hover:text-indigo-700" title="Toggle growth view">
                                        <TrendingUp className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>
                            <div className="ml-auto flex items-center gap-1.5 shrink-0">
                                <button onClick={() => onPin(currentQuestionLabel, { ...result, vis: chartType, formatting: { ...formatting, tableCalculations: [] } as any, config: config || result.config || undefined, queryConfig: config || result.config || undefined })} className={`flex items-center text-sm font-bold text-white ${pinLabel ? 'bg-amber-600 hover:bg-amber-700' : 'bg-indigo-600 hover:bg-indigo-700'} px-3 py-1.5 rounded-lg shadow-sm transition-all active:scale-95 whitespace-nowrap`} title={pinLabel || 'Pin to Dashboard'}>
                                    <Pin className="w-4 h-4 mr-1" /> Pin
                                </button>
                                <button
                                    onClick={() => { if (config) handleRunAnalysis(config); }}
                                    className="flex items-center text-sm font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-all active:scale-95 whitespace-nowrap"
                                    title="Refresh — re-run current query"
                                >
                                    <RefreshCw className="w-4 h-4 mr-1" /> Refresh
                                </button>
                                <button
                                    onClick={() => { setResult(undefined); setConfig(undefined); setError(null); setCurrentQuestionLabel('Select a question'); setCurrentQuestionId(null); setViewMode('bank'); onStateChange?.(undefined, undefined); }}
                                    className="flex items-center text-sm font-bold text-red-500 hover:text-red-600 bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg transition-all active:scale-95 whitespace-nowrap"
                                    title="Reset — clear all results and start fresh"
                                >
                                    <RotateCcw className="w-4 h-4 mr-1" /> Reset
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* CONTENT AREA — Tabbed */}
                <div className="flex-1 flex flex-col overflow-auto p-4">
                    {/* AI SQL Chat Panel */}
                    {isAISQLOpen && (
                        <div className="mb-4 rounded-xl border border-violet-200 shadow-sm overflow-hidden relative" style={{ minHeight: 320 }}>
                            <AISQLChat
                                dataset={dataset}
                                onClose={() => setIsAISQLOpen(false)}
                            />
                        </div>
                    )}
                    {error && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 flex items-start">
                            <AlertTriangle className="w-6 h-6 text-amber-600 mt-0.5 mr-4 flex-shrink-0" />
                            <div className="flex-1">
                                <h4 className="text-base font-bold text-amber-800">Cannot answer this question</h4>
                                <p className="text-sm text-amber-700 mt-2 whitespace-pre-wrap">{error}</p>
                            </div>
                        </div>
                    )}

                    {/* ─── EMPTY STATE — No question selected yet ─── */}
                    {!result && !error && (
                        <div className="flex flex-col items-center justify-center h-full text-center py-16 px-8">
                            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-100 to-purple-100 flex items-center justify-center mb-6 shadow-sm">
                                <MousePointerClick className="w-10 h-10 text-indigo-500" />
                            </div>
                            <h3 className="text-lg font-bold text-slate-800 mb-2">Select a Question to Get Started</h3>
                            <p className="text-sm text-slate-500 max-w-md mb-6 leading-relaxed">
                                Choose a pre-built question from the <strong>Question Bank</strong> on the left,
                                or use the <strong>Builder</strong> above to create a custom analysis.
                            </p>
                            <div className="flex flex-wrap gap-3 justify-center">
                                <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">
                                    <BarChart2 className="w-3.5 h-3.5 text-indigo-400" />
                                    82+ pre-built questions
                                </div>
                                <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">
                                    <Code className="w-3.5 h-3.5 text-emerald-400" />
                                    Deterministic SQL engine
                                </div>
                                <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">
                                    <Pin className="w-3.5 h-3.5 text-amber-400" />
                                    Pin to dashboard
                                </div>
                            </div>
                        </div>
                    )}

                    {result && !error && (
                        <>
                            {/* ─── VISUAL TAB ─── */}
                            {contentTab === 'visual' && (
                                <>
                                    {result.data && result.data.length > 0 ? (
                                        <div
                                            className="w-full bg-white flex-1 min-h-[350px] rounded-xl border border-slate-200 shadow-sm overflow-hidden relative"
                                        >
                                            <ChartVisualization
                                                data={result.data}
                                                config={config || result.config}
                                                xKey={result.xKey}
                                                yKey={result.yKey}
                                                chartType={chartType}
                                                onChartTypeChange={handleChartTypeChange}
                                                yLabel={result.yLabel}
                                                formatting={formatting}
                                                onToggleFormat={() => setIsFormatPanelOpen(!isFormatPanelOpen)}
                                                isFormatOpen={isFormatPanelOpen}
                                                onToggleAnalytics={() => setIsAnalyticsPanelOpen(!isAnalyticsPanelOpen)}
                                                isAnalyticsOpen={isAnalyticsPanelOpen}
                                                onToggleLabels={formatting && onUpdateFormatting ? () => onUpdateFormatting({ ...formatting, showDataLabels: !formatting.showDataLabels }) : undefined}
                                                onAIInsight={() => setIsAIInsightOpen(!isAIInsightOpen)}
                                                isAIInsightOpen={isAIInsightOpen}
                                                chartContainerRef={chartContainerRef}
                                            />

                                            {/* AI Insight Panel */}
                                            <AIInsightPanel
                                                isOpen={isAIInsightOpen}
                                                onClose={() => setIsAIInsightOpen(false)}
                                                chartContainerRef={chartContainerRef}
                                                chartTitle={result.yLabel}
                                                visualHash={JSON.stringify({
                                                    id: result?.config?.questionId,
                                                    chart: chartType,
                                                    fmt: formatting,
                                                    time: asOfDate
                                                })}
                                            />

                                            {/* FLOATING FORMAT PANEL */}
                                            {isFormatPanelOpen && formatting && onUpdateFormatting && (
                                                <div className="absolute top-4 right-4 w-64 bg-white/95 backdrop-blur shadow-xl border border-slate-200 rounded-lg p-4 z-20 animate-in fade-in slide-in-from-right-4">
                                                    <div className="flex justify-between items-center mb-3">
                                                        <h3 className="font-bold text-slate-700 flex items-center gap-2">
                                                            <Palette className="w-4 h-4 text-indigo-500" />
                                                            Chart Style
                                                        </h3>
                                                        <button onClick={() => setIsFormatPanelOpen(false)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
                                                    </div>

                                                    <div className="space-y-4">
                                                        <div>
                                                            <label className="text-xs font-semibold text-slate-500 mb-1 block">Color Palette</label>
                                                            <div className="grid grid-cols-5 gap-1">
                                                                {['vibrant', 'electric', 'neon', 'sunset', 'ocean'].map(mode => (
                                                                    <button
                                                                        key={mode}
                                                                        onClick={() => onUpdateFormatting({ ...formatting, colorMode: mode as any })}
                                                                        className={`h-6 rounded border ${formatting.colorMode === mode ? 'ring-2 ring-indigo-500 border-transparent' : 'border-slate-200 hover:border-slate-300'}`}
                                                                        style={{ background: mode === 'vibrant' ? '#3b82f6' : mode === 'electric' ? '#6366f1' : mode === 'neon' ? '#22c55e' : mode === 'sunset' ? '#f97316' : '#0ea5e9' }}
                                                                        title={mode}
                                                                    />
                                                                ))}
                                                            </div>
                                                        </div>

                                                        <div>
                                                            <label className="text-xs font-semibold text-slate-500 mb-1 block">Number Format</label>
                                                            <select
                                                                value={formatting.numberFormat}
                                                                onChange={e => onUpdateFormatting({ ...formatting, numberFormat: e.target.value as any })}
                                                                className="w-full text-sm border-slate-200 rounded-md py-1 text-slate-700 bg-white focus:ring-indigo-500 focus:border-indigo-500"
                                                            >
                                                                <option value="auto" className="text-slate-700 font-semibold">✨ Intelligent (Auto)</option>
                                                                <option value="raw" className="text-slate-700">Raw Number</option>
                                                                <option value="currency_usd" className="text-slate-700">Currency (USD)</option>
                                                                <option value="currency_eur" className="text-slate-700">Currency (EUR)</option>
                                                                <option value="percent" className="text-slate-700">Percentage (%)</option>
                                                                <option value="compact" className="text-slate-700">Compact (1k, 1M)</option>
                                                            </select>
                                                        </div>

                                                        <div>
                                                            <label className="text-xs font-semibold text-slate-500 mb-1 block">Date Axis Format</label>
                                                            <select
                                                                value={formatting.dateFormat || 'raw'}
                                                                onChange={(e) => onUpdateFormatting({ ...formatting, dateFormat: e.target.value as any })}
                                                                className="w-full text-sm border-slate-200 rounded-md py-1 text-slate-700 bg-white focus:ring-indigo-500 focus:border-indigo-500 mb-4"
                                                            >
                                                                <option value="raw">Default (Auto)</option>
                                                                <option value="yyyy-mm-dd">YYYY-MM-DD (2023-11-05)</option>
                                                                <option value="mm/dd/yyyy">MM/DD/YYYY (11/05/2023)</option>
                                                                <option value="month_name_year">Month Year (November 2023)</option>
                                                                <option value="month_short_year">Short Month Year (Nov '23)</option>
                                                                <option value="month_number">Month Number (11)</option>
                                                                <option value="month_name_only">Month Name (November)</option>
                                                            </select>
                                                        </div>

                                                        <div>
                                                            <label className="text-xs font-semibold text-slate-500 mb-1 block">Decimals</label>
                                                            <div className="flex bg-slate-100 rounded p-1">
                                                                {([0, 1, 2]).map(d => (
                                                                    <button
                                                                        key={d}
                                                                        onClick={() => onUpdateFormatting({ ...formatting, decimals: d })}
                                                                        className={`flex-1 text-xs py-1 rounded-md transition-all ${formatting.decimals === d ? 'bg-white text-indigo-600 shadow-sm font-medium' : 'text-slate-500 hover:text-slate-700'}`}
                                                                    >
                                                                        {d}
                                                                    </button>
                                                                ))}
                                                                <button
                                                                    onClick={() => onUpdateFormatting({ ...formatting, decimals: undefined })}
                                                                    className={`flex-1 text-xs py-1 rounded-md transition-all ${formatting.decimals === undefined ? 'bg-white text-indigo-600 shadow-sm font-medium' : 'text-slate-500 hover:text-slate-700'}`}
                                                                >
                                                                    Auto
                                                                </button>
                                                            </div>
                                                        </div>


                                                        <div className="flex items-center justify-between">
                                                            <span className="text-sm font-medium text-slate-700">Map Label</span>
                                                            <select
                                                                value={formatting.mapLabelContent || 'value'}
                                                                onChange={(e) => onUpdateFormatting({ ...formatting, mapLabelContent: e.target.value as any })}
                                                                className="text-xs border-slate-200 rounded-md py-1 px-2 text-slate-700 bg-white focus:ring-indigo-500 focus:border-indigo-500"
                                                            >
                                                                <option value="value">Value</option>
                                                                <option value="label">Label</option>
                                                                <option value="both">Both</option>
                                                                <option value="none">None</option>
                                                            </select>
                                                        </div>

                                                        <div className="flex flex-col gap-2 pt-2 border-t border-slate-100 mt-2">
                                                            <label className="flex items-center gap-2 cursor-pointer">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={formatting.headerBold}
                                                                    onChange={e => onUpdateFormatting({ ...formatting, headerBold: e.target.checked })}
                                                                    className="rounded text-indigo-600 focus:ring-indigo-500"
                                                                />
                                                                <span className="text-sm text-slate-600 font-medium">Bold Chart Title</span>
                                                            </label>

                                                            <label className="flex items-center gap-2 cursor-pointer">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={formatting.axisBold ?? false}
                                                                    onChange={e => onUpdateFormatting({ ...formatting, axisBold: e.target.checked })}
                                                                    className="rounded text-indigo-600 focus:ring-indigo-500"
                                                                />
                                                                <span className="text-sm text-slate-600 font-medium">Bold Axis Labels</span>
                                                            </label>

                                                            <div className="flex items-center gap-2">
                                                                <label className="text-xs font-semibold text-slate-500">Axis Label Color</label>
                                                                <input
                                                                    type="color"
                                                                    value={formatting.axisColor || '#475569'}
                                                                    onChange={e => onUpdateFormatting({ ...formatting, axisColor: e.target.value })}
                                                                    className="w-6 h-6 rounded border border-slate-200 cursor-pointer p-0"
                                                                />
                                                                {formatting.axisColor && (
                                                                    <button
                                                                        onClick={() => onUpdateFormatting({ ...formatting, axisColor: undefined })}
                                                                        className="text-[10px] text-slate-400 hover:text-slate-600"
                                                                    >
                                                                        Reset
                                                                    </button>
                                                                )}
                                                            </div>

                                                            <label className="flex items-center gap-2 cursor-pointer">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={formatting.showLabels}
                                                                    onChange={e => onUpdateFormatting({ ...formatting, showLabels: e.target.checked })}
                                                                    className="rounded text-indigo-600 focus:ring-indigo-500"
                                                                />
                                                                <span className="text-sm text-slate-600">Show Legend</span>
                                                            </label>

                                                            <label className="flex items-center gap-2 cursor-pointer">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={formatting.showDataLabels}
                                                                    onChange={e => onUpdateFormatting({ ...formatting, showDataLabels: e.target.checked })}
                                                                    className="rounded text-indigo-600 focus:ring-indigo-500"
                                                                />
                                                                <span className="text-sm text-slate-600 font-medium">Show Data Labels</span>
                                                            </label>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}

                                            {/* FLOATING ANALYTICS PANEL */}
                                            {isAnalyticsPanelOpen && formatting && onUpdateFormatting && (
                                                <div className="absolute top-4 left-4 w-80 bg-white/95 backdrop-blur-xl shadow-2xl border border-slate-200 rounded-xl p-0 z-20 animate-in fade-in slide-in-from-left-4 overflow-hidden">
                                                    <div className="p-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
                                                        <div className="flex justify-between items-center">
                                                            <h3 className="font-bold text-slate-700 flex items-center gap-2 text-sm">
                                                                <Activity className="w-4 h-4 text-emerald-500" />
                                                                Analytics
                                                            </h3>
                                                            <button onClick={() => setIsAnalyticsPanelOpen(false)} className="text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-100 transition-colors">
                                                                <X className="w-4 h-4" />
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
                                                        {/* Period Comparison */}
                                                        <div>
                                                            <div className="flex items-center gap-2 mb-2">
                                                                <div className="w-5 h-5 rounded bg-indigo-100 flex items-center justify-center">
                                                                    <TrendingUp className="w-3 h-3 text-indigo-600" />
                                                                </div>
                                                                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Period Comparison</span>
                                                            </div>
                                                            <div className="space-y-1.5">
                                                                <label className={`flex items-start gap-3 p-2.5 rounded-lg cursor-pointer transition-all border ${!config?.comparison || config?.comparison === 'none' ? 'bg-indigo-50 border-indigo-400 ring-1 ring-indigo-400 shadow-sm' : 'hover:bg-slate-50 border-transparent hover:border-slate-200'
                                                                    }`}>
                                                                    <input type="radio" name="comparison" checked={!config?.comparison || config?.comparison === 'none'} onChange={() => {
                                                                        if (config) handleRunAnalysis({ ...config, comparison: undefined, comparisonMode: undefined, comparisonGrain: undefined });
                                                                    }} className="mt-0.5 text-indigo-600" />
                                                                    <div>
                                                                        <span className="text-xs font-bold text-slate-700 leading-tight">Single Period (Default)</span>
                                                                        <span className="text-[10px] text-slate-500 leading-tight mt-0.5 block">Show data for the selected time range only</span>
                                                                    </div>
                                                                </label>
                                                                <label className={`flex items-start gap-3 p-2.5 rounded-lg cursor-pointer transition-all border ${config?.comparison === 'previous_period' ? 'bg-indigo-50 border-indigo-400 ring-1 ring-indigo-400 shadow-sm' : 'hover:bg-slate-50 border-transparent hover:border-slate-200'
                                                                    }`}>
                                                                    <input type="radio" name="comparison" checked={config?.comparison === 'previous_period'} onChange={() => {
                                                                        if (config) handleRunAnalysis({ ...config, comparison: 'previous_period' });
                                                                    }} className="mt-0.5 text-indigo-600" />
                                                                    <div>
                                                                        <span className="text-xs font-bold text-slate-700 leading-tight">Previous Period</span>
                                                                        <span className="text-[10px] text-slate-500 leading-tight mt-0.5 block">Compare with the immediately preceding period</span>
                                                                    </div>
                                                                </label>
                                                                <label className={`flex items-start gap-3 p-2.5 rounded-lg cursor-pointer transition-all border ${config?.comparison === 'same_period_last_year' ? 'bg-indigo-50 border-indigo-400 ring-1 ring-indigo-400 shadow-sm' : 'hover:bg-slate-50 border-transparent hover:border-slate-200'
                                                                    }`}>
                                                                    <input type="radio" name="comparison" checked={config?.comparison === 'same_period_last_year'} onChange={() => {
                                                                        if (config) handleRunAnalysis({ ...config, comparison: 'same_period_last_year' });
                                                                    }} className="mt-0.5 text-indigo-600" />
                                                                    <div>
                                                                        <span className="text-xs font-bold text-slate-700 leading-tight">Same Period Last Year</span>
                                                                        <span className="text-[10px] text-slate-500 leading-tight mt-0.5 block">Year-over-year comparison</span>
                                                                    </div>
                                                                </label>

                                                                {/* Same Period Last N */}
                                                                <label className={`flex items-start gap-3 p-2.5 rounded-lg cursor-pointer transition-all border ${config?.comparison === 'same_period_last_n' ? 'bg-indigo-50 border-indigo-400 ring-1 ring-indigo-400 shadow-sm' : 'hover:bg-slate-50 border-transparent hover:border-slate-200'
                                                                    }`}>
                                                                    <input type="radio" name="comparison" checked={config?.comparison === 'same_period_last_n'} onChange={() => {
                                                                        if (config) handleRunAnalysis({ ...config, comparison: 'same_period_last_n' as any, comparisonGrain: config.comparisonGrain || 'month', comparisonOffset: config.comparisonOffset || 1 });
                                                                    }} className="mt-0.5 text-indigo-600" />
                                                                    <div>
                                                                        <span className="text-xs font-bold text-slate-700 leading-tight">Same Period Last N</span>
                                                                        <span className="text-[10px] text-slate-500 leading-tight mt-0.5 block">Flexible: pick grain &amp; offset</span>
                                                                    </div>
                                                                </label>

                                                                {/* Grain + Offset controls (only when Same Period Last N is active) */}
                                                                {config?.comparison === 'same_period_last_n' && (
                                                                    <div className="ml-7 mt-1 p-3 bg-indigo-50/60 rounded-lg border border-indigo-100 space-y-3">
                                                                        {/* Grain selector pills */}
                                                                        <div>
                                                                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide block mb-1.5">Grain</span>
                                                                            <div className="flex gap-1">
                                                                                {(['day', 'week', 'month', 'quarter', 'year'] as const).map(g => {
                                                                                    const labels: Record<string, string> = { day: 'D', week: 'W', month: 'M', quarter: 'Q', year: 'Y' };
                                                                                    const active = (config.comparisonGrain || 'month') === g;
                                                                                    return (
                                                                                        <button key={g} onClick={() => handleRunAnalysis({ ...config, comparisonGrain: g })}
                                                                                            className={`px-2.5 py-1 text-xs font-bold rounded-md transition-all ${active ? 'bg-indigo-600 text-white shadow-sm' : 'bg-white text-slate-600 border border-slate-200 hover:border-indigo-400 hover:text-indigo-700'}`}>
                                                                                            {labels[g]}
                                                                                        </button>
                                                                                    );
                                                                                })}
                                                                            </div>
                                                                        </div>
                                                                        {/* Offset stepper */}
                                                                        <div>
                                                                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide block mb-1.5">Offset</span>
                                                                            <div className="flex items-center gap-2">
                                                                                <button onClick={() => { const n = Math.max(1, (config.comparisonOffset || 1) - 1); handleRunAnalysis({ ...config, comparisonOffset: n }); }}
                                                                                    className="w-7 h-7 flex items-center justify-center rounded-md bg-white border border-slate-200 text-slate-600 hover:bg-indigo-50 hover:border-indigo-400 hover:text-indigo-700 font-bold text-sm transition-all">−</button>
                                                                                <span className="w-8 text-center text-sm font-bold text-indigo-800">{config.comparisonOffset || 1}</span>
                                                                                <button onClick={() => { const n = Math.min(24, (config.comparisonOffset || 1) + 1); handleRunAnalysis({ ...config, comparisonOffset: n }); }}
                                                                                    className="w-7 h-7 flex items-center justify-center rounded-md bg-white border border-slate-200 text-slate-600 hover:bg-indigo-50 hover:border-indigo-400 hover:text-indigo-700 font-bold text-sm transition-all">+</button>
                                                                            </div>
                                                                            <span className="text-[10px] text-indigo-700 mt-1.5 block font-medium">
                                                                                vs {config.comparisonOffset || 1} {(config.comparisonGrain || 'month') + ((config.comparisonOffset || 1) > 1 ? 's' : '')} ago
                                                                            </span>
                                                                        </div>
                                                                    </div>
                                                                )}

                                                                {/* Comparison visual hint */}
                                                                {(config?.comparison === 'previous_period' || config?.comparison === 'same_period_last_year' || config?.comparison === 'same_period_last_n') && (
                                                                    <div className="mt-2 p-2.5 bg-indigo-50/60 rounded-lg border border-indigo-100 space-y-1.5">
                                                                        <div className="flex items-start gap-2">
                                                                            <div className="flex gap-1 mt-0.5 shrink-0">
                                                                                <div className="w-2.5 h-6 bg-indigo-500 rounded-sm" />
                                                                                <div className={`w-2.5 h-4 ${config?.comparison === 'same_period_last_year' ? 'bg-amber-300' : 'bg-slate-300'} rounded-sm self-end`} />
                                                                            </div>
                                                                            <p className="text-[10px] text-indigo-700 leading-snug">
                                                                                <span className="font-bold">Total:</span> Side-by-side bars with <span className="font-bold text-emerald-600">growth %</span> labels.
                                                                            </p>
                                                                        </div>
                                                                        <div className="flex items-start gap-2">
                                                                            <div className="flex gap-1 mt-0.5 shrink-0">
                                                                                <div className="w-6 h-0.5 bg-indigo-500 mt-2" />
                                                                                <div className={`w-6 mt-2 ${config?.comparison === 'same_period_last_year' ? 'border-amber-400' : 'border-slate-400'}`} style={{ borderTop: '2px dashed' }} />
                                                                            </div>
                                                                            <p className="text-[10px] text-indigo-700 leading-snug">
                                                                                <span className="font-bold">Trend:</span> Switch to <span className="font-bold text-emerald-600">Trend</span> in the top bar to see dual-line overlay at D / W / M / Q / Y grain.
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>

                                                        <div className="border-t border-slate-100" />

                                                        {/* Table Calculations */}
                                                        <div>
                                                            <div className="flex items-center gap-2 mb-2">
                                                                <div className="w-5 h-5 rounded bg-emerald-100 flex items-center justify-center">
                                                                    <svg className="w-3 h-3 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                                                    </svg>
                                                                </div>
                                                                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Table Calculation</span>
                                                            </div>
                                                            <div className="space-y-1 max-h-[280px] overflow-y-auto pr-1">
                                                                {([
                                                                    { id: 'percent_of_total', desc: 'Each value as % of column total' },
                                                                    { id: 'rank_desc', desc: 'Rank from highest to lowest' },
                                                                    { id: 'rank_asc', desc: 'Rank from lowest to highest' },
                                                                    { id: 'running_total', desc: 'Cumulative sum across rows' },
                                                                    { id: 'moving_avg', desc: 'Smooth values with N-period average' },
                                                                    { id: 'pct_diff_from_prev', desc: 'Percentage change from previous row' },
                                                                    { id: 'diff_from_prev', desc: 'Absolute difference from previous row' },
                                                                    { id: 'percentile', desc: 'Percentile rank within data set' }
                                                                ] as { id: TableCalculation; desc: string }[]).map(({ id: calc, desc }) => {
                                                                    const isSelected = (formatting.tableCalculations || []).includes(calc);
                                                                    return (
                                                                        <label
                                                                            key={calc}
                                                                            className={`flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all ${isSelected
                                                                                ? 'bg-emerald-50 border border-emerald-400 ring-1 ring-emerald-400 shadow-sm'
                                                                                : 'hover:bg-slate-50 border border-transparent hover:border-slate-200'
                                                                                }`}
                                                                        >
                                                                            <input
                                                                                type="checkbox"
                                                                                checked={isSelected}
                                                                                onChange={() => {
                                                                                    const current = formatting.tableCalculations || [];
                                                                                    const updated = isSelected
                                                                                        ? current.filter(c => c !== calc)
                                                                                        : [...current, calc];
                                                                                    onUpdateFormatting({ ...formatting, tableCalculations: updated });
                                                                                }}
                                                                                className="rounded text-emerald-600 focus:ring-emerald-500"
                                                                            />
                                                                            <div className="flex-1 min-w-0">
                                                                                <span className="text-xs font-bold text-slate-700 leading-tight block">{getCalculationDisplayName(calc)}</span>
                                                                                <span className="text-[10px] text-slate-500 leading-tight">{desc}</span>
                                                                            </div>
                                                                        </label>
                                                                    );
                                                                })}
                                                            </div>

                                                            {(formatting.tableCalculations || []).length > 0 && (
                                                                <button
                                                                    onClick={() => onUpdateFormatting({ ...formatting, tableCalculations: [] })}
                                                                    className="mt-1 text-[11px] text-slate-400 hover:text-red-500 transition-colors cursor-pointer"
                                                                >
                                                                    Clear all calculations
                                                                </button>
                                                            )}

                                                            {(formatting.tableCalculations || []).includes('moving_avg') && (
                                                                <div className="mt-2 p-3 bg-emerald-50/70 rounded-lg border border-emerald-200">
                                                                    <label className="flex items-center justify-between gap-3">
                                                                        <span className="text-xs font-semibold text-emerald-800">Window Size</span>
                                                                        <div className="flex items-center gap-1.5">
                                                                            <button
                                                                                onClick={() => {
                                                                                    const current = formatting.movingAvgWindow || 3;
                                                                                    if (current > 2) onUpdateFormatting({ ...formatting, movingAvgWindow: current - 1 });
                                                                                }}
                                                                                className="w-6 h-6 rounded bg-white border border-emerald-300 text-emerald-700 flex items-center justify-center hover:bg-emerald-100 text-sm font-bold transition-colors"
                                                                            >−</button>
                                                                            <input
                                                                                type="number"
                                                                                min={2}
                                                                                max={30}
                                                                                value={formatting.movingAvgWindow || 3}
                                                                                onChange={(e) => {
                                                                                    const val = Math.max(2, Math.min(30, parseInt(e.target.value) || 3));
                                                                                    onUpdateFormatting({ ...formatting, movingAvgWindow: val });
                                                                                }}
                                                                                className="w-12 h-6 text-center text-sm font-bold text-emerald-900 bg-white border border-emerald-300 rounded focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                                                            />
                                                                            <button
                                                                                onClick={() => {
                                                                                    const current = formatting.movingAvgWindow || 3;
                                                                                    if (current < 30) onUpdateFormatting({ ...formatting, movingAvgWindow: current + 1 });
                                                                                }}
                                                                                className="w-6 h-6 rounded bg-white border border-emerald-300 text-emerald-700 flex items-center justify-center hover:bg-emerald-100 text-sm font-bold transition-colors"
                                                                            >+</button>
                                                                        </div>
                                                                    </label>
                                                                    <p className="text-[10px] text-emerald-600 mt-1">Average of current + {(formatting.movingAvgWindow || 3) - 1} prior periods</p>
                                                                </div>
                                                            )}
                                                        </div>

                                                        {(formatting.tableCalculations || []).filter(c => c !== 'none').length > 0 && (
                                                            <div className="p-2.5 bg-emerald-50 rounded-lg border border-emerald-100 flex items-center gap-2">
                                                                <div className="w-5 h-5 rounded-full bg-emerald-200 flex items-center justify-center shrink-0">
                                                                    <span className="text-xs">✨</span>
                                                                </div>
                                                                <p className="text-xs text-emerald-700 font-medium">
                                                                    {(formatting.tableCalculations || []).filter(c => c !== 'none').map(c => getCalculationDisplayName(c)).join(', ')}
                                                                </p>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="p-12 text-center text-slate-400 bg-slate-50 border border-slate-200 rounded-xl border-dashed">
                                            No Data available for visualization
                                        </div>
                                    )}
                                </>
                            )}

                            {/* ─── SQL TAB ─── */}
                            {contentTab === 'sql' && (
                                <div className="space-y-4">
                                    <div className="bg-gray-100 dark:bg-slate-900 rounded-xl p-6 overflow-hidden shadow-inner">
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="text-xs text-slate-500 font-mono flex items-center gap-2">
                                                <Code className="w-3.5 h-3.5" /> SQL Preview
                                            </div>
                                            <button
                                                onClick={() => { navigator.clipboard.writeText(result.sql || ''); setCopiedSql(true); setTimeout(() => setCopiedSql(false), 2000); }}
                                                className={`flex items-center gap-1.5 text-[10px] ${copiedSql ? 'text-green-400 bg-green-900/30' : 'text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700'} px-2.5 py-1 rounded transition-colors font-medium`}
                                            >
                                                {copiedSql ? <><CheckCircle2 className="w-3 h-3" /> Copied!</> : <><Clipboard className="w-3 h-3" /> Copy SQL</>}
                                            </button>
                                        </div>
                                        <pre className="text-sm text-green-400 font-mono overflow-auto whitespace-pre-wrap p-2 selection:bg-green-900 min-h-[200px]">
                                            {result.sql || '-- Generating query...'}
                                        </pre>
                                    </div>
                                    {/* Config Debug */}
                                    <div className="bg-white rounded-xl border border-slate-200 p-4">
                                        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Query Config</h4>
                                        <pre className="text-xs text-slate-600 font-mono overflow-auto max-h-[300px] whitespace-pre-wrap">
                                            {JSON.stringify(result.config, null, 2)}
                                        </pre>
                                    </div>
                                </div>
                            )}

                            {/* ─── DATA TAB ─── */}
                            {contentTab === 'data' && (
                                <>
                                    {result.data && result.data.length > 0 && (
                                        <>
                                            <div className="flex items-center justify-between mb-3">
                                                <span className="text-xs text-slate-500 font-medium">
                                                    Showing <strong className="text-slate-700">{result.data.length}</strong> row{result.data.length !== 1 ? 's' : ''}
                                                </span>
                                                <button
                                                    onClick={() => {
                                                        if (!result.data || result.data.length === 0) return;
                                                        const headers = Object.keys(result.data[0]);
                                                        const csvRows = [headers.join(',')];
                                                        result.data.forEach((row: any) => {
                                                            csvRows.push(headers.map(h => {
                                                                const val = row[h];
                                                                return typeof val === 'string' && val.includes(',') ? `"${val}"` : String(val ?? '');
                                                            }).join(','));
                                                        });
                                                        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
                                                        const url = URL.createObjectURL(blob);
                                                        const a = document.createElement('a');
                                                        a.href = url;
                                                        a.download = `${(result.yLabel || 'data').replace(/[^a-zA-Z0-9]/g, '_')}.csv`;
                                                        a.click();
                                                        URL.revokeObjectURL(url);
                                                    }}
                                                    className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 hover:text-indigo-600 bg-white hover:bg-indigo-50 border border-slate-200 hover:border-indigo-300 px-3 py-1.5 rounded-lg transition-colors"
                                                >
                                                    <FileDown className="w-3.5 h-3.5" />
                                                    Download CSV
                                                </button>
                                            </div>
                                            <ResultsTable
                                                data={result.data}
                                                xKey={result.xKey}
                                                yKey={result.yKey}
                                                yLabel={result.yLabel || ''}
                                                tableCalculations={formatting?.tableCalculations}
                                                numberFormat={formatting?.numberFormat}
                                                movingAvgWindow={formatting?.movingAvgWindow}
                                            />
                                        </>
                                    )}
                                    {(!result.data || result.data.length === 0) && (
                                        <div className="flex flex-col items-center justify-center py-12 text-center">
                                            <Table2 className="w-10 h-10 text-slate-300 mb-3" />
                                            <p className="text-sm text-slate-500">No data rows to display</p>
                                            <p className="text-xs text-slate-400 mt-1">Try running a question to see results here</p>
                                        </div>
                                    )}
                                </>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div >
    );
};
