import React from 'react';
import { Palette, X, RotateCcw } from 'lucide-react';
import { FormattingConfig } from '../types';
import { PALETTES } from '../utils/chartUtils';
import { useAppStore } from '../store/useAppStore';

interface FormatPanelProps {
  formatting: FormattingConfig;
  onUpdateFormatting: (f: FormattingConfig) => void;
  onClose: () => void;
  chartType?: string;
  /** Render as a normal flex child instead of the Question Builder overlay. */
  embedded?: boolean;
}

type Option<T extends string> = { label: string; value: T; title?: string };

/** A row of mutually exclusive choices. */
function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="qi-style-segmented" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={value === option.value}
          className={value === option.value ? 'is-active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** An on/off switch with its label. */
const Switch: React.FC<{ label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }> = ({ label, checked, onChange, hint }) => (
  <label className="qi-style-switch">
    <span className="min-w-0">
      <span className="qi-style-label">{label}</span>
      {hint && <span className="qi-style-hint block">{hint}</span>}
    </span>
    <input type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} />
    <span className="qi-style-switch-track" aria-hidden><span /></span>
  </label>
);

/** Automatic colour, or one the user picked. */
const ColourChoice: React.FC<{ label: string; value?: string; fallback: string; onChange: (colour: string | undefined) => void }> = ({ label, value, fallback, onChange }) => (
  <div className="qi-style-row">
    <span className="qi-style-label">{label}</span>
    <div className="flex items-center gap-1.5">
      <button type="button" className={`qi-style-chip ${value ? '' : 'is-active'}`} aria-pressed={!value} onClick={() => onChange(undefined)}>Auto</button>
      <label className={`qi-style-colour ${value ? 'is-active' : ''}`} title={`Pick a ${label.toLowerCase()}`}>
        <input type="color" value={value || fallback} onChange={event => onChange(event.target.value)} aria-label={`${label} picker`} />
        <span style={{ background: value || fallback }} />
      </label>
    </div>
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="qi-style-section" aria-label={title}>
    <h4 className="qi-style-section-title">{title}</h4>
    <div className="space-y-3">{children}</div>
  </section>
);

const Field: React.FC<{ label: string; htmlFor?: string; children: React.ReactNode }> = ({ label, htmlFor, children }) => (
  <div className="space-y-1.5">
    <label className="qi-style-label block" htmlFor={htmlFor}>{label}</label>
    {children}
  </div>
);

const SIZE_OPTIONS: Option<'xs' | 'sm' | 'md' | 'lg'>[] = [
  { label: 'XS', value: 'xs', title: 'Extra small' },
  { label: 'S', value: 'sm', title: 'Small' },
  { label: 'M', value: 'md', title: 'Medium' },
  { label: 'L', value: 'lg', title: 'Large' },
];

const PALETTE_NAMES: Record<string, string> = { vibrant: 'Clean (default)', electric: 'Electric', neon: 'Neon', sunset: 'Sunset', ocean: 'Ocean' };

/** Style settings that Reset puts back; data choices (calculations, goals) are kept. */
const STYLE_RESET: Partial<FormattingConfig> = {
  colorEncoding: 'auto', colorMode: 'vibrant', numberFormat: 'auto', decimals: undefined, yAxisFormat: undefined,
  dateFormat: undefined, dataLabelSize: undefined, dataLabelBold: undefined, dataLabelColor: undefined,
  axisLabelSize: undefined, axisBold: undefined, axisColor: undefined, showGridLines: undefined,
  showAxisTitles: undefined, fontSize: 'md',
};

export const FormatPanel: React.FC<FormatPanelProps> = ({
  formatting,
  onUpdateFormatting,
  onClose,
  chartType,
  embedded = false,
}) => {
  const update = (patch: Partial<FormattingConfig>) => onUpdateFormatting({ ...formatting, ...patch });
  const isArc = chartType === 'pie' || chartType === 'doughnut' || chartType === 'polarArea' || chartType === 'radar' || chartType === 'gauge';
  const isMap = chartType === 'map';
  const hasAxes = !isArc && !isMap && chartType !== 'kpiCard' && chartType !== 'treemap' && chartType !== 'funnel';

  // The file's own currency, so "Automatic" can say what it will use.
  const datasetCurrency = useAppStore(state => state.dataset?.columns?.find(column => column.currency)?.currency);
  const symbol = (() => {
    if (!datasetCurrency) return '';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: datasetCurrency }).formatToParts(0).find(part => part.type === 'currency')?.value || '';
    } catch { return ''; }
  })();

  const labelsOn = Boolean(formatting.showDataLabels) && formatting.dataLabelMode !== 'off';
  const labelMode = formatting.dataLabelMode === 'primary' ? 'primary' : 'all';

  return (
    <div
      className={`qi-format-panel qi-style-panel overflow-y-auto ${embedded
        ? 'h-full w-full'
        : 'absolute top-4 right-4 w-[300px] max-h-[calc(100%_-_2rem)] rounded-xl z-20 animate-in fade-in slide-in-from-right-4'
      }`}
    >
      <div className="qi-style-header">
        <h3 className="flex items-center gap-2">
          <Palette className="w-4 h-4" aria-hidden />
          Style
        </h3>
        <div className="flex items-center gap-1">
          <button type="button" className="qi-style-icon" onClick={() => update(STYLE_RESET)} title="Reset style to the defaults" aria-label="Reset style">
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button type="button" className="qi-style-icon" onClick={onClose} aria-label="Close chart appearance">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <Section title="Colours">
        <div role="group" aria-label="Colour meaning" className="space-y-1.5">
          <span className="qi-style-label block">Colour by</span>
          <Segmented
            label="Colour by"
            value={(formatting.colorEncoding || 'auto') as 'auto' | 'sequential' | 'discrete'}
            options={[
              { label: 'Auto', value: 'auto', title: 'One colour for a single series; distinct colours for slices and multiple series' },
              { label: 'Low → high', value: 'sequential', title: 'Shade bars by their value' },
              { label: 'Categories', value: 'discrete', title: 'A different colour for each bar' },
            ]}
            onChange={value => update({ colorEncoding: value })}
          />
        </div>
        <div className="space-y-1.5">
          <span className="qi-style-label block">Palette</span>
          <div className="grid grid-cols-5 gap-1.5">
            {(['vibrant', 'electric', 'neon', 'sunset', 'ocean'] as const).map(mode => {
              const active = (formatting.colorMode || 'vibrant') === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => update({ colorMode: mode })}
                  aria-pressed={active}
                  className={`qi-style-palette ${active ? 'is-active' : ''}`}
                  style={{
                    background: `linear-gradient(90deg, ${PALETTES[mode].slice(0, 4)
                      .map((colour, index) => `${colour} ${index * 25}% ${(index + 1) * 25}%`).join(', ')})`,
                  }}
                  title={PALETTE_NAMES[mode]}
                  aria-label={`${PALETTE_NAMES[mode]} palette`}
                />
              );
            })}
          </div>
        </div>
      </Section>

      {chartType === 'kpiCard' && (
        <Section title="Goal">
          <Field label="Target value" htmlFor="qi-kpi-goal">
            <input
              id="qi-kpi-goal"
              type="number"
              inputMode="decimal"
              placeholder="e.g. 250000"
              value={formatting.kpiGoal ?? ''}
              onChange={e => {
                const raw = e.target.value.trim();
                const goal = raw === '' ? undefined : Number(raw);
                update({ kpiGoal: goal !== undefined && Number.isFinite(goal) && goal > 0 ? goal : undefined });
              }}
              className="qi-ws-select w-full rounded-lg px-2.5 py-1.5 text-[13px]"
            />
          </Field>
          <p className="qi-style-hint">Shows progress towards this target under the number. Leave empty to hide.</p>
        </Section>
      )}

      <Section title="Numbers">
        <Field label="Format" htmlFor="qi-style-number">
          <select
            id="qi-style-number"
            value={formatting.numberFormat || 'auto'}
            onChange={e => update({ numberFormat: e.target.value as FormattingConfig['numberFormat'] })}
            className="qi-ws-select w-full rounded-lg px-2.5 py-1.5 text-[13px]"
          >
            <option value="auto">Automatic{symbol ? ` (${symbol} from your file)` : ''}</option>
            <option value="compact">Short (1.2K, 3.4M)</option>
            <option value="raw">Plain number (1,200)</option>
            <option value="currency_gbp">Pounds (£)</option>
            <option value="currency_usd">Dollars ($)</option>
            <option value="currency_eur">Euros (€)</option>
            <option value="percent">Percentage (%)</option>
          </select>
        </Field>
        <Field label="Decimal places">
          <Segmented
            label="Decimal places"
            value={formatting.decimals === undefined ? 'auto' : String(formatting.decimals)}
            options={[{ label: 'Auto', value: 'auto' }, { label: '0', value: '0' }, { label: '1', value: '1' }, { label: '2', value: '2' }]}
            onChange={value => update({ decimals: value === 'auto' ? undefined : Number(value) })}
          />
        </Field>
        {hasAxes && (
          <Field label="Large numbers">
            <Segmented
              label="Large numbers"
              value={formatting.yAxisFormat === 'full' ? 'full' : 'compact'}
              options={[
                { label: 'Short (1.2M)', value: 'compact' },
                { label: 'Full (1,200,000)', value: 'full' },
              ]}
              onChange={value => update({ yAxisFormat: value })}
            />
          </Field>
        )}
        <Field label="Dates" htmlFor="qi-style-date">
          <select
            id="qi-style-date"
            value={formatting.dateFormat || 'auto'}
            onChange={e => update({ dateFormat: e.target.value === 'auto' ? undefined : e.target.value as any })}
            className="qi-ws-select w-full rounded-lg px-2.5 py-1.5 text-[13px]"
          >
            <option value="auto">Automatic</option>
            <option value="month_short_year">Jan '24</option>
            <option value="month_name_year">January 2024</option>
            <option value="month_name_only">January</option>
            <option value="yyyy-mm-dd">2024-01-15</option>
            <option value="mm/dd/yyyy">01/15/2024</option>
            <option value="raw">As in the file</option>
          </select>
        </Field>
      </Section>

      {chartType !== 'kpiCard' && (
        <Section title="Value labels">
          <Switch
            label="Show values on the chart"
            checked={labelsOn}
            onChange={on => update({ showDataLabels: on, dataLabelMode: on ? labelMode : 'off' })}
          />
          {labelsOn && (
            <>
              <Field label="Which series">
                <Segmented
                  label="Which series"
                  value={labelMode}
                  options={[{ label: 'All', value: 'all' }, { label: 'First only', value: 'primary' }]}
                  onChange={value => update({ showDataLabels: true, dataLabelMode: value })}
                />
              </Field>
              <Field label="Size">
                <Segmented label="Value label size" value={formatting.dataLabelSize || 'md'} options={SIZE_OPTIONS} onChange={value => update({ dataLabelSize: value })} />
              </Field>
              <Switch label="Bold" checked={formatting.dataLabelBold !== false} onChange={value => update({ dataLabelBold: value })} />
              <ColourChoice label="Colour" value={formatting.dataLabelColor} fallback="#334155" onChange={value => update({ dataLabelColor: value })} />
              <p className="qi-style-hint">Numbers inside a bar switch to dark or light text so they stay readable.</p>
            </>
          )}
        </Section>
      )}

      {hasAxes && (
        <Section title="Axes">
          <div className="grid grid-cols-2 gap-2">
            <Switch label="Category axis" checked={Boolean(formatting.showXAxis ?? formatting.showAxis)} onChange={value => update({ showXAxis: value })} />
            <Switch label="Value axis" checked={Boolean(formatting.showYAxis ?? formatting.showAxis)} onChange={value => update({ showYAxis: value })} />
          </div>
          <Switch label="Axis titles" hint="Name each axis, e.g. Manufacturer and Total price" checked={formatting.showAxisTitles === true} onChange={value => update({ showAxisTitles: value })} />
          <Switch label="Grid lines" checked={formatting.showGridLines ?? false} onChange={value => update({ showGridLines: value })} />
          <Field label="Label size">
            <Segmented label="Axis label size" value={formatting.axisLabelSize || 'md'} options={SIZE_OPTIONS} onChange={value => update({ axisLabelSize: value })} />
          </Field>
          <Switch label="Bold labels" checked={formatting.axisBold ?? false} onChange={value => update({ axisBold: value })} />
          <ColourChoice label="Label colour" value={formatting.axisColor} fallback="#475569" onChange={value => update({ axisColor: value })} />
          <p className="qi-style-hint">Every category name is shown: long names wrap onto two lines, then shorten with "…" (hover a bar for the full name).</p>
        </Section>
      )}

      <Section title="Legend">
        <Switch label="Show legend" hint="Appears when there is more than one series or slice" checked={formatting.showLabels ?? true} onChange={value => update({ showLabels: value })} />
        <Field label="Legend text size">
          <Segmented
            label="Legend text size"
            value={formatting.fontSize || 'md'}
            options={[{ label: 'S', value: 'sm' }, { label: 'M', value: 'md' }, { label: 'L', value: 'lg' }]}
            onChange={value => update({ fontSize: value })}
          />
        </Field>
      </Section>
    </div>
  );
};

export default FormatPanel;
