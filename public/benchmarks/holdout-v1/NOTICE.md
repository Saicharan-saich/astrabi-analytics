# New BIRD + Spider 2.0 evaluation set

This is a **QuickInsight, oracle-table, DuckDB-adapted public-source subset**,
not an official BIRD or Spider 2.0 leaderboard evaluation.

## Sources and attribution

- BIRD public development questions, evidence, SQL and database fixtures:
  https://bird-bench.github.io/ and https://github.com/AlibabaResearch/DAMO-ConvAI/tree/main/bird
  (CC BY-SA 4.0; https://creativecommons.org/licenses/by-sa/4.0/).
  Cite Li et al., *Can LLM Already Serve as a Database Interface? A BIG Bench
  for Large-Scale Database Grounded Text-to-SQLs*, NeurIPS 2023.
- Spider 2.0 Lite SQLite questions, documentation, oracle table lists and published
  result CSVs: https://github.com/xlang-ai/Spider2, commit
  `cafb867313aab4e674652054198f383cf4018943`.
  Cite Lei et al., *Spider 2.0: Evaluating Language Models on Real-World Enterprise
  Text-to-SQL Workflows*, ICLR 2025. Repository license: MIT, copyright (c) 2024
  bird_sql. Underlying databases retain their upstream terms. See the source
  repository's database provenance; this notice does not relicense those data.

## Adaptations and interpretation

Original question text is retained. Complete relevant tables are converted from
SQLite to JSON and loaded into DuckDB-WASM; no source rows are sampled. Relevant
tables are selected using reference SQL (BIRD) or the authors' gold-table list
(Spider 2.0). This oracle schema scope makes table discovery easier than the full
original benchmark. Source budgets, hashes, exclusions and selection identity
are recorded in manifest.json. Difficulty/category labels are local analysis
labels; all Spider 2.0 tasks are labelled hard, not official difficulty ratings.

BIRD reference SQL is frozen after local DuckDB execution and is checked again
at run time. Spider 2.0 uses the publisher's reference CSV alternatives and
condition-column projections; no substitute gold SQL is invented where the
authors do not publish SQL. Published ordering constraints are retained. Local
comparison preserves row associations, unlike the upstream column-wise checker,
so these scores should not be described as identical to the official evaluator.
Source SQLite SQL, when present, is displayed as provenance, not silently claimed
to be DuckDB SQL. Reference outputs are not sent to the candidate model.

An independent 2026-09-03 oracle-quality audit preserves the complete frozen
550-question source set but quarantines cases with confirmed defects,
under-specified interpretations, conflicting publisher alternatives, or
insufficient verification. Only quality-cleared cases are selectable for scored
runs. The audit decision hash is recorded separately from the source manifest;
quarantined cases are never silently treated as model failures or successes.

The new set is disjoint from the versioned old application manifests and retained
local run evidence by source identity and normalized question text; BIRD gold SQL
duplicates are also excluded. It is NOT a claim that a public question was absent
from model pretraining or every historical user conversation. Do not tune against
this set and then describe subsequent runs as unseen. First-run results should be
saved with the manifest hash, application commit, privacy mode and model route.

## Spider 2.0 repository MIT notice

Copyright (c) 2024 bird_sql

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
