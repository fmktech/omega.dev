# Module: knowledge-marketplace

## Owns

`src/knowledge/knowledge-service.ts`, `marketplace-service.ts`, `artifact-state.ts`, and `knowledge-marketplace.test.ts`.

## Implements

Implement `KnowledgeService` and `MarketplaceService`. Validate skill-like Markdown frontmatter, return lightweight catalogs, use SHA compare-and-swap writes, retain source provenance, automatically publish local artifacts, enforce marketplace states, and install only compatible permitted components. Complete harnesses are precedents; receiving projects keep independent lineages.

Export both factories from `docs/implementation/runtime-contract.md`. Compatibility is evaluated from the artifact manifest; experimental installs remain inactive and require a project-scoped canary.

## Edge cases and gates

Test invalid frontmatter, stale knowledge write, path/tag filtering, missing provenance, credential-name declarations, duplicate publication, experimental/proven/deprecated/quarantined transitions, quarantined install denial, compatibility failure, and cross-project activation isolation.
