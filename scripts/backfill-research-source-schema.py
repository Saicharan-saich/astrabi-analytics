"""Backfill declared SQLite key metadata into already-selected benchmark assets.

This deliberately does not reselect questions, regenerate outputs, or change
fixture rows. It only adds SourceSchema metadata from the original public
SQLite database for the tables already present in each JSON asset.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

_GENERATOR = Path(__file__).with_name("build-research-benchmark-packs.py")
_SPEC = importlib.util.spec_from_file_location("research_pack_generator", _GENERATOR)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Could not load {_GENERATOR}")
_MODULE = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _MODULE
_SPEC.loader.exec_module(_MODULE)
read_source_schema = _MODULE.read_source_schema


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--datasets", type=Path, required=True)
    parser.add_argument("--spider-root", type=Path, required=True)
    parser.add_argument("--bird-root", type=Path, required=True)
    return parser.parse_args()


def database_path(asset: dict[str, Any], path: Path, spider_root: Path, bird_root: Path) -> Path:
    db_id = str(asset.get("name") or "").split()[-1]
    root = spider_root if path.name.startswith("spider--") else bird_root
    candidate = root / db_id / f"{db_id}.sqlite"
    if not candidate.exists():
        raise FileNotFoundError(f"Could not find source database for {path.name}: {candidate}")
    return candidate


def main() -> None:
    args = parse_args()
    updated = 0
    for path in sorted(args.datasets.glob("*.json")):
        asset = json.loads(path.read_text(encoding="utf-8"))
        tables = [str(table["name"]) for table in asset.get("relatedTables", [])]
        if not tables:
            continue
        db_path = database_path(asset, path, args.spider_root, args.bird_root)
        with sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True) as connection:
            asset["sourceSchema"] = read_source_schema(connection, tables)
        path.write_text(json.dumps(asset, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        updated += 1
    print(json.dumps({"updatedAssets": updated}, indent=2))


if __name__ == "__main__":
    main()
