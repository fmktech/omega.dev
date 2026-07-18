# ADR-0017: Developer workstream learning and final holdout evaluation

- Status: Accepted
- Date: 2026-07-18
- Supersedes: ADR-0015 AI feedback loop steps 6–9 for project-learning benchmarks

## Context

The first crystallization experiment evaluated every candidate and used the paired result to select the next parent. That is useful for testing Promotion Eval, but it is not representative of a developer working in one project every day. A real project does not provide a sealed incumbent-versus-candidate benchmark after each session. It provides local commands, tests, process output, CI, later corrections, and future tasks.

Even when evaluation results are hidden from the crystallizer, repeatedly selecting the lineage on the same suite lets the controller overfit that suite. It also confuses two product questions: whether Promotion Eval can reject regressions, and whether ordinary project experience produces a better future harness.

## Decision

Project-learning benchmarks use a developer-workstream protocol:

1. Start with a frozen project and initial harness.
2. Run or replay an ordered sequence of ordinary project work sessions.
3. Give reflection only evidence a developer could observe during that work: objectives, repository content, attempts, process output, local checks, and locally observed results.
4. After each session, install every structurally valid and policy-valid project-scoped mutation as the harness for the next session.
5. Do not run an intermediate capability benchmark, read a scorecard, ask for a promotion decision, or branch based on sealed results.
6. Retry malformed model output against the same work evidence within a bounded budget. Never install malformed or unsafe output.
7. After the workstream is complete, freeze the final harness and evaluate the untouched initial harness and final harness once on a disjoint holdout.
8. Treat the final score as measurement, not feedback: it cannot change the completed lineage or enter project memory.

The benchmark record must state `selectionPolicy: "none"`, `intermediateEvaluationCount: 0`, the complete parent chain, evidence hashes, model routes, usage, and structural retry counts.

Promotion Eval under ADR-0011 remains valid for deliberate candidate governance, marketplace adoption, and testing the promotion mechanism itself. It is not the inner loop of a project-learning benchmark.

## Natural production feedback

Production learning may accumulate confidence from signals naturally present in project work: repository tests, CI, authoritative verifiers, retries, reversions, later user corrections, reopened tasks, policy violations, and resource use. These signals may influence retrieval weight, revision, or retirement of individual lessons. They are not fabricated paired benchmark results.

When a project supplies no external outcome signal, Omega may retain a lesson as provisional knowledge but must not claim that the harness improved based only on self-reflection.

## Consequences

- A negative final holdout remains visible; it cannot be hidden by branching around intermediate regressions.
- The protocol measures cumulative learning and interference together, as a developer experiences them.
- Benchmark cost falls because evaluation occurs once rather than after every workday.
- A task-instance holdout that shares capability families with the workstream still has limited external validity; stronger studies require fresh project histories and family-level holdouts.
- Promotion Eval and continual learning remain separate product mechanisms with separate evidence claims.

## Alternatives considered

- **Select every generation using a sealed suite:** rejected for project-learning claims because real projects do not supply that signal and repeated selection biases the lineage.
- **Let an LLM judge its own reflection:** rejected as a capability oracle; a model may validate structure or policy but cannot establish improvement from its own confidence.
- **Never evaluate the evolved harness:** rejected because it would make the self-improvement claim unfalsifiable.
- **Feed the final holdout back into another mutation:** rejected because the holdout would stop being a holdout.
