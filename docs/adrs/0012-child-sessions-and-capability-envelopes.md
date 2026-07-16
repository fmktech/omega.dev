# ADR-0012: Child sessions and immutable capability envelopes

- Status: Accepted
- Date: 2026-07-14

## Context

Task delegation, evolution, evaluation, and crystallization all need bounded agents. Embedding their internal events in a parent's log would pollute parent context, while inventing a special evolution orchestration system would duplicate lifecycle and audit behavior.

## Decision

Every subagent is a child session using the same general session mechanism. Evolution agents are ordinary child sessions with an `evolution` role and suitable capabilities.

A child session records:

- `thread_id` and `parent_session_id`;
- the parent's `spawn_event_id`;
- its declared role and objective;
- inherited harness version and explicit context references;
- its immutable capability envelope.

The parent records child lifecycle events and the child's aggregated result/artifact references, not the child's full transcript. CLI and HTML clients may navigate into the child session for complete details.

At spawn time the daemon assigns a capability envelope covering:

- tool and connector allowlists;
- filesystem/workspace scope;
- injectable environment-variable names;
- available logical model roles and spending limits;
- permission to create harness candidates;
- permission to run Promotion Evals.

The envelope is immutable for the lifetime of the child. A need for broader capability creates a new linked child session instead of expanding the existing one. Children receive only the capability necessary for their role rather than inheriting all parent authority.

An evolution child may create candidates but cannot activate its own candidate. Activation requires the incumbent generational evaluation described in ADR-0011.

## Consequences

- One auditable mechanism supports task, evolution, evaluation, and crystallization agents.
- Parent context remains compact without sacrificing drill-down evidence.
- Capability expansion has a visible lineage boundary.
- The daemon must enforce capabilities against actual invocations, not runner declarations alone.

## Alternatives considered

- **Inline every child event in the parent:** rejected because it creates noisy context and storage coupling.
- **Special evolution worker subsystem:** rejected because it would duplicate child lifecycle and observation semantics.
- **Mutable child permissions:** rejected because mid-session expansion is harder to reason about and audit.
- **Full parent capability inheritance:** rejected because a narrow role does not need ambient parent authority.

