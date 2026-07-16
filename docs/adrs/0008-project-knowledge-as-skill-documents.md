# ADR-0008: Project knowledge as skill-like documents

- Status: Accepted
- Date: 2026-07-14

## Context

A single project profile injected into every prompt would waste context and make detailed knowledge hard to organize. Agents already understand the pattern of a lightweight skill catalog whose complete documents are loaded only when relevant.

## Decision

Durable project knowledge is stored as readable Markdown documents with validated frontmatter. Typical frontmatter includes:

- stable identifier, title, and short summary;
- tags and relevant repository paths;
- confidence and verification time;
- source session/event/artifact provenance;
- invalidation or freshness conditions.

At session start, the runner receives only a compact catalog of titles, summaries, tags, confidence, and relevant paths. It reads a complete document selectively when the task requires it.

The same discovery shape may catalog project knowledge, installed skills, connectors, tools, and marketplace precedents, while retaining distinct artifact types and permissions.

Knowledge files remain ordinary readable Markdown, but writes go through the daemon API so Omega can validate frontmatter, attach provenance, version the document, and reject concurrent modification.

Both of these write paths are allowed:

- the main agent creates or updates knowledge directly when it identifies a useful durable fact;
- a background post-task crystallization session proposes knowledge extracted from a difficult or successful trajectory.

Original session evidence remains authoritative if a knowledge document becomes stale or incorrect.

## Consequences

- Context is retrieved progressively instead of injected wholesale.
- Knowledge is inspectable and portable without a database client.
- Retrieval and staleness behavior can evolve as harness components.
- The daemon needs a small schema validator and provenance/versioning API.

## Alternatives considered

- **One monolithic project profile:** rejected because it grows into mandatory context.
- **Opaque vector-store-only memory:** rejected because durable knowledge must remain readable and attributable.
- **Only post-task memory writes:** rejected because the main agent may discover an immediately valuable durable fact.
- **Only direct writes:** rejected because automatic crystallization is central to compounding hard-won knowledge.

