# Study 2 — User study protocol: does GAFS + the guided builder help non-technical users?

**A publication-grade protocol for the human half of the contribution. This is a plan to
be executed with participants; it is written to the standard a reviewer (or an ethics
board) expects, and it states precisely what each result would and would not license us
to claim.**

---

## 1. Research questions & hypotheses

Study 1 shows the machine computes the right number. Study 2 asks whether the
*interface and framework* help a non-technical person **formulate a valid analytical
question in the first place**.

- **RQ1 (formulation success).** Can non-technical users construct correct analytical
  queries more successfully with the guided, GAFS-structured builder than with a free-text
  natural-language box?
  - **H1.** Task-success rate is higher with the guided builder than with free-text NL.
- **RQ2 (error reduction).** Does the guided builder reduce *analytical* errors (wrong
  grouping, wrong aggregate, missing filter) — the same silent-error classes from Study 1,
  but committed by the *user*?
  - **H2.** Per-task analytical-error rate is lower with the guided builder.
- **RQ3 (learning).** Does playing the GAFS Challenge improve users' ability to decompose a
  question into Grouping / Aggregating / Filtering / Sorting?
  - **H3.** GAFS-decomposition accuracy is higher after the game than before (within-subject
    pre/post).
- **RQ4 (perceived usability).** How usable do non-technical users find the guided builder?
  (Descriptive; reported via SUS, not hypothesis-tested.)

## 2. Design

- **RQ1–RQ2:** within-subjects, two interface conditions, **counterbalanced** order to
  cancel learning effects:
  - **C1 — Free-text NL box** (baseline): the user types the question in words.
  - **C2 — Guided GAFS builder**: the Mad-Lib / fill-the-slots interface (metric =
    Aggregate, dimension = Group, filters = Filter, sort = Sort).
  - Both feed the *same* deterministic execution engine, so the only variable is
    **formulation**, not execution.
- **RQ3:** within-subjects **pre/post** around a fixed GAFS-Challenge session.
- Task sets **A** and **B** are matched in difficulty and **rotated** across conditions so
  no task is always paired with one interface.

## 3. Participants

- **Target N = 24** (within-subjects; powers a paired comparison at d ≈ 0.6, α = .05,
  power = .8). A pilot of 4–6 precedes the main run to fix wording and timing.
- **Inclusion:** self-identified non-technical background; **no SQL proficiency** (screened).
- **Recruitment:** Prolific / university participant pool; screener for "never written SQL /
  database queries."
- **Compensation:** at or above local minimum wage, pro-rated to ~45 min.

## 4. Tasks

10–12 analytical questions over a familiar dataset (e.g. a coffee-shop sales sheet), each
with a single objective correct answer (an independent JS oracle, exactly as in Study 1).
Tasks deliberately span the silent-error classes, e.g.:

- filtered count ("how many orders were refunded?") → tests *filter*
- grouped breakdown ("average rating by store") → tests *group + non-additive aggregate*
- ranking ("top 3 products by revenue") → tests *sort + limit*

Each participant does every task once, in one of the two interfaces (rotated).

## 5. Procedure (~45 min, screen + audio recorded with consent)

1. Consent + screener (2 min).
2. **GAFS pre-test** — 6 written questions: "which part is the Grouping? the Filtering?" (5 min).
3. **GAFS Challenge** — fixed session, e.g. first 8 levels (10 min).
4. **GAFS post-test** — 6 matched questions (5 min). *(RQ3)*
5. Two task blocks, one per interface, counterbalanced; think-aloud (18 min). *(RQ1, RQ2)*
6. **SUS** (10 items) for the guided builder + 3 open-ended questions (5 min). *(RQ4)*

## 6. Measures

| Measure | How captured | Feeds |
|---|---|---|
| **Task success** (correct answer vs oracle) | auto-graded against JS ground truth | RQ1 / H1 |
| **Analytical-error rate & class** | the Study-1 silent-error taxonomy, applied to the user's constructed query | RQ2 / H2 |
| **Time-on-task** | timestamps | RQ1 (secondary) |
| **GAFS-decomposition score** (pre, post) | rubric-graded, two raters | RQ3 / H3 |
| **SUS score** (0–100) | standard 10-item instrument | RQ4 |
| **Think-aloud / open-ended** | thematic coding | qualitative context |

## 7. Analysis plan (pre-registered before data collection)

- **H1** (success): McNemar / paired proportions across conditions.
- **H2** (errors): Wilcoxon signed-rank on per-participant error counts; report error-class
  breakdown descriptively.
- **H3** (learning): paired *t*-test (or Wilcoxon) on pre vs post GAFS scores; report effect
  size (Cohen's *d*) with 95% CI.
- **SUS:** mean + CI, and the standard adjective/percentile band.
- Inter-rater reliability (Cohen's κ) reported for the GAFS rubric.
- **Multiple-comparison correction** (Holm) across the confirmatory tests.

## 8. What each result licenses us to claim (the guardrail)

| If we find… | We may claim… | We may **not** claim… |
|---|---|---|
| H1 supported | "the guided approach **raised query-formulation success** for non-technical users in a controlled task" | "anyone can now do analytics" |
| H2 supported | "it **reduced analytical errors of classes X, Y**" | "it eliminates errors" |
| H3 supported | "a short GAFS-Challenge session **improved question-decomposition on our instrument**" | "it teaches analytical thinking" (too broad — see below) |
| SUS high | "users rated it usable (SUS = N)" | anything causal about learning |

Deliberately conservative framing, matching the agreed claim: *"a guided, grammar-based
question-formulation approach that complements the GAFS analytical framework and lowers the
barrier to constructing valid BI queries."* We evaluate **query formulation**, and treat
"teaches analytical thinking" as a *measured decomposition-skill* result, never a broad
cognitive claim.

## 9. Threats to validity & mitigations

- **Learning / order effects** → counterbalancing + task rotation.
- **Novelty effect** of the game → the pre/post is around a *single fixed* session; we do
  not claim durable learning without a delayed re-test (named as future work).
- **Task-selection bias** → tasks fixed in advance, span all error classes, oracle-graded.
- **Experimenter demand** (think-aloud) → neutral scripting; success auto-graded, not judged.
- **Generalisability** → one dataset, one domain, N = 24; stated as a limitation, not hidden.

## 10. Ethics

IRB/ethics approval before recruitment; informed consent; right to withdraw; no personal
data in the analytical datasets; recordings stored encrypted and deleted after
transcription; fair compensation.

## 11. Deliverables from this study

- The confirmatory results table (H1–H3, SUS).
- The **user-committed** silent-error breakdown — a direct human-side mirror of Study 1's
  machine-side result, which is what makes the two studies tell one story.
