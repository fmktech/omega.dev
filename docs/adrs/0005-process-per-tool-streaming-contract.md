# ADR-0005: Process-per-tool streaming contract

- Status: Accepted
- Date: 2026-07-14

## Context

Harness tools may be implemented in Node, Python, Bash, or another executable language. Some tools finish quickly; others remain active in the background and need incremental observation or interactive input. Returning output only when a tool exits would prevent terminal-like work and the interlocks used by effective coding agents.

## Decision

Every tool invocation runs as its own operating-system process rather than inside a shared extension host.

The daemon exposes a process-handle protocol with these operations:

- `process.start` starts an invocation and returns its handle;
- `process.observe` peeks at new stdout/stderr byte ranges and current status;
- `process.input` writes stdin or a control message;
- `process.cancel` terminates the invocation's process group.

Live stdout and stderr chunks are forwarded immediately to the runner and connected CLI/HTML clients. A process remains associated with the harness version that spawned it, even when a newer harness becomes active.

Raw streams are written append-only to per-process sidecars:

```text
process-output/<process-id>.stdout
process-output/<process-id>.stderr
```

The session JSONL contains semantic records rather than chunks:

- `process.started` records identity, command facts, harness version, and stream paths;
- `process.observed` records the byte ranges intentionally incorporated by an agent;
- `process.completed` records exit status, duration, final sizes, and hashes.

Model response deltas follow the same storage principle: stream live, but persist the aggregated response, usage, resolved route, and timing. A failed model call may retain a reference to its partial aggregate.

## Consequences

- Tools are language-neutral and failure-isolated.
- Long-running commands can be observed and controlled without blocking a runner turn.
- The semantic event log remains compact while raw evidence remains available.
- The daemon must implement backpressure, output limits, process-group termination, and secure command fact extraction.

## Alternatives considered

- **In-process plugins:** rejected because one broken or incompatible extension could corrupt the daemon and would constrain implementation languages.
- **Collect output only at exit:** rejected because interactive and background work require live streams.
- **Persist every chunk as JSONL:** rejected because chunks inflate the canonical log without adding semantic value.

