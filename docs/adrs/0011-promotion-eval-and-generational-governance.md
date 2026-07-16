# ADR-0011: Promotion Eval and generational evaluator governance

- Status: Accepted
- Date: 2026-07-14

## Context

A mutation is not an improvement merely because it was inspired by a successful task. It must demonstrate a material advantage over the current harness under matched conditions. Omega should also be able to improve its evaluation method without allowing a candidate to weaken the test that authorizes itself.

## Decision

**Promotion Eval** is the single evidence and decision protocol for project harness promotion. A paired incumbent-versus-candidate run is the Promotion Eval, not a separate evaluation feature.

The protocol:

- starts incumbent and candidate from equivalent frozen conditions;
- pins the same objective, route class, policy, context boundary, and resource budget;
- measures verified task outcome, cost, latency, unnecessary actions, and configured regression signals;
- uses configured matched replicates and a minimum-effect threshold;
- refuses promotion on a material protected regression;
- records an immutable scorecard and all effective harness component hashes.

For crystallization from a successful grind, the preferred evaluation starts at a reproducible pre-breakthrough state. The evolution session may inspect the successful trace to design a reusable candidate and evaluation, but neither paired runner receives the solution transcript. The exact mechanism for capturing a reproducible workspace baseline remains open.

Promotion is automatic when the incumbent evaluator's rules pass the candidate. No human approval is required. The new default is monitored as a canary and may be automatically rolled back and quarantined.

The evaluator and promotion logic are mutable harness components under a generational rule:

- harness v1 proposes v2;
- v1's evaluator and promotion rules judge all of v2, including changes to evaluation logic;
- only after v2 is active may v2's evaluator judge v3;
- a candidate may never use its own changed evaluator to justify its activation.

Evaluation evidence is scoped to the tested project, harness composition, and model-route class. Other projects may read it as marketplace precedent but must synthesize and evaluate their own candidate.

Initial metric thresholds, replicate counts, budgets, and workspace snapshot mechanics are separate open decisions.

## Consequences

- Improvements require behavioral evidence rather than persuasive narratives.
- The evaluation system can itself improve without circular self-approval.
- Reproducible paired execution may be expensive and needs isolation.
- Automatic promotion depends on strong scorecards, canary detection, rollback, and quarantine.

## Alternatives considered

- **Candidate evaluates itself:** rejected because it can weaken or game its admission test.
- **Permanently immutable evaluator:** rejected because evaluation quality is part of the harness that should improve.
- **Human approval after every passing evaluation:** rejected because project-scoped compounding is intended to be autonomous.
- **Promote from one successful transcript:** rejected because it proves task completion, not transferable efficiency.

