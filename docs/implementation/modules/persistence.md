# Module: persistence

## Owns

`src/persistence/object-store.ts`, `project-repository.ts`, `session-repository.ts`, `artifact-store.ts`, and `persistence.test.ts`.

## Implements

Implement `ObjectStore`, `ProjectRepository`, and `SessionRepository`. Use filesystem-native state under the resolved Omega home: immutable SHA-256 objects, atomic project pointers, per-session `session.json`, append-only `events.jsonl`, artifacts, and raw process sidecars. Recover a trailing partial JSONL record without rewriting valid history. Compare-and-set project and event sequence writes must return typed conflicts.

Export the persistence factories exactly as specified in `docs/implementation/runtime-contract.md`.

## Edge cases and gates

Test duplicate object writes, hash mismatch, missing objects, concurrent event appends, final-page cursors, crash during append, artifact range boundaries, repository/worktree identity, and credential-value absence. No SQLite is authoritative.
