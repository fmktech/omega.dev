# ADR-0007: Append-only session storage and linked resumes

- Status: Accepted
- Date: 2026-07-14

## Context

Omega needs inspectable, durable task history without forcing every model turn to ingest an ever-growing transcript. Stable session metadata should not be repeated on every event, while raw process streams should not dominate the semantic log. An intentional context resume is conceptually a fresh context with a handoff, not a continuation that rewrites old history.

## Decision

The authoritative session history is append-only JSONL inside a directory per session:

```text
~/.omega/projects/<project-id>/sessions/<session-id>/
  session.json
  events.jsonl
  artifacts/
  snapshots/
  process-output/
```

`session.json` contains stable header data, including session, thread, project, workspace, initial harness, route/policy configuration, schema versions, and environment-variable names but never credential values. Static identifiers implied by the directory and header are omitted from individual event records.

`events.jsonl` contains ordered semantic events. Raw process streams live in sidecars as specified by ADR-0005.

An intentional resume creates a new linked session:

- the predecessor remains immutable;
- the predecessor produces an immutable handoff artifact;
- the new session has a fresh event log;
- `parent_session_id`, `thread_id`, and `handoff_artifact` tie the lineage together;
- the handoff captures the objective, progress, decisions, unresolved work, relevant artifacts, live-handle status, observed file SHAs, and harness version;
- the new runner sees the handoff and explicitly selected artifacts rather than the complete old transcript.

A daemon crash is not an intentional resume and therefore does not create a new session by itself. Recovery appends interruption/recovery facts to the existing session when possible.

SQLite is deferred in v0. Filesystem traversal and append/tail operations are sufficient until measurements justify a rebuildable derived index.

## Consequences

- Original evidence remains auditable while resumed context stays small.
- CLI and HTML can render either one session or the full thread lineage.
- Handoff quality becomes an important evolvable context-compiler concern.
- Schema versioning and append recovery must be defined carefully.

## Alternatives considered

- **One indefinitely growing session:** rejected because resume boundaries and context costs become opaque.
- **Rewrite or compact old events:** rejected because it destroys authoritative evidence.
- **Put all state in SQLite immediately:** deferred under YAGNI; an index may be derived later.
- **Recompute the full history every turn:** rejected because a handoff provides a cleaner explicit context boundary.

