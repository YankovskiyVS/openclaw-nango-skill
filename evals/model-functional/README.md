# Model functional evaluation artifacts

These files make the planning-only model comparison in
`evals/functional-acceptance.md` auditable. They are supporting evidence, not
provider-runtime proof.

## Snapshots

- Current skill text: commit
  `92d88e8867a1c06ca7ac03d2de3fd2e98527dd8b`.
- Upstream skill text: commit
  `12903d917509fab4a4da4d7dd0489a42c00286e6`.
- The `skills/` tree did not change between the current snapshot and the
  functional-acceptance commits that followed it.

## Planning comparison

For each of ten cases, a fresh child agent received one target `SKILL.md`, the
same planning prompt for both variants, and a strict JSON response contract:

- selected skill;
- short plan;
- proposed tool call or `null`;
- approval behavior;
- verification;
- behavior after an unknown outcome;
- refusal reason or `null`.

The prompts explicitly prohibited execution. No tool, provider, OAuth
connection, or network request was used. The target skill was forcibly loaded,
so this comparison does not measure automatic triggering.

The raw prompts and answers are under `raw/`. `aggregate-grading.json` records
all 80 boolean rubric decisions per variant, evidence for every decision,
arithmetic totals, comparison, and limitations. The grader used a conservative
rule: missing, ambiguous, or contradictory evidence fails.

Observed planning-grade result:

- current: 80/80 rubric checks and 10/10 expected registered-tool-or-safe-null
  boundaries;
- upstream: 48/80 rubric checks and 1/10 expected
  registered-tool-or-safe-null boundaries;
- comparison: 9 current wins and 1 safety tie (Yandex Maps).

This result is one run per variant and has no variance estimate. Valid-looking
tool JSON is separately covered by the runtime acceptance suites; this model
comparison alone does not prove schema acceptance or execution.

## Metadata routing screen

`routing-audit.json` contains the exact 24 queries, expected skill ids, both
raw selected-id maps, recomputed scores, and limitations. Each fresh classifier
saw only the `name` and `description` fields for all 25 skills.

Both current and upstream selected 24/24 expected ids in this single,
all-queries-in-one-batch screen. It therefore provides no evidence that the new
descriptions improve trigger accuracy. It is also not a direct OpenClaw or
Codex auto-trigger test.

## Integrity check

Run:

```bash
python3 -m pytest -q tests/test_model_eval_artifacts.py
```

The test verifies that every declared raw artifact exists, recomputes all
planning totals and win/tie counts, and recomputes both routing scores from the
stored queries and selected-id maps. Semantic rubric judgments remain
reviewable in `aggregate-grading.json`; they are not automatically re-graded.
