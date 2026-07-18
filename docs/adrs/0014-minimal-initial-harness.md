# ADR-0014: Minimal initial harness

- Status: Accepted
- Date: 2026-07-14

## Context

Omega begins from a mini-swe-agent-like preference for a lean harness. Shipping many specialized IDE and integration tools would enlarge the trusted starting surface and leave less meaningful work for harness evolution.

## Decision

The initial harness exposes only these conceptual tools:

- `file.read` and SHA-guarded `file.write`;
- `process.start`, `process.observe`, `process.input`, and `process.cancel`;
- `subagent.spawn` and `subagent.observe`;
- automatic `context.bootstrap`, then `knowledge.catalog`, `knowledge.read`, `skill.read`, and `knowledge.write`;
- `marketplace.search` and `marketplace.install`;
- `harness.evolve` and `harness.status`.

The main agent may call `harness.evolve` at any point, subject to the incumbent execution-policy decision. Automatic post-task crystallization is also enabled for eligible expensive successes.

`context.bootstrap` is an internal runner handshake rather than a model-facing tool. It must complete after `runner.ready` and before the first model request so repository instructions and compact catalogs cannot depend on model initiative.

Shell commands, Git, tests, search utilities, Python, Node, and Bash are accessed through the process interface. Jira and similar connectors are marketplace components rather than kernel features.

Specialized patching, Git, testing, code-search, browser, and domain tools should emerge as versioned components after observed need and Promotion Eval evidence.

## Consequences

- The bootstrap harness is small enough to understand and replace incrementally.
- Generic process execution remains powerful, so execution policy and isolation are essential.
- Early agent ergonomics may be weaker until high-value specialized tools crystallize.
- Conceptual tool names will need exact request, response, and error schemas before implementation.

## Alternatives considered

- **Replicate a broad existing coding-agent tool suite:** rejected because Omega should learn which tools its projects need.
- **Bash as the only tool:** rejected because process lifecycle, structured knowledge, marketplace, evolution, and the SHA file interlock need explicit contracts.
- **Jira in the kernel:** rejected because connectors are installable, project-dependent components.
