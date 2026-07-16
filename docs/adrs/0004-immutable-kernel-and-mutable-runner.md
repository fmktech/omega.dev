# ADR-0004: Immutable daemon kernel and mutable agent runner

- Status: Accepted
- Date: 2026-07-14

## Context

Omega should be able to improve its own agent harness, including the logic that controls model turns and tool use. Some substrate must remain stable enough to store history, enforce actual capabilities, supervise processes, and roll back a broken harness.

## Decision

Omega separates a small immutable daemon kernel from a mutable runner.

The kernel provides:

- the local session and event API;
- the AI SDK v7 model transport and route resolution;
- process spawning, streaming, and supervision;
- content-addressed storage and project activation pointers;
- rollback and recovery;
- API authentication;
- enforcement of the effective capability envelope.

The `agent-runner` is a content-addressed harness component executed as its own process. It decides:

- model-turn sequencing;
- context construction and compression;
- exposed tool schemas and observation handling;
- child-session creation;
- when to request evolution.

The runner and daemon communicate using bidirectional JSONL over standard streams:

- runner stdout emits commands;
- runner stdin receives results and events;
- runner stderr contains diagnostic output.

The exact protocol schema remains to be specified before implementation.

## Consequences

- Omega can evolve substantive orchestration behavior without risking the storage and rollback substrate.
- The kernel must remain narrow; moving agent strategy into it would accidentally freeze the harness.
- A protocol mismatch or broken runner can be detected and rolled back by the daemon.

## Alternatives considered

- **Agent loop embedded in the daemon:** rejected because the central behavior would not be evolvable.
- **Everything mutable:** rejected because a failed candidate could corrupt its evidence, activation, or recovery mechanisms.
- **Language-specific extension host:** rejected because harness components may be Node, Python, Bash, or other executables.

