# Module: clients

## Owns

`src/clients/local-client.ts`, `cli.ts`, `html-app.ts`, and `clients.test.ts`.

## Implements

Implement `OmegaClient`, the CLI commands, and the local HTML application against the same HTTP/SSE contract. Both surfaces list/register projects, list/start/resume/cancel sessions, stream live events, inspect artifacts/knowledge/marketplace/evolution/scorecards, resolve policy escalations, and pin/rollback harnesses. Neither client implements agent logic.

Export the three exact client entry points and implement every state in the acceptance matrix in `docs/implementation/runtime-contract.md`.

## Edge cases and gates

Test invalid bearer token, daemon unavailable, SSE reconnect and sequence deduplication, paginated discovery, binary artifact slices, interrupted streams, sanitized errors, concurrent clients, terminal cancellation, and HTML rendering of mixed-version session history. Do not persist credentials in browser storage or CLI logs.
