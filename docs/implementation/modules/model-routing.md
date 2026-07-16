# Module: model-routing

## Owns

`src/models/provider-registry.ts`, `openrouter-adapter.ts`, `model-router.ts`, and `model-routing.test.ts`.

## Implements

Implement `ModelRouter` with AI SDK v7 and `@openrouter/ai-sdk-provider`. Resolve logical roles from parsed config, stream normalized deltas/tool calls, aggregate usage, record actual OpenRouter model/provider/generation metadata, and honor reasoning/sampling/provider-selection settings. Credentials come only from the injected daemon environment name.

Export `createModelRouter` exactly as specified in `docs/implementation/runtime-contract.md`.

## Edge cases and gates

Test missing credentials, unsupported parameters, malformed tool input, partial response failure, abort, timeout, 429 with retry metadata, unavailable pinned provider, fallback attribution, free-route zero charge plus equivalent list price, and absent provider fingerprint fields.
