# Module: model-routing

## Owns

`src/models/provider-registry.ts`, `openrouter-adapter.ts`, `codex-app-server-adapter.ts`, `model-router.ts`, and their routing tests.

## Implements

Implement `ModelRouter` with AI SDK v7 and `@openrouter/ai-sdk-provider`. Resolve logical roles from parsed config, stream normalized deltas/tool calls, aggregate usage, record actual OpenRouter model/provider/generation metadata, and honor reasoning/sampling/provider-selection settings. For providers Omega authenticates directly, credentials come only from the injected daemon environment name.

The opt-in Codex adapter delegates ChatGPT subscription authentication to the local `codex app-server`, verifies ChatGPT auth through `account/read`, and currently accepts no-tool crystallizer requests only. It never reads Codex credential storage.

Export `createModelRouter` exactly as specified in `docs/implementation/runtime-contract.md`.

## Edge cases and gates

Test missing credentials, unsupported parameters, malformed tool input, partial response failure, abort, timeout, 429 with retry metadata, unavailable pinned provider, fallback attribution, free-route zero charge plus equivalent list price, and absent provider fingerprint fields.
