#!/usr/bin/env python3
"""Build a deterministic, compressed archive of exported Benchmark Lab runs.

The archive is intentionally generated from exported evidence rather than from
summaries. Duplicate run IDs are collapsed to the richest available export so
human-verification annotations are retained when present.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def candidate_files(inputs: Iterable[Path]) -> Iterable[Path]:
    for item in inputs:
        if item.is_file() and item.suffix.lower() == ".json":
            yield item
        elif item.is_dir():
            yield from item.rglob("*.json")


def read_run(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    if value.get("schemaVersion") != 1 or not isinstance(value.get("id"), str):
        return None
    if not isinstance(value.get("results"), list) or not isinstance(value.get("metrics"), dict):
        return None
    return value


def evidence_score(run: dict[str, Any], path: Path) -> tuple[int, int, int, int]:
    results = run.get("results", [])
    reviewed = sum(
        1
        for result in results
        if isinstance(result, dict)
        and (result.get("humanVerification") or result.get("adjudication"))
    )
    has_review_summary = int(bool(run.get("humanVerificationSummary")))
    completed_at = int(run.get("completedAt") or 0)
    return reviewed, has_review_summary, len(results), completed_at or int(path.stat().st_mtime_ns)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--archive-date", required=True)
    args = parser.parse_args()

    selected: dict[str, tuple[dict[str, Any], Path]] = {}
    for path in candidate_files(args.input):
        run = read_run(path)
        if run is None:
            continue
        existing = selected.get(run["id"])
        if existing is None or evidence_score(run, path) > evidence_score(*existing):
            selected[run["id"]] = (run, path)

    if not selected:
        raise SystemExit("No valid Benchmark Lab run exports were found")

    entries = []
    for run, source in sorted(selected.values(), key=lambda item: int(item[0].get("startedAt") or 0)):
        entries.append(
            {
                "run": run,
                "sourceFile": source.name,
                "sourceSha256": sha256(source),
            }
        )

    archive = {
        "version": "quickinsight-benchmark-history-v1",
        "archiveDate": args.archive_date,
        "runCount": len(entries),
        "runs": entries,
    }
    payload = json.dumps(archive, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            compressed.write(payload)

    print(f"Wrote {len(entries)} unique runs to {args.output}")
    for entry in entries:
        run = entry["run"]
        print(
            f"  {run['id']} | {run.get('privacyMode') or 'unspecified'} | "
            f"{len(run['results'])}/{run.get('metrics', {}).get('total', '?')} results | "
            f"{entry['sourceFile']}"
        )


if __name__ == "__main__":
    main()
