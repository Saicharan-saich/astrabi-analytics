import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public', 'tutorials', 'question-builder-guide.webm');
const narrationMasterPath = path.join(root, 'public', 'tutorials', 'question-builder-guide-narration.wav');
const voiceoverPath = path.join(os.tmpdir(), `quickinsight-builder-guide-${process.pid}.wav`);
const duration = 70000;

const narration = [
  'Welcome to the QuickInsight Question Builder. It turns a business question into a calculation you can inspect and change.',
  'Start with the measure. This is the number you want to understand. Here, we select trade value in billions of U S dollars.',
  'Next, choose the aggregation. Sum adds the measure across matching records. You can also use average, count, minimum, or maximum when appropriate.',
  'Now add the first dimension. Flow direction splits the total into imports and exports, and the visual updates immediately.',
  'Add a second dimension to create a more detailed comparison. Period label nests reporting periods inside the flow direction groups without losing either level.',
  'Use filters to focus the business question, then choose sorting and a row limit. In this example, we keep exports and rank the largest periods first.',
  'Choose a chart that suits the grouped result and enable labels when exact values matter. Every builder control remains editable.',
  'Finally, pin the result. Give the visual a meaningful name, choose a dashboard, and save it. That title stays with the visual when you edit it later.',
].join(' ');

function createNarration() {
  // Speech synthesis is intentionally cached: Windows SAPI renders close to
  // real time, while the video itself must also be recorded in real time.
  if (fs.existsSync(narrationMasterPath)) {
    return `data:audio/wav;base64,${fs.readFileSync(narrationMasterPath).toString('base64')}`;
  }
  const escapedPath = voiceoverPath.replaceAll("'", "''");
  const escapedNarration = narration.replaceAll("'", "''");
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$preferred = @('Microsoft Zira Desktop','Microsoft Zira','Microsoft David Desktop','Microsoft David')",
    '$installed = @($speaker.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })',
    '$voice = $preferred | Where-Object { $installed -contains $_ } | Select-Object -First 1',
    'if ($voice) { $speaker.SelectVoice($voice) }',
    '$speaker.Rate = 1',
    '$speaker.Volume = 100',
    `$speaker.SetOutputToWaveFile('${escapedPath}')`,
    `$speaker.Speak('${escapedNarration}')`,
    '$speaker.Dispose()',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8' });
  if (result.status !== 0 || !fs.existsSync(voiceoverPath)) {
    throw new Error(`Could not generate narrated audio. ${result.stderr || result.stdout || 'PowerShell speech synthesis failed.'}`);
  }
  fs.copyFileSync(voiceoverPath, narrationMasterPath);
  return `data:audio/wav;base64,${fs.readFileSync(voiceoverPath).toString('base64')}`;
}

const audioDataUrl = createNarration();
const browserCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => fs.existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.setContent(`<!doctype html>
<html><body style="margin:0;background:#020617;overflow:hidden">
<canvas id="guide" width="1280" height="720"></canvas>
<script>
const canvas = document.getElementById('guide');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;
const duration = ${duration};
const stepDuration = duration / 8;
const audioDataUrl = ${JSON.stringify(audioDataUrl)};
const steps = [
  { title: 'Understand the builder sentence', body: 'Show me [measure] using [calculation], grouped by [dimensions].', badge: '1 of 8', target: [215, 127] },
  { title: 'Choose the measure', body: 'Select the business value to analyse — here, value_usd_bn.', badge: '2 of 8', target: [219, 279] },
  { title: 'Choose the calculation', body: 'Sum adds matching values; Average, Count, Min and Max answer different questions.', badge: '3 of 8', target: [219, 361] },
  { title: 'Add the first dimension', body: 'Flow direction splits one total into separate Import and Export series.', badge: '4 of 8', target: [219, 443] },
  { title: 'Add another dimension', body: 'Period label creates a nested comparison without replacing flow direction.', badge: '5 of 8', target: [220, 512] },
  { title: 'Filter, sort and limit', body: 'Keep relevant records, rank the result, and control how many groups are shown.', badge: '6 of 8', target: [140, 558] },
  { title: 'Choose the visual and labels', body: 'Match the chart to the result shape and show exact values when useful.', badge: '7 of 8', target: [1003, 128] },
  { title: 'Name and pin the visual', body: 'Choose a meaningful title and dashboard. The name survives future edits.', badge: '8 of 8', target: [1175, 128] },
];

function rr(x, y, w, h, r, fill, stroke, lineWidth = 1) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.roundRect(x, y, w, h, radius);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}
function text(value, x, y, size, color, weight = 500, align = 'left') {
  ctx.font = weight + ' ' + size + 'px Arial, sans-serif';
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillText(value, x, y);
}
function ease(value) {
  const t = Math.max(0, Math.min(1, value));
  return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
function field(label, value, x, y, active, accent = '#4f46e5') {
  text(label.toUpperCase(), x, y, 11, active ? accent : '#64748b', 800);
  if (active) { ctx.shadowColor = accent; ctx.shadowBlur = 16; }
  rr(x, y + 14, 288, 47, 11, active ? '#eef2ff' : '#ffffff', active ? accent : '#cbd5e1', active ? 2 : 1);
  ctx.shadowBlur = 0; text(value, x + 16, y + 38, 15, '#0f172a', 700); text('⌄', x + 266, y + 38, 18, '#64748b', 700, 'center');
}
function dropdown(x, y, options, selected) {
  ctx.shadowColor = '#0f172a'; ctx.shadowBlur = 20; rr(x, y, 288, options.length * 34 + 12, 10, '#ffffff', '#cbd5e1'); ctx.shadowBlur = 0;
  options.forEach((option, index) => {
    if (index === selected) rr(x + 6, y + 6 + index * 34, 276, 30, 7, '#eef2ff');
    text(option, x + 17, y + 21 + index * 34, 13, index === selected ? '#4338ca' : '#334155', index === selected ? 800 : 600);
    if (index === selected) text('✓', x + 264, y + 21 + index * 34, 13, '#4f46e5', 800, 'center');
  });
}
function drawChart(step, pulse) {
  const x0 = 465, y0 = 190, chartW = 700, chartH = 292;
  const multi = step >= 4; const split = step >= 3; const exportOnly = step >= 5;
  text(multi ? 'Imports vs exports by reporting period' : split ? 'Trade value by flow direction' : 'Trade value overview', x0, 142, 22, '#0f172a', 800);
  text(exportOnly ? 'Filtered to Export · highest first' : 'SUM of value_usd_bn', x0, 168, 13, exportOnly ? '#15803d' : '#64748b', 700);
  ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) { const y = y0 + i * chartH / 4; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + chartW, y); ctx.stroke(); text(String(2000 - i * 500), x0 - 16, y, 11, '#64748b', 600, 'right'); }
  let categories = multi ? ['FY2023-24', 'FY2024-25', 'FY2025-26'] : split ? ['Import', 'Export'] : ['Goods', 'Services', 'Software'];
  let first = multi ? [979, 1490, 1730] : split ? [1490, 860] : [1490, 292, 191];
  let second = multi && !exportOnly ? [860, 734, 980] : null;
  if (exportOnly) { categories = ['FY2025-26', 'FY2023-24', 'FY2024-25']; first = [980, 860, 734]; }
  categories.forEach((label, i) => {
    const groupX = x0 + 82 + i * 213; const aH = first[i] / 2000 * 245 * pulse;
    rr(groupX, y0 + chartH - aH, 62, aH, 7, exportOnly ? '#16a34a' : '#3b82f6');
    if (step >= 6) text(first[i] >= 1000 ? (first[i] / 1000).toFixed(1) + 'K' : String(first[i]), groupX + 31, y0 + chartH - aH - 13, 12, '#0f172a', 800, 'center');
    if (second) { const bH = second[i] / 2000 * 245 * pulse; rr(groupX + 70, y0 + chartH - bH, 62, bH, 7, '#16a34a'); if (step >= 6) text(String(second[i]), groupX + 101, y0 + chartH - bH - 13, 12, '#0f172a', 800, 'center'); }
    text(label, groupX + (second ? 66 : 31), y0 + chartH + 27, 12, '#334155', 700, 'center');
  });
  if (multi && !exportOnly) { rr(x0 + 260, 541, 12, 12, 3, '#3b82f6'); text('Import', x0 + 280, 547, 12, '#475569', 600); rr(x0 + 352, 541, 12, 12, 3, '#16a34a'); text('Export', x0 + 372, 547, 12, '#475569', 600); }
}
function drawCursor(step, local) {
  const previous = step === 0 ? [70, 76] : steps[step - 1].target; const target = steps[step].target; const movement = ease(local / .22);
  const x = previous[0] + (target[0] - previous[0]) * movement; const y = previous[1] + (target[1] - previous[1]) * movement; const click = local > .22 && local < .38;
  if (click) { const ring = 9 + (local - .22) / .16 * 24; ctx.beginPath(); ctx.arc(x, y, ring, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(99,102,241,' + (1 - (local - .22) / .16) + ')'; ctx.lineWidth = 4; ctx.stroke(); ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = '#f43f5e'; ctx.fill(); }
  ctx.save(); ctx.translate(x, y); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 27); ctx.lineTo(7, 20); ctx.lineTo(13, 33); ctx.lineTo(19, 30); ctx.lineTo(13, 18); ctx.lineTo(23, 18); ctx.closePath(); ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 3; ctx.fill(); ctx.stroke(); ctx.restore();
}
function pinDialog(local) {
  if (local < .28) return;
  ctx.fillStyle = 'rgba(15,23,42,.46)'; ctx.fillRect(34, 100, 1212, 508); ctx.shadowColor = '#0f172a'; ctx.shadowBlur = 26; rr(438, 162, 440, 390, 20, '#ffffff'); ctx.shadowBlur = 0;
  text('Pin to Dashboard', 470, 198, 19, '#0f172a', 800); text('Name the visual and choose where to save it', 470, 225, 12, '#64748b', 600); text('VISUAL TITLE', 470, 266, 10, '#64748b', 800);
  rr(470, 280, 376, 46, 9, '#f8fafc', '#8b5cf6', 2); const fullTitle = 'FY2025 export performance'; const typed = fullTitle.slice(0, Math.floor(Math.max(0, local - .38) / .34 * fullTitle.length)); text(typed || 'Name this visual', 485, 303, 14, typed ? '#0f172a' : '#94a3b8', 700);
  text('DASHBOARD', 470, 359, 10, '#64748b', 800); rr(470, 374, 376, 55, 10, '#eef2ff', '#c7d2fe'); text('Executive Trade Dashboard', 486, 396, 14, '#4338ca', 700); text('6 visuals', 486, 416, 10, '#64748b', 600);
  rr(664, 472, 182, 44, 10, '#4f46e5'); text('Pin to Dashboard', 755, 494, 13, '#ffffff', 800, 'center');
}
function draw(ms) {
  const step = Math.min(7, Math.floor(ms / stepDuration)); const local = (ms % stepDuration) / stepDuration; const pulse = Math.min(1, local * 3 + .22);
  const bg = ctx.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#0f172a'); bg.addColorStop(1, '#312e81'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = .15; ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(70, 680, 280, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#6366f1'; ctx.beginPath(); ctx.arc(1190, -20, 310, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  text('QUICKINSIGHT', 44, 39, 13, '#a5b4fc', 800); text('Question Builder guided walkthrough', 44, 71, 25, '#ffffff', 800);
  rr(34, 100, 1212, 508, 22, '#f8fafc'); rr(34, 100, 1212, 55, 22, '#ffffff'); ctx.fillStyle = '#ffffff'; ctx.fillRect(34, 132, 1212, 23); text('Show me', 60, 128, 15, '#0f172a', 800);
  rr(158, 113, 176, 32, 9, step === 1 ? '#eef2ff' : '#f8fafc', step === 1 ? '#4f46e5' : '#cbd5e1'); text(step >= 1 ? 'value usd bn' : 'choose a measure', 246, 129, 12, '#334155', 700, 'center'); text('using', 347, 128, 13, '#64748b', 700);
  rr(393, 113, 86, 32, 9, step === 2 ? '#f5f3ff' : '#f8fafc', step === 2 ? '#7c3aed' : '#cbd5e1'); text(step >= 2 ? 'Sum' : '...', 436, 129, 12, '#334155', 700, 'center'); text('grouped by', 492, 128, 13, '#64748b', 700);
  rr(571, 113, 176, 32, 9, step === 3 ? '#ecfeff' : '#f8fafc', step === 3 ? '#0891b2' : '#cbd5e1'); text(step >= 3 ? 'flow direction' : 'a dimension', 659, 129, 12, '#334155', 700, 'center');
  rr(805, 113, 116, 32, 9, step === 6 ? '#eef2ff' : '#ffffff', step === 6 ? '#4f46e5' : '#cbd5e1'); text('Vertical Bar', 863, 129, 12, '#475569', 700, 'center');
  rr(931, 113, 105, 32, 9, step === 6 ? '#eef2ff' : '#ffffff', step === 6 ? '#4f46e5' : '#cbd5e1'); text(step >= 6 ? 'Labels ✓' : 'Labels', 983, 129, 12, step >= 6 ? '#4338ca' : '#475569', 700, 'center');
  rr(1046, 113, 78, 32, 9, '#ffffff', '#cbd5e1'); text('Export', 1085, 129, 12, '#475569', 700, 'center'); rr(1134, 113, 82, 32, 9, step === 7 ? '#4f46e5' : '#ffffff', step === 7 ? '#4f46e5' : '#cbd5e1'); text('Pin', 1175, 129, 12, step === 7 ? '#ffffff' : '#475569', 700, 'center');
  rr(54, 174, 360, 410, 18, '#ffffff', '#e2e8f0'); text('BUILD THE QUESTION', 78, 202, 12, '#6366f1', 800); field('Measure', step >= 1 ? 'value usd bn' : 'Choose a measure', 78, 232, step === 1); field('Aggregation', step >= 2 ? 'Sum' : 'Choose calculation', 78, 314, step === 2, '#7c3aed'); field('Group by', step >= 3 ? 'flow direction' : 'Choose a dimension', 78, 396, step === 3, '#0891b2');
  if (step >= 4) { rr(78, 480, 288, 39, 10, '#ecfeff', step === 4 ? '#0891b2' : '#a5f3fc', step === 4 ? 2 : 1); text('+ period label', 94, 500, 14, '#0e7490', 700); } else { rr(78, 480, 138, 36, 10, '#f8fafc', '#cbd5e1'); text('+ Dimension', 147, 498, 12, '#475569', 700, 'center'); }
  if (step >= 5) { rr(78, 534, 112, 32, 9, '#dcfce7', '#86efac'); text('Export only', 134, 550, 12, '#15803d', 700, 'center'); rr(198, 534, 94, 32, 9, '#f1f5f9', '#cbd5e1'); text('Highest', 245, 550, 12, '#475569', 700, 'center'); rr(300, 534, 66, 32, 9, '#f1f5f9', '#cbd5e1'); text('Top 10', 333, 550, 12, '#475569', 700, 'center'); }
  drawChart(step, pulse);
  if (step === 1 && local > .25 && local < .58) dropdown(78, 292, ['value usd bn', 'trade volume', 'record count'], 0);
  if (step === 2 && local > .25 && local < .58) dropdown(78, 374, ['Sum', 'Average', 'Count', 'Minimum', 'Maximum'], 0);
  if (step === 3 && local > .25 && local < .58) dropdown(78, 456, ['flow direction', 'trade scope', 'country', 'category'], 0);
  if (step === 4 && local > .25 && local < .58) dropdown(78, 520, ['period label', 'country', 'category'], 0);
  if (step === 7) pinDialog(local);
  const info = steps[step]; rr(34, 628, 1212, 70, 16, '#0f172a', '#334155'); rr(54, 647, 58, 32, 16, '#4f46e5'); text(info.badge, 83, 663, 11, '#ffffff', 800, 'center'); text(info.title, 132, 651, 17, '#ffffff', 800); text(info.body, 132, 676, 13, '#cbd5e1', 500); rr(1000, 657, 205, 7, 4, '#334155'); rr(1000, 657, 205 * Math.min(1, ms / duration), 7, 4, '#22d3ee'); drawCursor(step, local);
}

window.startRecording = async () => {
  const audioContext = new AudioContext(); const audioBuffer = await audioContext.decodeAudioData(await (await fetch(audioDataUrl)).arrayBuffer()); const audioSource = audioContext.createBufferSource(); const audioDestination = audioContext.createMediaStreamDestination(); audioSource.buffer = audioBuffer; audioSource.connect(audioDestination);
  const videoStream = canvas.captureStream(30); const combinedStream = new MediaStream([...videoStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()]); const mimeTypes = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']; const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type)); if (!mimeType) throw new Error('No supported WebM MediaRecorder codec');
  return new Promise((resolve, reject) => {
    const recorder = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 1400000, audioBitsPerSecond: 96000 }); const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); }; recorder.onerror = event => reject(event.error || new Error('MediaRecorder failed')); recorder.onstop = () => { const blob = new Blob(chunks, { type: mimeType }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'question-builder-guide.webm'; document.body.appendChild(link); link.click(); resolve({ bytes: blob.size, audioSeconds: audioBuffer.duration }); };
    draw(0); recorder.start(1000); audioSource.start(0); const start = performance.now();
    const frameTimer = setInterval(() => {
      const elapsed = performance.now() - start;
      draw(Math.min(duration, elapsed));
      if (elapsed >= duration) {
        clearInterval(frameTimer);
        recorder.stop();
      }
    }, 1000 / 30);
  });
};
</script></body></html>`);

try {
  // Decoding the narrated WAV can take 20–30 seconds before real-time canvas
  // recording begins, so the packaging timeout must include that preparation.
  const downloadPromise = page.waitForEvent('download', { timeout: duration + 90000 });
  const recordingPromise = page.evaluate(() => window.startRecording());
  const download = await downloadPromise;
  await download.saveAs(output);
  const result = await recordingPromise;
  console.log(`Generated ${output} (${Math.round(result.bytes / 1024)} KiB, ${(duration / 1000).toFixed(0)}s video, ${result.audioSeconds.toFixed(1)}s narration)`);
} finally {
  await browser.close();
  fs.rmSync(voiceoverPath, { force: true });
}
