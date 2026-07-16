# Omega.dev implementation handoff

This packet is the output of contract-first preparation. Implementers build against the frozen contract without coordinating concrete types with other leaf modules.

## Immutable files

Do not edit these files during fan-out:

- `src/contracts/index.ts`
- `src/config/defaults.ts`
- `src/shared/core.ts`
- `docs/implementation/runtime-contract.md`

If a signature is wrong or missing, stop and report the gap to the orchestrator. The orchestrator alone may amend and re-freeze the contract, then rebroadcast the change.

## Shared rules

1. Create or edit only files assigned to your module in `plan.json`.
2. Import cross-module shapes and service interfaces from `src/contracts/index.ts`.
3. Leaf modules must not import another feature module's concrete implementation.
4. `daemon-integrator` is the only module allowed broad concrete imports and owns all wiring.
5. Expected operational failures use the contract's `Result<T, E>` channel; do not throw them.
6. Never persist or log credential values. Only declared environment-variable names cross contracts.
7. Persist semantic events, not model/process chunks. Raw process output remains in sidecars.
8. Tests assert observable behavior and use real owned collaborators or in-memory fakes; mock only external boundaries.
9. Do not add dependencies, change compiler settings, or amend defaults without orchestrator approval.
10. Finish with no TODOs, skipped tests, placeholder branches, `any`, or untyped wire data.
11. Export the exact named factories and implement the HTTP/SSE/JSONL rules in `runtime-contract.md`.

## Build order

All nine leaf modules can start independently. `daemon-integrator` reads only their documented exports and should wire them after leaf typechecks are green. Final integration runs root typecheck, build, unit/integration tests, and the deterministic scripted-model end-to-end flow before any live-model benchmark.

## Contract and decision context

- Contract seam inventory: `docs/implementation/contract-seams.md`
- Runtime construction and transport: `docs/implementation/runtime-contract.md`
- Architectural decisions: `docs/adrs/README.md`
- Testing/evaluation loop: `docs/adrs/0015-testing-and-ai-feedback-loop.md`
- Sandbox enforcement: `docs/adrs/0016-enforceable-process-sandbox-boundary.md`
- Module specs: `docs/implementation/modules/`
