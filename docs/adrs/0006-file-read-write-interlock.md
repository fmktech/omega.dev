# ADR-0006: Evolvable SHA-based file interlock

- Status: Accepted
- Date: 2026-07-14

## Context

A coding agent can overwrite another actor's change when it edits content it has not recently observed. Mini-swe-agent's Bash-only action model does not provide a read-before-write compare-and-swap interlock. Omega needs a safe initial mechanism without freezing that mechanism forever in the kernel.

## Decision

The initial harness includes a file tool with an optimistic concurrency contract:

1. `file.read` returns file content and its SHA.
2. `file.write` requires the expected SHA from the relevant read.
3. The tool recomputes the current SHA immediately before writing.
4. A mismatch blocks the write and returns a stale-read error that instructs the runner to read again.

This interlock is a versioned harness tool, not an immutable kernel rule. A future harness may replace it with a better patching, transaction, or editor mechanism, subject to Promotion Eval.

The multi-file atomic-write contract remains unspecified.

## Consequences

- The initial agent cannot silently clobber a file changed after it read that file.
- Stale-edit recovery becomes explicit and observable.
- A malicious or badly designed replacement tool remains constrained by its actual filesystem capability envelope and execution policy, but the SHA algorithm itself can evolve.

## Alternatives considered

- **Unconditional writes:** rejected because they create avoidable lost updates.
- **Kernel-enforced editor semantics:** rejected because file-manipulation strategy is part of the harness Omega should improve.
- **Depend on Git conflict detection:** rejected because harness operation and runtime state cannot assume a local Git history.

