# ADR-0013: Daemon restart and non-resumable tool processes

- Status: Accepted
- Date: 2026-07-14

## Context

Tool processes use daemon-owned stdin/stdout/stderr pipes. Transparently reconnecting those streams after the daemon crashes would require a persistent broker around every invocation and substantially increase v0 complexity.

## Decision

Running tool processes are not resumable across daemon restarts in v0.

- A graceful daemon shutdown cancels its active process groups.
- An unexpected daemon failure causes unfinished invocations to be recorded as `interrupted` during recovery.
- Startup identifies and terminates verified orphaned process groups owned by the prior daemon instance.
- Captured stdout/stderr sidecars and already appended semantic events remain available.
- The resumed runner decides whether an interrupted invocation is safe and useful to restart.
- Omega does not claim transparent stdin/stdout reconnection.

An intentional agent-context resume remains a new linked session under ADR-0007; daemon crash recovery is an infrastructure event and continues the existing session history where possible.

## Consequences

- V0 avoids a per-tool broker while remaining honest about lost interactive state.
- Tool invocations should be idempotent where practical, but the runner must not blindly retry side effects.
- Orphan verification must avoid terminating unrelated host processes.

## Alternatives considered

- **Persistent broker for every process:** deferred until evidence shows restart continuity is worth the complexity.
- **Leave orphans running:** rejected because they could continue side effects without observation or control.
- **Always auto-retry:** rejected because interrupted tools may have partially completed external effects.

