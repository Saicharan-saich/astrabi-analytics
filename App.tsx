import React, { useState, useEffect, useRef } from 'react';
import { Upload, Database, Settings, Play, Layout, Plus, Search, FileText, BarChart2, Shield, Menu, LogOut, Users, Brain, Sparkles } from 'lucide-react';
import {
  Dataset,
  RefreshSchedule,
  AnalysisResult,
  Tab,
  ColumnType,
  DatasetDomainProfile,
  UserRole
} from './types';
import { runAnalysis, runAutomatedETL, parseCSV, parseExcel, autoJoinDatasets, getSampleData } from './services/analysisEngine';
import { profileDatasetWithAI } from './services/aiSemanticProfiler';
import { buildSemanticModel } from './services/semanticModel';
import { fetchGlobalHiddenTabs } from './services/tabVisibilityService';
import { fetchColumnCorrections, saveColumnCorrections, rememberedOverridesFor, datasetSignature } from './services/columnCorrectionsService';
import { buildAutoDashboard } from './services/autoDashboardBuilder';
import { refreshLiveDataset } from './services/liveRefreshService';
import { preloadDuckDB } from './services/duckdbEngine';
import { Sidebar } from './components/Sidebar';
import { UploadView } from './components/UploadView';
import { DatasetSummaryView } from './components/DatasetSummaryView';
import { WorkbenchView } from './components/WorkbenchView';
import { BuilderView } from './components/BuilderView';
import { NLQView } from './components/NLQView';
import { AISQLView } from './components/AISQLView';
import { VisualPreviewView } from './components/VisualPreviewView';
import { DerivedColumnsView } from './components/DerivedColumnsView';
import { Dashboard } from './components/Dashboard';
import { QuestionBuilder } from './components/QuestionBuilder';
import { LoginPage } from './components/LoginPage';
import { UserManagement } from './components/UserManagement';
import { AdminQuestionBuilder } from './components/AdminQuestionBuilder';
import { MessageSquare, Zap } from 'lucide-react';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useAppStore } from './store/useAppStore';
import { useAuthStore, ROLE_PERMISSIONS } from './store/useAuthStore';
import { ThemeProvider } from './components/ThemeProvider';
import { OnboardingTour } from './components/OnboardingTour';
import { DatasetSwitcher } from './components/DatasetSwitcher';
import { saveDatasetToDB, loadAllDatasetsFromDB, deleteDatasetFromDB } from './services/datasetDB';
import { inferDefaultAggregation } from './services/smartAggregation';
import { DomainReviewModal } from './components/DomainReviewModal';
import { SplashScreen } from './components/SplashScreen';
import { SmartQuestionsView } from './components/SmartQuestionsView';
import { PinToDashboardModal } from './components/PinToDashboardModal';
import ReconnectModal from './components/ReconnectModal';
import { AlertsView } from './components/AlertsView';
import { UserInsightsView } from './components/UserInsightsView';
import { QuickInsightsView } from './components/QuickInsightsView';
import { NotificationCenter } from './components/NotificationCenter';
import { useAlertStore } from './store/useAlertStore';
import { evaluateAllAlerts } from './services/alertEngine';
import { useActivityStore } from './store/useActivityStore';
import { DataStoryView } from './components/DataStoryView';
import LegalPage from './components/LegalPage';
import { GameView } from './components/GameView';
import { TabVisibilityManager } from './components/TabVisibilityManager';
import { useMobile } from './hooks/useMobile';

// ── SESSION CREDENTIAL CACHE (auto-reconnect without re-entering password) ──
// Stored in sessionStorage: survives page refresh but cleared on tab close or logout.
// Never persisted to localStorage/IndexedDB — password stays ephemeral.
interface CachedCredentials { host: string; port: string; database: string; username: string; password: string; ssl: boolean }

function cacheSessionCredentials(datasetId: string, creds: CachedCredentials): void {
  try {
    sessionStorage.setItem(`db_creds_${datasetId}`, JSON.stringify(creds));
    console.log('[Session] Cached DB credentials for auto-reconnect');
  } catch { /* sessionStorage unavailable — silent fallback */ }
}

function getSessionCredentials(datasetId: string): CachedCredentials | null {
  try {
    const raw = sessionStorage.getItem(`db_creds_${datasetId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function clearSessionCredentials(datasetId?: string): void {
  try {
    if (datasetId) {
      sessionStorage.removeItem(`db_creds_${datasetId}`);
    } else {
      // Clear ALL cached credentials (used on logout)
      const keys = Object.keys(sessionStorage).filter(k => k.startsWith('db_creds_'));
      keys.forEach(k => sessionStorage.removeItem(k));
    }
  } catch { /* silent */ }
}

// ── Heuristic domain detection (fallback when AI profiling unavailable) ──
function detectDomainFromColumns(columns: { name: string }[], fileName: string): string {
  const allText = [...columns.map(c => c.name.toLowerCase()), fileName.toLowerCase()].join(' ');
  const patterns: [string, string[]][] = [
    ['HR', ['employee', 'emp_id', 'hire_date', 'termination', 'salary', 'department', 'position', 'tenure', 'attrition', 'headcount', 'payroll', 'staff', 'resignation', 'term_date', 'performance_rating']],
    ['Healthcare', ['patient', 'diagnosis', 'treatment', 'hospital', 'medical', 'prescription', 'doctor', 'clinical', 'health', 'procedure', 'admission', 'discharge', 'pharmacy', 'nurse']],
    ['Education', ['student', 'course', 'grade', 'enrollment', 'gpa', 'semester', 'teacher', 'school', 'university', 'curriculum', 'graduation', 'instructor', 'exam']],
    ['SaaS', ['subscription', 'mrr', 'arr', 'churn', 'license', 'trial', 'tier', 'plan', 'renewal', 'saas', 'monthly_recurring', 'signup', 'feature_usage']],
    ['Inventory', ['inventory', 'stock', 'warehouse', 'sku', 'reorder', 'supply', 'stockout', 'safety_stock', 'lead_time', 'replenishment', 'backorder']],
    ['Marketing', ['campaign', 'impression', 'click', 'ctr', 'conversion', 'ad_spend', 'bounce', 'engagement', 'seo', 'lead', 'cpc', 'cpm', 'roas', 'utm', 'newsletter']],
    ['Finance', ['revenue', 'expense', 'profit', 'budget', 'invoice', 'accounts', 'ledger', 'debit', 'credit', 'balance', 'tax', 'depreciation', 'cash_flow', 'net_income', 'fiscal']],
  ];
  let best = 'Sales', bestN = 0;
  for (const [domain, kws] of patterns) {
    const n = kws.filter(kw => allText.includes(kw)).length;
    if (n >= 2 && n > bestN) { bestN = n; best = domain; }
  }
  return best;
}

// Safer ID generator that works in non-secure contexts
const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

// Basic Error Boundary to catch runtime crashes
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-900 text-white p-10">
          <div className="max-w-2xl bg-slate-800 p-8 rounded-xl border border-red-500/50 shadow-2xl">
            <h2 className="text-3xl font-bold text-red-400 mb-4">Something went wrong</h2>
            <p className="text-slate-300 mb-6">The application encountered a critical error. Please show this to the developer.</p>
            <div className="bg-slate-950 p-4 rounded-lg overflow-auto max-h-64 font-mono text-sm border border-slate-700">
              <p className="text-red-300 font-bold mb-2">{this.state.error?.message}</p>
              <pre className="text-slate-500">{this.state.error?.stack}</pre>
            </div>
            <button
              onClick={() => { localStorage.clear(); window.location.reload(); }}
              className="mt-6 px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
            >
              Clear Cache & Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Step indicator row for the profiling overlay */
function ProfilingStep({ label, active, done, theme }: { label: string; active: boolean; done: boolean; theme: string }) {
  return (
    <div className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-left text-xs font-medium transition-all ${active
      ? theme === 'dark' ? 'bg-violet-500/10 text-violet-300' : 'bg-violet-50 text-violet-700'
      : done
        ? theme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'
        : theme === 'dark' ? 'text-gray-600' : 'text-gray-400'
      }`}>
      {done ? (
        <svg className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
      ) : active ? (
        <div className="w-3.5 h-3.5 flex-shrink-0 relative">
          <div className="absolute inset-0 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
        </div>
      ) : (
        <div className={`w-3.5 h-3.5 rounded-full flex-shrink-0 ${theme === 'dark' ? 'bg-white/[0.06]' : 'bg-gray-200'}`} />
      )}
      {label}
    </div>
  );
}

function App() {
  // Global State
  const {
    activeTab,
    setActiveTab,
    isSidebarOpen,
    toggleSidebar,
    setSidebarOpen,
    showAbout,
    toggleAbout,
    dataset,
    setDataset,
    isProcessing,
    setProcessing,
    error,
    setError,
    formatting,
    updateFormatting,
    addItem,
    updateItem,
    removeItem,
    appFontSize,
    appFontBold,
    setAppFontSize,
    toggleAppFontBold,
    theme,
    toggleTheme,
    setTheme,
    datasets,
    setActiveDatasetById,
    removeDataset
  } = useAppStore();

  // Auth State
  const { isAuthenticated, currentUser, logout } = useAuthStore();
  const { isMobile } = useMobile();
  const [showUserMgmt, setShowUserMgmt] = useState(false);
  const [showTabManager, setShowTabManager] = useState(false);
  const [isAIProfiling, setIsAIProfiling] = useState(false);
  const [showDomainReview, setShowDomainReview] = useState(false);
  const [pendingProfile, setPendingProfile] = useState<any>(null);
  const [showSplash, setShowSplash] = useState(true);
  const [smartQuestionQuery, setSmartQuestionQuery] = useState<string | null>(null);
  const [pendingPinItem, setPendingPinItem] = useState<any>(null);

  // ── Activity Tracking ──
  const { trackActivity } = useActivityStore();
  const prevAuthRef = useRef(false);

  // Track login events + load the admin-defined global tab visibility
  useEffect(() => {
    if (isAuthenticated && currentUser && !prevAuthRef.current) {
      trackActivity({
        userId: currentUser.id,
        userName: currentUser.name,
        userEmail: currentUser.email,
        userRole: currentUser.role,
        action: 'login',
      });
      // Apply the admin's global tab-visibility config for EVERY user on login,
      // so hiding a tab actually affects everyone (not just the admin's browser).
      fetchGlobalHiddenTabs()
        .then((tabs) => useAppStore.getState().setHiddenTabs(tabs))
        .catch(() => { /* fail-open: keep whatever is local */ });
      // Prime the remembered column-classification cache so future uploads can
      // auto-apply corrections. Metadata only (columnName → role) — never data.
      fetchColumnCorrections().catch(() => { /* fail-open */ });
    }
    prevAuthRef.current = isAuthenticated;
  }, [isAuthenticated, currentUser]);

  // Track tab visits
  useEffect(() => {
    if (isAuthenticated && currentUser && activeTab) {
      trackActivity({
        userId: currentUser.id,
        userName: currentUser.name,
        userEmail: currentUser.email,
        userRole: currentUser.role,
        action: 'tab_visit',
        details: activeTab,
      });
    }
  }, [activeTab]);

  // ── Session Heartbeat (validates token against backend every 30s) ──
  // If admin revokes sessions via "Logout All Devices", this detects it and auto-logouts.
  const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5002/api';
  useEffect(() => {
    if (!isAuthenticated) return;
    const checkSession = async () => {
      const token = localStorage.getItem('qi_token');
      if (!token) return;
      try {
        const res = await fetch(`${API_BASE}/auth/verify`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (res.status === 401) {
            console.warn('[Session] Token revoked or expired — logging out');
            await logout();
            // Force reload to show login page
            window.location.reload();
          }
        }
      } catch {
        // Network error — skip (don't logout on connectivity issues)
      }
    };
    // Check immediately on mount, then every 30 seconds
    checkSession();
    const interval = setInterval(checkSession, 30_000);
    return () => clearInterval(interval);
  }, [isAuthenticated]);

  // ── Visual Preview state (full-page AI SQL result view) ──
  const [visualPreviewResult, setVisualPreviewResult] = useState<AnalysisResult | null>(null);
  const [visualPreviewPipeline, setVisualPreviewPipeline] = useState<any>(null);
  const [visualPreviewQuery, setVisualPreviewQuery] = useState('');
  const [visualPreviewFormatting, setVisualPreviewFormatting] = useState<any>({
    colorMode: 'vibrant', numberFormat: 'auto', fontSize: 'md', headerSize: 'xl',
    headerBold: true, headerColor: '#000000', showLabels: true, showDataLabels: true,
    tableCalculations: [], showAxis: true, showXAxis: true, showYAxis: true,
    axisColor: '#000000', axisBold: true, axisLabelSize: 'md',
    dataLabelColor: '#000000', dataLabelBold: true, dataLabelSize: 'md',
  });

  // ── Data Story state ──
  const [showDataStory, setShowDataStory] = useState(false);

  // Alert evaluation on dataset load/refresh
  const alertStore = useAlertStore();
  useEffect(() => {
    if (!dataset || !dataset.rows.length) return;
    const runAlerts = async () => {
      const activeRules = alertStore.rules.filter(r => r.datasetId === dataset.id);
      if (activeRules.length === 0) return;
      try {
        const { events: newEvents, updatedRules } = await evaluateAllAlerts(activeRules, [dataset]);
        for (const rule of updatedRules) alertStore.updateRule(rule);
        for (const evt of newEvents) alertStore.addEvent(evt);
        if (newEvents.length > 0) console.log(`[Alerts] ${newEvents.length} alert(s) triggered`);
      } catch (err) { console.warn('[Alerts] Evaluation error:', err); }
    };
    const timer = setTimeout(runAlerts, 1500);
    return () => clearTimeout(timer);
  }, [dataset?.id, dataset?.version, dataset?.totalRows]);

  // Smart Questions → AI SQL routing
  const handleSmartQuestion = (question: string) => {
    setSmartQuestionQuery(question);
    setActiveTab(Tab.AI_SQL);
  };

  // Hydrate datasets from IndexedDB on mount (scoped by user)
  useEffect(() => {
    const userId = currentUser?.id;
    if (!userId) return; // Don't load until authenticated

    // ALWAYS clear datasets first — prevents cross-user data leakage
    const store = useAppStore.getState();
    if (store.datasets.length > 0 || store.dataset) {
      console.log(`[App] Clearing ${store.datasets.length} stale datasets for user switch`);
      useAppStore.setState({ datasets: [], dataset: null });
    }

    loadAllDatasetsFromDB(userId).then(saved => {
      console.log(`[App] Loaded ${saved.length} datasets from IndexedDB for user: ${userId}`);
      if (saved.length > 0) {
        saved.forEach(ds => useAppStore.getState().setDataset(ds));
        if (!useAppStore.getState().dataset) {
          useAppStore.getState().setDataset(saved[saved.length - 1]);
        }
      }
    });
  }, [currentUser?.id]);

  // Pre-warm DuckDB when dataset is loaded (eliminates cold-start on first AI SQL query)
  useEffect(() => {
    if (dataset && dataset.data && dataset.data.length > 0) {
      preloadDuckDB(dataset.name, dataset.data).catch(() => {/* non-fatal */});
    }
  }, [dataset?.name]);

  // Auto-collapse sidebar when entering the builder
  useEffect(() => {
    if (activeTab === Tab.BUILDER) {
      setSidebarOpen(false);
    }
  }, [activeTab, setSidebarOpen]);

  // Auto-close sidebar on mobile
  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [isMobile, setSidebarOpen]);

  // ── AUTO-SYNC pendingProfile to active dataset ──
  // When the user switches datasets or a new dataset is uploaded,
  // update pendingProfile so the Column Mapping Wizard always shows
  // the correct domain profile for the active dataset.
  useEffect(() => {
    if (dataset?.domainProfile) {
      setPendingProfile(dataset.domainProfile);
    } else {
      setPendingProfile(null);
    }
  }, [dataset?.id]);

  const handleDeleteDataset = (id: string) => {
    // Reset processing/profiling state to prevent blocking overlay from persisting
    // when the user deletes a dataset that was still being profiled
    setProcessing(false);
    setIsAIProfiling(false);
    setPendingProfile(null);
    removeDataset(id);
    deleteDatasetFromDB(id);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setProcessing(true);
    setError(null);

    const worker = new Worker(new URL('./workers/etl.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event) => {
      const { type, result, error } = event.data;
      if (type === 'SUCCESS') {
        const { rows, logs, columns, timeContext, sourceSchema, dimDate, rawRows, relatedTables } = result;

        // ── APPLY REMEMBERED CORRECTIONS ──
        // If a user previously corrected the role of a column with this name,
        // auto-apply it so the app gets smarter about a schema over time.
        // Metadata only (columnName → role); no raw data involved.
        const remembered = rememberedOverridesFor(columns.map((c: any) => c.name));
        const correctedColumns = Object.keys(remembered).length > 0
          ? columns.map((col: any) => (remembered[col.name] ? { ...col, type: remembered[col.name] } : col))
          : columns;
        if (Object.keys(remembered).length > 0) {
          console.log(`[App] Applied ${Object.keys(remembered).length} remembered column correction(s) on upload`);
        }

        const newDataset: Dataset = {
          id: generateId(),
          name: file.name,
          rows,
          rawRows,
          columns: correctedColumns,
          totalRows: rows.length,
          etlLogs: logs,
          timeContext,
          dimDate,
          sourceSchema,
          // The unjoined source tables, when the upload had several. AI SQL can
          // query these directly instead of the flattened join.
          relatedTables,
          version: 1,
          createdAt: Date.now(),
        };

        // ── BUILD SEMANTIC MODEL (deterministic, from ETL output) ──
        try {
          const model = buildSemanticModel(newDataset);
          (newDataset as any).semanticModel = model;
          console.log(`[App] Semantic Model built: ${model.measures.length} measures, ${model.dimensions.length} dimensions, warnings: ${model.warnings.length}`);
        } catch (err) {
          console.warn('[App] Semantic model build failed (non-blocking):', err);
        }

        setDataset(newDataset);
        saveDatasetToDB(newDataset);
        setProcessing(false);
        worker.terminate();

        // Everything is queried in the browser, so the practical ceiling is this
        // tab's memory rather than a server's. Warn once at upload instead of
        // letting a very large file surface as an unexplained slowdown later.
        {
          const n = newDataset.rows.length;
          const LARGE = 500_000, VERY_LARGE = 1_000_000;
          if (n >= VERY_LARGE) {
            showToast(`⚠️ ${n.toLocaleString()} rows — that's beyond what a browser tab handles comfortably. Expect slow queries, and consider filtering or aggregating the file first.`);
          } else if (n >= LARGE) {
            showToast(`ℹ️ ${n.toLocaleString()} rows loaded. Everything runs locally, so very large files can feel slow — filtering the file first will speed things up.`);
          }
        }

        // Track upload activity
        if (currentUser) {
          trackActivity({
            userId: currentUser.id,
            userName: currentUser.name,
            userEmail: currentUser.email,
            userRole: currentUser.role,
            action: 'upload_dataset',
            details: file.name,
          });
        }

        // ── AI SEMANTIC PROFILING (async, non-blocking) ──
        setIsAIProfiling(true);
        profileDatasetWithAI(rows, columns, file.name).then(profile => {
          setIsAIProfiling(false);
          if (profile) {
            const profiled: Dataset = { ...newDataset, domainProfile: profile };
            // ── REBUILD SEMANTIC MODEL with AI enrichment ──
            try {
              const enrichedModel = buildSemanticModel(profiled, newDataset.semanticModel);
              (profiled as any).semanticModel = enrichedModel;
              console.log(`[App] Semantic Model enriched with AI: ${enrichedModel.measures.length} measures, source: ${enrichedModel.source}`);
            } catch (err) {
              console.warn('[App] Semantic model AI enrichment failed (keeping ETL model):', err);
            }
            setDataset(profiled);
            saveDatasetToDB(profiled);
            setPendingProfile(profile);
            setActiveTab(Tab.COLUMN_MAPPING);
            console.log(`[App] AI Profile: ${profile.domain} (${(profile.confidence * 100).toFixed(0)}% confidence)`);
          } else {
            // ── HEURISTIC DOMAIN FALLBACK (no AI required) ──
            console.log('[App] AI profiling returned null — using heuristic domain detection');
            const heuristicDomain = detectDomainFromColumns(columns, file.name);
            // Build column semantics from ETL column types
            const colSem: Record<string, any> = {};
            for (const col of columns) {
              colSem[col.name] = {
                role: col.type,
                aggregation: inferDefaultAggregation(col.name, col.type),
                format: 'raw',
                humanLabel: col.name.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
                description: '',
                semanticRole: col.type === ColumnType.METRIC ? 'primary_metric' : col.type === ColumnType.DATE ? 'primary_date' : col.type === ColumnType.ID ? 'identifier' : 'other',
                isHidden: false,
              };
            }
            const fallbackProfile: any = {
              domain: heuristicDomain || 'Sales',
              summary: `Detected as ${heuristicDomain || 'Sales'} domain (heuristic — please review)`,
              confidence: 0.4,
              themeColor: '#6366f1',
              columnSemantics: colSem,
              detectedAt: Date.now(),
            };
            const profiled: Dataset = { ...newDataset, domainProfile: fallbackProfile };
            setDataset(profiled);
            saveDatasetToDB(profiled);
            setPendingProfile(fallbackProfile);
            setActiveTab(Tab.COLUMN_MAPPING);
            console.log(`[App] Heuristic domain: ${heuristicDomain || 'Sales'}`);
          }
        }).catch(err => {
          setIsAIProfiling(false);
          console.warn('[App] AI profiling failed (graceful fallback):', err);
          // Build heuristic profile and open wizard
          const heuristicDomain = detectDomainFromColumns(columns, file.name);
          const colSem: Record<string, any> = {};
          for (const col of columns) {
            colSem[col.name] = {
              role: col.type,
              aggregation: inferDefaultAggregation(col.name, col.type),
              format: 'raw',
              humanLabel: col.name.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
              description: '',
              semanticRole: col.type === ColumnType.METRIC ? 'primary_metric' : col.type === ColumnType.DATE ? 'primary_date' : col.type === ColumnType.ID ? 'identifier' : 'other',
              isHidden: false,
            };
          }
          const fallbackProfile: any = {
            domain: heuristicDomain || 'Sales',
            summary: `Detected as ${heuristicDomain || 'Sales'} domain (heuristic — please review)`,
            confidence: 0.4,
            themeColor: '#6366f1',
            columnSemantics: colSem,
            detectedAt: Date.now(),
          };
          const profiled: Dataset = { ...newDataset, domainProfile: fallbackProfile };
          setDataset(profiled);
          saveDatasetToDB(profiled);
          setPendingProfile(fallbackProfile);
          setActiveTab(Tab.COLUMN_MAPPING);
        });
      } else if (type === 'ERROR') {
        setError(error);
        setProcessing(false);
        worker.terminate();
      }
    };

    worker.postMessage({ type: 'PROCESS_FILE', file });
  };

  const handleSchemaOverride = (columnName: string, newType: ColumnType) => {
    if (!dataset) return;

    // Re-run the ETL pipeline with the type override so all downstream
    // cleaning steps (casting, imputation, etc.) reflect the new type.
    const worker = new Worker(new URL('./workers/etl.worker.ts', import.meta.url), { type: 'module' });

    // Build override map from current column types, then apply the user change
    const overrides: Record<string, ColumnType> = {};
    dataset.columns.forEach(col => { overrides[col.name] = col.type; });
    overrides[columnName] = newType;

    worker.onmessage = (event: MessageEvent) => {
      if (event.data.type === 'SUCCESS') {
        const { rows, logs, columns, timeContext, dimDate } = event.data.result;
        const updated: Dataset = {
          ...dataset,
          rows,
          columns,
          totalRows: rows.length,
          etlLogs: logs,
          timeContext,
          dimDate,
        };
        setDataset(updated);
        saveDatasetToDB(updated);
        worker.terminate();
      }
    };

    worker.postMessage({
      type: 'PROCESS_FILE',
      rawData: dataset.rawRows || dataset.rows,
      fileName: dataset.name,
      columnTypeOverrides: overrides,
    });
  };

  const handleDatasetRowsRecovered = (recoveredRows: Record<string, any>[]) => {
    if (!dataset) return;
    const updatedRows = [...dataset.rows, ...recoveredRows];
    const updated: Dataset = { ...dataset, rows: updatedRows, totalRows: updatedRows.length };
    setDataset(updated);
    saveDatasetToDB(updated);
    console.log(`[App] Recovered ${recoveredRows.length} rows. New total: ${updatedRows.length}`);
  };

  const handleDatasetDataCleaned = (newRows: Record<string, any>[], log: any) => {
    if (!dataset) return;
    const updated: Dataset = { ...dataset, rows: newRows, totalRows: newRows.length };
    setDataset(updated);
    saveDatasetToDB(updated);
    console.log(`[App] Data cleaning: ${log.operation} — ${log.rowsAffected} rows affected. New total: ${newRows.length}`);
  };

  const handleWorkspaceMappingApply = (
    updatedProfile: DatasetDomainProfile,
    columnTypeOverrides: Record<string, ColumnType>,
  ) => {
    if (!dataset) return;
    // Semantic-only update: preserves rows and avoids another ETL run.
    let finalDataset: Dataset = { ...dataset, domainProfile: updatedProfile };
    if (Object.keys(columnTypeOverrides).length > 0) {
      const updatedColumns = dataset.columns.map(col => {
        const override = columnTypeOverrides[col.name];
        return override ? { ...col, type: override } : col;
      });
      finalDataset = { ...finalDataset, columns: updatedColumns };
      const sig = datasetSignature(dataset.columns.map(c => c.name));
      saveColumnCorrections(sig, columnTypeOverrides).catch(() => { /* fail-open */ });
    }
    try {
      const model = buildSemanticModel(finalDataset);
      (finalDataset as any).semanticModel = model;
      console.log(`[App] Semantic model rebuilt: ${model.measures.length} measures, ${model.dimensions.length} dimensions`);
    } catch (err) {
      console.warn('[App] Semantic model rebuild failed:', err);
    }
    setDataset(finalDataset);
    saveDatasetToDB(finalDataset);
    setPendingProfile(null);
    showToast(`Mapping applied: ${updatedProfile.domain} domain · Grain: ${updatedProfile.grain || 'unset'}`);
  };

  const datasetWorkspaceProps = {
    mappingProfile: pendingProfile || dataset?.domainProfile || null,
    isAIProfiling,
    onApplyMapping: handleWorkspaceMappingApply,
    onDismissMapping: () => setPendingProfile(null),
    onSchemaOverride: handleSchemaOverride,
    onRowsRecovered: handleDatasetRowsRecovered,
    onDataCleaned: handleDatasetDataCleaned,
    onSwitchToLive: () => setActiveTab(Tab.UPLOAD),
  };

  const handlePromoteToTitle = (columnName: string) => {
    console.log("Promoted to title:", columnName);
  };

  const loadSampleData = () => {
    const csvContent = getSampleData();
    setProcessing(true);

    const worker = new Worker(new URL('./workers/etl.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event) => {
      if (event.data.type === 'SUCCESS') {
        const { rows, logs, columns, timeContext, dimDate, rawRows } = event.data.result;
        const sampleDs: Dataset = {
          id: generateId(),
          name: "sample_sales_data.csv",
          rows,
          rawRows,
          columns,
          totalRows: rows.length,
          etlLogs: logs,
          timeContext,
          dimDate,
          version: 1,
          createdAt: Date.now(),
        };
        // ── BUILD SEMANTIC MODEL ──
        try {
          const model = buildSemanticModel(sampleDs);
          (sampleDs as any).semanticModel = model;
          console.log(`[App] Sample data semantic model: ${model.measures.length} measures, ${model.dimensions.length} dimensions`);
        } catch (err) {
          console.warn('[App] Semantic model build failed for sample data:', err);
        }
        setDataset(sampleDs);
        saveDatasetToDB(sampleDs);
        // Open Column Mapping Wizard
        const colSem: Record<string, any> = {};
        for (const col of columns) {
          colSem[col.name] = {
            role: col.type,
            aggregation: inferDefaultAggregation(col.name, col.type),
            format: 'raw',
            humanLabel: col.name.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
            description: '',
            semanticRole: col.type === ColumnType.METRIC ? 'primary_metric' : col.type === ColumnType.DATE ? 'primary_date' : col.type === ColumnType.ID ? 'identifier' : 'other',
            isHidden: false,
          };
        }
        const sampleProfile: any = { domain: 'Sales', summary: 'Sample sales dataset', confidence: 0.9, themeColor: '#6366f1', columnSemantics: colSem, detectedAt: Date.now() };
        (sampleDs as any).domainProfile = sampleProfile;
        setPendingProfile(sampleProfile);
        setActiveTab(Tab.COLUMN_MAPPING);
        setProcessing(false);
        worker.terminate();
      }
    };

    worker.postMessage({ type: 'PROCESS_FILE', rawData: csvContent, fileName: 'sample_sales_data.csv' });
  };

  const handleConnectorData = (rawData: any, name: string, sourceSchema?: any, liveInfo?: any) => {
    setProcessing(true);
    const worker = new Worker(new URL('./workers/etl.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event) => {
      if (event.data.type === 'SUCCESS') {
        const { rows, logs, columns, timeContext, sourceSchema: resultSchema, dimDate, rawRows } = event.data.result;

        // ── BUILD DOMAIN PROFILE FIRST (before setDataset) ──
        // This prevents the useEffect on dataset?.id from nulling pendingProfile
        const colSem: Record<string, any> = {};
        for (const col of columns) {
          colSem[col.name] = {
            role: col.type,
            aggregation: inferDefaultAggregation(col.name, col.type),
            format: 'raw',
            humanLabel: col.name.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
            description: '',
            semanticRole: col.type === ColumnType.METRIC ? 'primary_metric' : col.type === ColumnType.DATE ? 'primary_date' : col.type === ColumnType.ID ? 'identifier' : 'other',
            isHidden: false,
          };
        }
        const hDomain = detectDomainFromColumns(columns, name);
        const connProfile: any = { domain: hDomain || 'Sales', summary: `Detected as ${hDomain || 'Sales'} domain`, confidence: 0.5, themeColor: '#6366f1', columnSemantics: colSem, detectedAt: Date.now() };

        console.log(`[App] Connector columns (master table): ${columns.length} columns — ${columns.map((c: any) => c.name).join(', ')}`);

        const connDs: Dataset = {
          id: generateId(),
          name: name,
          rows,
          rawRows,
          columns,
          totalRows: rows.length,
          etlLogs: logs,
          timeContext,
          dimDate,
          sourceSchema: resultSchema,
          domainProfile: connProfile,
          connectionMode: liveInfo?.connectionMode || (liveInfo ? 'import' : undefined),
          liveConnection: liveInfo ? { connectionId: liveInfo.connectionId, dbType: liveInfo.dbType, tables: liveInfo.tables, joinEdges: liveInfo.joinEdges } : undefined,
          version: 1,
          createdAt: Date.now(),
        };
        // ── BUILD SEMANTIC MODEL ──
        try {
          const model = buildSemanticModel(connDs);
          (connDs as any).semanticModel = model;
          console.log(`[App] Connector semantic model: ${model.measures.length} measures, ${model.dimensions.length} dimensions`);
        } catch (err) {
          console.warn('[App] Semantic model build failed for connector:', err);
        }

        // Set state AFTER domainProfile is attached — prevents useEffect race condition
        setDataset(connDs);
        saveDatasetToDB(connDs);

        // ── CACHE CREDENTIALS for session auto-reconnect ──
        if (liveInfo?._sessionPassword && liveInfo.host && liveInfo.username) {
          cacheSessionCredentials(connDs.id, {
            host: liveInfo.host,
            port: liveInfo.port || '1433',
            database: liveInfo.database || '',
            username: liveInfo.username,
            password: liveInfo._sessionPassword,
            ssl: liveInfo.ssl ?? false,
          });
        }

        setPendingProfile(connProfile);
        setActiveTab(Tab.COLUMN_MAPPING);
        setProcessing(false);
        worker.terminate();
      }
    };

    worker.postMessage({ type: 'PROCESS_FILE', rawData, fileName: name, isConnector: true, sourceSchema });
  };

  // ── LIVE REFRESH — Re-fetch data from the source database ──
  const [isLiveRefreshing, setIsLiveRefreshing] = useState(false);
  const isRefreshingRef = useRef(false); // Ref for async overlap guard (setInterval can't read state)
  const datasetRef = useRef(dataset); // BUG 1 FIX: Always-current dataset for async/interval callbacks
  datasetRef.current = dataset; // Keep ref synced on every render
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [showReconnectModal, setShowReconnectModal] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | undefined>(undefined);
  const autoReconnectAttempts = useRef(0);

  // Switch connection mode (Import ↔ Live) on the current dataset
  const switchConnectionMode = async (newMode: 'import' | 'live') => {
    if (!dataset || !dataset.liveConnection) return;
    if (dataset.connectionMode === newMode) { setShowModeDropdown(false); return; }

    // Auto-disable refresh schedule when switching to import mode
    const updated: Dataset = {
      ...dataset,
      connectionMode: newMode,
      ...(newMode === 'import' && dataset.refreshSchedule?.enabled
        ? { refreshSchedule: { ...dataset.refreshSchedule, enabled: false } }
        : {}),
    };
    setDataset(updated);
    saveDatasetToDB(updated);
    setShowModeDropdown(false);
    console.log(`[App] Connection mode switched to: ${newMode}`);
  };
  const handleLiveRefresh = async () => {
    // BUG 1 FIX: Read from ref to always get latest dataset (not stale closure)
    const ds = datasetRef.current;
    if (!ds?.liveConnection || ds.connectionMode !== 'live') return;
    if (isRefreshingRef.current) { console.log('[App] Refresh skipped — already in progress'); return; }
    isRefreshingRef.current = true;
    setIsLiveRefreshing(true);
    try {
      const { rows: freshRows, executionTimeMs } = await refreshLiveDataset(ds.liveConnection);
      console.log(`[App] Live refresh complete: ${freshRows.length} rows in ${executionTimeMs}ms`);

      // Re-run ETL on fresh data via worker
      const worker = new Worker(new URL('./workers/etl.worker.ts', import.meta.url), { type: 'module' });

      // BUG 3 FIX: Handle worker errors to prevent stuck isRefreshingRef
      worker.onerror = (err) => {
        console.error('[App] ETL worker error during refresh:', err);
        isRefreshingRef.current = false;
        setIsLiveRefreshing(false);
        showToast('❌ Refresh failed: ETL processing error');
        worker.terminate();
      };

      worker.onmessage = (event) => {
        if (event.data.type === 'SUCCESS') {
          // BUG 1 FIX: Use datasetRef.current (not closure 'ds') for the spread
          // so we don't revert any state changes that happened during the async refresh
          const latestDs = datasetRef.current || ds;
          const { rows, columns, timeContext, dimDate, rawRows, logs } = event.data.result;
          const refreshedDs: Dataset = {
            ...latestDs,
            rows,
            rawRows,
            columns,
            totalRows: rows.length,
            etlLogs: logs,
            timeContext,
            dimDate,
            version: (latestDs.version || 1) + 1,
          };
          // Rebuild semantic model
          try {
            const model = buildSemanticModel(refreshedDs);
            (refreshedDs as any).semanticModel = model;
          } catch (err) {
            console.warn('[App] Semantic model rebuild failed on refresh:', err);
          }
          // Update schedule: record success + reset failure counter
          if (refreshedDs.refreshSchedule?.enabled) {
            refreshedDs.refreshSchedule = {
              ...refreshedDs.refreshSchedule,
              lastRefreshAt: Date.now(),
              consecutiveFailures: 0,
            };
          }
          setDataset(refreshedDs);
          saveDatasetToDB(refreshedDs);
          showToast(`⚡ Live data refreshed — ${rows.length} rows (${executionTimeMs}ms)`);
          isRefreshingRef.current = false;
          setIsLiveRefreshing(false);
          worker.terminate();
        }
        // BUG 3 FIX: Handle worker ERROR messages
        if (event.data.type === 'ERROR') {
          console.error('[App] ETL worker reported error:', event.data.error);
          isRefreshingRef.current = false;
          setIsLiveRefreshing(false);
          showToast(`❌ Refresh failed: ${event.data.error || 'ETL processing error'}`);
          worker.terminate();
        }
      };
      worker.postMessage({
        type: 'PROCESS_FILE',
        rawData: freshRows,
        fileName: ds.name,
        isConnector: true,
        sourceSchema: ds.sourceSchema,
      });
    } catch (err: any) {
      console.error('[App] Live refresh failed:', err);
      const msg = err.message || 'Unknown error';
      // BUG 1 FIX: Re-read latest dataset from ref for error handling
      const latestDs = datasetRef.current;
      // Detect expired/invalid connection errors
      const isConnectionExpired = msg.includes('expired') || msg.includes('invalid') || msg.includes('ECONNRESET')
        || msg.includes('Failed to refresh') || msg.includes('Connection');
      if (isConnectionExpired && latestDs?.liveConnection) {
        // ── AUTO-RECONNECT: Try cached credentials first (max 2 attempts) ──
        const cached = getSessionCredentials(latestDs.id);
        if (cached && autoReconnectAttempts.current < 2) {
          autoReconnectAttempts.current += 1;
          console.log(`[App] Auto-reconnecting with cached session credentials... (attempt ${autoReconnectAttempts.current}/2)`);
          try {
            // Reset refresh lock BEFORE reconnect so the re-triggered refresh can proceed
            isRefreshingRef.current = false;
            setIsLiveRefreshing(false);
            await handleReconnect(cached);
            return; // Success — refresh was re-triggered inside handleReconnect
          } catch (autoErr: any) {
            console.warn('[App] Auto-reconnect failed, showing modal:', autoErr.message);
            // Clear stale cached credentials
            clearSessionCredentials(latestDs.id);
          }
        } else if (autoReconnectAttempts.current >= 2) {
          console.warn('[App] Auto-reconnect limit reached (2 attempts). Showing manual reconnect modal.');
          clearSessionCredentials(latestDs.id);
          autoReconnectAttempts.current = 0;
        }
        setReconnectError(msg);
        setShowReconnectModal(true);
      } else {
        showToast(`❌ Refresh failed: ${msg}`);
      }
      // Track scheduler failures
      // BUG 2 FIX: Keep enabled: true so the scheduler loop can resume.
      // The UI uses consecutiveFailures >= 3 to show "Paused" state.
      if (latestDs?.refreshSchedule?.enabled) {
        const failures = (latestDs.refreshSchedule.consecutiveFailures || 0) + 1;
        const updatedSchedule: RefreshSchedule = {
          ...latestDs.refreshSchedule,
          consecutiveFailures: failures,
          // BUG 2 FIX: Do NOT set enabled: false — keep the loop alive
          // The interval guard at line 730 will skip ticks while paused
        };
        const updatedDs = { ...latestDs, refreshSchedule: updatedSchedule };
        setDataset(updatedDs);
        saveDatasetToDB(updatedDs);
        if (failures >= 3) {
          showToast('⏸️ Auto-refresh paused after 3 consecutive failures. Select an interval to retry.');
        }
      }
      isRefreshingRef.current = false;
      setIsLiveRefreshing(false);
    }
  };

  // ── DATASET SYNCHRONIZATION SCHEDULER ──────────────────────────
  // Timer-based scheduler that calls handleLiveRefresh at configured intervals.
  // Downstream reactivity (dashboards, alerts, KPIs) is triggered automatically
  // via dataset.version increments — no direct coupling.
  useEffect(() => {
    const sched = dataset?.refreshSchedule;
    if (!sched?.enabled || !sched.intervalMs || !dataset?.liveConnection || dataset.connectionMode !== 'live') {
      return; // No schedule, not live, or disabled
    }
    // BUG 2 FIX: Don't start interval if paused due to consecutive failures
    const MAX_FAILURES = 3;
    if ((sched.consecutiveFailures || 0) >= MAX_FAILURES) {
      console.log(`[Scheduler] ⏸ Paused — ${sched.consecutiveFailures} consecutive failures`);
      return;
    }
    console.log(`[Scheduler] ▶ Auto-refresh enabled: every ${Math.round(sched.intervalMs / 60000)}min`);
    const interval = setInterval(() => {
      if (isRefreshingRef.current) {
        console.log('[Scheduler] ⏭ Skipped tick — refresh already in progress');
        return;
      }
      console.log('[Scheduler] ⏰ Scheduled refresh triggered');
      // BUG 1 FIX: handleLiveRefresh reads from datasetRef, so it's always fresh
      handleLiveRefresh();
    }, sched.intervalMs);
    return () => {
      console.log('[Scheduler] ⏹ Cleared interval');
      clearInterval(interval);
    };
  }, [dataset?.refreshSchedule?.enabled, dataset?.refreshSchedule?.intervalMs, dataset?.refreshSchedule?.consecutiveFailures, dataset?.connectionMode]);

  // Handler for RefreshSchedulerDropdown to update the schedule
  const updateRefreshSchedule = (schedule: RefreshSchedule) => {
    if (!dataset) return;
    const updated: Dataset = { ...dataset, refreshSchedule: schedule };
    // If enabling, record first "lastRefreshAt" as now so countdown starts immediately
    if (schedule.enabled && !schedule.lastRefreshAt) {
      updated.refreshSchedule = { ...schedule, lastRefreshAt: Date.now() };
    }
    setDataset(updated);
    saveDatasetToDB(updated);
    console.log(`[Scheduler] Schedule updated:`, schedule.enabled ? `every ${Math.round(schedule.intervalMs / 60000)}min` : 'OFF');

    // BUG 5 FIX: Fire immediate first refresh when enabling auto-refresh
    // Guard: skip if a refresh is already running (e.g. during auto-reconnect flow)
    if (schedule.enabled && schedule.intervalMs > 0 && !isRefreshingRef.current) {
      console.log('[Scheduler] ▶ Firing immediate first refresh on enable');
      // Small delay so state updates propagate before refresh reads datasetRef
      setTimeout(() => handleLiveRefresh(), 100);
    }
  };

  // ── RECONNECT — Re-establish expired live database connection ──
  const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://api.quickinsight.co.uk';
  const handleReconnect = async (config: { host: string; port: string; database: string; username: string; password: string; ssl: boolean }) => {
    if (!dataset?.liveConnection) return;
    const lc = dataset.liveConnection;
    const isPostgres = lc.dbType === 'pg';
    const endpoint = isPostgres ? '/api/pg/connect' : '/api/connect';

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': import.meta.env.VITE_API_KEY || '',
      },
      body: JSON.stringify({
        host: config.host,
        port: config.port,
        database: config.database,
        username: config.username,
        password: config.password,
        ssl: config.ssl,
      }),
    });

    const data = await response.json();
    if (!data.success) {
      setReconnectError(data.error || 'Reconnection failed');
      throw new Error(data.error);
    }

    // Update connectionId AND persist non-sensitive metadata for future reconnects
    const updatedLc = {
      ...lc,
      connectionId: data.connectionId,
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      ssl: config.ssl,
    };
    const updatedDs: Dataset = { ...dataset, liveConnection: updatedLc };
    setDataset(updatedDs);
    saveDatasetToDB(updatedDs);

    // ── CACHE CREDENTIALS in sessionStorage for auto-reconnect ──
    cacheSessionCredentials(dataset.id, config);

    // Close modal and re-trigger refresh
    setShowReconnectModal(false);
    setReconnectError(undefined);
    autoReconnectAttempts.current = 0; // Reset counter on successful reconnect
    showToast('🔗 Reconnected successfully — refreshing data...');
    // Small delay then refresh
    setTimeout(() => handleLiveRefresh(), 500);
  };

  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [workbenchConfig, setWorkbenchConfig] = useState<any>(undefined);
  const [workbenchResult, setWorkbenchResult] = useState<AnalysisResult | undefined>(undefined);
  const [editingDashboardItemId, setEditingDashboardItemId] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };

  const handlePin = (result: AnalysisResult) => {
    const newItem = {
      id: generateId(),
      title: result.insight || "New Analysis",
      result: result,
      width: 'half' as 'half' | 'full',
      datasetVersion: dataset?.version,
      datasetId: dataset?.id,
      datasetName: dataset?.name,
    };
    // Open Pin-to-Dashboard modal instead of adding directly
    setPendingPinItem(newItem);
  };

  // ── Auto-Dashboard: build a full dashboard from auto-insights ──
  const [isBuildingDashboard, setIsBuildingDashboard] = useState(false);
  const [buildDashboardMsg, setBuildDashboardMsg] = useState('');

  const handleBuildDashboard = async () => {
    if (!dataset || isBuildingDashboard) return;
    setIsBuildingDashboard(true);
    setBuildDashboardMsg('Analyzing your data…');
    try {
      const { count } = await buildAutoDashboard(dataset, { onProgress: setBuildDashboardMsg });
      if (count > 0) {
        setActiveTab(Tab.DASHBOARD);
      } else {
        setError('We couldn’t auto-build a dashboard for this dataset yet — try building a chart from Smart Insights or the Question Builder.');
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to build the dashboard. Please try again.');
    } finally {
      setIsBuildingDashboard(false);
      setBuildDashboardMsg('');
    }
  };

  // NOTE: Building the dashboard is now OPT-IN only. It used to auto-run here on
  // mount, which meant it fired on every login/refresh (this ref resets on each
  // fresh mount) — irritating and unwanted. Users trigger it themselves via the
  // "Build my dashboard" / "Auto-build" buttons on the Dashboard tab.

  const handleEditAnalysis = (item: any) => {
    const config = { ...item.result.config };
    // Backward compat: AI SQL cards pinned before the limit/sort fix
    if (config.questionId?.startsWith('ai_sql_') || config.questionId?.startsWith('regen_')) {
      // Infer limit from result data if not stored
      if (!config.limit && item.result.data?.length > 0 && item.result.data.length <= 20) {
        config.limit = item.result.data.length;
      }
      if (!config.sort) {
        config.sort = 'desc';
      }
      // Forward the SQL for direct re-execution
      if (item.result.sql) {
        config.aiSql = item.result.sql;
      }
    }
    setWorkbenchConfig(config);
    setWorkbenchResult(item.result);
    setEditingDashboardItemId(item.id);
    setActiveTab(Tab.BUILDER); // Redirected from WORKBENCH (hidden)
    showToast("Editing: " + item.title);
  };

  const handleSaveBackToDashboard = (result: AnalysisResult) => {
    if (editingDashboardItemId) {
      updateItem({
        id: editingDashboardItemId,
        title: result.insight || "Updated Analysis",
        result: result,
        width: 'half' as 'half' | 'full'
      });
      setEditingDashboardItemId(null);
      setActiveTab(Tab.DASHBOARD);
      showToast("Dashboard visual updated!");
    }
  };

  // Resolve global styles
  const getGlobalStyle = () => {
    return {
      fontSize: `${appFontSize}px`,
      fontWeight: appFontBold ? 'bold' : 'normal'
    } as React.CSSProperties;
  };

  const getGlobalClasses = () => {
    const classes = [
      'flex h-screen font-sans selection:bg-violet-500/30',
      theme === 'dark'
        ? 'text-gray-100'
        : 'text-gray-900'
    ];
    if (appFontBold) classes.push('font-bold');
    return classes.join(' ');
  };

  return (
    <ErrorBoundary>
      {/* ── Splash / Boot Screen ── */}
      {showSplash && <SplashScreen onComplete={() => setShowSplash(false)} />}

      {/* Auto-Dashboard build overlay */}
      {isBuildingDashboard && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className={`flex flex-col items-center gap-4 px-8 py-7 rounded-2xl border shadow-2xl ${theme === 'dark' ? 'bg-[#12161f] border-white/10' : 'bg-white border-gray-200'}`}>
            <div className="relative">
              <div className="w-11 h-11 rounded-full border-2 border-indigo-500/25 border-t-indigo-500 animate-spin" />
              <Sparkles className="w-4 h-4 text-indigo-400 absolute inset-0 m-auto" />
            </div>
            <div className="text-center">
              <div className={`text-sm font-semibold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>Building your dashboard</div>
              <div className={`text-xs mt-1 ${theme === 'dark' ? 'text-slate-400' : 'text-gray-500'}`}>{buildDashboardMsg || 'One moment…'}</div>
            </div>
          </div>
        </div>
      )}

      {/* ── Reconnect Modal (connection expired) ── */}
      {showReconnectModal && dataset?.liveConnection && (
        <ReconnectModal
          dbType={dataset.liveConnection.dbType}
          host={dataset.liveConnection.host}
          port={dataset.liveConnection.port}
          database={dataset.liveConnection.database}
          username={dataset.liveConnection.username}
          ssl={dataset.liveConnection.ssl}
          error={reconnectError}
          onReconnect={handleReconnect}
          onCancel={() => { setShowReconnectModal(false); setReconnectError(undefined); }}
        />
      )}

      <ThemeProvider theme={theme} toggleTheme={toggleTheme} setTheme={setTheme}>

        {/* Auth Gate: Show login if not authenticated */}
        {!isAuthenticated ? (
          <>
            <LoginPage onShowLegal={() => setActiveTab(Tab.LEGAL)} />
            {activeTab === Tab.LEGAL && (
              <LegalPage onClose={() => setActiveTab(Tab.DASHBOARD)} />
            )}
          </>
        ) : (
          <div className={getGlobalClasses()} style={getGlobalStyle()}>
            {/* Ambient background orbs */}
            <div className="ambient-orb ambient-orb-1 print:hidden" />
            <div className="ambient-orb ambient-orb-2 print:hidden" />

            {/* Sidebar — drawer overlay on mobile, side panel on desktop */}
            {isMobile ? (
              <AnimatePresence>
                {isSidebarOpen && (
                  <>
                    {/* Backdrop */}
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm print:hidden"
                      onClick={() => setSidebarOpen(false)}
                    />
                    {/* Drawer */}
                    <motion.div
                      initial={{ x: -300, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      exit={{ x: -300, opacity: 0 }}
                      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                      className={`fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] border-r overflow-hidden flex-shrink-0 print:hidden ${theme === 'dark' ? 'bg-[#0c0f16] border-white/[0.06]' : 'bg-white border-gray-200'
                        }`}
                    >
                      <Sidebar
                        activeTab={activeTab}
                        onTabChange={(tab) => { setActiveTab(tab); setSidebarOpen(false); }}
                        onToggle={() => setSidebarOpen(false)}
                        onOpenUserManagement={() => { setShowUserMgmt(true); setSidebarOpen(false); }}
                        hasVisualResult={!!visualPreviewResult}
                        onDataStory={() => { setShowDataStory(true); setSidebarOpen(false); }}
                        onOpenTabManager={() => { setShowTabManager(true); setSidebarOpen(false); }}
                      />
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            ) : (
              <AnimatePresence>
                {isSidebarOpen && (
                  <motion.div
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 260, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    className={`h-full border-r z-20 overflow-hidden flex-shrink-0 relative print:hidden ${theme === 'dark' ? 'bg-[#0c0f16]/90 backdrop-blur-xl border-white/[0.06]' : 'bg-white/90 backdrop-blur-xl border-gray-200'
                      }`}
                  >
                    <Sidebar
                      activeTab={activeTab}
                      onTabChange={setActiveTab}
                      onToggle={() => toggleSidebar()}
                      onOpenUserManagement={() => setShowUserMgmt(true)}
                      hasVisualResult={!!visualPreviewResult}
                      onDataStory={() => setShowDataStory(true)}
                      onOpenTabManager={() => setShowTabManager(true)}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            )}

            <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
              {/* Header */}
              <header className={`h-14 flex items-center justify-between px-3 md:px-5 z-30 relative border-b print:hidden ${theme === 'dark' ? 'bg-[#12161f]/80 backdrop-blur-xl border-white/[0.06]' : 'bg-white/80 backdrop-blur-xl border-gray-200 shadow-sm'
                }`}>
                <div className="flex items-center gap-2 md:gap-3 min-w-0">
                  {(!isSidebarOpen || isMobile) && (
                    <button
                      onClick={() => isMobile ? setSidebarOpen(true) : toggleSidebar()}
                      className={`p-2 -ml-1 rounded-lg transition-all duration-200 shrink-0 ${theme === 'dark' ? 'text-gray-400 hover:text-white hover:bg-white/[0.06]' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
                        }`}
                    >
                      <Menu className="w-5 h-5" />
                    </button>
                  )}

                  <div className={`flex items-center gap-2 md:gap-2.5 rounded-xl py-1.5 px-2 md:px-3 border transition-all min-w-0 ${theme === 'dark' ? 'bg-white/[0.04] border-white/[0.06] hover:border-violet-500/20' : 'bg-gray-50 border-gray-200 hover:border-violet-200'
                    }`}>
                    <div className={`
                      w-2 h-2 rounded-full transition-all duration-500 shrink-0
                      ${isProcessing ? 'bg-amber-400 animate-pulse shadow-sm shadow-amber-400/50' :
                        dataset ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50' : 'bg-gray-400'}
                    `} />
                    <span className={`text-sm font-semibold tracking-tight truncate max-w-[120px] md:max-w-none ${theme === 'dark' ? 'text-gray-200' : 'text-gray-700'
                      }`}>
                      {dataset ? dataset.name : 'No active dataset'}
                    </span>
                    {dataset && (
                      <span className={`text-[11px] font-medium hidden sm:inline ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'
                        }`}>
                        {dataset.totalRows?.toLocaleString()} rows
                      </span>
                    )}
                    {isAIProfiling && (
                      <span className="text-[11px] font-medium text-violet-400 items-center gap-1 animate-pulse hidden sm:flex">
                        <Brain className="w-3 h-3" /> Profiling...
                      </span>
                    )}
                    {dataset?.domainProfile && !isAIProfiling && (
                      <span className="text-[11px] font-semibold text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded-full hidden sm:inline">
                        {dataset.domainProfile.domain}
                      </span>
                    )}
                    {dataset?.liveConnection && (
                      <div className="relative hidden md:block">
                        <button
                          onClick={() => setShowModeDropdown(!showModeDropdown)}
                          className={`text-[11px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1.5 border transition-all cursor-pointer ${
                            dataset.connectionMode === 'live'
                              ? 'text-emerald-400 bg-emerald-500/15 border-emerald-500/25 hover:bg-emerald-500/25'
                              : 'text-gray-400 bg-white/[0.06] border-white/[0.08] hover:bg-white/[0.1]'
                          }`}
                        >
                          {dataset.connectionMode === 'live' ? (
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                          ) : (
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                          )}
                          {dataset.connectionMode === 'live' ? 'Live' : 'Import'}
                          <svg className="w-3 h-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                        </button>
                        {showModeDropdown && (
                          <>
                            <div className="fixed inset-0 z-30" onClick={() => setShowModeDropdown(false)} />
                            <div className={`absolute top-full left-0 mt-1 z-40 w-48 rounded-xl shadow-2xl border overflow-hidden ${
                              theme === 'dark' ? 'bg-[#171c26] border-white/10' : 'bg-white border-gray-200'
                            }`}>
                              <button
                                onClick={() => switchConnectionMode('import')}
                                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition-all ${
                                  dataset.connectionMode === 'import'
                                    ? theme === 'dark' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-indigo-50 text-indigo-700'
                                    : theme === 'dark' ? 'text-gray-400 hover:bg-white/[0.05]' : 'text-gray-600 hover:bg-gray-50'
                                }`}
                              >
                                <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                                <div className="text-left">
                                  <div className="font-bold">Import</div>
                                  <div className={`text-[10px] ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>Static snapshot of your data</div>
                                </div>
                                {dataset.connectionMode === 'import' && (
                                  <svg className="w-4 h-4 ml-auto text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                                )}
                              </button>
                              <div className={`h-px ${theme === 'dark' ? 'bg-white/[0.06]' : 'bg-gray-100'}`} />
                              <button
                                onClick={() => switchConnectionMode('live')}
                                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition-all ${
                                  dataset.connectionMode === 'live'
                                    ? 'bg-emerald-500/15 text-emerald-300'
                                    : theme === 'dark' ? 'text-gray-400 hover:bg-white/[0.05]' : 'text-gray-600 hover:bg-gray-50'
                                }`}
                              >
                                <svg className="w-4 h-4 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                <div className="text-left">
                                  <div className="font-bold">⚡ Live</div>
                                  <div className={`text-[10px] ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>Real-time data from database</div>
                                </div>
                                {dataset.connectionMode === 'live' && (
                                  <svg className="w-4 h-4 ml-auto text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                                )}
                              </button>
                              {/* Reconnect option — always visible for live connections */}
                              {dataset.liveConnection && (
                                <>
                                  <div className={`h-px ${theme === 'dark' ? 'bg-white/[0.06]' : 'bg-gray-100'}`} />
                                  <button
                                    onClick={() => { setShowModeDropdown(false); setReconnectError(undefined); setShowReconnectModal(true); }}
                                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition-all ${
                                      theme === 'dark' ? 'text-amber-400 hover:bg-amber-500/10' : 'text-amber-600 hover:bg-amber-50'
                                    }`}
                                  >
                                    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                                    <div className="text-left">
                                      <div className="font-bold">🔌 Reconnect</div>
                                      <div className={`text-[10px] ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>Re-enter password to reconnect</div>
                                    </div>
                                  </button>
                                </>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="hidden md:block">
                    <DatasetSwitcher
                      datasets={datasets}
                      activeDataset={dataset}
                      onSwitch={setActiveDatasetById}
                      onRemove={removeDataset}
                      onAddNew={() => setActiveTab(Tab.UPLOAD)}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-1 md:gap-1.5 shrink-0">
                  {/* Notification Center (Alert Bell) */}
                  <NotificationCenter onNavigateToAlerts={() => setActiveTab(Tab.ALERTS)} />
                  {/* Re-open Column Mapping — hide on mobile */}
                  {dataset?.domainProfile && (
                    <button
                      onClick={() => {
                        setPendingProfile(dataset.domainProfile!);
                        setActiveTab(Tab.COLUMN_MAPPING);
                      }}
                      className={`p-2 rounded-lg transition-all duration-200 hidden md:block ${theme === 'dark' ? 'text-gray-400 hover:text-violet-400 hover:bg-violet-500/10' : 'text-gray-500 hover:text-violet-600 hover:bg-violet-50'
                        }`}
                      title="Re-open Column Mapping"
                    >
                      <Brain className="w-5 h-5" />
                    </button>
                  )}

                  <button
                    onClick={toggleTheme}
                    className={`p-2 rounded-lg transition-all duration-200 ${theme === 'dark' ? 'text-gray-400 hover:text-amber-400 hover:bg-amber-500/10' : 'text-gray-500 hover:text-amber-600 hover:bg-amber-50'
                      }`}
                    title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                  >
                    {theme === 'dark' ? (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                    )}
                  </button>

                  <button
                    onClick={() => toggleAbout(true)}
                    className={`p-2 rounded-lg transition-all duration-200 hidden sm:block ${theme === 'dark' ? 'text-gray-400 hover:text-violet-400 hover:bg-violet-500/10' : 'text-gray-500 hover:text-violet-600 hover:bg-violet-50'
                      }`}
                    title="Settings"
                  >
                    <Settings className="w-5 h-5" />
                  </button>

                  {currentUser && (
                    <div className={`flex items-center gap-1 md:gap-2 ml-0.5 md:ml-1 pl-1.5 md:pl-3 border-l ${theme === 'dark' ? 'border-white/[0.08]' : 'border-gray-200'
                      }`}>
                      <div className="relative">
                        <div className="absolute -inset-0.5 rounded-full bg-gradient-to-br from-violet-500 to-indigo-500 opacity-50" />
                        <div
                          className="relative w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs shadow-md cursor-default"
                          style={{ backgroundColor: currentUser.avatar || '#7c3aed' }}
                          title={`${currentUser.name} (${currentUser.role})`}
                        >
                          {currentUser.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                        </div>
                        {/* Online indicator */}
                        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-[#12161f]" />
                      </div>
                      <button
                        onClick={async () => { clearSessionCredentials(); await logout(); }}
                        className={`p-1.5 rounded-lg transition-all duration-200 ${theme === 'dark' ? 'text-gray-500 hover:text-red-400 hover:bg-red-500/10' : 'text-gray-400 hover:text-red-500 hover:bg-red-50'
                          }`}
                        title="Sign Out"
                      >
                        <LogOut className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              </header>

              {/* Main Content Area */}
              <main className={`flex-1 overflow-hidden relative ${theme === 'dark' ? 'bg-[#0a0c12]' : 'bg-[#f4f6fb]'
                }`}>

                {/* ── FULL-SCREEN PROFILING OVERLAY ── */}
                <AnimatePresence>
                  {(isProcessing || isAIProfiling) && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className="absolute inset-0 z-50 flex items-center justify-center"
                      style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
                    >
                      {/* Dark scrim */}
                      <div className="absolute inset-0 bg-black/60" />

                      {/* Profiling card */}
                      <motion.div
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.9, opacity: 0 }}
                        transition={{ delay: 0.1, duration: 0.3 }}
                        className="relative z-10 w-[90vw] max-w-[420px] rounded-2xl border shadow-2xl overflow-hidden"
                        style={{
                          background: theme === 'dark'
                            ? 'linear-gradient(135deg, #171c26 0%, #12161f 100%)'
                            : 'linear-gradient(135deg, #ffffff 0%, #f8f9fc 100%)',
                          borderColor: theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
                        }}
                      >
                        {/* Top glow accent */}
                        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-violet-500 via-indigo-500 to-purple-600" />

                        <div className="p-8 flex flex-col items-center text-center">
                          {/* Animated brain icon */}
                          <div className="relative mb-6">
                            <div className="absolute inset-0 rounded-full bg-violet-500/20 animate-ping" style={{ animationDuration: '2s' }} />
                            <div className="relative w-16 h-16 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-500/25">
                              <Brain className="w-8 h-8 text-white" />
                            </div>
                          </div>

                          {/* Title */}
                          <h3 className={`text-lg font-bold mb-1 ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                            {isProcessing ? 'Processing Dataset' : 'AI Profiling'}
                          </h3>
                          <p className={`text-sm mb-6 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                            {isProcessing
                              ? 'Running ETL pipeline — cleaning, classifying, and structuring your data...'
                              : 'Analyzing column semantics, detecting domain, and building the decision model...'
                            }
                          </p>

                          {/* Progress bar */}
                          <div className={`w-full h-2 rounded-full overflow-hidden mb-4 ${theme === 'dark' ? 'bg-white/[0.06]' : 'bg-gray-200'}`}>
                            <motion.div
                              className="h-full rounded-full bg-gradient-to-r from-violet-500 via-indigo-500 to-purple-500"
                              initial={{ width: '5%' }}
                              animate={{
                                width: isProcessing ? ['5%', '40%', '65%'] : ['30%', '60%', '85%', '95%'],
                              }}
                              transition={{
                                duration: isProcessing ? 8 : 12,
                                ease: 'easeInOut',
                                times: isProcessing ? [0, 0.4, 1] : [0, 0.3, 0.7, 1],
                              }}
                            />
                          </div>

                          {/* Step indicators */}
                          <div className="w-full space-y-2">
                            {isProcessing ? (
                              <>
                                <ProfilingStep label="Structural normalization" active done={false} theme={theme} />
                                <ProfilingStep label="Column classification" active={false} done={false} theme={theme} />
                                <ProfilingStep label="Data transformation" active={false} done={false} theme={theme} />
                              </>
                            ) : (
                              <>
                                <ProfilingStep label="ETL pipeline complete" active={false} done theme={theme} />
                                <ProfilingStep label="Semantic domain detection" active done={false} theme={theme} />
                                <ProfilingStep label="Building decision model" active={false} done={false} theme={theme} />
                              </>
                            )}
                          </div>

                          {/* Dataset info */}
                          {dataset && (
                            <div className={`mt-5 pt-4 border-t w-full flex items-center justify-center gap-3 ${theme === 'dark' ? 'border-white/[0.06]' : 'border-gray-200'}`}>
                              <span className={`text-xs font-medium ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
                                {dataset.name}
                              </span>
                              <span className={`text-xs ${theme === 'dark' ? 'text-gray-600' : 'text-gray-300'}`}>•</span>
                              <span className={`text-xs font-medium ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
                                {dataset.totalRows?.toLocaleString()} rows • {dataset.columns?.length} columns
                              </span>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Dataset preparation tools live inside Dataset Workspace. Legacy routes preserve deep links. */}
                <div className={`h-full w-full ${activeTab === Tab.COLUMN_MAPPING ? '' : 'hidden'}`}>
                  <DatasetSummaryView dataset={dataset} initialSection="mapping" {...datasetWorkspaceProps} />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.UPLOAD ? '' : 'hidden'}`}>
                  <UploadView
                    onFileUpload={handleFileUpload}
                    onSampleLoad={loadSampleData}
                    processing={isProcessing}
                    error={error}
                    onConnectorLoad={handleConnectorData}
                    datasets={datasets}
                    onLoadDataset={setActiveDatasetById}
                    onDeleteDataset={handleDeleteDataset}
                    activeDatasetId={dataset?.id}
                  />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.ETL ? '' : 'hidden'}`}>
                  <DatasetSummaryView dataset={dataset} initialSection="cleaned" {...datasetWorkspaceProps} />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.DATA_STUDIO ? '' : 'hidden'}`}>
                  <DatasetSummaryView dataset={dataset} initialSection="studio" {...datasetWorkspaceProps} />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.SCHEMA ? '' : 'hidden'}`}>
                  <DatasetSummaryView dataset={dataset} initialSection="schema" {...datasetWorkspaceProps} />
                </div>

                {/* Legacy Data Explorer links open the Explorer section of Dataset Workspace. */}
                <div className={`h-full w-full ${activeTab === Tab.DATA ? '' : 'hidden'}`}>
                  <DatasetSummaryView dataset={dataset} initialSection="explore" {...datasetWorkspaceProps} />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.DATASET_SUMMARY ? '' : 'hidden'}`}>
                  <DatasetSummaryView dataset={dataset} {...datasetWorkspaceProps} />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.NLQ ? '' : 'hidden'}`}>
                  <NLQView
                    dataset={dataset}
                    onPin={(title, result) => handlePin({ ...result, insight: title })}
                  />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.AI_SQL ? '' : 'hidden'}`}>
                  <AISQLView
                    dataset={dataset}
                    onPin={(title, result) => handlePin({ ...result, insight: title })}
                    initialQuery={smartQuestionQuery}
                    onViewFullPage={(result, pipelineResult, query, fmt) => {
                      setVisualPreviewResult(result);
                      setVisualPreviewPipeline(pipelineResult);
                      setVisualPreviewQuery(query);
                      setVisualPreviewFormatting(fmt);
                      setActiveTab(Tab.VISUAL_PREVIEW);
                    }}
                  />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.VISUAL_PREVIEW ? '' : 'hidden'}`}>
                  {visualPreviewResult && (
                    <VisualPreviewView
                      dataset={dataset}
                      result={visualPreviewResult}
                      pipelineResult={visualPreviewPipeline}
                      query={visualPreviewQuery}
                      formatting={visualPreviewFormatting}
                      onBack={() => setActiveTab(Tab.AI_SQL)}
                      onPin={(title, result) => handlePin({ ...result, insight: title })}
                      onFormatChange={setVisualPreviewFormatting}
                    />
                  )}
                </div>

                <div className={`h-full w-full overflow-hidden ${activeTab === Tab.DERIVED_COLUMNS ? '' : 'hidden'}`}>
                  <DerivedColumnsView
                    dataset={dataset}
                    onDatasetUpdate={(updated) => { setDataset(updated); saveDatasetToDB(updated); }}
                  />
                </div>

                <div className={`h-full w-full overflow-hidden ${activeTab === Tab.BUILDER ? '' : 'hidden'}`}>
                  {dataset && (
                    <BuilderView
                      dataset={dataset}
                      onPin={(title, result) => handlePin({ ...result, insight: title })}
                      formatting={formatting}
                      onUpdateFormatting={updateFormatting}
                      initialConfig={workbenchConfig}
                      editingItemId={editingDashboardItemId}
                      onSaveBackToDashboard={handleSaveBackToDashboard}
                      onCancelEdit={() => { setEditingDashboardItemId(null); setActiveTab(Tab.DASHBOARD); }}
                      onLiveRefresh={handleLiveRefresh}
                      isLiveRefreshing={isLiveRefreshing}
                      refreshSchedule={dataset?.refreshSchedule}
                      onScheduleChange={updateRefreshSchedule}
                    />
                  )}
                </div>

                <div className={`h-full w-full ${activeTab === Tab.WORKBENCH ? '' : 'hidden'}`}>
                  <WorkbenchView
                    dataset={dataset}
                    initialConfig={workbenchConfig}
                    initialResult={workbenchResult}
                    onAddResult={handlePin}
                    formatting={formatting}
                    onUpdateFormatting={updateFormatting}
                    editingDashboardItemId={editingDashboardItemId}
                    onSaveBackToDashboard={handleSaveBackToDashboard}
                    onCancelEdit={() => { setEditingDashboardItemId(null); setActiveTab(Tab.DASHBOARD); }}
                  />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.DASHBOARD ? '' : 'hidden'}`}>
                  <Dashboard
                    dataset={dataset}
                    onAddResult={handlePin}
                    onEdit={handleEditAnalysis}
                    onLiveRefresh={handleLiveRefresh}
                    isLiveRefreshing={isLiveRefreshing}
                    refreshSchedule={dataset?.refreshSchedule}
                    onScheduleChange={updateRefreshSchedule}
                    onBuildDashboard={handleBuildDashboard}
                    isBuildingDashboard={isBuildingDashboard}
                  />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.CUSTOM_QUESTIONS ? '' : 'hidden'}`}>
                  <AdminQuestionBuilder dataset={dataset} />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.ALERTS ? '' : 'hidden'}`}>
                  <AlertsView dataset={dataset} />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.USER_INSIGHTS ? '' : 'hidden'}`}>
                  <UserInsightsView />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.QUICK_INSIGHTS ? '' : 'hidden'}`}>
                  <QuickInsightsView
                    dataset={dataset}
                    onPin={(title, result) => handlePin(result)}
                    onAskQuestion={handleSmartQuestion}
                  />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.SMART_QUESTIONS ? '' : 'hidden'}`}>
                  {dataset && (
                    <SmartQuestionsView
                      dataset={dataset}
                      onAskQuestion={handleSmartQuestion}
                    />
                  )}
                </div>

              </main>
            </div>

            {/* Legal Pages (full-screen overlay) */}
            {activeTab === Tab.LEGAL && (
              <LegalPage onClose={() => setActiveTab(Tab.DASHBOARD)} />
            )}

            {/* GAFS Challenge Game */}
            <div className={`h-full w-full ${activeTab === Tab.GAME ? '' : 'hidden'}`}>
              <GameView onNavigateToBuilder={() => setActiveTab(Tab.BUILDER)} />
            </div>

            {/* Global Settings Modal */}
            <AnimatePresence>
              {showAbout && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
                  <motion.div
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    className={`w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border ${theme === 'dark' ? 'bg-[#171c26] border-white/10' : 'bg-white border-gray-200'
                      }`}
                  >
                    <div className="p-6">
                      <div className="flex items-center gap-4 mb-6">
                        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-md">
                          <Settings className="w-5 h-5 text-white" />
                        </div>
                        <div>
                          <h2 className={`text-lg font-bold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>Settings</h2>
                          <p className={`text-sm ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>Appearance & System</p>
                        </div>
                      </div>

                      <div className="space-y-5">
                        <div>
                          <h3 className={`text-xs font-semibold uppercase tracking-wider mb-3 ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>Appearance</h3>

                          <div className="space-y-4">
                            <div className="flex justify-between items-center">
                              <span className={theme === 'dark' ? 'text-gray-200' : 'text-gray-700'}>Font Size</span>
                              <div className={`flex rounded-lg p-1 border ${theme === 'dark' ? 'bg-white/5 border-white/5' : 'bg-gray-100 border-gray-200'}`}>
                                {[12, 14, 16, 18, 20].map(size => (
                                  <button
                                    key={size}
                                    onClick={() => setAppFontSize(size)}
                                    className={`px-3 py-1 rounded-md text-sm transition-all ${appFontSize === size
                                      ? 'bg-violet-600 text-white shadow-sm'
                                      : theme === 'dark' ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-900'
                                      }`}
                                  >
                                    {size}
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div className="flex justify-between items-center">
                              <span className={theme === 'dark' ? 'text-gray-200' : 'text-gray-700'}>High Contrast</span>
                              <button
                                onClick={toggleAppFontBold}
                                className={`w-11 h-6 rounded-full p-0.5 transition-colors ${appFontBold ? 'bg-violet-600' : theme === 'dark' ? 'bg-gray-700' : 'bg-gray-300'}`}
                              >
                                <div className={`w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${appFontBold ? 'translate-x-5' : 'translate-x-0'}`} />
                              </button>
                            </div>

                            <div className="flex justify-between items-center">
                              <span className={theme === 'dark' ? 'text-gray-200' : 'text-gray-700'}>Theme</span>
                              <div className={`flex rounded-lg p-1 border ${theme === 'dark' ? 'bg-white/5 border-white/5' : 'bg-gray-100 border-gray-200'}`}>
                                {(['dark', 'light'] as const).map(t => (
                                  <button
                                    key={t}
                                    onClick={() => setTheme(t)}
                                    className={`px-4 py-1 rounded-md text-sm capitalize transition-all ${theme === t
                                      ? 'bg-violet-600 text-white shadow-sm'
                                      : theme === 'dark' ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-900'
                                      }`}
                                  >
                                    {t}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className={`border-t pt-4 ${theme === 'dark' ? 'border-white/5' : 'border-gray-100'}`}>
                          <p className={`text-xs text-center ${theme === 'dark' ? 'text-gray-600' : 'text-gray-400'}`}>
                            QuickInsight v3.0.1 · Production Build
                          </p>
                        </div>
                      </div>

                      <div className="mt-5">
                        <button
                          onClick={() => toggleAbout(false)}
                          className={`w-full py-2.5 rounded-xl transition-colors font-medium border ${theme === 'dark' ? 'bg-white/5 hover:bg-white/10 text-white border-white/5' : 'bg-gray-100 hover:bg-gray-200 text-gray-700 border-gray-200'
                            }`}
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>

            {/* User Management Modal (Admin only) */}
            {showUserMgmt && currentUser?.role === UserRole.ADMIN && (
              <UserManagement onClose={() => setShowUserMgmt(false)} />
            )}

            {/* Tab Visibility Manager (Admin only) */}
            <TabVisibilityManager isOpen={showTabManager && currentUser?.role === UserRole.ADMIN} onClose={() => setShowTabManager(false)} />

            {/* Domain Review Modal — replaced by full-page ColumnMappingWizard */}
            {/* DomainReviewModal kept in code but no longer rendered */}

            {/* Onboarding Tour */}
            <OnboardingTour />

            {/* Toast Notifications */}
            {/* ── Pin-to-Dashboard Modal ── */}
            {pendingPinItem && (
              <PinToDashboardModal
                item={pendingPinItem}
                onClose={() => setPendingPinItem(null)}
                onPinned={(dashboardName) => {
                  setPendingPinItem(null);
                  showToast(`Pinned to "${dashboardName}"!`);
                }}
              />
            )}

            <AnimatePresence>
              {toastMsg && (
                <motion.div
                  initial={{ opacity: 0, y: 50, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 20, scale: 0.95 }}
                  className="fixed bottom-6 right-6 bg-violet-600 text-white px-5 py-2.5 rounded-xl shadow-lg z-[100] flex items-center gap-2.5 font-semibold text-sm"
                >
                  <div className="p-1 bg-white/20 rounded-full">
                    <Zap className="w-4 h-4 text-white" fill="currentColor" />
                  </div>
                  {toastMsg}
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Data Story Overlay ──────────────────────── */}
            {showDataStory && dataset && (
              <DataStoryView
                dataset={dataset}
                onClose={() => setShowDataStory(false)}
              />
            )}
          </div>
        )}
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;