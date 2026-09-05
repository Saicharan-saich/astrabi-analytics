# Benchmark history persistence

Benchmark Lab archives complete run exports in PostgreSQL so research evidence
is not lost when a browser profile, IndexedDB database, or deployment origin is
cleared. IndexedDB remains a private cache for the 20 most recent runs; it is no
longer the source of truth.

## Database record

`benchmark_runs` stores one row per stable Benchmark Lab run ID. Indexed columns
retain the corpus, privacy mode, scope, timestamps, application version, and
methodology. The `run_data` JSONB column preserves the complete exported run,
including case results, candidate and gold SQL, recorded result rows,
comparisons, token usage, failures, and any later adjudication evidence.

The archive is available only through authenticated administrator routes:

- `GET /api/admin/benchmark-runs`
- `POST /api/admin/benchmark-runs`
- `DELETE /api/admin/benchmark-runs/:id`

New completed, paused, resumed, or adjudicated runs are upserted automatically.
Deleting a history record removes both its browser cache entry and database
record.

## Historical evidence restoration

`backend/seed-data/benchmark-runs-v1.json.gz` contains 11 unique exported runs
from 11 August through 3 September 2026. Every entry preserves its source-file
SHA-256. Duplicate exports were collapsed by stable run ID, preferring the
version with the most complete answer-level review evidence.

The backend imports this archive once, assigns it to the earliest active admin,
and records the import marker in `app_settings`. Inserts are idempotent and never
overwrite a database record with the same run ID. The archive contains no
credentials, connection strings, or email addresses.

To rebuild the archive from retained JSON exports, run:

```powershell
python scripts/build-benchmark-history-seed.py `
  --input <export-folder> `
  --output backend/seed-data/benchmark-runs-v1.json.gz `
  --archive-date YYYY-MM-DD
```
