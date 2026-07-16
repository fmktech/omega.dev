# ADR-0003: Project harness lineages and a local marketplace

- Status: Accepted
- Date: 2026-07-14

## Context

Omega is used across different projects, but a harness improvement that works in one project must not silently change another. At the same time, projects should be able to learn from tools and harnesses already created locally. Harness history cannot rely on a mutable local Git tree when Omega is deployed as software.

## Decision

Each project owns an independent harness lineage. There is no active global harness lineage.

Harness versions are immutable manifests with:

- a canonical content-addressed identifier;
- a readable project-local alias such as `project-a@18`;
- parent and source-artifact provenance;
- references to immutable content-addressed components rather than duplicated component contents.

Omega also maintains a fully local marketplace:

- It contains only artifacts created and vetted by the local Omega installation; it is not an external package feed.
- It advertises complete harness snapshots as precedents and extracted tools, connectors, skills, workflows, and deltas as reusable components.
- Artifacts are classified as `experimental`, `proven`, `deprecated`, or `quarantined`.
- Publication is automatic and requires no human approval.
- Proven compatible components may be installed automatically when needed. Experimental artifacts require stricter canary evaluation. Quarantined artifacts are never installed.
- Tools and connectors may be adopted as-is. Complete harnesses are primarily evidence for an evolution agent, which synthesizes a project-owned candidate rather than replacing the receiving project's lineage.
- A project never changes another project's active harness pointer.

The filesystem object store under `~/.omega` is authoritative in v0. A full export materializes a manifest and all referenced objects. SQLite or another index may be added later as a derived, rebuildable acceleration layer.

## Consequences

- Improvements are shareable without creating cross-project ambient mutation.
- Provenance and deduplication are natural properties of the object model.
- Automatic installation is limited to artifacts already trusted by the local system.
- Compatibility, canary, and quarantine semantics must be defined as machine-readable contracts.

## Alternatives considered

- **Global mutable harness:** rejected because project-specific assumptions would leak into unrelated work.
- **Copy another project's entire harness into the active project:** rejected because the receiving project must evaluate and own its composition.
- **Git repository as harness database:** rejected because deployed installations need a runtime-native history and activation mechanism.
- **External marketplace:** rejected; the product thesis is to build and compound locally, not copy unknown artifacts from outside.

