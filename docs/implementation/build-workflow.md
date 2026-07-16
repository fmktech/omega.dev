# Omega.dev reproducible build workflow

## Frozen seed

- Contract commit: `ae434fa`
- Immutable sources: `src/contracts/index.ts`, `src/config/defaults.ts`, `src/shared/core.ts`, and `docs/implementation/runtime-contract.md`
- Ownership manifest: `plan.json`
- Module direction: `docs/implementation/modules/*.md`

The prep passed three independent strong reviews: the original Claude Fable review and two contract-gauntlet reviewers. Material corrections were re-reviewed until both gauntlet reviewers returned `FREEZE`.

## Implementer rules

Every implementer receives `HANDOFF.md`, `runtime-contract.md`, its module brief, and these rules:

1. Edit only the module's exclusive files from `plan.json`.
2. Never edit the frozen seed.
3. Strict TypeScript, named exports, no `any`, no skipped tests, and no placeholder behavior.
4. Implement the contract-owned `Create*` function types exactly.
5. Expected operational failures use `Result`; credentials never enter logs, config artifacts, or persisted events.
6. Tests assert observable behavior and fake only external boundaries.
7. Do not compile during parallel fan-out; the orchestrator owns the compile loop.

## Implementation waves

1. Persistence, model routing, knowledge/marketplace.
2. Execution policy, process runtime, harness runtime.
3. Sessions, evolution/benchmarks, clients.
4. Daemon integrator.

Each wave is still ownership-independent; waves constrain concurrency and make compiler feedback easier to attribute.

## Hardening phases

1. Run strict typecheck and production build. Group failures by owned file and assign one fixer per file, for at most six rounds.
2. Run reviewers for contract conformance, data integrity, security/policy, client wiring, and lifecycle/race behavior.
3. Skeptically verify every serious finding against an exact runtime path.
4. Apply only confirmed fixes, one owner per file.
5. Run `pnpm presubmit`, boot the daemon with deterministic model/sandbox doubles, exercise authenticated and unauthenticated HTTP, SSE reconnect, session/resume, child/evolution, activation/rollback, and clean shutdown.
6. Run live OpenRouter benchmarks separately and preserve the complete model-route signature; never compare unlike routes.
