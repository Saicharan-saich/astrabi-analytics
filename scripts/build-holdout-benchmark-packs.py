"""Build a disjoint BIRD + genuine Spider 2.0 local evaluation, without LLM calls.

Source questions are never generated/rephrased. No source rows are sampled.
The frozen source selection is based on availability and browser resource limits,
not on candidate-model success. Run --inspect before building.
"""
import argparse
from collections import Counter
import csv
import hashlib
import gzip
import importlib.util
import json
import os
import math
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import threading
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("research_builder", Path(__file__).with_name("build-research-benchmark-packs.py"))
helper = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = helper
spec.loader.exec_module(helper)
SOURCE = ROOT / ".benchmark-source/spider2"
COMMIT = "cafb867313aab4e674652054198f383cf4018943"
VERSION = "quickinsight-holdout-550-v1"
OUTPUT = ROOT / "public/benchmarks/holdout-v1"
SELECTION_LOCK = OUTPUT / "selection-lock.json"

_execute_native_gold = helper.execute_gold
def bounded_native_gold(connection, sql, max_rows):
    deadline = time.monotonic() + 20
    connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    try:
        return _execute_native_gold(connection, sql, max_rows)
    finally:
        connection.set_progress_handler(None, 0)
helper.execute_gold = bounded_native_gold


class CachedValidator(helper.DuckDBValidator):
    """Persist successful fixture checks only; never model answers."""
    def __init__(self, node):
        self.node = node
        os.environ["BENCHMARK_BULK_FIXTURES"] = "1"
        super().__init__(node)
        # v2 preserves SQL projection order. The previous canonical JSON cache
        # sorted object keys, which made positional SQLite/DuckDB comparison
        # depend on whether a result was freshly executed or read from cache.
        self.cache_dir = SOURCE / "validation-cache-v2"
        self.cache_dir.mkdir(exist_ok=True)
        self.asset_hashes = {}
        self.calls = 0

    def execute(self, asset, sql, max_rows):
        if asset["id"] not in self.asset_hashes:
            self.asset_hashes[asset["id"]] = digest(canonical(asset))
        key = digest(canonical([self.asset_hashes[asset["id"]], sql, max_rows]))
        target = self.cache_dir / (key + ".json")
        self.calls += 1
        if self.calls % 25 == 1:
            print(f"Fixture validation {self.calls}: {asset['id']}", flush=True)
        if target.exists():
            return json.loads(target.read_text(encoding="utf-8"))
        watchdog = threading.Timer(30, self.process.kill)
        watchdog.start()
        try:
            result = super().execute(asset, sql, max_rows)
        except (RuntimeError, BrokenPipeError, OSError):
            # Availability is an eligibility constraint, not a model failure.
            self.process.kill()
            self.process.wait()
            helper.DuckDBValidator.__init__(self, self.node)
            result = None
        finally:
            watchdog.cancel()
        if result is not None:
            target.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
        return result


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def normalized(text):
    return re.sub(r"\W+", " ", text.casefold()).strip()


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def extract_databases():
    folder = SOURCE / "databases"
    folder.mkdir(exist_ok=True)
    with zipfile.ZipFile(SOURCE / "local_sqlite.zip") as archive:
        entries = [i for i in archive.infolist() if i.filename.endswith(".sqlite") and "__MACOSX" not in i.filename]
        if sum(i.file_size for i in entries) > 10_000_000_000:
            raise ValueError("Archive exceeds the 10 GB extraction budget")
        for entry in entries:
            # Flatten to a validated file name; never trust archive paths.
            name = Path(entry.filename).name
            if not re.fullmatch(r"[\w .-]+\.sqlite", name):
                raise ValueError(f"Invalid database name {name}")
            target = folder / name
            if not target.exists() or target.stat().st_size != entry.file_size:
                with archive.open(entry) as source, target.open("wb") as destination:
                    shutil.copyfileobj(source, destination)
    return folder


def inspect_local(folder, cases):
    rows = []
    for name, count in Counter(c["db"] for c in cases).items():
        path = folder / f"{name}.sqlite"
        if not path.exists():
            rows.append({"db": name, "cases": count, "missing": True})
            continue
        with sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True) as connection:
            names = list(helper.table_names(connection).values())
            shapes = [helper.table_shape(connection, t) for t in names]
        rows.append({"db": name, "cases": count, "tables": len(names), "rows": sum(r for r,c in shapes), "cells": sum(r*c for r,c in shapes), "empty": sum(r==0 for r,c in shapes), "bytes": path.stat().st_size})
    return rows


def prior_cases():
    """Exclude every version of the old official manifest, not just HEAD."""
    name = "services/benchmark/researchFixtures.generated.ts"
    texts = [(ROOT / name).read_text(encoding="utf-8")]
    commits = subprocess.check_output(["git", "log", "--format=%H", "--", name], cwd=ROOT, text=True).splitlines()
    for commit in commits:
        texts.append(subprocess.check_output(["git", "show", f"{commit}:{name}"], cwd=ROOT).decode("utf-8"))
    result = []
    for text in texts:
        match = re.search(r"const GENERATED = (.+?) satisfies", text, re.S)
        if match:
            result.extend(c for cases in json.loads(match[1]).values() for c in cases)
    # Locally retained run evidence can contain cases outside an old manifest.
    for path in (ROOT / "benchmark-audits").rglob("*.json"):
        try:
            report = json.loads(path.read_text(encoding="utf-8-sig"))
            if isinstance(report, dict):
                result.extend(report.get("results", []))
        except (ValueError, OSError):
            pass
    return result


def choose(cases, count):
    """Balanced difficulty/database/category coverage; never candidate outcomes."""
    pools = {}
    for case in sorted(cases, key=lambda c: digest((VERSION+c["sourceId"]).encode())):
        key = (case["difficulty"], case["sourceId"].split(":")[-1], case["category"])
        pools.setdefault(key, []).append(case)
    selected = []
    while len(selected) < count:
        progress = False
        for pool in pools.values():
            if pool and len(selected) < count:
                selected.append(pool.pop(0))
                progress = True
        if not progress:
            raise ValueError(f"Only {len(selected)} validated disjoint cases; need {count}. Nothing is padded or duplicated.")
    return selected


def asset_ref(asset, assets):
    payload = canonical(asset)
    sha = digest(payload)
    ref = f"/benchmarks/holdout-v1/datasets/{asset['id']}-{sha[:12]}.json.gz"
    assets[ref] = payload
    return {"datasetRef": ref, "datasetSha256": sha}


def csv_rows(path):
    def value(cell):
        if cell == "":
            return None
        # Preserve leading-zero identifiers; the comparator handles numeric strings.
        if re.fullmatch(r"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?", cell):
            return float(cell) if any(c in cell for c in ".eE") else int(cell)
        return cell
    with path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        headers = reader.fieldnames or []
        if not headers or len(set(headers)) != len(headers):
            raise ValueError("Invalid reference CSV columns")
        rows = [{k: value(v) for k,v in row.items()} for row in reader]
    return headers, rows


def same_result_values(left, right):
    """Ignore dialect-dependent headings/order, but preserve row associations."""
    if left is None or len(left) != len(right):
        return False
    def scalar(a, b):
        if a is None or b is None:
            return a is None and b is None
        if isinstance(a, (float, int)) and isinstance(b, (float, int)):
            return math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-6)
        return str(a) == str(b)
    def column_key(name):
        return re.sub(r"\W+", "", str(name).casefold())
    left_names = list(left[0]) if left else []
    right_names = list(right[0]) if right else []
    left_by_name = {column_key(name): name for name in left_names}
    right_by_name = {column_key(name): name for name in right_names}
    names_align = len(left_by_name) == len(left_names) and set(left_by_name) == set(right_by_name)
    def values(row, names, by_name):
        if names_align:
            return [row[by_name[key]] for key in sorted(left_by_name)]
        return [row[name] for name in names]
    unmatched = [values(row, right_names, right_by_name) for row in right]
    for row in left:
        row_values = values(row, left_names, left_by_name)
        found = next((i for i, other in enumerate(unmatched) if len(row_values) == len(other) and all(scalar(a,b) for a,b in zip(row_values, other))), None)
        if found is None:
            return False
        unmatched.pop(found)
    return True


def spider_cases(folder, cases, assets, validator, max_rows, max_cells):
    scopes = {c["instance_id"]: c["gold_tables"] for c in read_jsonl(SOURCE / "methods/gold-tables/spider2-lite-gold-tables.jsonl")}
    standards = {c["instance_id"]: c for c in read_jsonl(SOURCE / "spider2-lite/evaluation_suite/gold/spider2lite_eval.jsonl")}
    eligible, rejected, cache = [], Counter(), {}
    for case in cases:
        source_id = case["instance_id"]
        tables = scopes[source_id]
        with sqlite3.connect(f"file:{(folder / (case['db']+'.sqlite')).as_posix()}?mode=ro", uri=True) as db:
            available = helper.table_names(db)
            if any(t.lower() not in available or helper.safe_slug(t).replace('-', '_') != t.lower() for t in tables):
                rejected["table_names"] += 1
                continue
            tables = [available[t.lower()] for t in tables]
            shapes = [helper.table_shape(db, t) for t in tables]
            if any(r==0 for r,c in shapes) or sum(r for r,c in shapes)>max_rows or sum(r*c for r,c in shapes)>max_cells:
                rejected["fixture_budget_or_empty_table"] += 1
                continue
            cache_key = (case["db"], tuple(tables))
            if cache_key not in cache:
                source = helper.SourceCase(0, source_id, case["db"], case["question"], "", None, "hard")
                cache[cache_key] = helper.build_dataset_asset("spider2-lite", source, tables, db)
            asset = cache[cache_key]
        if not asset:
            rejected["unsupported_values"] += 1
            continue
        # Probe every source-table column through the same WASM loader. Do not
        # use or generate a candidate analytical answer during fixture validation.
        probe = "SELECT " + ", ".join(f'(SELECT COUNT(*) FROM "{t}") AS "table_{i}"' for i,t in enumerate(tables))
        counts = validator.execute(asset, probe, 1)
        if not counts or any(counts[0].get(f"table_{i}") != shapes[i][0] for i in range(len(tables))):
            rejected["duckdb_load"] += 1
            continue
        base = SOURCE / "spider2-lite/evaluation_suite/gold/exec_result"
        paths = [base / f"{source_id}.csv"] if (base / f"{source_id}.csv").exists() else sorted(base.glob(f"{source_id}_*.csv"))
        standard = standards[source_id]
        conditions = standard.get("condition_cols", [])
        alternatives = []
        try:
            for i,path in enumerate(paths):
                headers, rows = csv_rows(path)
                if not rows or len(rows)>500:
                    continue
                columns = conditions[i] if conditions and isinstance(conditions[0], list) else conditions
                if any(not isinstance(c, int) or c<0 or c>=len(headers) for c in columns):
                    raise ValueError("Reference column index out of range")
                selected_columns = [headers[c] for c in columns] if columns else headers
                alternatives.append({"source": path.relative_to(SOURCE).as_posix(), "sha256": digest(path.read_bytes()), "rows": [{k: row[k] for k in selected_columns} for row in rows], "conditionColumns": columns})
        except (ValueError, IndexError):
            rejected["reference_format"] += 1
            continue
        if not alternatives:
            rejected["missing_or_large_reference"] += 1
            continue
        knowledge = case.get("external_knowledge")
        context = None
        if knowledge:
            resource = SOURCE / "spider2-lite/resource/documents" / knowledge
            if not resource.is_file():
                rejected["missing_document"] += 1
                continue
            context = resource.read_text(encoding="utf-8")
        sql_path = SOURCE / "spider2-lite/evaluation_suite/gold/sql" / f"{source_id}.sql"
        sql = sql_path.read_text(encoding="utf-8") if sql_path.exists() else ""
        eligible.append({
            "id": f"holdout-spider2-{source_id}", "suiteId": "spider2-lite-holdout", "sourceId": f"spider2-lite:{source_id}:{case['db']}",
            "question": case["question"], "context": context, "category": "Multi-table reasoning" if len(tables)>1 else "Advanced analytics", "difficulty": "hard",
            **asset_ref(asset, assets), "goldSql": sql, "expectedRows": alternatives[0]["rows"],
            "referenceResult": {"kind": "published-result", "sourceCommit": COMMIT, "alternatives": alternatives},
            "comparison": {"orderMatters": not standard.get("ignore_order", False), "strictColumns": False, "absoluteTolerance": 0.01, "relativeTolerance": 1e-9},
            "tags": ["official-spider2-lite", "sqlite-source", "duckdb-adapted", "oracle-tables", case["db"], *tables],
        })
    return eligible, rejected


def bird_cases(prior, assets, validator, args, preserved_source_ids=frozenset()):
    source_path = ROOT / ".benchmark-source/bird/dev_20240627/dev.json"
    source = helper.load_bird_cases(source_path)
    prior = [c for c in prior if c.get("sourceId") not in preserved_source_ids]
    banned_ids = {c.get("sourceId") for c in prior}
    banned_questions = {normalized(c.get("question", "")) for c in prior}
    banned_sql = {normalized(c.get("goldSql", "")) for c in prior if c.get("goldSql")}
    questions, sqls = set(banned_questions), set(banned_sql)
    fresh = []
    excluded = 0
    for case in source:
        question, sql = normalized(case.question), normalized(case.gold_sql)
        if case.source_id in banned_ids or question in questions or sql in sqls:
            excluded += 1
            continue
        questions.add(question)
        sqls.add(sql)
        fresh.append(case)
    print(f"BIRD: validating {len(fresh)} unused, deduplicated source cases ({excluded} excluded)", flush=True)
    eligible, data, rejected = helper.find_eligible("bird", fresh, ROOT / ".benchmark-source/bird/dev_20240627/dev_databases/dev_databases", OUTPUT / "datasets", args, validator)
    results = []
    for item in eligible:
        # A successful DuckDB query is insufficient: dialect/coercion changes
        # must not silently redefine the published SQLite answer.
        path = helper.database_path(ROOT / ".benchmark-source/bird/dev_20240627/dev_databases/dev_databases", item.source.db_id)
        with sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True) as db:
            native = helper.execute_gold(db, item.source.gold_sql, args.max_result_rows)
        if not same_result_values(native, item.expected_rows):
            if item.source.source_id not in preserved_source_ids:
                rejected["sqlite_duckdb_result_difference"] += 1
                continue
            # A frozen selection remains reproducible even if dialect tie
            # ordering/coercion differs on a later rebuild. The oracle-quality
            # audit quarantines such cases from scoring.
            rejected["locked_sqlite_duckdb_result_difference"] += 1
        case = helper.typescript_case("bird-dev", "bird-dev-holdout", item)
        case["id"] = "holdout-" + case["id"]
        case.update(asset_ref(data[item.dataset_ref], assets))
        case["tags"] += ["new-catalog-holdout", "oracle-tables"]
        results.append(case)
    return results, rejected, excluded


def build(folder, cases, args):
    selection_lock = json.loads(SELECTION_LOCK.read_text(encoding="utf-8")) if SELECTION_LOCK.exists() else None
    locked_source_ids = selection_lock.get("sourceIds", []) if selection_lock else []
    if selection_lock and (selection_lock.get("version") != VERSION or len(locked_source_ids) != 550):
        raise ValueError("The holdout selection lock is invalid or belongs to a different corpus version")
    prior = prior_cases()
    assets = {}
    validator = CachedValidator(args.node)
    try:
        spider, spider_rejected = spider_cases(folder, cases, assets, validator, args.max_table_rows, args.max_table_cells)
        print(f"Spider 2.0: {len(spider)} eligible; exclusions {dict(spider_rejected)}", flush=True)
        bird, bird_rejected, excluded = bird_cases(prior, assets, validator, args, frozenset(locked_source_ids))
    finally:
        validator.close()
    if locked_source_ids:
        eligible_by_source = {case["sourceId"]: case for case in [*bird, *spider]}
        missing = [source_id for source_id in locked_source_ids if source_id not in eligible_by_source]
        if missing:
            raise ValueError(f"Selection-lock cases are no longer eligible: {missing}")
        selected = [eligible_by_source[source_id] for source_id in locked_source_ids]
    else:
        selected = choose(bird, 500) + choose(spider, 50)
    old_questions = {normalized(c.get("question", "")) for c in prior}
    assert len({normalized(c["question"]) for c in selected}) == 550
    assert not old_questions.intersection(normalized(c["question"]) for c in selected)
    needed = {case["datasetRef"] for case in selected}
    manifest = {
        "schemaVersion": 1, "corpusId": "holdout-550", "version": VERSION, "count": 550,
        "assetEncoding": "gzip; SHA-256 refers to decompressed canonical JSON bytes",
        "selection": "Fixed SHA-256 rank, round-robin difficulty/database/category; no candidate pipeline calls; 500 BIRD + 50 Spider 2.0 Lite SQLite; oracle table scope, complete table rows. BIRD frozen values cross-checked against native SQLite.",
        "novelty": "Disjoint source IDs, normalized question text and BIRD gold SQL versus versioned old manifests and retained local reports. Public sources may have appeared in model training. Not a guarantee about every past user chat.",
        "sourceCommit": COMMIT, "birdSourceSha256": digest((ROOT / ".benchmark-source/bird/dev_20240627/dev.json").read_bytes()),
        "spider2ArchiveSha256": digest((SOURCE / "local_sqlite.zip").read_bytes()),
        "priorSourceIds": sorted({c["sourceId"] for c in prior if c.get("sourceId")}),
        "constraints": {"maxTableRows": args.max_table_rows, "maxTableCells": args.max_table_cells, "maxTables": args.max_tables, "maxResultRows": 500, "nativeQuerySeconds": 20, "duckdbQuerySeconds": 30},
        "eligible": {"bird": len(bird), "spider2": len(spider)}, "rejected": {"bird": dict(bird_rejected), "spider2": dict(spider_rejected), "birdPreviouslyUsedOrDuplicate": excluded},
        "caseIds": [c["id"] for c in selected], "sourceIds": [c["sourceId"] for c in selected],
        "caseSha256": {c["id"]: digest(canonical(c)) for c in selected},
        "assets": {ref: digest(assets[ref]) for ref in sorted(needed)},
    }
    manifest_hash = digest(canonical(manifest))
    manifest["manifestSha256"] = manifest_hash
    # Only publish after exact count and all integrity/overlap checks succeed.
    for ref in needed:
        target = ROOT / "public" / ref.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(gzip.compress(assets[ref], compresslevel=9, mtime=0))
    (OUTPUT / "manifest.json").write_bytes(canonical(manifest))
    header = "// Generated by scripts/build-holdout-benchmark-packs.py. Never edit case content manually.\nimport type { BenchmarkCase, BenchmarkSuite } from './types';\n"
    content = header + "const CASES: BenchmarkCase[] = " + json.dumps(selected, ensure_ascii=False, indent=2) + ";\n"
    content += f"export const HOLDOUT_MANIFEST_SHA256 = '{manifest_hash}';\n"
    suites = []
    for suite_id, name, short, benchmark, homepage, license_name in [
        ("bird-dev-holdout", "New BIRD Public Dev Subset", "New BIRD", "BIRD public dev", "https://bird-bench.github.io/", "CC BY-SA 4.0"),
        ("spider2-lite-holdout", "New Spider 2.0 Lite SQLite Subset", "Spider 2.0 Lite", "Spider 2.0 Lite", "https://github.com/xlang-ai/Spider2", "Upstream source terms; repository MIT"),
    ]:
        count = sum(c["suiteId"]==suite_id for c in selected)
        suite = {"id": suite_id, "name": name, "shortName": short, "version": VERSION, "corpusId": "holdout-550", "manifestSha256": manifest_hash,
                 "description": f"{count} original, previously unselected questions. Complete oracle-scoped tables; locally executed in DuckDB.",
                 "methodology": "Disjoint public-source, oracle-table, DuckDB-adapted subset. Not an official leaderboard score or a guarantee of model-training novelty.",
                 "accent": "cyan" if "bird" in suite_id else "amber", "evaluationClass": "official-public-subset",
                 "attribution": {"benchmark": benchmark, "homepage": homepage, "license": license_name, "notice": "Original questions and source data; frozen reference outputs. See holdout-v1/manifest.json and NOTICE.md."}}
        suites.append(json.dumps(suite, ensure_ascii=False)[:-1]+f", cases: CASES.filter(c => c.suiteId === '{suite_id}')"+"}")
    content += "export const HOLDOUT_BENCHMARK_SUITES: BenchmarkSuite[] = [\n"+",\n".join(suites)+"\n];\n"
    (ROOT / "services/benchmark/holdoutFixtures.generated.ts").write_text(content, encoding="utf-8")
    print(json.dumps({"selected": 550, "bird": 500, "spider2": 50, "assets": len(needed), "assetBytes": sum(len(assets[x]) for x in needed), "manifestSha256": manifest_hash}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--node", default="node")
    parser.add_argument("--max-table-rows", type=int, default=50000)
    parser.add_argument("--max-table-cells", type=int, default=1000000)
    parser.add_argument("--max-tables", type=int, default=6)
    parser.add_argument("--max-result-rows", type=int, default=500)
    args = parser.parse_args()
    cases = [c for c in read_jsonl(SOURCE / "spider2-lite/spider2-lite.jsonl") if c["instance_id"].startswith("local")]
    folder = extract_databases()
    if args.inspect:
        print(json.dumps(inspect_local(folder, cases), indent=2), flush=True)
    else:
        build(folder, cases, args)
