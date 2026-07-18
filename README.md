# omega.dev

Omega.dev is a local daemon, CLI, and HTML control plane for a project-scoped, self-improving software-engineering harness. It runs every harness tool as an isolated process, routes models through AI SDK v7, records durable evidence, and promotes harness mutations only after paired evaluation.

This repository is an early implementation. The runtime contract is strict and the main flows are tested, but the product is not yet a stable release.

## What is implemented

- One local daemon shared by the HTML client and `omega` CLI.
- Project-scoped harness lineages stored in Omega's content-addressed state, not in a project's Git history.
- Direct OpenRouter and local/provider-adapter routing through AI SDK v7. There is no implicit Vercel AI Gateway or “Omega provider.”
- Separate model roles: DeepSeek V4 Flash is the current coding/evolution route and GPT-OSS-20B is the cheap automatic execution-policy gate.
- A model-assisted execution policy with deterministic capability bounds and fail-closed sandbox enforcement.
- One isolated OCI process per runner or tool, with live stdin/stdout/stderr observation.
- SHA-bound file writes: a write is rejected when the file changed after the agent read it.
- Durable JSONL session events, resumable handoffs, child sessions, project knowledge, and a local-only marketplace.
- Deterministic scoped `AGENTS.md` bootstrap plus compact project-knowledge and installed-skill catalogs; full documents load selectively through typed runner operations.
- OmegaBench-10: ten content-addressed unusual-project tasks with hidden verifiers and paired incumbent/candidate scoring.
- Project harness evolution with cancellation, canary evidence, automatic promotion, rollback, and quarantine paths.

## Requirements

- Node.js 24.12 or newer
- pnpm 11
- Docker or Podman for isolated runner/tool execution
- An `OPENROUTER_API_KEY` for the default route, or a configured local/provider adapter

The checked-in OpenRouter routes permit provider data collection. Do not send confidential project content through those defaults; select a private provider or local adapter and set the route's data-collection policy accordingly.

## Quick start

```sh
pnpm install
pnpm sandbox:image
pnpm build

export OMEGA_API_TOKEN="choose-a-long-random-token"
export OPENROUTER_API_KEY="..."
pnpm start
```

Open `http://127.0.0.1:7337` and unlock it with `OMEGA_API_TOKEN`.

In another shell, the same daemon is available through the CLI:

```sh
export OMEGA_API_TOKEN="choose-a-long-random-token"
pnpm cli -- projects
pnpm cli -- register /absolute/path/to/project
pnpm cli -- help
```

After installation as a package, the command is exposed as `omega`. Set `OMEGA_DAEMON_URL` to override the default `http://127.0.0.1:7337` loopback address.

## Runtime model

```text
HTML / omega CLI
       │ local HTTP + SSE
       ▼
Omega daemon ── sessions / policy / evolution / marketplace
       │
       ├── model adapters (OpenRouter by default; local endpoints are valid adapters)
       └── Docker or Podman
             └── one process per runner or tool
```

Credentials are read from the daemon process environment. Harness manifests declare only credential environment-variable names; secrets are not persisted into manifests, session headers, or marketplace records.

The default state directory is under the configured Omega home. It contains content-addressed objects, project and harness indexes, append-only session directories, artifacts, knowledge documents, marketplace records, benchmark evidence, and evolution jobs. Project working trees do not version Omega's harness evolution.

## Verification

```sh
pnpm presubmit
```

That runs strict typechecking, the production build, all unit/integration tests, contract conformance, and daemon end-to-end tests.

Architecture decisions live in [`docs/adrs`](docs/adrs/README.md), and the runtime integration contract is in [`docs/implementation/runtime-contract.md`](docs/implementation/runtime-contract.md).
The first completed live evolution run is recorded in [`docs/benchmarks/2026-07-17-deepseek-v4-flash-evolution.md`](docs/benchmarks/2026-07-17-deepseek-v4-flash-evolution.md).

## License

MIT. See [`LICENSE`](LICENSE).
