"""Fetch pinned official benchmark metadata, never executable upstream code."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from urllib.request import Request, urlopen

COMMIT = "cafb867313aab4e674652054198f383cf4018943"
ROOT = Path(__file__).resolve().parents[1] / ".benchmark-source/spider2"
BASE = f"https://raw.githubusercontent.com/xlang-ai/Spider2/{COMMIT}/"


def fetch(url):
    with urlopen(Request(url, headers={"User-Agent": "QuickInsight-benchmark-import"}), timeout=60) as response:
        result = response.read(20_000_001)
        if len(result) > 20_000_000:
            raise ValueError("Unexpectedly large source metadata file")
        return result


def save(path):
    target = ROOT / path
    if not target.exists():
        content = fetch(BASE + path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    tree = json.loads(fetch(f"https://api.github.com/repos/xlang-ai/Spider2/git/trees/{COMMIT}?recursive=1"))
    assert tree["sha"] == COMMIT and not tree.get("truncated")
    (ROOT / "source-tree.json").write_text(json.dumps(tree), encoding="utf-8")
    paths = ["LICENSE", "spider2-lite/spider2-lite.jsonl", "spider2-lite/evaluation_suite/gold/spider2lite_eval.jsonl", "methods/gold-tables/spider2-lite-gold-tables.jsonl"]
    paths += [item["path"] for item in tree["tree"] if item["type"] == "blob" and (
        item["path"].startswith("spider2-lite/evaluation_suite/gold/exec_result/local")
        or item["path"].startswith("spider2-lite/evaluation_suite/gold/sql/local")
        or item["path"].startswith("spider2-lite/resource/documents/")
    )]
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(save, paths))
    print(f"Fetched {len(paths)} pinned metadata/reference files from {COMMIT}", flush=True)
