#!/usr/bin/env node
/**
 * Secret scanner — a tripwire, not a guarantee.
 *
 *   node scripts/scan-secrets.mjs            scan tracked files (what CI runs)
 *   node scripts/scan-secrets.mjs --staged   scan staged changes (pre-commit)
 *   node scripts/scan-secrets.mjs --history  scan every blob ever committed
 *
 * Exits non-zero on a hit. This exists because backend/.env was once committed
 * with a live API key in it; the point is that the next one fails CI instead of
 * reaching a public repository.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const PATTERNS = [
    ['OpenRouter API key', /sk-or-v1-[A-Za-z0-9]{20,}/],
    ['Anthropic API key', /sk-ant-[A-Za-z0-9\-_]{20,}/],
    ['OpenAI API key', /sk-(proj-)?[A-Za-z0-9]{32,}/],
    ['Google API key', /AIza[0-9A-Za-z\-_]{35}/],
    ['AWS access key id', /AKIA[0-9A-Z]{16}/],
    ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36}/],
    ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
    ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['bcrypt hash', /\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/],
    ['JSON Web Token', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
    ['DB URL with password', /(postgres(ql)?|mysql|mongodb(\+srv)?):\/\/[^\s:/]+:[^\s@]+@/],
];

/**
 * Lines that are meant to contain a fake credential. Kept deliberately narrow —
 * a blanket "ignore anything in an example file" would let a real key through
 * the moment someone pastes one into .env.example by accident.
 */
const ALLOWED = [
    // Documented placeholder in the env templates.
    /postgresql:\/\/user:password@localhost:5432\//,
    // This scanner's own pattern list.
    /scripts\/scan-secrets\.mjs$/,
];

const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|docx|xlsx|zip|woff2?|ttf|eot|mp4|duckdb|sqlite)$/i;
const SKIP_DIRS = /^(node_modules|dist|test-results|playwright-report|\.git)\//;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

function scanText(text, label, findings) {
    for (const [name, rx] of PATTERNS) {
        for (const line of text.split('\n')) {
            if (!rx.test(line)) continue;
            if (ALLOWED.some(a => a.test(line) || a.test(label))) continue;
            findings.push({ name, label, sample: line.trim().slice(0, 90) });
        }
    }
}

function scanFiles(files) {
    const findings = [];
    for (const f of files) {
        if (!f || BINARY.test(f) || SKIP_DIRS.test(f)) continue;
        if (ALLOWED.some(a => a.test(f))) continue;
        try {
            if (statSync(f).size > 2 << 20) continue; // skip anything over 2 MB
            scanText(readFileSync(f, 'utf8'), f, findings);
        } catch { /* deleted or unreadable — nothing to scan */ }
    }
    return findings;
}

function scanHistory() {
    const findings = [];
    const seen = new Set();
    for (const line of git('rev-list', '--all', '--objects').split('\n')) {
        const [sha, path] = line.split(' ');
        if (!sha || !path || seen.has(sha) || BINARY.test(path)) continue;
        seen.add(sha);
        let blob;
        try { blob = execFileSync('git', ['cat-file', '-p', sha], { maxBuffer: 1 << 28 }); } catch { continue; }
        if (blob.length > (2 << 20)) continue;
        scanText(blob.toString('utf8'), `${path} @ ${sha.slice(0, 9)}`, findings);
    }
    return findings;
}

const mode = process.argv[2] || '';
let findings, scope;
if (mode === '--history') {
    scope = 'every blob in git history';
    findings = scanHistory();
} else if (mode === '--staged') {
    scope = 'staged changes';
    findings = scanFiles(git('diff', '--cached', '--name-only', '--diff-filter=ACM').split('\n'));
} else {
    scope = 'tracked files';
    findings = scanFiles(git('ls-files').split('\n'));
}

if (findings.length === 0) {
    console.log(`✓ No secrets found in ${scope}.`);
    process.exit(0);
}

console.error(`\n✗ Possible secrets found in ${scope}:\n`);
for (const f of findings) console.error(`  ${f.name}\n    ${f.label}\n    ${f.sample}\n`);
console.error('If a hit is a deliberate placeholder, add a narrow pattern to ALLOWED in');
console.error('scripts/scan-secrets.mjs. Do not widen it to a whole file.\n');
console.error('If a hit is real: rotate the credential first — removing it from the repo');
console.error('does not un-leak it — then purge it from history.\n');
process.exit(1);
