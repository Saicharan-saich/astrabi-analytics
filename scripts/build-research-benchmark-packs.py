#!/usr/bin/env python3
"""Build reproducible, browser-loadable Spider and BIRD research subsets.

This script intentionally selects only public development questions whose gold
SQL can be executed against a small, self-contained set of SQLite tables. It
does not invent questions or gold answers. The generated TypeScript manifest
contains provenance and frozen outputs; table rows are stored as lazy JSON
assets so they do not inflate QuickInsight's initial JavaScript bundle.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import re
import sqlite3
import subprocess
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


TABLE_REFERENCE = re.compile(
    r"\b(?:from|join)\s+((?:\"[^\"]+\"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\.(?:\"[^\"]+\"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*))?)",
    re.IGNORECASE,
)
UNSUPPORTED = re.compile(
    r"\b(?:insert|update|delete|drop|alter|create|attach|pragma|vacuum|replace)\b|\b(?:regexp|match|glob)\b|(?:'now'|\"now\")",
    re.IGNORECASE,
)


@dataclass
class SourceCase:
    source_index: int
    source_id: str
    db_id: str
    question: str
    gold_sql: str
    evidence: str | None
    difficulty: str


@dataclass
class EligibleCase:
    source: SourceCase
    tables: list[str]
    expected_rows: list[dict[str, Any]]
    dataset_ref: str
    category: str
    table_rows: int
    table_cells: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spider-root", type=Path, required=True)
    parser.add_argument("--bird-root", type=Path, required=True)
    parser.add_argument("--bird-manifest", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--typescript-output", type=Path, required=True)
    parser.add_argument("--count", type=int, default=200)
    parser.add_argument("--node", default="node", help="Node.js executable used for DuckDB-WASM validation")
    parser.add_argument("--max-tables", type=int, default=3)
    parser.add_argument("--max-table-rows", type=int, default=12_000)
    parser.add_argument("--max-table-cells", type=int, default=240_000)
    parser.add_argument("--max-result-rows", type=int, default=200)
    return parser.parse_args()


def clean_identifier(value: str) -> str:
    value = value.strip()
    if "." in value:
        value = value.split(".")[-1]
    if len(value) >= 2 and ((value[0], value[-1]) in {("\"", "\""), ("`", "`"), ("[", "]")}):
        value = value[1:-1]
    return value


def safe_slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "dataset"


def json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, bytes):
        return {"__base64": base64.b64encode(value).decode("ascii")}
    return str(value)


def normalize_difficulty(value: str | None, sql: str, table_count: int) -> str:
    lookup = {"simple": "easy", "moderate": "medium", "challenging": "hard"}
    if value and value.lower() in lookup:
        return lookup[value.lower()]
    complexity = len(re.findall(r"\bselect\b", sql, re.IGNORECASE)) - 1
    complexity += max(0, table_count - 1)
    complexity += sum(bool(re.search(fr"\b{token}\b", sql, re.IGNORECASE)) for token in ("having", "case", "intersect", "except", "union"))
    if complexity >= 2:
        return "hard"
    if complexity or re.search(r"\b(group\s+by|order\s+by|limit|distinct)\b", sql, re.IGNORECASE):
        return "medium"
    return "easy"


def category_for(sql: str, table_count: int) -> str:
    if table_count > 1:
        return "Multi-table reasoning"
    if re.search(r"\b(over|lag|lead|row_number|rank)\s*\(", sql, re.IGNORECASE):
        return "Window analytics"
    if re.search(r"\b(order\s+by)\b", sql, re.IGNORECASE) and re.search(r"\blimit\b", sql, re.IGNORECASE):
        return "Ranking"
    if re.search(r"\b(group\s+by|having)\b", sql, re.IGNORECASE):
        return "Grouped aggregation"
    if re.search(r"\b(sum|avg|count|min|max)\s*\(", sql, re.IGNORECASE):
        return "Aggregation"
    if re.search(r"\bwhere\b", sql, re.IGNORECASE):
        return "Filter"
    return "Projection"


def source_rank(prefix: str, case: SourceCase) -> str:
    payload = f"quickinsight-research-v1|{prefix}|{case.source_id}|{case.question}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_spider_cases(root: Path) -> list[SourceCase]:
    records = json.loads((root / "dev.json").read_text(encoding="utf-8"))
    return [
        SourceCase(
            source_index=index,
            source_id=f"spider-dev:{index}:{record['db_id']}",
            db_id=record["db_id"],
            question=record["question"].strip(),
            gold_sql=record["query"].strip().rstrip(";"),
            evidence=None,
            difficulty="",
        )
        for index, record in enumerate(records)
    ]


def load_bird_cases(path: Path) -> list[SourceCase]:
    records = json.loads(path.read_text(encoding="utf-8"))
    return [
        SourceCase(
            source_index=int(record.get("question_id", index)),
            source_id=f"bird-dev:{record.get('question_id', index)}:{record['db_id']}",
            db_id=record["db_id"],
            question=record["question"].strip(),
            gold_sql=(record.get("SQL") or record.get("sql") or "").strip().rstrip(";"),
            evidence=(record.get("evidence") or "").strip() or None,
            difficulty=record.get("difficulty", ""),
        )
        for index, record in enumerate(records)
    ]


def database_path(root: Path, db_id: str) -> Path | None:
    candidates = [root / db_id / f"{db_id}.sqlite", root / "database" / db_id / f"{db_id}.sqlite"]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    matches = list(root.glob(f"**/{db_id}.sqlite"))
    return matches[0] if matches else None


def table_names(connection: sqlite3.Connection) -> dict[str, str]:
    rows = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
    return {str(row[0]).lower(): str(row[0]) for row in rows}


def referenced_tables(sql: str, available: dict[str, str]) -> list[str]:
    found: list[str] = []
    for match in TABLE_REFERENCE.finditer(sql):
        name = clean_identifier(match.group(1))
        actual = available.get(name.lower())
        if not actual:
            return []
        if actual not in found:
            found.append(actual)
    return found


def table_column_info(connection: sqlite3.Connection, table: str) -> list[tuple[Any, ...]]:
    """Return one authoritative, selectable SQLite column list.

    ``PRAGMA table_info`` omits generated columns while ``SELECT *`` includes
    them. Pairing those two shapes shifted every value after a generated
    column into the wrong field in holdout fixtures. ``table_xinfo`` includes
    generated columns; hidden virtual-table implementation columns (hidden=1)
    are deliberately excluded because they are not part of the user schema.
    """
    quoted = table.replace('"', '""')
    rows = connection.execute(f'PRAGMA table_xinfo("{quoted}")').fetchall()
    if not rows:  # Compatibility with older SQLite builds.
        rows = connection.execute(f'PRAGMA table_info("{quoted}")').fetchall()
    return [row for row in rows if len(row) < 7 or int(row[6] or 0) != 1]


def table_shape(connection: sqlite3.Connection, table: str) -> tuple[int, int]:
    quoted = table.replace('"', '""')
    row_count = int(connection.execute(f'SELECT COUNT(*) FROM "{quoted}"').fetchone()[0])
    column_count = len(table_column_info(connection, table))
    return row_count, column_count


def execute_gold(connection: sqlite3.Connection, sql: str, max_rows: int) -> list[dict[str, Any]] | None:
    try:
        cursor = connection.execute(sql)
        names = [str(item[0]) for item in cursor.description or []]
        if not names or len({name.lower() for name in names}) != len(names):
            return None
        rows = cursor.fetchmany(max_rows + 1)
        if len(rows) > max_rows:
            return None
        return [{name: json_value(value) for name, value in zip(names, row)} for row in rows]
    except sqlite3.Error:
        return None


def infer_column_type(name: str, declared: str, values: Iterable[Any]) -> str:
    lowered = name.lower()
    declared_upper = declared.upper()
    non_null = [value for value in values if value is not None][:200]
    if re.search(r"(^|_)(date|time|year|month|day)($|_)", lowered) or any(token in declared_upper for token in ("DATE", "TIME")):
        return "DATE"
    if lowered == "id" or lowered.endswith("_id") or lowered.endswith("id") and " " not in lowered:
        return "ID"
    if non_null and all(isinstance(value, (bool, int)) and value in (0, 1, True, False) for value in non_null):
        return "BOOLEAN"
    if any(isinstance(value, (int, float)) and not isinstance(value, bool) for value in non_null):
        return "METRIC"
    return "DIMENSION"


def read_table(connection: sqlite3.Connection, table: str) -> tuple[list[dict[str, Any]], list[dict[str, str]]] | None:
    quoted = table.replace('"', '""')
    info = table_column_info(connection, table)
    names = [str(row[1]) for row in info]
    projection = ", ".join(f'"{name.replace(chr(34), chr(34) * 2)}"' for name in names)
    try:
        raw_rows = connection.execute(f'SELECT {projection} FROM "{quoted}"').fetchall()
    except sqlite3.Error:
        return None
    if any(isinstance(value, bytes) for row in raw_rows for value in row):
        return None
    rows = [{name: json_value(value) for name, value in zip(names, row)} for row in raw_rows]
    columns = [
        {
            "name": name,
            "type": infer_column_type(name, str(info[index][2] or ""), (row[index] for row in raw_rows)),
            "originalType": str(info[index][2] or "TEXT"),
        }
        for index, name in enumerate(names)
    ]
    return rows, columns


class DuckDBValidator:
    """Persistent JSON-lines bridge to the repository's DuckDB-WASM build."""

    def __init__(self, node_executable: str) -> None:
        helper = Path(__file__).with_name("duckdb-benchmark-validator.cjs")
        self.process = subprocess.Popen(
            [node_executable, str(helper)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

    def execute(self, asset: dict[str, Any], sql: str, max_rows: int) -> list[dict[str, Any]] | None:
        if not self.process.stdin or not self.process.stdout:
            return None
        request = json.dumps({"asset": asset, "sql": sql, "maxRows": max_rows}, ensure_ascii=False, separators=(",", ":"))
        self.process.stdin.write(request + "\n")
        self.process.stdin.flush()
        response_line = self.process.stdout.readline()
        if not response_line:
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise RuntimeError(f"DuckDB validator stopped unexpectedly. {stderr}")
        response = json.loads(response_line)
        return response.get("rows") if response.get("ok") else None

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()


def asset_id(prefix: str, db_id: str, tables: list[str]) -> str:
    digest = hashlib.sha256("|".join(sorted(tables)).encode("utf-8")).hexdigest()[:10]
    return f"{prefix}--{safe_slug(db_id)}--{digest}"


def read_source_schema(connection: sqlite3.Connection, tables: list[str]) -> dict[str, Any]:
    """Preserve declared SQLite keys so AI SQL never has to guess joins."""
    table_lookup = {table.lower(): table for table in tables}
    schema_tables: list[dict[str, Any]] = []
    join_edges: list[dict[str, str]] = []
    for table in tables:
        quoted = table.replace('"', '""')
        info = table_column_info(connection, table)
        row_count = int(connection.execute(f'SELECT COUNT(*) FROM "{quoted}"').fetchone()[0])
        schema_tables.append({
            "name": table,
            "rows": row_count,
            "columns": [{
                "name": str(column[1]),
                "dataType": str(column[2] or "TEXT"),
                "isPK": bool(column[5]),
                "isNullable": not bool(column[3]) and not bool(column[5]),
                **({"isGenerated": True} if len(column) >= 7 and int(column[6] or 0) in (2, 3) else {}),
            } for column in info],
        })
        for foreign_key in connection.execute(f'PRAGMA foreign_key_list("{quoted}")').fetchall():
            target = table_lookup.get(str(foreign_key[2]).lower())
            if not target:
                continue
            join_edges.append({
                "leftTable": table,
                "rightTable": target,
                "leftColumn": str(foreign_key[3]),
                "rightColumn": str(foreign_key[4]),
                "type": "fk",
            })
    return {
        "tables": schema_tables,
        "joinEdges": join_edges,
        "joinLogs": [f"Loaded {len(join_edges)} declared SQLite foreign-key relationship(s)."],
    }


def build_dataset_asset(prefix: str, case: SourceCase, tables: list[str], connection: sqlite3.Connection) -> dict[str, Any] | None:
    loaded: list[tuple[str, list[dict[str, Any]], list[dict[str, str]]]] = []
    for table in tables:
        result = read_table(connection, table)
        if result is None:
            return None
        rows, columns = result
        loaded.append((table, rows, columns))
    primary_name, primary_rows, primary_columns = loaded[0]
    dataset_id = asset_id(prefix, case.db_id, tables)
    return {
        "id": dataset_id,
        "name": f"{prefix.upper()} · {case.db_id}",
        "rows": primary_rows,
        "columns": primary_columns,
        "totalRows": len(primary_rows),
        "etlLogs": [{
            "step": "Research benchmark fixture",
            "details": f"Unmodified public benchmark table set: {', '.join(tables)}",
            "status": "info",
            "timestamp": 0,
        }],
        "relatedTables": [{"name": name, "rows": rows} for name, rows, _ in loaded],
        "sourceSchema": read_source_schema(connection, tables),
        "version": 1,
        "createdAt": 0,
    }


def find_eligible(
    prefix: str,
    cases: list[SourceCase],
    db_root: Path,
    output_datasets: Path,
    args: argparse.Namespace,
    validator: DuckDBValidator,
) -> tuple[list[EligibleCase], dict[str, dict[str, Any]], Counter[str]]:
    eligible: list[EligibleCase] = []
    assets: dict[str, dict[str, Any]] = {}
    rejected: Counter[str] = Counter()
    connections: dict[str, sqlite3.Connection] = {}
    available_tables: dict[str, dict[str, str]] = {}

    try:
        for case in cases:
            if not case.gold_sql or not case.gold_sql.lstrip().lower().startswith("select") or UNSUPPORTED.search(case.gold_sql):
                rejected["unsupported_sql"] += 1
                continue
            path = database_path(db_root, case.db_id)
            if path is None:
                rejected["missing_database"] += 1
                continue
            if case.db_id not in connections:
                connections[case.db_id] = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
                available_tables[case.db_id] = table_names(connections[case.db_id])
            connection = connections[case.db_id]
            tables = referenced_tables(case.gold_sql, available_tables[case.db_id])
            if not tables or len(tables) > args.max_tables:
                rejected["table_scope"] += 1
                continue
            # DuckDB's loader sanitizes table names; retain only references that
            # remain identical under that product rule.
            if any(safe_slug(table).replace("-", "_") != table.lower() for table in tables):
                rejected["unsafe_table_name"] += 1
                continue
            shapes = [table_shape(connection, table) for table in tables]
            total_rows = sum(rows for rows, _ in shapes)
            total_cells = sum(rows * columns for rows, columns in shapes)
            if total_rows > args.max_table_rows or total_cells > args.max_table_cells:
                rejected["fixture_too_large"] += 1
                continue
            sqlite_expected = execute_gold(connection, case.gold_sql, args.max_result_rows)
            if sqlite_expected is None:
                rejected["gold_or_result"] += 1
                continue
            ref = asset_id(prefix, case.db_id, tables)
            if ref not in assets:
                asset = build_dataset_asset(prefix, case, tables, connection)
                if asset is None:
                    rejected["unsupported_values"] += 1
                    continue
                assets[ref] = asset
            expected = validator.execute(assets[ref], case.gold_sql, args.max_result_rows)
            if expected is None:
                rejected["duckdb_incompatible"] += 1
                continue
            eligible.append(EligibleCase(
                source=case,
                tables=tables,
                expected_rows=expected,
                dataset_ref=ref,
                category=category_for(case.gold_sql, len(tables)),
                table_rows=total_rows,
                table_cells=total_cells,
            ))
    finally:
        for connection in connections.values():
            connection.close()

    output_datasets.mkdir(parents=True, exist_ok=True)
    return eligible, assets, rejected


def select_cases(prefix: str, eligible: list[EligibleCase], count: int) -> list[EligibleCase]:
    # Deterministic diversity pass: first include one question per database,
    # then per database/table-set/category, then fill by a fixed SHA-256 rank.
    ranked = sorted(eligible, key=lambda item: source_rank(prefix, item.source))
    selected: list[EligibleCase] = []
    selected_ids: set[str] = set()
    dimensions = [
        lambda item: item.source.db_id,
        lambda item: f"{item.source.db_id}|{'|'.join(item.tables)}|{item.category}",
    ]
    for dimension in dimensions:
        seen: set[str] = set()
        for item in ranked:
            key = dimension(item)
            if key in seen or item.source.source_id in selected_ids:
                continue
            seen.add(key)
            selected.append(item)
            selected_ids.add(item.source.source_id)
            if len(selected) >= count:
                return selected
    for item in ranked:
        if item.source.source_id in selected_ids:
            continue
        selected.append(item)
        selected_ids.add(item.source.source_id)
        if len(selected) >= count:
            break
    if len(selected) < count:
        raise RuntimeError(f"Only {len(selected)} eligible {prefix} cases; requested {count}.")
    return selected


def write_assets(output_root: Path, selected: list[EligibleCase], assets: dict[str, dict[str, Any]]) -> list[str]:
    needed = sorted({item.dataset_ref for item in selected})
    datasets_root = output_root / "datasets"
    datasets_root.mkdir(parents=True, exist_ok=True)
    for ref in needed:
        payload = json.dumps(assets[ref], ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        (datasets_root / f"{ref}.json").write_text(payload, encoding="utf-8")
    return needed


def typescript_case(prefix: str, suite_id: str, item: EligibleCase) -> dict[str, Any]:
    source = item.source
    return {
        "id": f"{prefix}-{source.source_index:04d}",
        "suiteId": suite_id,
        "sourceId": source.source_id,
        "question": source.question,
        "context": source.evidence,
        "category": item.category,
        "difficulty": normalize_difficulty(source.difficulty, source.gold_sql, len(item.tables)),
        "datasetRef": f"/benchmarks/research-v1/datasets/{item.dataset_ref}.json",
        "goldSql": source.gold_sql,
        "expectedRows": item.expected_rows,
        "comparison": {
            "orderMatters": False,
            "strictColumns": False,
            "absoluteTolerance": 1e-5,
            "relativeTolerance": 1e-5,
        },
        "tags": ["official-public-dev", prefix, source.db_id, *item.tables],
    }


def emit_typescript(path: Path, spider: list[EligibleCase], bird: list[EligibleCase], manifest_sha: str) -> None:
    spider_cases = [typescript_case("spider-dev", "spider-dev-research", item) for item in spider]
    bird_cases = [typescript_case("bird-dev", "bird-dev-research", item) for item in bird]
    cases_json = json.dumps({"spider": spider_cases, "bird": bird_cases}, ensure_ascii=False, indent=2)
    # JSON is valid TypeScript except for null, booleans, and quoted keys, all of
    # which are valid in object literals. `satisfies` keeps the file type-safe.
    content = f"""// AUTO-GENERATED by scripts/build-research-benchmark-packs.py.
// Do not edit case contents manually. Research manifest SHA-256: {manifest_sha}
import type {{ BenchmarkCase, BenchmarkSuite }} from './types';

const GENERATED = {cases_json} satisfies {{ spider: BenchmarkCase[]; bird: BenchmarkCase[] }};

export const RESEARCH_BENCHMARK_SUITES: BenchmarkSuite[] = [
  {{
    id: 'spider-dev-research',
    name: 'Spider Public Dev Research Subset',
    shortName: 'Spider Dev',
    version: '1.0.0',
    description: '{len(spider_cases)} unchanged public Spider development questions with official gold SQL and frozen local outputs.',
    methodology: 'Deterministic SHA-256-ranked subset of public Spider development questions executable from at most three compact source tables. Questions and gold SQL are unchanged.',
    accent: 'violet',
    evaluationClass: 'official-public-subset',
    attribution: {{
      benchmark: 'Spider 1.0 public development set',
      homepage: 'https://yale-lily.github.io/spider',
      license: 'CC BY-SA 4.0',
      notice: 'Official public development examples, evaluated as a declared QuickInsight subset. This is not an official Spider leaderboard submission or full-dev score.',
    }},
    cases: GENERATED.spider,
  }},
  {{
    id: 'bird-dev-research',
    name: 'BIRD Public Dev Research Subset',
    shortName: 'BIRD Dev',
    version: '1.0.0',
    description: '{len(bird_cases)} unchanged public BIRD development questions with official gold SQL, evidence, and frozen local outputs.',
    methodology: 'Deterministic SHA-256-ranked subset of public BIRD development questions executable from at most three compact source tables. Questions, evidence, and gold SQL are unchanged.',
    accent: 'cyan',
    evaluationClass: 'official-public-subset',
    attribution: {{
      benchmark: 'BIRD public development set',
      homepage: 'https://bird-bench.github.io/',
      license: 'CC BY-SA 4.0',
      notice: 'Official public development examples, evaluated as a declared QuickInsight subset. This is not an official BIRD leaderboard submission or full-dev score.',
    }},
    cases: GENERATED.bird,
  }},
];
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def main() -> None:
    args = parse_args()
    args.output_root.mkdir(parents=True, exist_ok=True)
    datasets_root = args.output_root / "datasets"
    spider_source = load_spider_cases(args.spider_root)
    bird_source = load_bird_cases(args.bird_manifest)
    validator = DuckDBValidator(args.node)
    try:
        spider_eligible, spider_assets, spider_rejected = find_eligible(
            "spider", spider_source, args.spider_root / "database", args.output_root / "datasets", args, validator
        )
        bird_eligible, bird_assets, bird_rejected = find_eligible(
            "bird", bird_source, args.bird_root, args.output_root / "datasets", args, validator
        )
    finally:
        validator.close()
    spider_selected = select_cases("spider-dev", spider_eligible, args.count)
    bird_selected = select_cases("bird-dev", bird_eligible, args.count)
    if datasets_root.exists():
        # Clear the generator-owned directory only after source scanning and
        # DuckDB validation succeed. An interrupted rebuild must never erase the
        # last known-good deployed fixture set.
        for stale_asset in datasets_root.glob("*.json"):
            stale_asset.unlink()
    spider_asset_ids = write_assets(args.output_root, spider_selected, spider_assets)
    bird_asset_ids = write_assets(args.output_root, bird_selected, bird_assets)

    manifest = {
        "schemaVersion": 1,
        "selectionVersion": "quickinsight-research-v1",
        "selectionRule": "Diversity passes followed by SHA-256(question source identity), fixed seed text quickinsight-research-v1",
        "constraints": {
            "countPerSuite": args.count,
            "maxTables": args.max_tables,
            "maxTableRows": args.max_table_rows,
            "maxTableCells": args.max_table_cells,
            "maxResultRows": args.max_result_rows,
        },
        "sources": {
            "spider": {
                "split": "dev",
                "sourceArchiveSha256": "00636695dabed6b5f4b8328a16b13e069a2f16591d5efcce57660669c85b121b",
                "eligible": len(spider_eligible),
                "selected": len(spider_selected),
                "datasetAssets": len(spider_asset_ids),
                "rejected": dict(spider_rejected),
            },
            "bird": {
                "split": "dev",
                "databaseArchiveSha256": "cdd6d19faeb45a23970b98d3ef6c40a87987c95459c2cf12076897a60cf5a630",
                "eligible": len(bird_eligible),
                "selected": len(bird_selected),
                "datasetAssets": len(bird_asset_ids),
                "rejected": dict(bird_rejected),
            },
        },
        "cases": {
            "spider": [item.source.source_id for item in spider_selected],
            "bird": [item.source.source_id for item in bird_selected],
        },
    }
    canonical = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    manifest_sha = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    manifest["manifestSha256"] = manifest_sha
    (args.output_root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    emit_typescript(args.typescript_output, spider_selected, bird_selected, manifest_sha)

    print(json.dumps({
        "spider": {"eligible": len(spider_eligible), "selected": len(spider_selected), "assets": len(spider_asset_ids)},
        "bird": {"eligible": len(bird_eligible), "selected": len(bird_selected), "assets": len(bird_asset_ids)},
        "manifestSha256": manifest_sha,
    }, indent=2))


if __name__ == "__main__":
    main()
