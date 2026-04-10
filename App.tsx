import React, { useState, useEffect } from 'react';
import { Upload, Database, Settings, Play, Layout, Plus, Search, FileText, BarChart2, Shield, Menu, LogOut, Users, Brain } from 'lucide-react';
import {
  Dataset,
  AnalysisResult,
  Tab,
  ColumnType,
  UserRole
} from './types';
import { runAnalysis, runAutomatedETL, parseCSV, parseExcel, autoJoinDatasets, getSampleData } from './services/analysisEngine';
import { profileDatasetWithAI } from './services/aiSemanticProfiler';
import { Sidebar } from './components/Sidebar';
import { UploadView } from './components/UploadView';
import { ETLView } from './components/ETLView';
import { DataExplorerView } from './components/DataExplorerView';
import { WorkbenchView } from './components/WorkbenchView';
import { BuilderView } from './components/BuilderView';
import { NLQView } from './components/NLQView';
import { AISQLView } from './components/AISQLView';
import { Dashboard } from './components/Dashboard';
import { SchemaView } from './components/SchemaView';
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
import { DomainReviewModal } from './components/DomainReviewModal';

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

function App() {
  // Global State
  const {
    activeTab,
    setActiveTab,
    isSidebarOpen,
    toggleSidebar,
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
  const [showUserMgmt, setShowUserMgmt] = useState(false);
  const [isAIProfiling, setIsAIProfiling] = useState(false);
  const [showDomainReview, setShowDomainReview] = useState(false);
  const [pendingProfile, setPendingProfile] = useState<any>(null);

  // Hydrate datasets from IndexedDB on mount
  useEffect(() => {
    loadAllDatasetsFromDB().then(saved => {
      if (saved.length > 0) {
        const store = useAppStore.getState();
        // Only hydrate if store has no datasets loaded yet
        if (store.datasets.length === 0) {
          saved.forEach(ds => store.setDataset(ds));
          // Set the last dataset as active if none active
          if (!store.dataset) {
            store.setDataset(saved[saved.length - 1]);
          }
        }
      }
    });
  }, []);

  const handleDeleteDataset = (id: string) => {
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
        const { rows, logs, columns, timeContext, sourceSchema, dimDate, rawRows } = result;
        const newDataset: Dataset = {
          id: generateId(),
          name: file.name,
          rows,
          rawRows,
          columns,
          totalRows: rows.length,
          etlLogs: logs,
          timeContext,
          dimDate,
          sourceSchema
        };

        setDataset(newDataset);
        saveDatasetToDB(newDataset);
        setActiveTab(Tab.ETL);
        setProcessing(false);
        worker.terminate();

        // ── AI SEMANTIC PROFILING (async, non-blocking) ──
        setIsAIProfiling(true);
        profileDatasetWithAI(rows, columns, file.name).then(profile => {
          setIsAIProfiling(false);
          if (profile) {
            const profiled: Dataset = { ...newDataset, domainProfile: profile };
            setDataset(profiled);
            saveDatasetToDB(profiled);
            setPendingProfile(profile);
            setShowDomainReview(true);
            console.log(`[App] AI Profile: ${profile.domain} (${(profile.confidence * 100).toFixed(0)}% confidence)`);
          }
        }).catch(err => {
          setIsAIProfiling(false);
          console.warn('[App] AI profiling failed (graceful fallback):', err);
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
          dimDate
        };
        setDataset(sampleDs);
        saveDatasetToDB(sampleDs);
        setActiveTab(Tab.ETL);
        setProcessing(false);
        worker.terminate();
      }
    };

    worker.postMessage({ type: 'PROCESS_FILE', rawData: csvContent, fileName: 'sample_sales_data.csv' });
  };

  const handleConnectorData = (rawData: any, name: string, sourceSchema?: any) => {
    setProcessing(true);
    const worker = new Worker(new URL('./workers/etl.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event) => {
      if (event.data.type === 'SUCCESS') {
        const { rows, logs, columns, timeContext, sourceSchema: resultSchema, dimDate, rawRows } = event.data.result;
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
          sourceSchema: resultSchema
        };
        setDataset(connDs);
        saveDatasetToDB(connDs);
        setActiveTab(Tab.ETL);
        setProcessing(false);
        worker.terminate();
      }
    };

    worker.postMessage({ type: 'PROCESS_FILE', rawData, fileName: name, isConnector: true, sourceSchema });
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
      width: 'half' as 'half' | 'full'
    };
    addItem(newItem);
    showToast("Pinned to Dashboard!");
  };

  const handleEditAnalysis = (item: any) => {
    setWorkbenchConfig(item.result.config);
    setWorkbenchResult(item.result);
    setEditingDashboardItemId(item.id);
    setActiveTab(Tab.WORKBENCH);
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
      <ThemeProvider theme={theme} toggleTheme={toggleTheme} setTheme={setTheme}>

        {/* Auth Gate: Show login if not authenticated */}
        {!isAuthenticated ? (
          <LoginPage />
        ) : (
          <div className={getGlobalClasses()} style={getGlobalStyle()}>
            <AnimatePresence>
              {isSidebarOpen && (
                <motion.div
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 260, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  className={`h-full border-r z-20 overflow-hidden flex-shrink-0 relative ${theme === 'dark' ? 'bg-[#111422] border-white/[0.06]' : 'bg-white border-gray-200'
                    }`}
                >
                  <Sidebar
                    activeTab={activeTab}
                    onTabChange={setActiveTab}
                    onToggle={() => toggleSidebar()}
                    onOpenUserManagement={() => setShowUserMgmt(true)}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
              {/* Header */}
              <header className={`h-14 flex items-center justify-between px-5 z-30 relative border-b ${theme === 'dark' ? 'bg-[#141825] border-white/[0.06]' : 'bg-white border-gray-200 shadow-sm'
                }`}>
                <div className="flex items-center gap-3">
                  {!isSidebarOpen && (
                    <button
                      onClick={() => toggleSidebar()}
                      className={`p-2 -ml-2 rounded-lg transition-all duration-200 ${theme === 'dark' ? 'text-gray-400 hover:text-white hover:bg-white/[0.06]' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
                        }`}
                    >
                      <Menu className="w-5 h-5" />
                    </button>
                  )}

                  <div className={`flex items-center gap-2.5 rounded-lg py-1.5 px-3 border ${theme === 'dark' ? 'bg-white/[0.04] border-white/[0.06]' : 'bg-gray-50 border-gray-200'
                    }`}>
                    <div className={`
                      w-2 h-2 rounded-full transition-all duration-500
                      ${isProcessing ? 'bg-amber-400 animate-pulse' :
                        dataset ? 'bg-emerald-500' : 'bg-gray-400'}
                    `} />
                    <span className={`text-sm font-medium tracking-tight ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                      }`}>
                      {dataset ? dataset.name : 'No active dataset'}
                    </span>
                    {dataset && (
                      <span className={`text-[11px] font-medium ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'
                        }`}>
                        {dataset.totalRows?.toLocaleString()} rows
                      </span>
                    )}
                    {isAIProfiling && (
                      <span className="text-[11px] font-medium text-violet-400 flex items-center gap-1 animate-pulse">
                        <Brain className="w-3 h-3" /> Profiling...
                      </span>
                    )}
                    {dataset?.domainProfile && !isAIProfiling && (
                      <span className="text-[11px] font-semibold text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded-full">
                        {dataset.domainProfile.domain}
                      </span>
                    )}
                  </div>

                  <DatasetSwitcher
                    datasets={datasets}
                    activeDataset={dataset}
                    onSwitch={setActiveDatasetById}
                    onRemove={removeDataset}
                    onAddNew={() => setActiveTab(Tab.UPLOAD)}
                  />
                </div>

                <div className="flex items-center gap-1.5">
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
                    className={`p-2 rounded-lg transition-all duration-200 ${theme === 'dark' ? 'text-gray-400 hover:text-violet-400 hover:bg-violet-500/10' : 'text-gray-500 hover:text-violet-600 hover:bg-violet-50'
                      }`}
                    title="Settings"
                  >
                    <Settings className="w-5 h-5" />
                  </button>

                  {currentUser && (
                    <div className={`flex items-center gap-2 ml-1 pl-3 border-l ${theme === 'dark' ? 'border-white/[0.08]' : 'border-gray-200'
                      }`}>
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs shadow-sm cursor-default"
                        style={{ backgroundColor: currentUser.avatar || '#7c3aed' }}
                        title={`${currentUser.name} (${currentUser.role})`}
                      >
                        {currentUser.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                      </div>
                      <button
                        onClick={logout}
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
              <main className={`flex-1 overflow-hidden relative ${theme === 'dark' ? 'bg-[#0c0f1a]' : 'bg-[#f5f6fa]'
                }`}>

                {/* All tabs stay mounted for state persistence — only the active one is visible */}
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
                  <ETLView
                    dataset={dataset}
                    onSchemaOverride={handleSchemaOverride}
                    onRowsRecovered={(recoveredRows) => {
                      if (!dataset) return;
                      const updatedRows = [...dataset.rows, ...recoveredRows];
                      const updated: Dataset = {
                        ...dataset,
                        rows: updatedRows,
                        totalRows: updatedRows.length,
                      };
                      setDataset(updated);
                      saveDatasetToDB(updated);
                      console.log(`[App] Recovered ${recoveredRows.length} rows. New total: ${updatedRows.length}`);
                    }}
                  />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.SCHEMA ? '' : 'hidden'}`}>
                  <SchemaView dataset={dataset} />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.DATA ? '' : 'hidden'}`}>
                  <DataExplorerView dataset={dataset} />
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
                  />
                </div>

                <div className={`h-full w-full overflow-hidden ${activeTab === Tab.BUILDER ? '' : 'hidden'}`}>
                  {dataset && (
                    <BuilderView
                      dataset={dataset}
                      onPin={(title, result) => handlePin({ ...result, insight: title })}
                      formatting={formatting}
                      onUpdateFormatting={updateFormatting}
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
                  />
                </div>

                <div className={`h-full w-full ${activeTab === Tab.CUSTOM_QUESTIONS ? '' : 'hidden'}`}>
                  <AdminQuestionBuilder dataset={dataset} />
                </div>
              </main>
            </div>

            {/* Global Settings Modal */}
            <AnimatePresence>
              {showAbout && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
                  <motion.div
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    className={`w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border ${theme === 'dark' ? 'bg-[#1c2033] border-white/10' : 'bg-white border-gray-200'
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
                            Astrabi Analytics v3.0.1 · Production Build
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

            {/* Domain Review Modal */}
            {showDomainReview && pendingProfile && (
              <DomainReviewModal
                profile={pendingProfile}
                isOpen={showDomainReview}
                onAccept={() => {
                  setShowDomainReview(false);
                  setPendingProfile(null);
                  showToast(`Domain detected: ${pendingProfile.domain}`);
                }}
                onDismiss={() => {
                  // Dismiss = remove the profile from dataset
                  if (dataset) {
                    const { domainProfile, ...rest } = dataset as any;
                    const stripped: Dataset = { ...rest };
                    setDataset(stripped);
                    saveDatasetToDB(stripped);
                  }
                  setShowDomainReview(false);
                  setPendingProfile(null);
                }}
              />
            )}

            {/* Onboarding Tour */}
            <OnboardingTour />

            {/* Toast Notifications */}
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
          </div>
        )}
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;