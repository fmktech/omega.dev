# Omega.dev Architecture Decision Records

These records capture the decisions agreed during the Omega.dev design interview. They are the architectural source of truth when they conflict with the older v0.2 PRD.

## Status vocabulary

- **Accepted**: agreed and expected to guide implementation.
- **Proposed**: plausible direction that still needs an explicit decision.
- **Superseded**: replaced by a later ADR.

## Decisions

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-local-daemon-and-equal-clients.md) | Local daemon and equal CLI/HTML clients | Accepted |
| [0002](0002-project-and-workspace-identity.md) | Logical projects and registered workspaces | Accepted |
| [0003](0003-project-harness-lineage-and-local-marketplace.md) | Project harness lineages and local marketplace | Accepted |
| [0004](0004-immutable-kernel-and-mutable-runner.md) | Immutable daemon kernel and mutable agent runner | Accepted |
| [0005](0005-process-per-tool-streaming-contract.md) | Process-per-tool streaming contract | Accepted |
| [0006](0006-file-read-write-interlock.md) | Evolvable SHA-based file interlock | Accepted |
| [0007](0007-append-only-session-storage-and-lineage.md) | Append-only session storage and linked resumes | Accepted |
| [0008](0008-project-knowledge-as-skill-documents.md) | Project knowledge as skill-like documents | Accepted |
| [0009](0009-model-routing-credentials-and-execution-policy.md) | Provider-neutral routing, environment credentials, and policy | Accepted |
| [0010](0010-background-evolution-and-mid-run-activation.md) | Background evolution and safe-boundary activation | Accepted |
| [0011](0011-promotion-eval-and-generational-governance.md) | Promotion Eval and generational evaluator governance | Accepted |
| [0012](0012-child-sessions-and-capability-envelopes.md) | Child sessions and immutable capability envelopes | Accepted |
| [0013](0013-daemon-restart-and-process-recovery.md) | Daemon restart and non-resumable tool processes | Accepted |
| [0014](0014-minimal-initial-harness.md) | Minimal initial harness | Accepted |
| [0015](0015-testing-and-ai-feedback-loop.md) | Testing and the AI feedback loop | Accepted |
| [0016](0016-enforceable-process-sandbox-boundary.md) | Enforceable process sandbox boundary | Accepted |

## Known PRD conflicts

The following v0.2 PRD positions were superseded during the interview and should be corrected in its next revision:

- Project harness promotion is automatic after Promotion Eval; it does not require human approval.
- The Promotion Eval implementation is evolvable under the parent-evaluates-child rule; it is not permanently protected runtime code.
- Harness updates may become active during a task at safe call boundaries.
- There is no active global harness lineage. Other projects discover precedents locally and synthesize their own candidates.
- The local registry is content-addressed filesystem storage in v0; SQLite is deferred until measured query needs justify it.
- Project knowledge is a catalog of skill-like Markdown documents, not one profile injected into every prompt.
- Durable sessions use per-session files and append-only JSONL; process and model chunks are not stored as JSONL events.

## Still open

These implementation choices were not finalized and therefore do not have accepted ADRs:

- Operating-system portability beyond the Docker/Podman OCI boundary.
- Exact OmegaBench-10 fixture contents and per-task budgets; route, policy, replicate, and baseline semantics are frozen in the runtime contract and defaults.
- Retention, encryption-at-rest, backup, and garbage-collection policies.
