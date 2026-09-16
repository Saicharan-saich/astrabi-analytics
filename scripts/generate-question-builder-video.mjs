import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public', 'tutorials', 'question-builder-guide.webm');
const browserCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => fs.existsSync(candidate));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.setContent(`<!doctype html>
<html><body style="margin:0;background:#020617;overflow:hidden">
<canvas id="guide" width="1280" height="720"></canvas>
<script>
const canvas = document.getElementById('guide');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;
const duration = 24000;
const steps = [
  { title: 'Start with the measure', body: 'Choose the number you want to understand.', badge: '1 of 6' },
  { title: 'Choose the calculation', body: 'Sum adds the selected value across matching rows.', badge: '2 of 6' },
  { title: 'Split it into groups', body: 'Flow direction creates separate Import and Export bars.', badge: '3 of 6' },
  { title: 'Add another dimension', body: 'Reporting period creates a grouped-in-group comparison.', badge: '4 of 6' },
  { title: 'Focus the answer', body: 'Filters, sorting and limits refine the same calculation.', badge: '5 of 6' },
  { title: 'Finish the visual', body: 'Change chart type, show labels, export or pin the result.', badge: '6 of 6' },
];

function rr(x, y, w, h, r, fill, stroke) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}
function text(value, x, y, size, color, weight = 500, align = 'left') {
  ctx.font = weight + ' ' + size + 'px Arial, sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(value, x, y);
}
function field(label, value, x, y, active, accent = '#4f46e5') {
  text(label.toUpperCase(), x, y, 11, active ? accent : '#64748b', 800);
  if (active) {
    ctx.shadowColor = accent;
    ctx.shadowBlur = 18;
  }
  rr(x, y + 14, 288, 47, 11, active ? '#eef2ff' : '#ffffff', active ? accent : '#cbd5e1');
  ctx.shadowBlur = 0;
  text(value, x + 16, y + 38, 15, '#0f172a', 700);
  text('⌄', x + 266, y + 38, 18, '#64748b', 700, 'center');
}
function drawChart(step, pulse) {
  const x0 = 465, y0 = 183, chartW = 700, chartH = 302;
  text(step < 3 ? 'Trade value overview' : 'Imports vs exports by reporting period', x0, 139, 22, '#0f172a', 800);
  text('SUM of value_usd_bn', x0, 166, 13, '#64748b', 600);
  ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = y0 + i * chartH / 4;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + chartW, y); ctx.stroke();
    text(String(2000 - i * 500), x0 - 16, y, 11, '#64748b', 600, 'right');
  }
  const periods = step >= 3 ? ['FY2023-24', 'FY2024-25', 'FY2025-26'] : ['Goods', 'Services', 'Software'];
  const imports = step >= 3 ? [979, 1490, 1730] : [1490, 292, 191];
  const exports = step >= 2 ? (step >= 3 ? [860, 734, 980] : [860, 418, 204]) : null;
  const max = 2000;
  periods.forEach((label, i) => {
    const groupX = x0 + 84 + i * 213;
    const aH = imports[i] / max * 250 * pulse;
    rr(groupX, y0 + chartH - aH, 62, aH, 7, '#3b82f6');
    if (step >= 5) text(imports[i] >= 1000 ? (imports[i] / 1000).toFixed(1) + 'K' : String(imports[i]), groupX + 31, y0 + chartH - aH - 13, 12, '#0f172a', 800, 'center');
    if (exports) {
      const bH = exports[i] / max * 250 * pulse;
      rr(groupX + 70, y0 + chartH - bH, 62, bH, 7, '#16a34a');
      if (step >= 5) text(String(exports[i]), groupX + 101, y0 + chartH - bH - 13, 12, '#0f172a', 800, 'center');
    }
    text(label, groupX + (exports ? 66 : 31), y0 + chartH + 28, 12, '#334155', 700, 'center');
  });
  const legendX = x0 + 260;
  rr(legendX, 543, 12, 12, 3, '#3b82f6'); text('Import', legendX + 20, 549, 12, '#475569', 600);
  if (exports) { rr(legendX + 92, 543, 12, 12, 3, '#16a34a'); text('Export', legendX + 112, 549, 12, '#475569', 600); }
}
function draw(ms) {
  const step = Math.min(5, Math.floor(ms / 4000));
  const local = (ms % 4000) / 4000;
  const pulse = Math.min(1, local * 3 + .18);
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0f172a'); bg.addColorStop(1, '#312e81');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = .16; ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(70, 680, 280, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#6366f1'; ctx.beginPath(); ctx.arc(1190, -20, 310, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  text('QUICKINSIGHT', 44, 39, 13, '#a5b4fc', 800);
  text('Question Builder', 44, 71, 25, '#ffffff', 800);
  rr(34, 100, 1212, 508, 22, '#f8fafc');
  rr(34, 100, 1212, 55, 22, '#ffffff'); ctx.fillStyle = '#ffffff'; ctx.fillRect(34, 132, 1212, 23);
  text('Show me', 60, 128, 15, '#0f172a', 800);
  rr(950, 114, 82, 30, 9, step >= 5 ? '#eef2ff' : '#f8fafc', step >= 5 ? '#4f46e5' : '#cbd5e1'); text('Labels', 991, 129, 12, step >= 5 ? '#4338ca' : '#475569', 700, 'center');
  rr(1042, 114, 82, 30, 9, '#ffffff', '#cbd5e1'); text('Export', 1083, 129, 12, '#475569', 700, 'center');
  rr(1134, 114, 82, 30, 9, step >= 5 ? '#4f46e5' : '#ffffff', step >= 5 ? '#4f46e5' : '#cbd5e1'); text('Pin', 1175, 129, 12, step >= 5 ? '#ffffff' : '#475569', 700, 'center');
  rr(54, 174, 360, 410, 18, '#ffffff', '#e2e8f0');
  text('BUILD THE QUESTION', 78, 203, 12, '#6366f1', 800);
  field('Measure', step >= 0 ? 'value usd bn' : 'Choose a measure', 78, 232, step === 0);
  field('Aggregation', step >= 1 ? 'Sum' : 'Choose calculation', 78, 314, step === 1, '#7c3aed');
  field('Group by', step >= 2 ? 'flow direction' : 'Choose a dimension', 78, 396, step === 2, '#0891b2');
  if (step >= 3) {
    ctx.shadowColor = step === 3 ? '#0ea5e9' : 'transparent'; ctx.shadowBlur = step === 3 ? 18 : 0;
    rr(78, 480, 288, 39, 10, '#ecfeff', step === 3 ? '#0891b2' : '#a5f3fc'); ctx.shadowBlur = 0;
    text('+ period label', 94, 500, 14, '#0e7490', 700);
  } else {
    rr(78, 480, 138, 36, 10, '#f8fafc', '#cbd5e1'); text('+ Dimension', 147, 498, 12, '#475569', 700, 'center');
  }
  if (step >= 4) {
    ctx.shadowColor = step === 4 ? '#22c55e' : 'transparent'; ctx.shadowBlur = step === 4 ? 16 : 0;
    rr(78, 534, 158, 32, 9, '#dcfce7', '#86efac'); ctx.shadowBlur = 0; text('Filter: All trade', 157, 550, 12, '#15803d', 700, 'center');
    rr(246, 534, 120, 32, 9, '#f1f5f9', '#cbd5e1'); text('Sort: Highest', 306, 550, 12, '#475569', 700, 'center');
  }
  drawChart(step, pulse);
  const info = steps[step];
  rr(34, 628, 1212, 70, 16, '#0f172a', '#334155');
  rr(54, 647, 58, 32, 16, '#4f46e5'); text(info.badge, 83, 663, 11, '#ffffff', 800, 'center');
  text(info.title, 132, 651, 17, '#ffffff', 800);
  text(info.body, 132, 676, 13, '#cbd5e1', 500);
  const progress = Math.min(1, ms / duration);
  rr(1000, 657, 205, 7, 4, '#334155'); rr(1000, 657, 205 * progress, 7, 4, '#22d3ee');
}

window.startRecording = () => new Promise((resolve, reject) => {
  const stream = canvas.captureStream(30);
  const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) return reject(new Error('No supported WebM MediaRecorder codec'));
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2200000 });
  const chunks = [];
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = event => reject(event.error || new Error('MediaRecorder failed'));
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'question-builder-guide.webm';
    document.body.appendChild(link);
    link.click();
    resolve(blob.size);
  };
  recorder.start(1000);
  const start = performance.now();
  function tick(now) {
    const elapsed = now - start;
    draw(Math.min(duration, elapsed));
    if (elapsed >= duration) recorder.stop();
    else requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
});
</script></body></html>`);

const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
const recordingPromise = page.evaluate(() => window.startRecording());
const download = await downloadPromise;
await download.saveAs(output);
const bytes = await recordingPromise;
await browser.close();
console.log(`Generated ${output} (${Math.round(bytes / 1024)} KiB)`);
