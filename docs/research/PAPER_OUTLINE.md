# Paper outline — one system, two studies

Working title: **"Interpret, then compute: a guided, verifiable architecture for
self-service analytics by non-technical users."**

## The through-line

The four pieces are not features — they are one workflow unified by **GAFS**
(Grouping · Aggregating · Filtering · Sorting), the mental model for turning a question
into a query:

```
GAFS Challenge  →  teaches the GAFS decomposition (a game)
Guided Builder  →  scaffolds GAFS as fill-the-slots (formulation without SQL)
Plan → Compile  →  the LLM interprets into a plan; deterministic code compiles the SQL
Validate + Local execution  →  the number comes from the database, not the model
```

The game *teaches* GAFS, the builder *scaffolds* GAFS, the pipeline *executes* GAFS intent.

## Contributions (ordered by strength of evidence)

1. **A plan-compile architecture** in which the LLM emits a structured plan and
   deterministic code compiles the SQL, so the model cannot produce the number — with a
   **silent-error taxonomy** and a **label-free differential oracle** that measures a
   correctness dimension execution-accuracy benchmarks miss. *(Study 1 — done, objective.)*
2. **A guided, GAFS-structured question-formulation interface** that lowers the barrier to
   constructing valid BI queries for non-technical users. *(Study 2 — protocol ready.)*
3. **GAFS as a learnable framing + a learning mechanism** (the Challenge) for
   question decomposition. *(Study 2, RQ3.)*
4. **A privacy-by-architecture property**: the model receives only metadata; zero data rows
   are transmitted. *(Quantified in Study 1.)*

Framing discipline: GAFS is positioned as a **pedagogical / interface** framing of relational
query structure, **not** a novel query abstraction. The headline claim is *verifiability and
guided formulation*, not "solved hallucination."

## Evidence map

| Claim | Evidence | Status |
|---|---|---|
| Deterministic compilation avoids silent errors | Study 1 hybrid arm: 100% correct, 0 silent errors; grader validated | **have it** |
| Naive LLM-writes-SQL commits silent errors | Study 1 naive arm (run with API key) | infra ready |
| Guided builder raises formulation success | Study 2, H1 | protocol ready |
| Guided builder reduces analytical errors | Study 2, H2 | protocol ready |
| GAFS game improves decomposition | Study 2, H3 | protocol ready |
| Zero data sent to the model | architecture + Study 1 accounting | **have it** |

## Suggested structure

1. Introduction — the trust gap in AI analytics for non-technical users.
2. Related work — text-to-SQL & IRs (IRNet/SemQL, RAT-SQL), constrained decoding (PICARD),
   decomposed prompting (DIN-SQL), self-service BI, end-user programming. *Position against
   these explicitly.*
3. System — GAFS, the guided builder, the plan-compile pipeline, local execution.
4. Study 1 — accuracy & the silent-error taxonomy (this repo).
5. Study 2 — the user study (protocol in this repo).
6. Discussion — verifiability vs. expressiveness trade-off (stated honestly).
7. Limitations & future work — Spider/BIRD scale-up; delayed-retention re-test.

## Venue

- **Primary fit: ACM IUI (Intelligent User Interfaces)** — exactly AI + HCI + end-user tooling.
- Adjacent: IEEE VIS / EuroVis (short), CSCW, EMNLP Industry / VLDB Industrial (systems slant).
- Preprint on arXiv first; open-source the differential harness as a standalone artifact.

## Reproducibility artifacts (already in the repo)

- `research/accuracyStudy/` + `__tests__/accuracyStudy.test.ts` — Study 1, runnable.
- `docs/research/STUDY1_accuracy.md` — Study 1 methodology.
- `docs/research/STUDY2_user_study_protocol.md` — Study 2 protocol.
