# ADR-0019: Subscription-managed model authentication

- Status: Accepted
- Date: 2026-07-29

## Context

ADR-0009 requires environment variables for providers Omega contacts directly. A local Codex installation can instead authenticate to OpenAI with a ChatGPT subscription: Codex owns the OAuth lifecycle and exposes a supported local app-server protocol. Copying its access or refresh tokens into Omega would duplicate credential ownership and increase secret exposure.

## Decision

Omega may support an explicit subscription-managed provider adapter when a trusted local provider runtime owns authentication.

For the Codex adapter:

- the operator logs in through `codex login` using ChatGPT;
- Omega starts `codex app-server --stdio` and verifies `account/read` reports `type: chatgpt`;
- API-key auth is rejected for a benchmark claiming subscription-backed execution;
- Codex owns token storage and refresh; Omega never reads, copies, logs, or persists tokens or account email;
- the adapter is opt-in and does not replace OpenRouter or local endpoints as defaults;
- the initial adapter is restricted to no-tool `crystallizer` requests in ephemeral, read-only threads;
- benchmark evidence records auth type, plan type, model route, usage, and downstream paired results, but no identity or secret values.

The environment-variable rule remains authoritative for providers whose credentials Omega supplies directly. Subscription-managed auth is delegation to a local provider runtime, not implicit project `.env` discovery.

## Consequences

- Operators can use ChatGPT Plus/Pro capacity for reflection without an OpenAI API key.
- Login and refresh behavior stays compatible with the installed Codex version.
- Omega depends on the local Codex executable and its app-server protocol for this adapter.
- Provider-reported subscription usage has no per-request API charge, so Omega records zero provider cost for reflection and keeps coder-arm cost comparisons separate.
- Tool-capable Codex routing remains deferred until Omega can map Codex tool requests through its own capability and policy boundaries.

## Alternatives considered

- **Read Codex credential files directly:** rejected because it couples Omega to private storage and exposes refresh tokens.
- **Call the Codex backend directly:** rejected because it duplicates OAuth, refresh, and account-header logic owned by Codex.
- **Treat the subscription as an OpenAI API key:** rejected because ChatGPT subscription auth and API billing are different mechanisms.
- **Make Codex the default provider:** rejected because provider choice remains operator-controlled.
