import React from 'react';
import { Palette, X, CheckCircle2, Type, Eye, Grid, Hash } from 'lucide-react';
import { FormattingConfig } from '../types';

interface FormatPanelProps {
  formatting: FormattingConfig;
  onUpdateFormatting: (f: FormattingConfig) => void;
  onClose: () => void;
  chartType?: string;
}

// Size option maps
const DATA_LABEL_SIZES: Record<string, number> = { xs: 9, sm: 10, md: 11, lg: 13 };
const AXIS_LABEL_SIZES: Record<string, number> = { xs: 9, sm: 10, md: 12, lg: 14 };

// Reusable checkbox component
const FormatCheckbox: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}> = ({ checked, onChange, label }) => (
  <label className="flex items-center gap-3 cursor-pointer group">
    <div className="relative flex items-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-slate-300 dark:border-slate-600 shadow-sm checked:border-indigo-500 checked:bg-indigo-500 hover:border-indigo-400 transition-all"
      />
      <CheckCircle2
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white opacity-0 peer-checked:opacity-100 transition-opacity"
        strokeWidth={3}
      />
    </div>
    <span className="text-sm font-medium text-slate-700 dark:text-slate-300 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
      {label}
    </span>
  </label>
);

// Reusable toggle-button row
const SizeToggle: React.FC<{
  value: string | undefined;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
}> = ({ value, options, onChange }) => (
  <div className="flex bg-slate-100 dark:bg-slate-700/50 rounded-lg p-1 border border-slate-200 dark:border-slate-600">
    {options.map(opt => (
      <button
        key={opt.value}
        onClick={() => onChange(opt.value)}
        className={`flex-1 text-xs py-2 rounded-md font-bold transition-all ${
          value === opt.value
            ? 'bg-white dark:bg-slate-600 text-indigo-600 dark:text-indigo-300 shadow-sm'
            : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
        }`}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

// Color picker row
const ColorPickerRow: React.FC<{
  label: string;
  value: string | undefined;
  defaultValue: string;
  onChange: (color: string | undefined) => void;
}> = ({ label, value, defaultValue, onChange }) => (
  <div className="flex items-center gap-2">
    <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex-1">
      {label}
    </span>
    <input
      type="color"
      value={value || defaultValue}
      onChange={e => onChange(e.target.value)}
      className="w-7 h-7 rounded-lg border border-slate-200 dark:border-slate-600 cursor-pointer p-0.5 shadow-sm hover:shadow-md transition-shadow"
    />
    {value && (
      <button
        onClick={() => onChange(undefined)}
        className="text-[10px] text-slate-400 hover:text-indigo-500 transition-colors font-medium"
      >
        Reset
      </button>
    )}
  </div>
);

// Section header
const SectionHeader: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <div className="flex items-center gap-2 pt-3 pb-1">
    <div className="w-5 h-5 rounded bg-indigo-100 dark:bg-indigo-500/20 flex items-center justify-center">
      {icon}
    </div>
    <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{label}</span>
  </div>
);

export const FormatPanel: React.FC<FormatPanelProps> = ({
  formatting,
  onUpdateFormatting,
  onClose,
  chartType,
}) => {
  const update = (patch: Partial<FormattingConfig>) =>
    onUpdateFormatting({ ...formatting, ...patch });

  const isPieType = chartType === 'pie' || chartType === 'doughnut' || chartType === 'polarArea' || chartType === 'radar';
  const isMapType = chartType === 'map';

  return (
    <div className="absolute top-4 right-4 w-[300px] max-h-[calc(100%-2rem)] overflow-y-auto bg-white dark:bg-slate-800/95 backdrop-blur shadow-2xl border border-slate-200 dark:border-white/10 rounded-xl p-5 z-20 animate-in fade-in slide-in-from-right-4 ring-1 ring-black/5">
      {/* Header */}
      <div className="flex justify-between items-center mb-4 pb-3 border-b border-slate-100 dark:border-white/5">
        <h3 className="font-bold text-slate-800 dark:text-white flex items-center gap-2 text-sm">
          <Palette className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          Chart Appearance
        </h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-600 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 p-1 rounded-full transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-4">
        {/* ═══ SECTION: Color & Palette ══════════════════════ */}
        <div>
          <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2 block">
            Color Palette
          </label>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {(['vibrant', 'electric', 'neon', 'sunset', 'ocean'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => update({ colorMode: mode })}
                className={`h-8 rounded-lg border-2 transition-all ${
                  formatting.colorMode === mode
                    ? 'ring-2 ring-indigo-500 ring-offset-1 border-transparent scale-110 shadow-md'
                    : 'border-transparent hover:scale-105 hover:shadow-sm'
                }`}
                style={{
                  background:
                    mode === 'vibrant' ? '#3b82f6' :
                    mode === 'electric' ? '#6366f1' :
                    mode === 'neon' ? '#22c55e' :
                    mode === 'sunset' ? '#f97316' : '#0ea5e9',
                }}
                title={mode.charAt(0).toUpperCase() + mode.slice(1)}
              />
            ))}
          </div>
        </div>

        {/* ═══ SECTION: Numbers ══════════════════════════════ */}
        <SectionHeader icon={<Hash className="w-3 h-3 text-indigo-600 dark:text-indigo-400" />} label="Numbers" />

        <div>
          <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2 block">
            Number Format
          </label>
          <select
            value={formatting.numberFormat}
            onChange={e => update({ numberFormat: e.target.value as any })}
            className="w-full text-sm text-slate-900 dark:text-white bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg py-2.5 px-3 shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none font-medium appearance-none cursor-pointer hover:bg-white dark:hover:bg-slate-600 hover:border-indigo-300 transition-all"
          >
            <option value="auto">✨ Intelligent (Auto)</option>
            <option value="raw">Raw Number (1200)</option>
            <option value="currency_usd">Currency ($ USD)</option>
            <option value="currency_eur">Currency (€ EUR)</option>
            <option value="percent">Percentage (%)</option>
            <option value="compact">Compact (1k, 1M)</option>
          </select>
        </div>

        <div>
          <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2 block">
            Decimal Places
          </label>
          <div className="flex bg-slate-100 dark:bg-slate-700/50 rounded-lg p-1 border border-slate-200 dark:border-slate-600">
            {[
              { label: 'Auto', val: undefined },
              { label: '0', val: 0 },
              { label: '1', val: 1 },
              { label: '2', val: 2 },
            ].map(opt => (
              <button
                key={opt.label}
                onClick={() => update({ decimals: opt.val })}
                className={`flex-1 text-xs py-2 rounded-md font-bold transition-all ${
                  formatting.decimals === opt.val
                    ? 'bg-white dark:bg-slate-600 text-indigo-600 dark:text-indigo-300 shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Y-Axis Format — hidden for pie/map */}
        {!isPieType && !isMapType && (
          <div>
            <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2 block">
              Y-Axis Tick Format
            </label>
            <SizeToggle
              value={formatting.yAxisFormat || 'compact'}
              options={[
                { label: 'Compact', value: 'compact' },
                { label: 'Full', value: 'full' },
                { label: '$-Short', value: 'short_currency' },
              ]}
              onChange={v => update({ yAxisFormat: v as any })}
            />
          </div>
        )}

        {/* Date Format */}
        <div>
          <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2 block">
            Date Format
          </label>
          <select
            value={formatting.dateFormat || 'auto'}
            onChange={e => update({ dateFormat: e.target.value === 'auto' ? undefined : e.target.value as any })}
            className="w-full text-sm text-slate-900 dark:text-white bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg py-2.5 px-3 shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none font-medium appearance-none cursor-pointer hover:bg-white dark:hover:bg-slate-600 hover:border-indigo-300 transition-all"
          >
            <option value="auto">Auto (Smart)</option>
            <option value="raw">Raw (as-is)</option>
            <option value="yyyy-mm-dd">2024-01-15</option>
            <option value="mm/dd/yyyy">01/15/2024</option>
            <option value="month_name_year">January 2024</option>
            <option value="month_short_year">Jan '24</option>
            <option value="month_name_only">January</option>
          </select>
        </div>

        {/* ═══ SECTION: Typography ══════════════════════════ */}
        <SectionHeader icon={<Type className="w-3 h-3 text-indigo-600 dark:text-indigo-400" />} label="Typography" />

        {/* Chart Title */}
        <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 space-y-3 border border-slate-100 dark:border-slate-600/30">
          <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Chart Title</span>
          <div>
            <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2 block">Size</label>
            <SizeToggle
              value={formatting.headerSize || 'lg'}
              options={[
                { label: 'SM', value: 'sm' },
                { label: 'MD', value: 'md' },
                { label: 'LG', value: 'lg' },
                { label: 'XL', value: 'xl' },
              ]}
              onChange={v => update({ headerSize: v as any })}
            />
          </div>
          <FormatCheckbox
            checked={formatting.headerBold}
            onChange={v => update({ headerBold: v })}
            label="Bold"
          />
          <ColorPickerRow
            label="Color"
            value={formatting.headerColor}
            defaultValue="#1e293b"
            onChange={v => update({ headerColor: v })}
          />
        </div>

        {/* Data Labels */}
        <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 space-y-3 border border-slate-100 dark:border-slate-600/30">
          <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Data Labels</span>
          <div>
            <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2 block">Size</label>
            <SizeToggle
              value={formatting.dataLabelSize || 'md'}
              options={[
                { label: 'XS', value: 'xs' },
                { label: 'SM', value: 'sm' },
                { label: 'MD', value: 'md' },
                { label: 'LG', value: 'lg' },
              ]}
              onChange={v => update({ dataLabelSize: v as any })}
            />
          </div>
          <FormatCheckbox
            checked={formatting.dataLabelBold !== false}
            onChange={v => update({ dataLabelBold: v })}
            label="Bold"
          />
          <ColorPickerRow
            label="Color"
            value={formatting.dataLabelColor}
            defaultValue="#334155"
            onChange={v => update({ dataLabelColor: v })}
          />
        </div>

        {/* Axis Labels — hidden for pie/map */}
        {!isPieType && !isMapType && (
          <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 space-y-3 border border-slate-100 dark:border-slate-600/30">
            <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Axis Labels</span>
            <div>
              <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2 block">Size</label>
              <SizeToggle
                value={formatting.axisLabelSize || 'md'}
                options={[
                  { label: 'XS', value: 'xs' },
                  { label: 'SM', value: 'sm' },
                  { label: 'MD', value: 'md' },
                  { label: 'LG', value: 'lg' },
                ]}
                onChange={v => update({ axisLabelSize: v as any })}
              />
            </div>
            <FormatCheckbox
              checked={formatting.axisBold ?? false}
              onChange={v => update({ axisBold: v })}
              label="Bold"
            />
            <ColorPickerRow
              label="Color"
              value={formatting.axisColor}
              defaultValue="#475569"
              onChange={v => update({ axisColor: v })}
            />
          </div>
        )}

        {/* General Font Size (legacy — controls legend etc.) */}
        <div>
          <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2 block">
            General Font Size
          </label>
          <SizeToggle
            value={formatting.fontSize || 'md'}
            options={[
              { label: 'SM', value: 'sm' },
              { label: 'MD', value: 'md' },
              { label: 'LG', value: 'lg' },
            ]}
            onChange={v => update({ fontSize: v as any })}
          />
        </div>

        {/* ═══ SECTION: Display ═════════════════════════════ */}
        <SectionHeader icon={<Eye className="w-3 h-3 text-indigo-600 dark:text-indigo-400" />} label="Display" />

        <div className="flex flex-col gap-3">
          <FormatCheckbox
            checked={formatting.showLabels}
            onChange={v => update({ showLabels: v })}
            label="Show Legend"
          />
          <FormatCheckbox
            checked={formatting.showDataLabels}
            onChange={v => update({ showDataLabels: v })}
            label="Show Data Labels"
          />

          {/* Axis toggles — hidden for pie/map */}
          {!isPieType && !isMapType && (
            <>
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mr-1">Axes:</span>
                <button
                  onClick={() => update({ showXAxis: !formatting.showXAxis })}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all border ${
                    formatting.showXAxis
                      ? 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-500/30'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  X-Axis
                </button>
                <button
                  onClick={() => update({ showYAxis: !formatting.showYAxis })}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all border ${
                    formatting.showYAxis
                      ? 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-500/30'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  Y-Axis
                </button>
              </div>

              <FormatCheckbox
                checked={formatting.showGridLines ?? false}
                onChange={v => update({ showGridLines: v })}
                label="Show Grid Lines"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default FormatPanel;
