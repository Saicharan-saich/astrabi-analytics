import React from 'react';
import { Workbench } from './Workbench';
import { Dataset, AnalysisResult, FormattingConfig } from '../types';
import { ArrowLeft, Save, X } from 'lucide-react';

interface WorkbenchViewProps {
    dataset?: Dataset;
    initialConfig?: any;
    initialResult?: AnalysisResult;
    onAddResult: (result: AnalysisResult) => void;
    formatting?: FormattingConfig;
    onUpdateFormatting?: (config: FormattingConfig) => void;
    // Dashboard edit flow
    editingDashboardItemId?: string | null;
    onSaveBackToDashboard?: (result: AnalysisResult) => void;
    onCancelEdit?: () => void;
}

export const WorkbenchView: React.FC<WorkbenchViewProps> = ({
    dataset, initialConfig, initialResult, onAddResult,
    formatting, onUpdateFormatting,
    editingDashboardItemId, onSaveBackToDashboard, onCancelEdit
}) => {
    const isEditingDashboard = !!editingDashboardItemId;

    if (!dataset) {
        return (
            <div className="flex items-center justify-center h-full text-slate-400">
                <p>Please load a dataset first.</p>
            </div>
        );
    }

    return (
        <div className="h-full w-full flex flex-col">
            {/* Editing Dashboard Banner */}
            {isEditingDashboard && (
                <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border-b border-amber-500/20 shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                        <span className="text-amber-200 text-sm font-semibold">
                            Editing Dashboard Visual
                        </span>
                        <span className="text-amber-400/60 text-xs">
                            — Make changes and save back to your dashboard
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onCancelEdit}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
                        >
                            <X className="w-3.5 h-3.5" />
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Workbench */}
            <div className="flex-1 min-h-0">
                <Workbench
                    dataset={dataset}
                    initialConfig={initialConfig}
                    initialResult={initialResult}
                    onPin={(title, result) => {
                        if (isEditingDashboard && onSaveBackToDashboard) {
                            onSaveBackToDashboard({ ...result, insight: title });
                        } else {
                            onAddResult(result);
                        }
                    }}
                    formatting={formatting}
                    onUpdateFormatting={onUpdateFormatting}
                    pinLabel={isEditingDashboard ? 'Save to Dashboard' : undefined}
                />
            </div>
        </div>
    );
};
