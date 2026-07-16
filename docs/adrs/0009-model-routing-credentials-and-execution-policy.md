# ADR-0009: Provider-neutral routing, environment credentials, and execution policy

- Status: Accepted
- Date: 2026-07-14

## Context

Omega must work with any desired cloud provider or local model without inventing an "Omega provider" or depending on Vercel AI Gateway. Tools such as Jira connectors need credentials, while the harness and marketplace must not capture secret values. Autonomous operation still needs decisions based on actual side effects rather than an agent's description of its intent.

## Decision

The daemon uses AI SDK v7 as its provider-neutral model router.

- Harness code asks for logical roles such as `main-coder`, `fast-policy`, `harness-mutator`, and `promotion-evaluator`.
- Local configuration maps roles to direct cloud-provider adapters or local endpoints.
- There is no Omega model provider and no implicit Vercel AI Gateway route.
- Every model event records the resolved provider/model route, parameters, usage, and timing.

Credentials come only from the daemon process environment:

- Omega core does not discover or parse project `.env` files.
- A tool process may load local environment files as part of its own runtime behavior.
- A marketplace component declares the environment-variable names it needs.
- The daemon injects only declared and permitted variables into that tool process.
- Credential values never enter prompts, marketplace artifacts, session headers, or event logs.

Every side-effecting invocation is evaluated by an execution-policy agent plus deterministic enforcement:

- policy outcomes are `allow`, `deny`, or `escalate`;
- operators may configure manual, guarded, or autonomous profiles;
- a cheap, fast model role may classify ambiguous actions;
- the adapter derives command, path, mount, egress, and side-effect facts from the actual invocation;
- deterministic hard limits and the effective capability envelope retain authority over a model's allow result.

Project harness promotion and locally trusted marketplace publication/installation do not require human approval; their automatic gates are specified in ADR-0003 and ADR-0011. Execution-policy escalation remains available as a configurable action outcome and is distinct from harness promotion.

## Consequences

- Provider choice remains operator-controlled and local models are first-class.
- Secret handling is narrow and auditable by variable name without persisting values.
- Policy decisions can be inexpensive without giving a policy model unrestricted authority.
- Tool manifests need explicit credential and capability declarations.

## Alternatives considered

- **Omega-specific provider:** rejected because it adds a fictitious and unnecessary abstraction.
- **Vercel AI Gateway default:** rejected because infrastructure independence is a requirement.
- **Core `.env` discovery:** rejected because it would make credential exposure implicit and project-dependent.
- **Trust agent-reported intent:** rejected because permission must be derived from the action actually executed.

