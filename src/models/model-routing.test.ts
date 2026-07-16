import { APICallError, type LanguageModelUsage, type ProviderMetadata } from "ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import type {
  CapabilityEnvelope,
  DurationMs,
  EnvironmentVariables,
  HarnessId,
  ModelRequest,
  ModelStreamEvent,
  ModelStreamId,
  SessionId,
  Timestamp,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";
import {
  createOpenRouterAdapter,
  type OpenRouterBoundary,
  type OpenRouterBoundaryChunk,
  type OpenRouterBoundaryRequest,
} from "./openrouter-adapter.js";
import { createModelRouterWithAdapters } from "./model-router.js";

const SDK_USAGE: LanguageModelUsage = {
  inputTokens: 12,
  inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 0 },
  outputTokens: 7,
  outputTokenDetails: { textTokens: 5, reasoningTokens: 2 },
  totalTokens: 19,
};

const OPENROUTER_METADATA: ProviderMetadata = {
  openrouter: {
    provider: "nvidia",
    quantization: "fp8",
    usage: { cost: 0 },
  },
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    sessionId: "session-1" as SessionId,
    harnessId: "harness-1" as HarnessId,
    role: "main-coder",
    messages: [{ role: "user", content: [{ kind: "text", text: "Fix it" }] }],
    tools: [],
    maxOutputTokens: 128 as TokenCount,
    abortAfterMs: 10_000 as DurationMs,
    ...overrides,
  };
}

function capabilities(overrides: Partial<CapabilityEnvelope> = {}): CapabilityEnvelope {
  return {
    grants: [],
    modelRoles: ["main-coder"],
    maxCostUsdMicros: 0 as UsdMicros,
    maxModelCalls: 3,
    maxProcessStarts: 0,
    maxInputTokens: 10_000 as TokenCount,
    maxOutputTokens: 1_000 as TokenCount,
    wallTimeMs: 60_000 as DurationMs,
    createdAt: "2026-07-16T00:00:00.000Z" as Timestamp,
    ...overrides,
  };
}

function boundary(
  chunks: readonly OpenRouterBoundaryChunk[],
  captured: OpenRouterBoundaryRequest[] = [],
): OpenRouterBoundary {
  return {
    stream(boundaryRequest) {
      captured.push(boundaryRequest);
      async function* stream(): AsyncIterable<OpenRouterBoundaryChunk> {
        yield* chunks;
      }
      return { stream: stream() };
    },
  };
}

async function collect(events: AsyncIterable<ModelStreamEvent>): Promise<readonly ModelStreamEvent[]> {
  const result: ModelStreamEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

function routerWithBoundary(
  openRouterBoundary: OpenRouterBoundary,
  environment: EnvironmentVariables = { OPENROUTER_API_KEY: "test-key" },
) {
  return createModelRouterWithAdapters(
    DEFAULT_CONFIG.models,
    environment,
    { openrouter: createOpenRouterAdapter(openRouterBoundary) },
    { createStreamId: () => "stream-1" as ModelStreamId },
  );
}

describe("model routing", () => {
  it("resolves a logical role to its frozen route signature", async () => {
    const router = routerWithBoundary(boundary([]));

    const result = await router.resolve("main-coder");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        providerId: "openrouter",
        modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
        variant: "free",
        contextLimit: 1_000_000,
        outputLimit: 32_768,
        equivalentListPrice: {
          inputUsdMicrosPerMillionTokens: 500_000,
          cachedInputUsdMicrosPerMillionTokens: 100_000,
          outputUsdMicrosPerMillionTokens: 2_200_000,
        },
      });
    }
  });

  it("reads credentials only from the injected environment", async () => {
    const router = routerWithBoundary(boundary([]), {});

    const result = await router.stream(request(), capabilities());

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "provider-unavailable", providerId: "openrouter" }),
    });
  });

  it("passes route controls to the SDK boundary and records actual provider metadata", async () => {
    const captured: OpenRouterBoundaryRequest[] = [];
    const router = routerWithBoundary(boundary([
      { type: "text-delta", text: "done" },
      {
        type: "finish-step",
        responseId: "generation-7",
        usage: SDK_USAGE,
        providerMetadata: OPENROUTER_METADATA,
      },
      { type: "finish", finishReason: "stop", totalUsage: SDK_USAGE },
    ], captured));

    const result = await router.stream(request(), capabilities());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const events = await collect(result.value.events);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      apiKey: "test-key",
      temperature: undefined,
      maxOutputTokens: 128,
      reasoning: "high",
      timeoutMs: 10_000,
    });
    expect(captured[0]?.modelSettings).toMatchObject({
      provider: { allow_fallbacks: true, require_parameters: true, data_collection: "allow" },
      usage: { include: true },
    });
    expect(events).toEqual([
      { kind: "text-delta", streamId: "stream-1", delta: "done" },
      {
        kind: "usage",
        streamId: "stream-1",
        usage: {
          inputTokens: 12,
          cachedInputTokens: 4,
          reasoningTokens: 2,
          outputTokens: 7,
          costUsdMicros: 0,
        },
      },
      expect.objectContaining({
        kind: "completed",
        completion: expect.objectContaining({
          providerGenerationId: "generation-7",
          finishReason: "stop",
          route: expect.objectContaining({ servingProvider: "nvidia", quantization: "fp8" }),
        }),
      }),
    ]);
  });

  it("fails closed on malformed tool input", async () => {
    const router = routerWithBoundary(boundary([
      { type: "tool-call", toolCallId: "call-1", toolName: "edit", input: "not-an-object" },
    ]));

    const result = await router.stream(request(), capabilities());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(await collect(result.value.events)).toEqual([
        expect.objectContaining({ kind: "failed", error: expect.objectContaining({ kind: "protocol-error" }) }),
      ]);
    }
  });

  it("preserves partial deltas before a provider stream failure", async () => {
    const router = routerWithBoundary(boundary([
      { type: "text-delta", text: "partial" },
      { type: "error", error: new Error("socket closed") },
    ]));

    const result = await router.stream(request(), capabilities());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const events = await collect(result.value.events);
      expect(events[0]).toEqual({ kind: "text-delta", streamId: "stream-1", delta: "partial" });
      expect(events[1]).toEqual(expect.objectContaining({ kind: "failed", partialArtifactId: null }));
    }
  });

  it("maps HTTP 429 and retry metadata to the typed rate-limit error", async () => {
    const rateLimit = new APICallError({
      message: "slow down",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { "retry-after": "2" },
    });
    const router = routerWithBoundary(boundary([{ type: "error", error: rateLimit }]));

    const result = await router.stream(request(), capabilities());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(await collect(result.value.events)).toEqual([
        expect.objectContaining({
          kind: "failed",
          error: expect.objectContaining({ kind: "provider-rate-limited", retryAfterMs: 2_000 }),
        }),
      ]);
    }
  });

  it("turns cancellation into a cancelled completion", async () => {
    const signalAwareBoundary: OpenRouterBoundary = {
      stream(boundaryRequest) {
        async function* stream(): AsyncIterable<OpenRouterBoundaryChunk> {
          if (boundaryRequest.signal.aborted) {
            yield { type: "abort" };
          }
        }
        return { stream: stream() };
      },
    };
    const router = routerWithBoundary(signalAwareBoundary);
    const result = await router.stream(request(), capabilities());
    expect(result.ok).toBe(true);
    if (result.ok) {
      await result.value.cancel("operator request");
      expect(await collect(result.value.events)).toEqual([
        expect.objectContaining({
          kind: "completed",
          completion: expect.objectContaining({ finishReason: "cancelled" }),
        }),
      ]);
    }
  });

  it("rejects unauthorized roles and output budgets before provider invocation", async () => {
    const captured: OpenRouterBoundaryRequest[] = [];
    const router = routerWithBoundary(boundary([], captured));

    const denied = await router.stream(request(), capabilities({ modelRoles: [] }));
    const overBudget = await router.stream(request({ maxOutputTokens: 2_000 as TokenCount }), capabilities());

    expect(denied).toEqual({ ok: false, error: expect.objectContaining({ kind: "capability-denied", capability: "model-call" }) });
    expect(overBudget).toEqual({ ok: false, error: expect.objectContaining({ kind: "budget-exceeded", budget: "tokens" }) });
    expect(captured).toHaveLength(0);
  });

  it("reports an unavailable provider adapter without making a call", async () => {
    const router = createModelRouterWithAdapters(
      DEFAULT_CONFIG.models,
      { OPENROUTER_API_KEY: "test-key" },
      {},
      { createStreamId: () => "stream-1" as ModelStreamId },
    );

    const result = await router.stream(request(), capabilities());

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "provider-unavailable", reason: expect.stringContaining("not installed") }),
    });
  });
});
