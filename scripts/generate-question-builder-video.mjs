import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(root, 'public', 'tutorials');
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quickinsight-guide-'));
const output = path.join(assetDir, 'question-builder-guide.webm');
const audioOutput = path.join(assetDir, 'question-builder-guide-narration.wav');
const captionsOutput = path.join(assetDir, 'question-builder-guide.vtt');
const posterOutput = path.join(assetDir, 'question-builder-guide-poster.png');
const timingOutput = path.join(assetDir, 'question-builder-guide-timing.json');

// These scenes are captured from the running application, not drawn as a mock UI.
// Each narration segment has its own audio duration, so the shot and captions
// stay in sync even if a different local voice is installed.
const scenes = [
  {
    title: 'Start with a business question',
    body: 'Pick the number you want to understand and how to calculate it.',
    narration: 'Welcome to Quick Insight’s Question Builder. Start with a measure, like sales, and choose how to calculate it. Sum adds the matching sales values.',
  },
  {
    title: 'See monthly sales',
    body: 'Time → Month builds a trend; darker or brighter shades show the highs.',
    narration: 'For a monthly trend, choose Month in the Time tab. The chart updates automatically, and the colour shades make lower and higher sales easier to spot.',
  },
  {
    title: 'Compare products',
    body: 'Named categories receive distinct colours instead of a value ramp.',
    narration: 'Switch to Product to compare categories. Each product gets a distinct colour. The plain-English answer says what the visual is showing.',
  },
  {
    title: 'Add another measure',
    body: 'Use Options to place Profit alongside Sales.',
    narration: 'Need more context? Open Options and add Profit as another measure. You can compare both numbers in one visual without building a new question.',
  },
  {
    title: 'Keep the question tidy',
    body: 'Remove an extra measure from Options whenever it is no longer needed.',
    narration: 'If Profit is not needed, remove it from the same Options menu. The visual returns to Sales, and Profit remains available to add again.',
  },
  {
    title: 'Focus the answer',
    body: 'Filter to a product; sorting and limits are available in Options.',
    narration: 'Filter to the product you want to inspect. Sorting and limits are also available in Options. Every change recalculates the answer.',
  },
  {
    title: 'Make the visual yours',
    body: 'Resize the panels; Auto chooses time shades or category colours.',
    narration: 'Drag the divider to give the chart more room. In Style, Auto chooses value shades for time and distinct colours for categories, but you can override it.',
  },
  {
    title: 'Name and pin the result',
    body: 'Choose a clear visual title and a dashboard name.',
    narration: 'When the answer is ready, choose Pin. Give the visual a clear title, then choose or create the dashboard where it belongs.',
  },
  {
    title: 'Return to your dashboard',
    body: 'The saved visual is ready to revisit, refresh and share.',
    narration: 'The finished visual now lives on your dashboard. You can revisit it, refresh it, or keep exploring the data with another question.',
  },
];

const escapePowerShell = value => value.replaceAll("'", "''");
const toTimestamp = milliseconds => {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
};

function findWavData(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Local speech synthesis returned an invalid WAV file.');
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') {
      return { header: wav.subarray(0, offset + 8), pcm: wav.subarray(offset + 8, offset + 8 + size), dataSizeAt: offset + 4 };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('Local speech synthesis returned WAV without audio data.');
}

function createNarration() {
  const narrationHash = createHash('sha256').update(JSON.stringify({ voice: 'Microsoft Mark', rate: 0, scenes: scenes.map(scene => scene.narration) })).digest('hex');
  if (fs.existsSync(audioOutput) && fs.existsSync(captionsOutput) && fs.existsSync(timingOutput)) {
    const timing = JSON.parse(fs.readFileSync(timingOutput, 'utf8'));
    if (timing.hash === narrationHash && timing.scenes?.length === scenes.length) {
      timing.scenes.forEach((times, index) => Object.assign(scenes[index], times));
      fs.copyFileSync(audioOutput, path.join(temporaryDir, 'narration.wav'));
      fs.copyFileSync(captionsOutput, path.join(temporaryDir, 'captions.vtt'));
      fs.copyFileSync(timingOutput, path.join(temporaryDir, 'timing.json'));
      return { audio: fs.readFileSync(audioOutput), durationMs: scenes.at(-1).endMs + 350 };
    }
  }
  const lines = Buffer.from(JSON.stringify(scenes.map(scene => scene.narration)), 'utf8').toString('base64');
  const directory = escapePowerShell(temporaryDir);
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$preferred = @('Microsoft Mark','Microsoft Mark Desktop','Microsoft Zira Desktop','Microsoft Zira','Microsoft David Desktop')",
    '$installed = @($speaker.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })',
    '$voice = $preferred | Where-Object { $installed -contains $_ } | Select-Object -First 1',
    'if ($voice) { $speaker.SelectVoice($voice) }',
    '$speaker.Rate = 0',
    '$speaker.Volume = 100',
    `$lines = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${lines}')) | ConvertFrom-Json`,
    `for ($i = 0; $i -lt $lines.Count; $i++) { $speaker.SetOutputToWaveFile((Join-Path '${directory}' ($i.ToString() + '.wav'))); $speaker.Speak([string]$lines[$i]); $speaker.SetOutputToNull() }`,
    '$speaker.Dispose()',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Narration synthesis failed: ${result.stderr || result.stdout}`);

  const clips = scenes.map((_, index) => findWavData(fs.readFileSync(path.join(temporaryDir, `${index}.wav`))));
  const byteRate = clips[0].header.readUInt32LE(28);
  const blockAlign = clips[0].header.readUInt16LE(32);
  const pauseBytes = Math.round((byteRate * 0.65) / blockAlign) * blockAlign;
  const chunks = [];
  let elapsedBytes = 0;
  clips.forEach((clip, index) => {
    if (clip.header.readUInt32LE(28) !== byteRate || clip.header.readUInt16LE(32) !== blockAlign) {
      throw new Error('The narration voice changed audio format between scenes.');
    }
    scenes[index].startMs = elapsedBytes / byteRate * 1000;
    chunks.push(clip.pcm);
    elapsedBytes += clip.pcm.length;
    chunks.push(Buffer.alloc(pauseBytes));
    elapsedBytes += pauseBytes;
    scenes[index].endMs = elapsedBytes / byteRate * 1000;
  });
  const audio = Buffer.concat([clips[0].header, ...chunks]);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.writeUInt32LE(elapsedBytes, clips[0].dataSizeAt);
  fs.writeFileSync(path.join(temporaryDir, 'narration.wav'), audio);

  const captions = ['WEBVTT', ''];
  scenes.forEach(scene => {
    captions.push(`${toTimestamp(scene.startMs)} --> ${toTimestamp(scene.endMs - 150)}`);
    captions.push(scene.narration.replace('Quick Insight’s', 'QuickInsight’s'));
    captions.push('');
  });
  fs.writeFileSync(path.join(temporaryDir, 'captions.vtt'), captions.join('\n'));
  fs.writeFileSync(path.join(temporaryDir, 'timing.json'), JSON.stringify({ hash: narrationHash, scenes: scenes.map(scene => ({ startMs: scene.startMs, endMs: scene.endMs })) }, null, 2));
  return { audio, durationMs: scenes.at(-1).endMs + 350 };
}

function retailCsv() {
  const rows = ['order_date,product,region,sales_amount,profit'];
  const products = ['Notebook', 'Headphones', 'Desk Lamp'];
  for (let month = 1; month <= 8; month++) {
    products.forEach((product, index) => {
      const sales = 1800 + month * 210 + index * 390 + ((month + index) % 3) * 180;
      rows.push(`2025-${String(month).padStart(2, '0')}-12,${product},${index === 1 ? 'South' : 'North'},${sales},${Math.round(sales * (0.17 + index * 0.035))}`);
    });
  }
  return Buffer.from(rows.join('\n'), 'utf8');
}

async function captureScenes(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const user = { id: 'guide-demo-user', email: 'guide@example.invalid', name: 'Guide Demo', role: 'contributor' };
  const token = `header.${Buffer.from(JSON.stringify({ userId: user.id })).toString('base64url')}.signature`;
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname.endsWith('/auth/login') ? { success: true, token, user }
      : pathname.endsWith('/auth/verify') ? { success: true, valid: true, user }
        : pathname.endsWith('/dashboards') ? { dashboards: [] } : {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.addInitScript(() => localStorage.setItem('QuickInsight-onboarding-complete', 'true'));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('button', { name: /skip tour/i }).click();
  await page.getByLabel('Email Address').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('LocalGuideFixture123');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByRole('button', { name: 'Data Source', exact: true }).click();
  await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').setInputFiles({
    name: 'guide-retail.csv', mimeType: 'text/csv', buffer: retailCsv(),
  });
  await page.getByRole('heading', { name: 'Dataset Workspace' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Question Builder', exact: true }).click();
  await page.locator('#qi-builder-panel .qi-builder-metric').first().waitFor();

  const frames = [];
  const capture = async (target, name) => {
    await page.waitForTimeout(850);
    const locator = page.locator(target).first();
    if (await locator.isVisible().catch(() => false)) await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox().catch(() => null);
    const image = await page.screenshot({ type: 'png', animations: 'disabled' });
    frames.push({ image: `data:image/png;base64,${image.toString('base64')}`, box });
    console.log(`Captured guide scene ${frames.length}/${scenes.length}: ${name}`);
  };

  // Start on the real Builder, then build two different question shapes.
  await capture('.qi-builder-metric', 'measure and aggregation');
  await page.getByRole('button', { name: 'Time', exact: true }).click();
  await page.locator('#qi-builder-panel .qi-builder-time-grain button[aria-haspopup="listbox"]').first().click();
  await page.getByRole('option', { name: 'Month', exact: true }).click();
  await capture('.qi-builder-time-grain', 'monthly sales');

  await page.locator('#qi-builder-panel .qi-builder-time-grain button[aria-haspopup="listbox"]').first().click();
  await page.getByRole('option', { name: '(None)', exact: true }).click();
  await page.getByRole('button', { name: 'Build', exact: true }).click();
  await page.locator('#qi-builder-panel .qi-builder-dimension button[aria-haspopup="listbox"]').first().click();
  await page.getByRole('option', { name: 'product', exact: true }).click();
  await capture('.qi-builder-dimension', 'product comparison');

  await page.getByRole('button', { name: 'Options', exact: true }).click();
  const options = page.locator('.qi-builder-options-panel');
  await options.getByRole('button', { name: /Add Metric/i }).click();
  await page.getByRole('option', { name: 'profit', exact: true }).click();
  await options.getByRole('button', { name: 'Remove additional metric profit' }).scrollIntoViewIfNeeded();
  await capture('.qi-builder-options-panel [aria-label="Remove additional metric profit"]', 'additional profit measure');
  await options.getByRole('button', { name: 'Remove additional metric profit' }).click();
  await capture('.qi-builder-options-panel', 'remove additional measure');

  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByTitle('Pick which product values to include').click();
  await page.locator('.qi-dimension-value-menu').waitFor();
  await page.locator('.qi-dimension-value-menu').getByRole('button', { name: 'Notebook', exact: true }).click();
  await capture('.qi-dimension-value-menu', 'filter values');
  await page.getByTitle('Pick which product values to include').click();

  const splitter = page.getByRole('separator', { name: 'Resize Question Builder and visual result' });
  await splitter.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  await capture('.qi-format-panel [role="group"][aria-label="Colour meaning"]', 'resize and automatic colours');
  await page.getByRole('button', { name: 'Close chart appearance' }).click();

  await page.locator('.qi-builder-commandbar').getByRole('button', { name: 'Pin', exact: true }).click();
  await page.getByText('Pin to Dashboard', { exact: true }).first().waitFor();
  await page.locator('#pin-visual-title').fill('Notebook sales');
  await page.locator('#new-dashboard-name').fill('Retail Overview');
  await capture('#pin-visual-title', 'pin to a dashboard');
  await page.getByRole('button', { name: 'Pin to Dashboard', exact: true }).click();
  if (await page.getByRole('button', { name: 'Open navigation' }).isVisible()) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await capture('.qi-dashboard-workspace', 'saved dashboard');
  await context.close();
  return frames;
}

async function recordGuide(browser, frames, audio, durationMs) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent('<!doctype html><html><body style="margin:0;background:#0b1221"><canvas id="guide" width="1280" height="720"></canvas></body></html>');
  await page.evaluate(async ({ frames, audio, scenes, durationMs }) => {
    const canvas = document.getElementById('guide');
    const ctx = canvas.getContext('2d');
    const images = await Promise.all(frames.map(frame => new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = frame.image;
    })));
    const audioContext = new AudioContext();
    const decoded = await audioContext.decodeAudioData(Uint8Array.from(atob(audio), char => char.charCodeAt(0)).buffer);

    const draw = milliseconds => {
      const index = Math.max(0, scenes.findIndex(scene => milliseconds < scene.endMs));
      const scene = scenes[index];
      const progress = Math.max(0, Math.min(1, (milliseconds - scene.startMs) / (scene.endMs - scene.startMs)));
      ctx.drawImage(images[index], 0, 0, 1280, 720);
      if (index > 0 && progress < 0.09) {
        ctx.globalAlpha = 1 - progress / 0.09;
        ctx.drawImage(images[index - 1], 0, 0, 1280, 720);
        ctx.globalAlpha = 1;
      }
      const box = frames[index].box;
      if (box && box.y > 78 && box.y + box.height < 595) {
        const glow = 0.55 + 0.3 * Math.sin(milliseconds / 260);
        ctx.save(); ctx.shadowColor = '#64d9ff'; ctx.shadowBlur = 18;
        ctx.strokeStyle = `rgba(99, 220, 255, ${glow})`; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.roundRect(box.x - 5, box.y - 5, box.width + 10, box.height + 10, 12); ctx.stroke(); ctx.restore();
      }
      ctx.fillStyle = 'rgba(5, 12, 28, 0.88)';
      ctx.beginPath(); ctx.roundRect(318, 11, 426, 38, 16); ctx.fill();
      ctx.font = '800 13px Arial'; ctx.fillStyle = '#d1ddff'; ctx.fillText('QUICKINSIGHT  /  QUESTION BUILDER', 336, 35);
      ctx.font = '700 12px Arial'; ctx.textAlign = 'right';
      ctx.fillText(`${index + 1} / ${scenes.length}`, 722, 35); ctx.textAlign = 'left';
      const bottom = ctx.createLinearGradient(0, 520, 0, 658);
      bottom.addColorStop(0, 'rgba(5, 12, 28, 0)'); bottom.addColorStop(0.35, 'rgba(5, 12, 28, 0.9)'); bottom.addColorStop(1, 'rgba(5, 12, 28, 0.97)');
      ctx.fillStyle = bottom; ctx.fillRect(0, 520, 1280, 138);
      ctx.font = '800 25px Arial'; ctx.fillStyle = '#ffffff'; ctx.fillText(scene.title, 34, 585);
      ctx.font = '500 17px Arial'; ctx.fillStyle = '#d4def1'; ctx.fillText(scene.body, 34, 617);
      ctx.fillStyle = 'rgba(148, 163, 184, 0.38)'; ctx.fillRect(34, 639, 1212, 5);
      ctx.fillStyle = '#57c8f4'; ctx.fillRect(34, 639, 1212 * Math.min(1, milliseconds / durationMs), 5);
    };

    window.startRecording = () => new Promise((resolve, reject) => {
      const source = audioContext.createBufferSource();
      const compressor = audioContext.createDynamicsCompressor();
      const destination = audioContext.createMediaStreamDestination();
      source.buffer = decoded; source.connect(compressor); compressor.connect(destination);
      const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...destination.stream.getAudioTracks()]);
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) return reject(new Error('No supported WebM recorder'));
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1800000, audioBitsPerSecond: 128000 });
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => reject(event.error || new Error('MediaRecorder failed'));
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
        link.download = 'question-builder-guide.webm'; document.body.appendChild(link); link.click();
        resolve({ bytes: blob.size, audioSeconds: decoded.duration });
      };
      draw(0); recorder.start(1000); source.start(); const started = performance.now();
      const timer = setInterval(() => {
        const elapsed = performance.now() - started; draw(Math.min(durationMs, elapsed));
        if (elapsed >= durationMs) { clearInterval(timer); recorder.stop(); }
      }, 1000 / 30);
    });
  }, { frames, audio: audio.toString('base64'), scenes, durationMs });
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: durationMs + 90000 });
    const recordingPromise = page.evaluate(() => window.startRecording());
    const download = await downloadPromise;
    await download.saveAs(path.join(temporaryDir, 'guide.webm'));
    return await recordingPromise;
  } finally {
    await page.close();
  }
}

let server;
let browser;
try {
  server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls.local[0];
  const browserCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const executablePath = browserCandidates.find(candidate => fs.existsSync(candidate));
  browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'], ...(executablePath ? { executablePath } : {}) });
  const frames = await captureScenes(browser, baseUrl);
  const { audio, durationMs } = createNarration();
  const result = await recordGuide(browser, frames, audio, durationMs);
  fs.copyFileSync(path.join(temporaryDir, 'guide.webm'), output);
  fs.copyFileSync(path.join(temporaryDir, 'narration.wav'), audioOutput);
  fs.copyFileSync(path.join(temporaryDir, 'captions.vtt'), captionsOutput);
  fs.copyFileSync(path.join(temporaryDir, 'timing.json'), timingOutput);
  fs.writeFileSync(posterOutput, Buffer.from(frames[2].image.split(',')[1], 'base64'));
  console.log(`Generated ${output}: ${(durationMs / 1000).toFixed(1)}s, ${Math.round(result.bytes / 1024)} KiB, narration ${result.audioSeconds.toFixed(1)}s`);
} finally {
  await browser?.close();
  await server?.close();
  fs.rmSync(temporaryDir, { recursive: true, force: true });
}
