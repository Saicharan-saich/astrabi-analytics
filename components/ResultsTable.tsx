import React from 'react';
import { applyMultipleCalculations, type TableCalculation, type CalculatedColumn } from '../utils/tableCalculations';

interface ResultsTableProps {
    data: any[];
    xKey: string;
    yKey: string;
    yLabel?: string;
    tableCalculations?: TableCalculation[];
    numberFormat?: string;
    movingAvgWindow?: number;
}

export const ResultsTable: React.FC<ResultsTableProps> = ({
    data,
    xKey,
    yKey,
    yLabel = '',
    tableCalculations = [],
    numberFormat = 'raw',
    movingAvgWindow = 3,
}) => {
    if (!data || data.length === 0) return null;

    const activeCalcs = tableCalculations.filter(c => c !== 'none');
    const { transformedData: tableRows, columns: calcColumns } = activeCalcs.length > 0
        ? applyMultipleCalculations(data, yKey, activeCalcs, yLabel, numberFormat, movingAvgWindow)
        : { transformedData: data, columns: [] as CalculatedColumn[] };

    // Check if comparison data exists
    const hasComparison = data.some((row: any) => row.growth_pct !== undefined);

    return (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden transition-shadow hover:shadow-md">
            {/* Header */}
            <div className="px-6 py-4 bg-gradient-to-r from-slate-50 to-white border-b border-slate-100">
                <div className="flex items-center gap-3">
                    <div className="w-1 h-5 rounded-full bg-indigo-500" />
                    <h4 className="text-sm font-semibold text-slate-800 tracking-tight">
                        Results Table
                    </h4>
                    {hasComparison && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-600 border border-blue-100">
                            vs Previous Period
                        </span>
                    )}
                    {calcColumns.length > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-600 border border-emerald-100">
                            + {calcColumns.length} calculation{calcColumns.length > 1 ? 's' : ''}
                        </span>
                    )}
                    <span className="ml-auto text-xs text-slate-400 font-medium">
                        {data.length} row{data.length !== 1 ? 's' : ''}
                    </span>
                </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
                <table className="min-w-full">
                    <thead>
                        <tr className="bg-slate-50/80">
                            <th className="px-5 py-3 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                                {xKey}
                            </th>
                            <th className="px-5 py-3 text-right text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                                {yKey}
                            </th>
                            {hasComparison && (
                                <>
                                    <th className="px-5 py-3 text-right text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-l border-slate-100">
                                        Previous
                                    </th>
                                    <th className="px-5 py-3 text-right text-[11px] font-bold text-blue-600 uppercase tracking-wider border-l border-blue-100 bg-blue-50/40">
                                        Growth %
                                    </th>
                                </>
                            )}
                            {calcColumns.map(col => (
                                <th key={col.key} className="px-5 py-3 text-right text-[11px] font-bold text-emerald-600 uppercase tracking-wider bg-emerald-50/40 border-l border-emerald-100">
                                    {col.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {tableRows.map((row: any, idx: number) => {
                            const growthPct = row.growth_pct !== undefined ? Number(row.growth_pct) : null;
                            const isPositive = growthPct !== null && growthPct >= 0;
                            const isNegative = growthPct !== null && growthPct < 0;

                            return (
                                <tr
                                    key={idx}
                                    className="group transition-colors hover:bg-indigo-50/30"
                                    style={{ animationDelay: `${idx * 20}ms` }}
                                >
                                    {/* Dimension */}
                                    <td className="px-5 py-3 text-sm text-slate-800 font-medium">
                                        {row[xKey]}
                                    </td>

                                    {/* Metric Value */}
                                    <td className="px-5 py-3 text-sm text-slate-900 font-semibold text-right tabular-nums">
                                        {typeof row[yKey] === 'number'
                                            ? row[yKey].toLocaleString(undefined, { maximumFractionDigits: 2 })
                                            : row[yKey]
                                        }
                                    </td>

                                    {/* Comparison Columns */}
                                    {hasComparison && (
                                        <>
                                            <td className="px-5 py-3 text-sm text-slate-500 text-right border-l border-slate-50 tabular-nums">
                                                {row.previous_value !== undefined
                                                    ? Number(row.previous_value).toLocaleString(undefined, { maximumFractionDigits: 2 })
                                                    : '—'
                                                }
                                            </td>
                                            <td className={`px-5 py-3 text-sm font-bold text-right border-l tabular-nums ${isPositive ? 'border-green-50 bg-green-50/30' :
                                                isNegative ? 'border-red-50 bg-red-50/30' :
                                                    'border-slate-50'
                                                }`}>
                                                {growthPct !== null ? (
                                                    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold transition-transform group-hover:scale-105 ${isPositive
                                                        ? 'bg-emerald-100 text-emerald-700 shadow-sm shadow-emerald-100'
                                                        : 'bg-red-100 text-red-700 shadow-sm shadow-red-100'
                                                        }`}>
                                                        <span className="text-[10px]">{isPositive ? '▲' : '▼'}</span>
                                                        {isPositive ? '+' : ''}{growthPct.toFixed(1)}%
                                                    </span>
                                                ) : (
                                                    <span className="text-slate-300">—</span>
                                                )}
                                            </td>
                                        </>
                                    )}

                                    {/* Calculation Columns */}
                                    {calcColumns.map(col => {
                                        const val = Number(row[col.key]) || 0;
                                        const isNeg = val < 0;
                                        const colorClass = isNeg ? 'text-red-600' : 'text-emerald-700';
                                        let formatted: string;
                                        if (col.format === 'percent') {
                                            formatted = val.toFixed(2) + '%';
                                        } else {
                                            formatted = val.toLocaleString(undefined, { maximumFractionDigits: 2 });
                                        }
                                        return (
                                            <td key={col.key} className={`px-5 py-3 text-sm font-bold text-right tabular-nums border-l border-emerald-50 bg-emerald-50/10 ${colorClass}`}>
                                                {formatted}
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
};
