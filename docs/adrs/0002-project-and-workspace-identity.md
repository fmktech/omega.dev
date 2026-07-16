# ADR-0002: Logical projects and registered workspaces

- Status: Accepted
- Date: 2026-07-14

## Context

The same repository may have multiple checkouts or worktrees. Harness evolution and durable knowledge belong to the repository as a logical project, while commands and file state belong to a particular checkout.

## Decision

Omega distinguishes projects from workspaces.

- A **project** is the logical repository identity and owns its harness lineage, marketplace relationship, knowledge, sessions, and evaluations.
- A **workspace** is a concrete checkout or worktree registered under a project.
- Multiple checkouts of the same repository share the project harness and project knowledge.
- Invoking Omega inside a repository registers or resolves that workspace.
- Omega does not scan the filesystem to discover projects.
- A session records both its project and workspace identity.

## Consequences

- Project learning transfers between intentional checkouts without duplicating lineages.
- Workspace-specific state cannot be mistaken for durable project knowledge.
- Repository identity and ambiguous fork handling require an explicit resolver during implementation.

## Alternatives considered

- **One project per directory:** rejected because worktrees would fragment knowledge and evolution.
- **Automatic filesystem discovery:** rejected because it is surprising, expensive, and unnecessary.
- **One global harness across all projects:** rejected because a project must own and control its own evolution.

