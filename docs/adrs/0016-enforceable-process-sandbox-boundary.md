# ADR-0016: Enforceable process sandbox boundary

- Status: Accepted
- Date: 2026-07-16

## Context

Each tool already runs as a separate process under ADR-0005, but process separation alone does not enforce filesystem or network restrictions. OmegaBench includes offline execution and prohibited-side-effect cases, and the execution-policy agent must decide from constraints the runtime can actually enforce. Silently falling back to an unrestricted host process would make those tests and policy decisions fictional.

## Decision

Every `ProcessSpec` includes an enforceable `SandboxSpec` declaring:

- workspace filesystem access as read-only or read-write;
- network access as none, an explicit host allowlist, or unrestricted;
- memory and CPU-time limits.

The process-runtime module uses a Docker or Podman backend. Configuration may select either backend or `auto`, which chooses an installed backend capable of enforcing the complete specification. Failure to find a capable backend is an explicit unsupported/runtime error; Omega does not weaken the specification or fall back to unsandboxed host execution.

The execution-policy adapter evaluates the effective `SandboxSpec`, command, working directory, credential names, and capability envelope before process creation. A network-egress capability identifies allowed hosts, and the sandbox applies the same or a narrower set.

Benchmark fixtures that declare offline execution use `network: none`. Their verifier must distinguish sandbox/provider availability failures from agent task failures.

Each tool invocation remains its own supervised process. The sandbox backend is an enforcement mechanism, not a shared extension host.

## Consequences

- Offline and egress-restricted benchmark cases test real behavior.
- Policy cannot claim to deny a side effect while the runtime remains technically able to perform it.
- Docker or Podman becomes a v0 runtime prerequisite for side-effecting tools.
- Supporting native operating-system sandboxes is deferred and will require a new backend conformance suite.
- Sandbox startup overhead must be measured separately from model and harness efficiency.

## Alternatives considered

- **Host processes plus model policy:** rejected because model intent cannot enforce filesystem or network boundaries.
- **Best-effort sandbox with host fallback:** rejected because it silently violates task and benchmark invariants.
- **One shared container for all tools:** rejected because invocations require independent process lifecycle, capabilities, attribution, and cancellation.
- **Choose Docker permanently:** rejected because Docker and Podman can implement the same contract; backend conformance matters more than brand.

