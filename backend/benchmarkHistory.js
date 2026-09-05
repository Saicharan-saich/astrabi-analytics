const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BUNDLED_ARCHIVE_PATH = path.join(__dirname, 'seed-data', 'benchmark-runs-v1.json.gz');
const BUNDLED_ARCHIVE_MARKER = 'benchmark_history_seed_v1';
const MAX_RESULTS_PER_RUN = 5000;
const MAX_RUN_ID_LENGTH = 200;

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateBenchmarkRun(run) {
    if (!isRecord(run)) return { valid: false, error: 'Benchmark run must be an object' };
    if (run.schemaVersion !== 1) return { valid: false, error: 'Unsupported benchmark schema version' };
    if (typeof run.id !== 'string' || !run.id.trim() || run.id.length > MAX_RUN_ID_LENGTH) {
        return { valid: false, error: 'Benchmark run ID is invalid' };
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(run.id)) {
        return { valid: false, error: 'Benchmark run ID contains unsupported characters' };
    }
    if (!Number.isFinite(run.startedAt) || run.startedAt <= 0) {
        return { valid: false, error: 'Benchmark start time is invalid' };
    }
    if (run.completedAt !== undefined && run.completedAt !== null && !Number.isFinite(run.completedAt)) {
        return { valid: false, error: 'Benchmark completion time is invalid' };
    }
    if (!Array.isArray(run.results) || run.results.length > MAX_RESULTS_PER_RUN) {
        return { valid: false, error: 'Benchmark results are missing or exceed the storage limit' };
    }
    if (!isRecord(run.metrics)) return { valid: false, error: 'Benchmark metrics are missing' };
    if (!Array.isArray(run.selectedSuiteIds)) return { valid: false, error: 'Selected benchmark suites are missing' };
    if (typeof run.scope !== 'string' || typeof run.methodologyLabel !== 'string') {
        return { valid: false, error: 'Benchmark methodology metadata is incomplete' };
    }
    return { valid: true };
}

function loadBundledBenchmarkArchive(archivePath = BUNDLED_ARCHIVE_PATH) {
    if (!fs.existsSync(archivePath)) return null;
    const payload = zlib.gunzipSync(fs.readFileSync(archivePath));
    const archive = JSON.parse(payload.toString('utf8'));
    if (!isRecord(archive) || archive.version !== 'quickinsight-benchmark-history-v1' || !Array.isArray(archive.runs)) {
        throw new Error('Bundled benchmark-history archive has an unsupported format');
    }
    if (archive.runCount !== archive.runs.length) {
        throw new Error('Bundled benchmark-history archive count does not match its contents');
    }
    for (const entry of archive.runs) {
        const validation = validateBenchmarkRun(entry?.run);
        if (!validation.valid) {
            throw new Error(`Bundled benchmark run is invalid: ${validation.error}`);
        }
        if (typeof entry.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sourceSha256)) {
            throw new Error(`Bundled benchmark run ${entry.run.id} has no valid source checksum`);
        }
    }
    return archive;
}

function benchmarkRunValues(run, createdBy, archiveSource, sourceSha256) {
    return [
        run.id,
        createdBy || null,
        run.schemaVersion,
        run.corpusId || 'legacy-550',
        run.privacyMode || 'strict',
        run.scope,
        new Date(run.startedAt).toISOString(),
        Number.isFinite(run.completedAt) ? new Date(run.completedAt).toISOString() : null,
        Boolean(run.cancelled),
        run.appVersion || null,
        run.methodologyLabel,
        JSON.stringify(run.metrics),
        JSON.stringify(run),
        archiveSource,
        sourceSha256 || null,
    ];
}

const INSERT_BENCHMARK_RUN_SQL = `
    INSERT INTO benchmark_runs (
        id, created_by, schema_version, corpus_id, privacy_mode, scope,
        started_at, completed_at, cancelled, app_version, methodology_label,
        metrics, run_data, archive_source, source_sha256, updated_at
    ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15, NOW()
    )
`;

async function upsertBenchmarkRun(pool, createdBy, run, archiveSource = 'application', sourceSha256 = null) {
    const validation = validateBenchmarkRun(run);
    if (!validation.valid) throw new Error(validation.error);
    await pool.query(
        `${INSERT_BENCHMARK_RUN_SQL}
         ON CONFLICT (id) DO UPDATE SET
            created_by = COALESCE(benchmark_runs.created_by, EXCLUDED.created_by),
            schema_version = EXCLUDED.schema_version,
            corpus_id = EXCLUDED.corpus_id,
            privacy_mode = EXCLUDED.privacy_mode,
            scope = EXCLUDED.scope,
            started_at = EXCLUDED.started_at,
            completed_at = EXCLUDED.completed_at,
            cancelled = EXCLUDED.cancelled,
            app_version = EXCLUDED.app_version,
            methodology_label = EXCLUDED.methodology_label,
            metrics = EXCLUDED.metrics,
            run_data = EXCLUDED.run_data,
            archive_source = EXCLUDED.archive_source,
            source_sha256 = COALESCE(EXCLUDED.source_sha256, benchmark_runs.source_sha256),
            updated_at = NOW()`,
        benchmarkRunValues(run, createdBy, archiveSource, sourceSha256),
    );
}

async function seedBundledBenchmarkHistory(pool) {
    const archive = loadBundledBenchmarkArchive();
    if (!archive?.runs.length) return { imported: 0, skipped: true, reason: 'archive_missing' };

    const marker = await pool.query('SELECT value FROM app_settings WHERE key = $1', [BUNDLED_ARCHIVE_MARKER]);
    if (marker.rows.length > 0) return { imported: 0, skipped: true, reason: 'already_imported' };

    const adminResult = await pool.query(
        `SELECT id FROM users
         WHERE role = 'admin' AND is_active = true
         ORDER BY created_at ASC
         LIMIT 1`,
    );
    const adminId = adminResult.rows[0]?.id;
    if (!adminId) return { imported: 0, skipped: true, reason: 'admin_missing' };

    let imported = 0;
    for (const entry of archive.runs) {
        const result = await pool.query(
            `${INSERT_BENCHMARK_RUN_SQL} ON CONFLICT (id) DO NOTHING`,
            benchmarkRunValues(entry.run, adminId, 'bundled_archive', entry.sourceSha256),
        );
        imported += result.rowCount || 0;
    }

    await pool.query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()`,
        [
            BUNDLED_ARCHIVE_MARKER,
            JSON.stringify({
                version: archive.version,
                archiveDate: archive.archiveDate,
                archivedRuns: archive.runCount,
                insertedRuns: imported,
            }),
            adminId,
        ],
    );

    return { imported, skipped: false, archivedRuns: archive.runCount };
}

module.exports = {
    BUNDLED_ARCHIVE_PATH,
    loadBundledBenchmarkArchive,
    seedBundledBenchmarkHistory,
    upsertBenchmarkRun,
    validateBenchmarkRun,
};
