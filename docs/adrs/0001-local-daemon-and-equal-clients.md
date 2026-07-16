# ADR-0001: Local daemon and equal CLI/HTML clients

- Status: Accepted
- Date: 2026-07-14

## Context

Omega must provide a strong terminal experience and may also expose an HTML interface. Both interfaces need live task state, process streaming, background evolution, and consistent control semantics. The system must run fully locally and must not depend on Vercel infrastructure.

## Decision

Omega runs as a persistent local daemon that owns the canonical API and runtime state.

- The CLI and HTML application are equal, thin clients of the same interface.
- The daemon binds only to loopback in v0.
- Request/response operations use a local HTTP API.
- Live updates use Server-Sent Events unless a later protocol requirement proves SSE insufficient.
- A generated local bearer token authenticates clients.
- Neither client contains a separate agent runtime or privileged implementation path.

## Consequences

- CLI and HTML behavior cannot drift behind separate backends.
- Background work continues when a client disconnects.
- API contracts become an early implementation dependency.
- Remote access, multi-user authorization, and hosted control planes are outside v0.

## Alternatives considered

- **CLI as the runtime:** rejected because HTML and reconnecting clients would need a second control path.
- **HTML as primary with CLI wrappers:** rejected because the terminal is a first-class product surface.
- **Vercel-hosted runtime:** rejected because local autonomous operation is a requirement.

