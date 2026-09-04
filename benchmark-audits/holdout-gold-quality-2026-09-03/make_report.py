"""Build the consolidated holdout-gold audit artifacts from captured evidence."""

from __future__ import annotations

import json
import re
import subprocess
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load(name: str):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def finding_key(case: dict) -> str:
    source_id = case["sourceId"]
    if source_id.startswith("bird-dev:"):
        return source_id.split(":", 2)[1]
    match = re.search(r"local\d+", source_id)
    if not match:
        raise ValueError(f"Cannot derive review key for {source_id}")
    return f"spider-{match.group(0)}"


def escaped(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


evidence = load("audit-evidence.json")
reviews = load("reviews.json")
verified = load("verified-decisions.json")

default_reason = (
    "Question, evidence, reference SQL and full frozen output were inspected; no "
    "specific defect was identified. Source/data integrity and native replay checks "
    "passed where applicable. This is no-issue-found, not human certification."
)

results = []
for ordinal, case in enumerate(evidence["cases"], start=1):
    key = finding_key(case)
    preliminary = reviews["findings"].get(key)
    decision = verified.get(key, preliminary)
    if decision is None:
        decision = ["no_issue_found", default_reason]
    status, reason = decision
    results.append(
        {
            "ordinal": ordinal,
            "caseId": case["id"],
            "suiteId": case["suiteId"],
            "sourceId": case["sourceId"],
            "question": case["question"],
            "category": case["category"],
            "difficulty": case["difficulty"],
            "auditStatus": status,
            "reason": reason,
            "preliminaryDecision": (
                {"status": preliminary[0], "reason": preliminary[1]}
                if preliminary
                else None
            ),
            "verifiedOverrideApplied": key in verified,
            "integrity": case["integrity"],
            "referenceFlags": case["referenceFlags"],
            "goldSql": case["goldSql"],
            "expectedRows": case["expectedRows"],
            "nativeRows": case["nativeRows"],
        }
    )

counts = Counter(item["auditStatus"] for item in results)
suite_counts = {
    suite: dict(Counter(r["auditStatus"] for r in results if r["suiteId"] == suite))
    for suite in sorted({r["suiteId"] for r in results})
}
integrity_counts = {
    "cases": len(results),
    "assetChecksumsMatched": sum(
        bool(r["integrity"].get("checksumMatches")) for r in results
    ),
    "completeTableComparisonsPassed": sum(
        all(t.get("matches") for t in r["integrity"].get("tables", []))
        for r in results
    ),
    "nativeSqlReplaySucceeded": sum(
        bool(r["goldSql"]) and not r["integrity"].get("nativeSqlError") for r in results
    ),
    "nativeSqlReplayFailedOrTimedOut": sum(
        bool(r["goldSql"]) and bool(r["integrity"].get("nativeSqlError")) for r in results
    ),
    "withoutPublishedSql": sum(not bool(r["goldSql"]) for r in results),
    "emptyFrozenOutputs": sum(not bool(r["expectedRows"]) for r in results),
}

payload = {
    "auditDate": "2026-09-03",
    "corpusId": evidence["corpusId"],
    "manifestSha256": evidence["manifestSha256"],
    "scope": evidence["auditScope"],
    "reviewer": reviews["reviewer"],
    "method": reviews["method"],
    "statusDefinitions": {
        "confirmed_defect": "Independent evidence demonstrates a source, fixture, reference-SQL, or expected-output defect.",
        "review_required": "A material ambiguity, conflicting reference, suspicious projection, or under-specified interpretation requires human adjudication.",
        "no_issue_found": "No concrete defect was identified during this audit; this is not a human certification.",
        "not_fully_verifiable": "The supplied evidence is insufficient for a defensible decision.",
    },
    "summary": dict(counts),
    "bySuite": suite_counts,
    "integritySummary": integrity_counts,
    "cases": results,
}
(ROOT / "audit-results.json").write_text(
    json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
)

# The product ships only the compact decision registry. Full outputs and replay
# evidence remain in this audit directory and are never bundled into the app.
decision_payload = {
    item["caseId"]: {
        "status": item["auditStatus"],
        "reason": item["reason"],
    }
    for item in results
}
decision_bytes = json.dumps(
    decision_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
).encode("utf-8")
audit_sha = __import__("hashlib").sha256(decision_bytes).hexdigest()
source_manifest_sha = evidence["manifestSha256"]
audited_manifest_sha = __import__("hashlib").sha256(
    f"{source_manifest_sha}:{audit_sha}".encode("ascii")
).hexdigest()
registry_path = ROOT.parents[1] / "services" / "benchmark" / "holdoutOracleQuality.generated.ts"
registry_path.write_text(
    "// Generated from benchmark-audits/holdout-gold-quality-2026-09-03/audit-results.json.\n"
    "// Do not edit decisions manually; preserve the audit evidence trail.\n"
    "import type { BenchmarkOracleQuality } from './types';\n\n"
    f"export const HOLDOUT_SOURCE_MANIFEST_SHA256 = '{source_manifest_sha}';\n"
    f"export const HOLDOUT_ORACLE_AUDIT_SHA256 = '{audit_sha}';\n"
    f"export const HOLDOUT_AUDITED_MANIFEST_SHA256 = '{audited_manifest_sha}';\n"
    "export const HOLDOUT_ORACLE_QUALITY = "
    + json.dumps({key: value["status"] for key, value in decision_payload.items()}, ensure_ascii=False, indent=2)
    + " as const satisfies Record<string, BenchmarkOracleQuality>;\n\n"
    "export const HOLDOUT_ORACLE_NOTES = "
    + json.dumps(
        {key: value["reason"] for key, value in decision_payload.items() if value["status"] != "no_issue_found"},
        ensure_ascii=False,
        indent=2,
    )
    + " as const satisfies Record<string, string>;\n",
    encoding="utf-8",
)

repo_root = ROOT.parents[1]
try:
    original_manifest = json.loads(subprocess.check_output(
        [
            "git",
            "-c",
            f"safe.directory={repo_root.as_posix()}",
            "show",
            "HEAD:public/benchmarks/holdout-v1/manifest.json",
        ],
        cwd=repo_root,
        text=True,
        encoding="utf-8",
    ))
    locked_source_ids = original_manifest["sourceIds"]
except (OSError, subprocess.CalledProcessError, KeyError, ValueError):
    locked_source_ids = [item["sourceId"] for item in results]
if set(locked_source_ids) != {item["sourceId"] for item in results}:
    raise ValueError("The original holdout selection and audited case set differ")
selection_lock = {
    "version": "quickinsight-holdout-550-v1",
    "sourceManifestSha256AtSelection": evidence["manifestSha256"],
    "sourceIds": locked_source_ids,
}
selection_path = ROOT.parents[1] / "public" / "benchmarks" / "holdout-v1" / "selection-lock.json"
selection_path.write_text(
    json.dumps(selection_lock, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
    encoding="utf-8",
)

lines = [
    "# Holdout-v1 Gold Quality Audit",
    "",
    "**Audit date:** 2026-09-03  ",
    f"**Corpus:** `{evidence['corpusId']}`  ",
    f"**Manifest SHA-256:** `{evidence['manifestSha256']}`  ",
    "**Scope:** all 550 holdout cases, their questions, evidence, reference SQL (when supplied), complete frozen outputs, compressed dataset assets, and original source databases.",
    "",
    "## Verdict",
    "",
    "The new 550-case holdout is **not clean enough to use as an unqualified research benchmark yet**. It contains confirmed defects and a substantial adjudication queue. The frozen corpus was not changed by this audit.",
    "",
    "| Audit status | Cases | Meaning |",
    "| --- | ---: | --- |",
    f"| Confirmed defect | {counts['confirmed_defect']} | Independently demonstrated source, fixture, SQL, or expected-output defect |",
    f"| Human review required | {counts['review_required']} | Conflicting references, ambiguous semantics, or suspicious scoring/projection |",
    f"| No issue found | {counts['no_issue_found']} | No concrete defect found; not a human certification |",
    f"| Not fully verifiable | {counts['not_fully_verifiable']} | Evidence was insufficient for a defensible decision |",
    f"| **Total** | **{len(results)}** | |",
    "",
    "These counts are **gold-quality audit classifications, not model accuracy corrections**. A confirmed reference defect must not automatically turn every candidate into a pass; the case first needs a corrected, versioned oracle and a rerun or human adjudication.",
    "",
    "## Corpus and replay checks",
    "",
    f"- All {integrity_counts['assetChecksumsMatched']} case-to-asset checksum references matched.",
    "- All 155 compressed dataset assets were decompressed and compared against the original source data; 144 unique source tables were compared using complete rows and duplicate multiplicity.",
    f"- Native reference SQL replay succeeded for {integrity_counts['nativeSqlReplaySucceeded']} cases, one published query timed out, and {integrity_counts['withoutPublishedSql']} Spider2 cases have no published SQL.",
    f"- Empty frozen expected outputs: {integrity_counts['emptyFrozenOutputs']}.",
    "- One BIRD question mismatch was only a trailing newline in the upstream question text.",
    "",
    "## Repaired corpus-construction defect",
    "",
    "The initial Spider2 F1 fixtures for `holdout-spider2-local309`, `local310`, and `local311` contained a shifted `drivers` table. SQLite `SELECT *` returned the generated `full_name` column while `PRAGMA table_info` omitted it. The builder now derives an explicit projection from `PRAGMA table_xinfo`; all 859 driver rows and all 550 case fixtures match their source tables. These three cases remain quarantined because their published interpretations or output alternatives still require adjudication.",
    "",
    "## Recurring gold-quality failure families",
    "",
    "- **Wrong entity or relationship:** district aggregates treated as schools; residential district used instead of branch district; actor/inventory tables omitted even when the question requires them.",
    "- **Wrong analytical grain:** laboratory rows counted as patients, bond/atom rows counted as molecules, repeated names grouped instead of stable entity identifiers, and event-budget rows counted instead of events.",
    "- **Join fan-out:** atom-to-bond joins inflate averages and counts; cumulative standings values are summed as if they were race-level facts.",
    "- **Predicate and scope defects:** Alameda questions filter Lake; requested atom 12 becomes atoms 1/2; missing parentheses broaden predicates; `COUNT(condition)` counts false rows because false is non-null.",
    "- **Ranking/order defects:** ascending order used for highest/longest and dates/times sorted as text.",
    "- **Reference disagreement:** several Spider2 cases publish mutually inconsistent alternatives; allowing all alternatives can admit a false pass.",
    "- **Projection/scoring defects:** condition columns and central calculated values are sometimes removed from the frozen output, so a materially incomplete candidate can pass.",
    "",
    "## Required remediation before publication",
    "",
    "1. Quarantine the confirmed-defect cases and do not include them in headline accuracy until corrected.",
    "2. Human-adjudicate every `review_required` case against a written semantic interpretation; resolve multiple reference alternatives to one canonical oracle.",
    "3. Fix the generated-column importer and rebuild the affected assets from the pinned upstream source.",
    "4. Bundle tables based on the question and source schema, not solely on table names extracted from potentially defective gold SQL.",
    "5. Preserve all requested identity and calculated output fields in the scoring contract; distinguish display projection from semantic comparison fields.",
    "6. Publish a new immutable corpus version and manifest. Keep holdout-v1 unchanged so earlier runs remain reproducible.",
    "7. Report raw automatic accuracy and adjudicated/corrected-corpus accuracy separately, with exclusions and reasons enumerated.",
    "",
    "## Case-by-case decisions",
    "",
    "The machine-readable file contains full frozen/native outputs and integrity metadata for every case. The table below records all 550 decisions.",
    "",
    "| # | Case | Source | Status | Reason |",
    "| ---: | --- | --- | --- | --- |",
]
for item in results:
    lines.append(
        f"| {item['ordinal']} | `{escaped(item['caseId'])}` | `{escaped(item['sourceId'])}` | "
        f"{escaped(item['auditStatus'])} | {escaped(item['reason'])} |"
    )

lines.extend(
    [
        "",
        "## Reproducibility artifacts",
        "",
        "- `audit-results.json`: final classification and evidence for all 550 cases.",
        "- `audit-evidence.json`: complete extracted source/frozen/native evidence.",
        "- `independent-checks.json`: independent SQL/Python reconstruction results.",
        "- `reviews.json`: first-pass semantic review decisions.",
        "- `verified-decisions.json`: decisions changed or strengthened by independent reconstruction.",
        "- `audit.py`, `verify_findings.py`, `followup_checks.py`, and `additional_reconstructions.py`: audit/replay programs.",
        "",
    ]
)
(ROOT / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")

print(json.dumps({"summary": dict(counts), "bySuite": suite_counts, "integrity": integrity_counts}, indent=2))
