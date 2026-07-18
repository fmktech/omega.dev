# Crystallization benchmark test plan

## Behavioral contract

The crystallization benchmark measures whether a harness can learn project-scoped operating guidance from ordinary work-session trajectories and transfer that guidance to different tasks without receiving evaluation evidence.

The experiment must:

1. Give the crystallizer only frozen work-session trajectories containing objectives, actions, ordinary tool output, retries, and the final locally observed result.
2. Reject source evidence containing benchmark identifiers, scorecards, hidden verifier details, promotion decisions, or evaluation outcomes.
3. Ask the crystallizer to route each lesson to `knowledge`, `skill`, `runner`, `tool`, or `policy` and return concise actionable guidance.
4. Compile the guidance into a project-scoped candidate derived from a fixed parent harness without activating it.
5. Produce the same candidate identity for the same parent and crystallization proposal.
6. Compare the unfed parent and experience-fed candidate under the same model route, fixture, policy, sandbox, budget, and verifier.
7. Keep evaluation evidence out of every later crystallizer prompt regardless of promotion or rejection.

Phase one compiles all selected lessons into the runner's project-experience section so their transfer effect is executable today. The recorded target still measures where the crystallizer believes each lesson should eventually live. Native lazy loading for knowledge and skill components is a later runtime concern and is not simulated by the evaluator.

## Named behaviors

| Behavior | Test evidence |
| --- | --- |
| Accepts ordinary process evidence | A trace with failed commands, recovery, and local success renders into a model prompt. |
| Fails closed on evaluation leakage | Each forbidden evidence class is rejected before a model request. |
| Produces a bounded typed proposal | Only the five learning targets and non-empty concise guidance are accepted. |
| Preserves project scope | The candidate inherits the parent's project and lineage and is never automatically activated. |
| Is reproducible | Recompiling identical guidance creates the same component and harness IDs. |
| Can change transfer behavior | A live paired run compares the unfed and fed harnesses on sealed tasks absent from the source trajectories. |

## Edge-case taxonomy

| Row | Applicability and cases |
| --- | --- |
| Empty / null / missing | Apply: no trajectories, empty trajectory text, no proposal lessons, missing target or guidance. |
| Boundary values | Apply: one trajectory, maximum trajectory count, one lesson, maximum lessons, maximum guidance length, and over-limit inputs. |
| Invalid input | Apply: malformed JSON, unknown target, benchmark marker, scorecard marker, verifier marker, evaluation-result marker, unsafe control characters. |
| Dependency failure | Apply: provider start failure, failed model stream, and completion without parseable JSON must install no candidate. |
| Concurrency / ordering | Apply: trajectory order is canonicalized so equivalent evidence sets produce one prompt and candidate. Concurrent installation relies on the content-addressed harness repository. |
| Idempotency / duplicate delivery | Apply: duplicate trajectories are deduplicated; repeated compilation returns the same candidate ID. |
| Unicode / encoding / timezone | Apply: UTF-8 project paths and non-English command output remain intact; timestamps are deliberately excluded from identity. |

## Risk-weighting

Highest risk is evaluation leakage because it can manufacture apparent learning. Second is silently activating an unproven candidate. Third is a non-reproducible candidate that cannot be audited against its source experience. Formatting failures and target-selection quality are lower risk because they cause a visible failed experiment rather than corrupting the active harness.

## Mutation checks

- Removing any forbidden-marker check must make its table row fail.
- Permitting an unknown target must make the typed-proposal test fail.
- Adding the crystallization timestamp to candidate identity must make the idempotency test fail.
- Activating the candidate during installation must make the project-pointer assertion fail.
- Removing guidance from the compiled runner must make the runner-content assertion fail.

## Live benchmark interpretation

A higher sealed-task success rate is evidence of positive transfer from process-derived guidance. Equal capability with lower cost is an efficiency improvement. A regression is still useful evidence: the source experience was crystallized too broadly or into the wrong layer. One ten-task replicate is diagnostic, not a broad generalization claim.
