# Module: daemon-integrator

## Owns

`src/app/omega-app.ts`, `http-server.ts`, `sse-broker.ts`, `daemon-integrator.test.ts`, and `src/main.ts`.

## Implements

This is the sole integrator. Construct `OmegaContext`, parse/resolve pure-data config, wire every concrete leaf, authenticate loopback HTTP, map `ClientRequest` to services, expose SSE, supervise startup/recovery/shutdown ordering, and sanitize uncaught defects into `InternalError` artifacts. It is the only module allowed broad concrete imports.

Use the exact routes, status behavior, factory names, construction order, and shutdown order in `docs/implementation/runtime-contract.md`.

## Edge cases and gates

Test startup with missing sandbox/provider configuration, invalid token, port conflict, partial persistence recovery, runner protocol failure, deferred policy reply, simultaneous shutdown and task start, process cleanup deadline, SSE client disconnect, and complete end-to-end task/resume/child/evolution/rollback flows using deterministic scripted model and sandbox doubles.
