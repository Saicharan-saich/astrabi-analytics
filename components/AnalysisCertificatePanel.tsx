import React from 'react';
import { AlertTriangle, CheckCircle2, Fingerprint, LockKeyhole, ShieldCheck, XCircle } from 'lucide-react';
import type { AnalysisCertificate } from '../services/ai-sql';

interface AnalysisCertificatePanelProps {
  certificate: AnalysisCertificate;
  isDark: boolean;
}

const statusCopy = {
  certified: { label: 'Certified answer', Icon: ShieldCheck, colour: 'emerald' },
  conditional: { label: 'Certified with limitations', Icon: AlertTriangle, colour: 'amber' },
  withheld: { label: 'Answer withheld', Icon: XCircle, colour: 'rose' },
} as const;

export const AnalysisCertificatePanel: React.FC<AnalysisCertificatePanelProps> = ({ certificate, isDark }) => {
  const status = statusCopy[certificate.status];
  const passed = certificate.checks.filter(check => check.status === 'pass').length;
  const warnings = certificate.checks.filter(check => check.status === 'warn').length;
  const failed = certificate.checks.filter(check => check.status === 'fail').length;
  const StatusIcon = status.Icon;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <section className={`overflow-hidden rounded-3xl border ${isDark ? 'border-white/10 bg-white/[0.03]' : 'border-slate-200 bg-white shadow-sm'}`}>
        <div className={`flex flex-col gap-5 border-b p-6 sm:flex-row sm:items-center sm:justify-between ${isDark ? 'border-white/10' : 'border-slate-100'}`}>
          <div className="flex items-start gap-4">
            <div className={`rounded-2xl p-3 ${status.colour === 'emerald' ? 'bg-emerald-500/15 text-emerald-500' : status.colour === 'amber' ? 'bg-amber-500/15 text-amber-500' : 'bg-rose-500/15 text-rose-500'}`}>
              <StatusIcon className="h-7 w-7" />
            </div>
            <div>
              <div className="text-xl font-black">{status.label}</div>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500 dark:text-slate-300">{certificate.summary}</p>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-emerald-500/10 px-3 py-2"><div className="text-lg font-black text-emerald-500">{passed}</div><div className="text-[9px] font-bold uppercase text-slate-400">Passed</div></div>
            <div className="rounded-xl bg-amber-500/10 px-3 py-2"><div className="text-lg font-black text-amber-500">{warnings}</div><div className="text-[9px] font-bold uppercase text-slate-400">Review</div></div>
            <div className="rounded-xl bg-rose-500/10 px-3 py-2"><div className="text-lg font-black text-rose-500">{failed}</div><div className="text-[9px] font-bold uppercase text-slate-400">Failed</div></div>
          </div>
        </div>

        <div className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-4">
          <CertificateFact label="Dataset grain" value={certificate.dataset.grain} detail={`${certificate.dataset.grainConfidence} confidence`} />
          <CertificateFact label="Execution" value="Local DuckDB" detail={`${certificate.execution.rowCount.toLocaleString()} result rows`} />
          <CertificateFact label="AI data access" value={certificate.execution.aiDataAccess === 'metadata_only' ? 'Metadata only' : 'Approved safe values'} detail={`${certificate.execution.tokenUsage.toLocaleString()} AI tokens`} />
          <CertificateFact label="SQL fingerprint" value={certificate.execution.sqlFingerprint} detail={certificate.execution.engine} mono />
        </div>
      </section>

      <section className={`rounded-2xl border p-5 ${isDark ? 'border-white/10 bg-white/[0.03]' : 'border-slate-200 bg-white shadow-sm'}`}>
        <div className="mb-4 flex items-center gap-2 text-sm font-black"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Verification checks</div>
        <div className="grid gap-2 md:grid-cols-2">
          {certificate.checks.map(check => {
            const Icon = check.status === 'pass' ? CheckCircle2 : check.status === 'warn' ? AlertTriangle : XCircle;
            const colour = check.status === 'pass' ? 'text-emerald-500' : check.status === 'warn' ? 'text-amber-500' : 'text-rose-500';
            return (
              <div key={`${check.category}:${check.id}`} className={`flex gap-3 rounded-xl border p-3 ${isDark ? 'border-white/[0.07] bg-black/10' : 'border-slate-100 bg-slate-50/70'}`}>
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${colour}`} />
                <div className="min-w-0"><div className="text-xs font-extrabold">{check.title}</div><div className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{check.detail}</div></div>
              </div>
            );
          })}
        </div>
      </section>

      <section className={`grid gap-4 rounded-2xl border p-5 sm:grid-cols-2 ${isDark ? 'border-white/10 bg-white/[0.03]' : 'border-slate-200 bg-white shadow-sm'}`}>
        <div>
          <div className="flex items-center gap-2 text-sm font-black"><Fingerprint className="h-4 w-4 text-indigo-500" /> Evidence identity</div>
          <dl className="mt-3 space-y-2 text-xs text-slate-500 dark:text-slate-400">
            <div><dt className="font-bold text-slate-400">Certificate</dt><dd className="mt-0.5 font-mono">{certificate.certificateId}</dd></div>
            <div><dt className="font-bold text-slate-400">Capability contract</dt><dd className="mt-0.5 font-mono">{certificate.contractId}</dd></div>
            {certificate.dataset.revision && <div><dt className="font-bold text-slate-400">Dataset revision</dt><dd className="mt-0.5 break-all font-mono">{certificate.dataset.revision}</dd></div>}
          </dl>
        </div>
        <div>
          <div className="flex items-center gap-2 text-sm font-black"><LockKeyhole className="h-4 w-4 text-indigo-500" /> Disclosed limitations</div>
          {certificate.limitations.length ? (
            <ul className="mt-3 space-y-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {certificate.limitations.map((limitation, index) => <li key={`${limitation}:${index}`} className="flex gap-2"><span className="text-amber-500">•</span><span>{limitation}</span></li>)}
            </ul>
          ) : <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">No material limitations were found by the configured checks.</p>}
        </div>
      </section>
    </div>
  );
};

const CertificateFact: React.FC<{ label: string; value: string; detail: string; mono?: boolean }> = ({ label, value, detail, mono }) => (
  <div>
    <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
    <div className={`mt-1 break-words text-sm font-black ${mono ? 'font-mono' : ''}`}>{value}</div>
    <div className="mt-0.5 text-[10px] text-slate-400">{detail}</div>
  </div>
);
