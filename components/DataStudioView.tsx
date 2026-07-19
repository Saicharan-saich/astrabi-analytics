import React from 'react';
import { Wand2, Database } from 'lucide-react';
import { Dataset } from '../types';
import { DataCleaningPanel } from './DataCleaningPanel';
import { CleaningLogEntry } from '../services/dataCleaningEngine';

interface DataStudioViewProps {
  dataset: Dataset | null;
  onDataCleaned?: (newRows: Record<string, any>[], log: CleaningLogEntry) => void;
}

/**
 * DataStudioView — the interactive Data Cleaning Studio, split out of the ETL
 * page into its own tab. Same functionality, its own home. The ETL page now
 * shows only the automatic pipeline steps; hands-on cleaning lives here.
 */
export const DataStudioView: React.FC<DataStudioViewProps> = ({ dataset, onDataCleaned }) => {
  if (!dataset) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400">
        <div className="text-center">
          <Database className="w-12 h-12 mx-auto mb-3 opacity-40" />
          <p className="text-lg font-medium">No dataset loaded</p>
          <p className="text-sm mt-1">Upload a file or connect to a database to use the Data Studio.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto bg-slate-50 dark:bg-slate-900">
      <div className="max-w-7xl mx-auto p-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl shadow-lg shadow-indigo-200 dark:shadow-none">
            <Wand2 className="w-6 h-6 text-white" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Data Studio</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Hands-on cleaning tools for <span className="font-mono font-semibold text-indigo-600 dark:text-indigo-400">{dataset.name}</span> — fix, transform, and refine your data
            </p>
          </div>
        </div>

        <DataCleaningPanel
          dataset={dataset}
          onDataCleaned={(newRows, log) => { if (onDataCleaned) onDataCleaned(newRows, log); }}
        />
      </div>
    </div>
  );
};
