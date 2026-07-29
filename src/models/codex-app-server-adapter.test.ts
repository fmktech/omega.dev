import { describe, expect, it } from "vitest";

import type {
  DurationMs,
  HarnessId,
  JsonObject,
  ModelRoleRoute,
  ModelStreamEvent,
  ModelStreamId,
  ProviderConfig,
  SessionId,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";
import {
  createCodexAppServerAdapter,
  inspectCodexSubscription,
  type CodexAppServerTransport,
} from "./codex-app-server-adapter.js";

const PROVIDER: ProviderConfig = {
  providerId: "openai-codex",
  adapter: "codex-app-server",
  baseUrl: "stdio://codex-app-server",
  credentialEnvName: null,
};

const ROUTE: ModelRoleRoute = {
  role: "crystallizer",
  providerId: PROVIDER.providerId,
  modelId: "gpt-5.6-sol",
  reasoning: { mode: "effort", effort: "high" },
  selection: { kind: "provider-defined", options: {} },
  temperature: null,
  topP: null,
  seed: null,
  contextLimit: 400_000 as TokenCount,
  maxOutputTokens: 6_000 as TokenCount,
  timeoutMs: 300_000 as DurationMs,
  equivalentListPrice: {
    inputUsdMicrosPerMillionTokens: 0 as UsdMicros,
    cachedInputUsdMicrosPerMillionTokens: 0 as UsdMicros,
    outputUsdMicrosPerMillionTokens: 0 as UsdMicros,
  },
};

function transport(messages: readonly JsonObject[], sent: JsonObject[] = []): CodexAppServerTransport {
  return {
    messages: (async function* () { yield* messages; })(),
    async send(message) { sent.push(message); },
    async close() {},
  };
}

async function collect(events: AsyncIterable<ModelStreamEvent>): Promise<readonly ModelStreamEvent[]> {
  const collected: ModelStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("Codex app-server adapter", () => {
  it("uses a ChatGPT subscription for a no-tool crystallizer completion", async () => {
    const sent: JsonObject[] = [];
    const fake = transport([
      { id: 1, result: { userAgent: "codex-test" } },
      { id: 2, result: { account: { type: "chatgpt", email: "never-persist@example.test", planType: "pro" }, requiresOpenaiAuth: true } },
      { id: 3, result: { thread: { id: "thread-1" } } },
      { id: 4, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } },
      { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "{\"decision\":\"evolve\"}" } },
      { method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { totalTokens: 27, inputTokens: 20, cachedInputTokens: 5, outputTokens: 7, reasoningOutputTokens: 2 }, last: { totalTokens: 27, inputTokens: 20, cachedInputTokens: 5, outputTokens: 7, reasoningOutputTokens: 2 }, modelContextWindow: 400_000 } } },
      { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 1_800_000_000_000, item: { type: "agentMessage", id: "item-1", text: "{\"decision\":\"evolve\"}", phase: "final_answer", memoryCitation: null } } },
      { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [], error: null, startedAt: 1_800_000_000, completedAt: 1_800_000_001, durationMs: 1_000 } } },
    ], sent);
    const adapter = createCodexAppServerAdapter(async () => ({ ok: true, value: fake }));

    const started = await adapter.start({
      provider: PROVIDER,
      route: ROUTE,
      request: {
        sessionId: "session-1" as SessionId,
        harnessId: "harness-1" as HarnessId,
        role: "crystallizer",
        messages: [{ role: "user", content: [{ kind: "text", text: "Crystallize this feedback" }] }],
        tools: [],
        maxOutputTokens: 6_000 as TokenCount,
        abortAfterMs: 300_000 as DurationMs,
      },
      credential: null,
      streamId: "stream-1" as ModelStreamId,
      signal: new AbortController().signal,
      timeoutMs: 300_000,
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const events = await collect(started.value.events);
    expect(sent.map((message) => message["method"])).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "thread/start",
      "turn/start",
    ]);
    expect(sent[3]?.["params"]).toMatchObject({
      model: "gpt-5.6-sol",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      serviceName: "omega-dev",
    });
    expect(events).toEqual([
      { kind: "text-delta", streamId: "stream-1", delta: "{\"decision\":\"evolve\"}" },
      {
        kind: "usage",
        streamId: "stream-1",
        usage: {
          inputTokens: 20,
          cachedInputTokens: 5,
          outputTokens: 7,
          reasoningTokens: 2,
          costUsdMicros: 0,
        },
      },
      expect.objectContaining({
        kind: "completed",
        completion: expect.objectContaining({
          providerGenerationId: "turn-1",
          content: [{ kind: "text", text: "{\"decision\":\"evolve\"}" }],
          usage: expect.objectContaining({ inputTokens: 20, outputTokens: 7 }),
          route: expect.objectContaining({
            providerId: "openai-codex",
            modelId: "gpt-5.6-sol",
            servingProvider: "chatgpt-subscription",
          }),
          finishReason: "stop",
        }),
      }),
    ]);
  });

  it("rejects an API-key account when subscription auth is required", async () => {
    const fake = transport([
      { id: 1, result: { userAgent: "codex-test" } },
      { id: 2, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } },
    ]);

    const evidence = await inspectCodexSubscription(async () => ({ ok: true, value: fake }));

    expect(evidence).toEqual({
      ok: false,
      error: expect.objectContaining({
        kind: "provider-unavailable",
        providerId: "openai-codex",
        reason: expect.stringContaining("ChatGPT subscription"),
      }),
    });
  });
});
