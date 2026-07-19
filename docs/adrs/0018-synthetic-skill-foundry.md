# ADR-0018: Synthetic skill foundry and promotion gate

- Status: Accepted
- Date: 2026-07-19

## Context

A completed project task can reveal a reusable correction, procedure, hard rule, guided workflow, environment fact, or external-system access pattern. Reflection alone can write plausible guidance, but its confidence does not establish that the guidance helps future work. Reusing a shared benchmark for every lesson also selects for benchmark familiarity instead of the concrete project behavior being learned.

The system therefore needs one bounded lifecycle that discovers an opportunity, creates a project skill, tests transfer and applicability, and activates it only when it changes observable workspace outcomes. The candidate author must not see the evaluation answers, and the evaluation author must not adapt its fixtures to the candidate text.

## Decision

`harness.evolve` is the initial opportunity-capture seam. A skill-only request defaults to `synthetic-skill-suite`; callers may explicitly choose the ordinary development suite for compatibility. The request cites immutable session evidence and remains subject to the existing candidate-creation capability and execution policy.

Synthetic skill evolution starts two attenuated child sessions from the same evidence before either result is consumed:

1. The evolution child reflects on the evidence and produces an evidence-linked project skill candidate. The existing atomic reflection compiler may include related skill, knowledge, runner, tool, and policy lessons in the same candidate; the skill remains the retrieval root.
2. The promotion-evaluation child independently produces exactly three tiny, hermetic workspace fixtures: near transfer, generalization, and a negative control. It cannot see the candidate, benchmark results, prior scorecards, or verifier implementations.

The daemon validates and content-addresses all fixture files, public objectives, hidden checks, negative invariants, environment descriptions, and provenance before execution. Unsafe paths, duplicate or missing variations, empty checks, and oversized fixtures fail closed.

The trusted benchmark launcher then runs the incumbent and candidate on identical copies of all three fixtures. Task runners receive the objective and fixture, never the hidden verifier or applicability expectation. Positive candidate runs must load the candidate-only skill component. The negative-control candidate run must not load that component. Reads of unrelated incumbent skills neither satisfy nor violate these gates.

The suite requires three comparable pairs, one per variation. Promotion requires at least a one-third success-rate improvement, every hidden check and invariant to hold, and no protected regression. The existing incumbent-owned Promotion Eval creates the scorecard and automatically activates only a promotable candidate. Rejected candidates and all evidence remain immutable for diagnosis.

The builder and evaluator may read only continuation artifacts explicitly supplied to their child sessions. `artifact.read` is therefore an initial harness tool, while cross-session artifacts not named in the continuation remain inaccessible.

## Relationship to project-learning evaluation

This lifecycle is a deliberate per-candidate Promotion Eval under ADR-0011. It does not replace ADR-0017's developer-workstream benchmark and cannot be used as intermediate feedback when claiming unselected continual-learning improvement. A final holdout still measures whether accumulated project learning transfers without benchmark-selected lineage.

## Consequences

- A useful-looking reflection is insufficient for activation; a skill must change deterministic workspace outcomes.
- Evaluation data is opportunity-specific without being visible to the candidate author.
- Near transfer checks recurrence, generalization checks the procedure rather than wording, and the negative control checks retrieval precision.
- Candidate-only skill-read evidence prevents unrelated installed skills from satisfying or tripping the applicability gate.
- Three fixtures are intentionally small and economical; broader external validity remains the role of development suites and final holdouts.
- The daemon now owns immutable synthetic-suite artifacts and evolution jobs record the evaluator session and suite lineage.

## Alternatives considered

- **Promote from reflection confidence alone:** rejected because self-assessment is not evidence of useful behavior.
- **Let the skill author write its own tests:** rejected because candidate-aware fixtures can encode the answer or avoid hard cases.
- **Use only the shared OmegaBench suite:** rejected because most project-specific skills need a local behavioral oracle.
- **Require the skill on every adjacent task:** rejected because over-triggering is a core harness regression and needs an explicit negative control.
- **Run synthetic evaluation after every session automatically:** deferred; the agent-facing opportunity seam is explicit and bounded until value and cost justify a post-session trigger.
