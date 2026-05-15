import React, { useState } from 'react';
import { AlertTriangle, AlertCircle, Info, ChevronRight, ChevronLeft, Check, X, TrendingUp, Filter, Clock, Zap } from 'lucide-react';
import { AlertRule, AlertSeverity, AlertTimeRange, AlertCondition, Dataset, ColumnType } from '../types';
import { useTheme } from './ThemeProvider';

interface Props {
  dataset: Dataset;
  editingRule?: AlertRule | null;
  onSave: (rule: AlertRule) => void;
  onCancel: () => void;
}

const AGG_OPTIONS = [
  { label: 'Total (Σ)', value: 'SUM' },
  { label: 'Average (μ)', value: 'AVG' },
  { label: 'Count (#)', value: 'COUNT' },
  { label: 'Unique Count (∩)', value: 'COUNT_DISTINCT' },
  { label: 'Highest (↑)', value: 'MAX' },
  { label: 'Lowest (↓)', value: 'MIN' },
];

const TIME_OPTIONS: { label: string; value: AlertTimeRange }[] = [
  { label: 'Today', value: { type: 'today' } },
  { label: 'Yesterday', value: { type: 'yesterday' } },
  { label: 'Last 7 Days', value: { type: 'last_n_days', value: 7 } },
  { label: 'Last 30 Days', value: { type: 'last_n_days', value: 30 } },
  { label: 'This Month', value: { type: 'this_month' } },
  { label: 'This Quarter', value: { type: 'this_quarter' } },
  { label: 'This Year', value: { type: 'this_year' } },
  { label: 'All Time', value: { type: 'all_time' } },
];

const OPERATORS = [
  { label: 'is greater than (>)', value: '>' },
  { label: 'is less than (<)', value: '<' },
  { label: 'is at least (≥)', value: '>=' },
  { label: 'is at most (≤)', value: '<=' },
  { label: 'equals (=)', value: '==' },
  { label: 'is not equal (≠)', value: '!=' },
];

export const AlertRuleWizard: React.FC<Props> = ({ dataset, editingRule, onSave, onCancel }) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [step, setStep] = useState(0);

  const metrics = dataset.columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
  const dims = dataset.columns.filter(c => c.type === ColumnType.DIMENSION || c.type === ColumnType.ID).map(c => c.name);
  const allMetricOptions = [...metrics, ...dims.map(d => d)];

  const [metric, setMetric] = useState(editingRule?.metric || metrics[0] || '');
  const [aggregation, setAggregation] = useState<'SUM'|'AVG'|'COUNT'|'COUNT_DISTINCT'|'MIN'|'MAX'>(editingRule?.aggregation || 'SUM');
  const [filters, setFilters] = useState<{ column: string; operator: string; value: string }[]>(editingRule?.filters || []);
  const [timeRange, setTimeRange] = useState<AlertTimeRange>(editingRule?.timeRange || { type: 'all_time' });
  const [conditionType, setConditionType] = useState<'threshold' | 'trend'>(editingRule?.condition.type || 'threshold');
  const [operator, setOperator] = useState((editingRule?.condition.type === 'threshold' ? editingRule.condition.operator : '>') as string);
  const [thresholdValue, setThresholdValue] = useState(editingRule?.condition.type === 'threshold' ? editingRule.condition.value : 0);
  const [trendDirection, setTrendDirection] = useState<'increases' | 'decreases'>(editingRule?.condition.type === 'trend' ? editingRule.condition.direction : 'increases');
  const [trendPercent, setTrendPercent] = useState(editingRule?.condition.type === 'trend' ? editingRule.condition.changePercent : 10);
  const [trendPeriod, setTrendPeriod] = useState<'previous_day'|'previous_week'|'previous_month'|'previous_quarter'>(editingRule?.condition.type === 'trend' ? editingRule.condition.comparisonPeriod : 'previous_month');
  const [severity, setSeverity] = useState<AlertSeverity>(editingRule?.severity || 'warning');
  const [name, setName] = useState(editingRule?.name || '');

  const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  const timeLabel = TIME_OPTIONS.find(t => JSON.stringify(t.value) === JSON.stringify(timeRange))?.label || 'All Time';

  const getColumnValues = (col: string) => {
    const vals = new Set<string>();
    const rows = dataset.rows.slice(0, 5000);
    const key = Object.keys(rows[0] || {}).find(k => k.toLowerCase() === col.toLowerCase()) || col;
    rows.forEach(r => { const v = r[key]; if (v != null && v !== '') vals.add(String(v)); });
    return Array.from(vals).sort().slice(0, 50);
  };

  const handleSave = () => {
    const condition: AlertCondition = conditionType === 'threshold'
      ? { type: 'threshold', operator: operator as any, value: thresholdValue }
      : { type: 'trend', direction: trendDirection, changePercent: trendPercent, comparisonPeriod: trendPeriod as any };

    const rule: AlertRule = {
      id: editingRule?.id || `alert_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: name || `${titleCase(metric)} Alert`,
      severity,
      status: editingRule?.status || 'active',
      datasetId: dataset.id,
      datasetName: dataset.name,
      metric,
      aggregation: aggregation as any,
      filters: filters.length > 0 ? filters : undefined,
      timeRange,
      condition,
      createdAt: editingRule?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    onSave(rule);
  };

  const canNext = () => {
    if (step === 0) return !!metric;
    if (step === 3) return conditionType === 'threshold' ? thresholdValue !== undefined : trendPercent > 0;
    return true;
  };

  const STEPS = ['Metric', 'Filters', 'Time Window', 'Condition', 'Name & Save'];

  const cardCls = `rounded-2xl border p-5 ${isDark ? 'bg-[#1a1f2e] border-white/[0.06]' : 'bg-white border-gray-200'}`;
  const labelCls = `text-[10px] font-semibold uppercase tracking-wider mb-2 block ${isDark ? 'text-gray-500' : 'text-gray-400'}`;
  const selectCls = `w-full rounded-xl px-3 py-2.5 text-sm border focus:outline-none focus:ring-2 focus:ring-violet-500/40 transition-all ${isDark ? 'bg-white/[0.05] border-white/[0.08] text-white' : 'bg-gray-50 border-gray-200 text-gray-900'}`;
  const btnPrimary = 'px-5 py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white shadow-lg shadow-violet-500/20 transition-all disabled:opacity-40';
  const btnSecondary = `px-4 py-2.5 rounded-xl text-sm font-medium border transition-all ${isDark ? 'bg-white/[0.05] border-white/[0.08] text-gray-300 hover:bg-white/[0.08]' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'}`;

  return (
    <div className={`${cardCls} max-w-2xl mx-auto`}>
      {/* Progress */}
      <div className="flex items-center gap-2 mb-6">
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <button onClick={() => i < step && setStep(i)} className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-all ${
              i === step ? isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-50 text-violet-700'
              : i < step ? isDark ? 'text-emerald-400' : 'text-emerald-600'
              : isDark ? 'text-gray-600' : 'text-gray-400'
            }`}>
              {i < step ? <Check className="w-3.5 h-3.5" /> : <span className="w-4 h-4 rounded-full border flex items-center justify-center text-[10px]">{i + 1}</span>}
              <span className="hidden sm:inline">{s}</span>
            </button>
            {i < STEPS.length - 1 && <ChevronRight className={`w-3 h-3 ${isDark ? 'text-gray-700' : 'text-gray-300'}`} />}
          </React.Fragment>
        ))}
      </div>

      {/* Step 0: Metric */}
      {step === 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="w-5 h-5 text-violet-400" />
            <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>What do you want to monitor?</h3>
          </div>
          <div>
            <label className={labelCls}>Metric</label>
            <select value={metric} onChange={e => setMetric(e.target.value)} className={selectCls}>
              <optgroup label="Measures">{metrics.map(m => <option key={m} value={m}>{titleCase(m)}</option>)}</optgroup>
              <optgroup label="Countable">{dims.map(d => <option key={d} value={d}>{titleCase(d)}</option>)}</optgroup>
            </select>
          </div>
          <div>
            <label className={labelCls}>Aggregation</label>
            <div className="grid grid-cols-3 gap-2">
              {AGG_OPTIONS.map(a => (
                <button key={a.value} onClick={() => setAggregation(a.value as typeof aggregation)}
                  className={`px-3 py-2 rounded-xl text-xs font-semibold border transition-all ${aggregation === a.value
                    ? isDark ? 'bg-violet-500/15 border-violet-500/30 text-violet-300' : 'bg-violet-50 border-violet-200 text-violet-700'
                    : isDark ? 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:bg-white/[0.06]' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
                  }`}>{a.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Step 1: Filters */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-1">
            <Filter className="w-5 h-5 text-blue-400" />
            <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Narrow the scope (optional)</h3>
          </div>
          {filters.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <select value={f.column} onChange={e => { const nf = [...filters]; nf[i] = { ...f, column: e.target.value }; setFilters(nf); }} className={`${selectCls} flex-1`}>
                {dims.map(d => <option key={d} value={d}>{titleCase(d)}</option>)}
              </select>
              <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>=</span>
              <select value={f.value} onChange={e => { const nf = [...filters]; nf[i] = { ...f, value: e.target.value }; setFilters(nf); }} className={`${selectCls} flex-1`}>
                <option value="">Any</option>
                {getColumnValues(f.column).map(v => <option key={v} value={v}>{v}</option>)}
              </select>
              <button onClick={() => setFilters(filters.filter((_, idx) => idx !== i))} className="p-1.5 text-gray-500 hover:text-red-400"><X className="w-4 h-4" /></button>
            </div>
          ))}
          <button onClick={() => setFilters([...filters, { column: dims[0] || '', operator: '=', value: '' }])}
            className={`text-xs font-semibold px-3 py-2 rounded-xl border transition-all ${isDark ? 'border-white/[0.08] text-violet-400 hover:bg-violet-500/10' : 'border-gray-200 text-violet-600 hover:bg-violet-50'}`}>
            + Add filter
          </button>
          {filters.length === 0 && <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>No filters — alert will monitor the entire dataset.</p>}
        </div>
      )}

      {/* Step 2: Time */}
      {step === 2 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-5 h-5 text-cyan-400" />
            <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Time window</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {TIME_OPTIONS.map(t => (
              <button key={t.label} onClick={() => setTimeRange(t.value)}
                className={`px-3 py-2.5 rounded-xl text-xs font-semibold border transition-all ${JSON.stringify(timeRange) === JSON.stringify(t.value)
                  ? isDark ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-300' : 'bg-cyan-50 border-cyan-200 text-cyan-700'
                  : isDark ? 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:bg-white/[0.06]' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
                }`}>{t.label}</button>
            ))}
          </div>
        </div>
      )}

      {/* Step 3: Condition */}
      {step === 3 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-1">
            <Zap className="w-5 h-5 text-amber-400" />
            <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>When should this alert trigger?</h3>
          </div>
          <div className="flex gap-2 mb-3">
            {(['threshold', 'trend'] as const).map(ct => (
              <button key={ct} onClick={() => setConditionType(ct)}
                className={`flex-1 px-4 py-3 rounded-xl text-sm font-semibold border transition-all ${conditionType === ct
                  ? isDark ? 'bg-amber-500/15 border-amber-500/30 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-700'
                  : isDark ? 'bg-white/[0.03] border-white/[0.06] text-gray-400' : 'bg-gray-50 border-gray-200 text-gray-600'
                }`}>
                {ct === 'threshold' ? '📊 Threshold' : '📈 Trend Change'}
              </button>
            ))}
          </div>
          {conditionType === 'threshold' ? (
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Operator</label>
                <select value={operator} onChange={e => setOperator(e.target.value)} className={selectCls}>
                  {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Value</label>
                <input type="number" value={thresholdValue} onChange={e => setThresholdValue(Number(e.target.value))}
                  className={selectCls} placeholder="Enter threshold value" />
              </div>
              <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                Alert when {titleCase(aggregation)} of {titleCase(metric)} {OPERATORS.find(o => o.value === operator)?.label.split('(')[0]} {thresholdValue.toLocaleString()}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Direction</label>
                <div className="flex gap-2">
                  {(['increases', 'decreases'] as const).map(d => (
                    <button key={d} onClick={() => setTrendDirection(d)}
                      className={`flex-1 px-3 py-2 rounded-xl text-xs font-semibold border transition-all ${trendDirection === d
                        ? isDark ? 'bg-violet-500/15 border-violet-500/30 text-violet-300' : 'bg-violet-50 border-violet-200 text-violet-700'
                        : isDark ? 'bg-white/[0.03] border-white/[0.06] text-gray-400' : 'bg-gray-50 border-gray-200 text-gray-600'
                      }`}>{d === 'increases' ? '📈 Increases' : '📉 Decreases'} by</button>
                  ))}
                </div>
              </div>
              <div>
                <label className={labelCls}>Change % (at least)</label>
                <input type="number" value={trendPercent} onChange={e => setTrendPercent(Number(e.target.value))}
                  className={selectCls} min={1} placeholder="e.g. 10" />
              </div>
              <div>
                <label className={labelCls}>Compared to</label>
                <select value={trendPeriod} onChange={e => setTrendPeriod(e.target.value as typeof trendPeriod)} className={selectCls}>
                  <option value="previous_day">Previous Day</option>
                  <option value="previous_week">Previous Week</option>
                  <option value="previous_month">Previous Month</option>
                  <option value="previous_quarter">Previous Quarter</option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 4: Name & Severity */}
      {step === 4 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle className="w-5 h-5 text-emerald-400" />
            <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Name & severity</h3>
          </div>
          <div>
            <label className={labelCls}>Rule Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className={selectCls}
              placeholder={`e.g. ${titleCase(metric)} ${conditionType === 'threshold' ? 'threshold' : 'trend'} alert`} />
          </div>
          <div>
            <label className={labelCls}>Severity</label>
            <div className="flex gap-2">
              {([
                { value: 'critical' as const, label: 'Critical', icon: <AlertTriangle className="w-3.5 h-3.5" />, color: 'red' },
                { value: 'warning' as const, label: 'Warning', icon: <AlertCircle className="w-3.5 h-3.5" />, color: 'amber' },
                { value: 'info' as const, label: 'Info', icon: <Info className="w-3.5 h-3.5" />, color: 'blue' },
              ]).map(s => (
                <button key={s.value} onClick={() => setSeverity(s.value)}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold border transition-all ${severity === s.value
                    ? `bg-${s.color}-500/15 border-${s.color}-500/30 text-${s.color}-${isDark ? '300' : '700'}`
                    : isDark ? 'bg-white/[0.03] border-white/[0.06] text-gray-400' : 'bg-gray-50 border-gray-200 text-gray-600'
                  }`}>
                  {s.icon} {s.label}
                </button>
              ))}
            </div>
          </div>
          {/* Summary */}
          <div className={`rounded-xl p-4 border ${isDark ? 'bg-white/[0.02] border-white/[0.06]' : 'bg-gray-50 border-gray-200'}`}>
            <p className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              Monitor <strong className={isDark ? 'text-white' : 'text-gray-900'}>{titleCase(aggregation)} of {titleCase(metric)}</strong>
              {' '}during <strong className={isDark ? 'text-white' : 'text-gray-900'}>{timeLabel}</strong>
              {conditionType === 'threshold'
                ? <> — alert when value {operator} <strong className={isDark ? 'text-white' : 'text-gray-900'}>{thresholdValue.toLocaleString()}</strong></>
                : <> — alert when value {trendDirection} by <strong className={isDark ? 'text-white' : 'text-gray-900'}>{trendPercent}%+</strong></>
              }
            </p>
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between mt-6 pt-4 border-t" style={{ borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)' }}>
        <button onClick={step === 0 ? onCancel : () => setStep(step - 1)} className={btnSecondary}>
          {step === 0 ? 'Cancel' : <><ChevronLeft className="w-4 h-4 inline mr-1" />Back</>}
        </button>
        {step < 4 ? (
          <button onClick={() => setStep(step + 1)} disabled={!canNext()} className={btnPrimary}>
            Next <ChevronRight className="w-4 h-4 inline ml-1" />
          </button>
        ) : (
          <button onClick={handleSave} className={btnPrimary}>
            <Check className="w-4 h-4 inline mr-1" />{editingRule ? 'Update Rule' : 'Create Rule'}
          </button>
        )}
      </div>
    </div>
  );
};
