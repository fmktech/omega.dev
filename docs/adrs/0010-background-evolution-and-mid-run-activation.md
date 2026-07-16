# ADR-0010: Background evolution and safe-boundary activation

- Status: Accepted
- Date: 2026-07-14

## Context

The highest-value harness improvements may become apparent only after an agent grinds through several failed attempts and finally finds a solution. Crystallization should capture that turning point without forcing the main task to wait. Because harness components are invoked through process/CLI boundaries, a project can adopt a newer version between calls without rewriting a process that is already executing.

## Decision

Harness evolution is an asynchronous child session using the ordinary child-session mechanism.

Evolution may begin:

- when the main agent calls `harness.evolve` during a task;
- after a repeated or expensive failure pattern;
- automatically after a costly successful task that contains a plausible reusable turning point.

The main agent may continue working and can observe or cancel the evolution handle. Evolution produces immutable candidate components and a candidate harness manifest with complete provenance.

After the incumbent Promotion Eval authorizes a candidate, the daemon atomically advances the project's active harness pointer. Activation may happen while a task is in progress, but only at safe boundaries:

- an already running process stays bound to the harness version that spawned it;
- a model generation is not interrupted;
- the next runner/model/tool call uses the newly active version;
- every prompt, call, observation, and process event records its harness version;
- a `harness.updated` event nudges the main process with the old version, new version, and reason;
- an idle agent may resume automatically after the update;
- an active agent receives the update at its next safe boundary;
- a call using a stale tool schema fails with `harness_version_mismatch` and must refresh before retrying.

Post-activation canary monitoring observes subsequent eligible project tasks. A measured regression automatically rolls back the project pointer and quarantines the candidate.

## Consequences

- A successful grind can improve the remaining task and future sessions without mutating an active invocation underneath it.
- Mixed-version sessions are expected and remain auditable.
- Tool-schema refresh and atomic activation are core daemon responsibilities.
- Automatic rollback limits the duration of a false-positive promotion.

## Alternatives considered

- **Only activate on the next new session:** rejected because process boundaries make safe mid-task adoption practical and useful.
- **Interrupt active model/tool calls:** rejected because it creates ambiguous partial effects and version attribution.
- **Run evolution synchronously:** rejected because expensive analysis should not block useful task work.
- **Require manual activation:** rejected because project-scoped promotion is intended to compound autonomously after evaluation.

