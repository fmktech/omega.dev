import {
  createOpenRouter,
  type OpenRouterChatSettings,
} from "@openrouter/ai-sdk-provider";
import {
  APICallError,
  jsonSchema,
  streamText,
  tool,
  type LanguageModelUsage,
  type ModelMessage as AiModelMessage,
  type ProviderMetadata,
  type JSONSchema7,
  type JSONValue as AiJsonValue,
  type ToolSet,
} from "ai";
import type {
  DurationMs,
  JsonObject,
  JsonValue,
  ModelCompletion,
  ModelContentPart,
  ModelError,
  ModelMessage,
  ModelRouteSignature,
  ModelStreamEvent,
  ModelToolCallPart,
  ModelUsage,
  Result,
  Timestamp,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";
import type { ProviderAdapter, ProviderStreamRequest } from "./provider-registry.js";

export type OpenRouterBoundaryChunk =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly input: object | string | number | boolean | null }
  | { readonly type: "finish-step"; readonly responseId: string; readonly usage: LanguageModelUsage; readonly providerMetadata: ProviderMetadata | undefined }
  | { readonly type: "finish"; readonly finishReason: string; readonly totalUsage: LanguageModelUsage }
  | { readonly type: "abort" }
  | { readonly type: "error"; readonly error: unknown };

type AiStream = {
  readonly stream: AsyncIterable<OpenRouterBoundaryChunk>;
};

export type OpenRouterBoundaryRequest = {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly modelId: string;
  readonly messages: readonly AiModelMessage[];
  readonly tools: ToolSet;
  readonly maxOutputTokens: number;
  readonly temperature: number | undefined;
  readonly topP: number | undefined;
  readonly seed: number | undefined;
  readonly reasoning: "none" | "low" | "medium" | "high" | "xhigh" | undefined;
  readonly modelSettings: OpenRouterChatSettings;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
};

export interface OpenRouterBoundary {
  stream(request: OpenRouterBoundaryRequest): AiStream;
}

type OpenRouterMetadata = {
  readonly servingProvider: string | null;
  readonly generationId: string | null;
  readonly quantization: string | null;
  readonly costUsdMicros: UsdMicros;
};

const ZERO_USAGE: ModelUsage = {
  inputTokens: 0 as TokenCount,
  cachedInputTokens: 0 as TokenCount,
  reasoningTokens: 0 as TokenCount,
  outputTokens: 0 as TokenCount,
  costUsdMicros: 0 as UsdMicros,
};

function isJsonObject(value: object | string | number | boolean | null): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: object): JsonObject | null {
  if (Array.isArray(value) || value === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(JSON.stringify(value)) as JsonValue;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toAiJsonValue(value: JsonValue): AiJsonValue {
  return JSON.parse(JSON.stringify(value)) as AiJsonValue;
}

function toAiJsonSchema(value: JsonObject): JSONSchema7 {
  return JSON.parse(JSON.stringify(value)) as JSONSchema7;
}

function toAiToolResult(part: Extract<ModelContentPart, { readonly kind: "tool-result" }>) {
  return {
    type: "tool-result" as const,
    toolCallId: part.callId,
    toolName: part.toolName,
    output: part.isError
      ? { type: "error-json" as const, value: toAiJsonValue(part.result) }
      : { type: "json" as const, value: toAiJsonValue(part.result) },
  };
}

function toAiMessages(messages: readonly ModelMessage[]): Result<readonly AiModelMessage[], ModelError> {
  const converted: AiModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.some((part) => part.kind !== "text")) {
        return { ok: false, error: protocol("System messages may contain text parts only") };
      }
      converted.push({
        role: "system",
        content: message.content.map((part) => part.kind === "text" ? part.text : "").join(""),
      });
      continue;
    }

    if (message.role === "user") {
      if (message.content.some((part) => part.kind !== "text")) {
        return { ok: false, error: protocol("User tool results must use a tool-role message") };
      }
      converted.push({
        role: "user",
        content: message.content.map((part) => ({
          type: "text" as const,
          text: part.kind === "text" ? part.text : "",
        })),
      });
      continue;
    }

    if (message.role === "tool") {
      converted.push({ role: "tool", content: message.content.map(toAiToolResult) });
      continue;
    }

    converted.push({
      role: "assistant",
      content: message.content.map((part) => {
        switch (part.kind) {
          case "text":
            return { type: "text" as const, text: part.text };
          case "reasoning":
            return { type: "reasoning" as const, text: part.text };
          case "tool-call":
            return {
              type: "tool-call" as const,
              toolCallId: part.callId,
              toolName: part.toolName,
              input: part.input,
            };
          case "tool-result":
            return toAiToolResult(part);
        }
      }),
    });
  }

  return { ok: true, value: converted };
}

function toTools(tools: ProviderStreamRequest["request"]["tools"]): ToolSet {
  return Object.fromEntries(
    tools.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(toAiJsonSchema(definition.inputSchema)),
      }),
    ]),
  );
}

function validateTools(tools: ProviderStreamRequest["request"]["tools"]): ModelError | null {
  const names = new Set<string>();
  for (const definition of tools) {
    if (definition.name.length === 0 || names.has(definition.name)) {
      return protocol(`Tool names must be non-empty and unique: ${definition.name}`);
    }
    names.add(definition.name);
    const schemaType = Object.getOwnPropertyDescriptor(definition.inputSchema, "type")?.value;
    if (schemaType !== "object") {
      return protocol(`Tool ${definition.name} input schema must describe an object`);
    }
  }
  return null;
}

function protocol(message: string): ModelError {
  return {
    kind: "protocol-error",
    protocol: "http",
    message,
    recoverable: false,
    callerAction: "abort",
  };
}

function readString(record: object, key: string): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return typeof descriptor?.value === "string" && descriptor.value.length > 0 ? descriptor.value : null;
}

function readNumber(record: object, key: string): number | null {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return typeof descriptor?.value === "number" && Number.isFinite(descriptor.value) ? descriptor.value : null;
}

function childObject(record: object, key: string): object | null {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor?.value !== null && typeof descriptor?.value === "object" ? descriptor.value : null;
}

function metadata(providerMetadata: ProviderMetadata | undefined, responseId: string | null): OpenRouterMetadata {
  const openrouter = providerMetadata === undefined ? null : childObject(providerMetadata, "openrouter");
  const usage = openrouter === null ? null : childObject(openrouter, "usage");
  const cost = usage === null ? 0 : (readNumber(usage, "cost") ?? 0);
  return {
    servingProvider: openrouter === null ? null : readString(openrouter, "provider"),
    generationId: responseId,
    quantization: openrouter === null ? null : readString(openrouter, "quantization"),
    costUsdMicros: Math.max(0, Math.round(cost * 1_000_000)) as UsdMicros,
  };
}

function usage(value: LanguageModelUsage, costUsdMicros: UsdMicros): ModelUsage {
  return {
    inputTokens: Math.max(0, value.inputTokens ?? 0) as TokenCount,
    cachedInputTokens: Math.max(0, value.inputTokenDetails.cacheReadTokens ?? 0) as TokenCount,
    reasoningTokens: Math.max(0, value.outputTokenDetails.reasoningTokens ?? 0) as TokenCount,
    outputTokens: Math.max(0, value.outputTokens ?? 0) as TokenCount,
    costUsdMicros,
  };
}

function mapFinishReason(reason: string): ModelCompletion["finishReason"] {
  switch (reason) {
    case "stop":
    case "tool-calls":
    case "length":
    case "content-filter":
    case "error":
      return reason;
    default:
      return "error";
  }
}

function rateLimitDelay(headers: Record<string, string> | undefined): DurationMs | null {
  const milliseconds = headers?.["retry-after-ms"];
  if (milliseconds !== undefined && Number.isFinite(Number(milliseconds))) {
    return Math.max(0, Math.round(Number(milliseconds))) as DurationMs;
  }
  const seconds = headers?.["retry-after"];
  return seconds !== undefined && Number.isFinite(Number(seconds))
    ? (Math.max(0, Math.round(Number(seconds) * 1_000)) as DurationMs)
    : null;
}

function providerError(error: unknown, providerId: string): ModelError {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) {
      return {
        kind: "provider-rate-limited",
        providerId,
        retryAfterMs: rateLimitDelay(error.responseHeaders),
        recoverable: true,
        callerAction: "retry-with-backoff",
      };
    }
    return {
      kind: "provider-unavailable",
      providerId,
      reason: error.statusCode === undefined ? "Provider request failed" : `Provider returned HTTP ${error.statusCode}`,
      recoverable: true,
      callerAction: "choose-different-route",
    };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return {
      kind: "provider-unavailable",
      providerId,
      reason: "Provider request was aborted or timed out",
      recoverable: true,
      callerAction: "choose-different-route",
    };
  }
  const detail = error instanceof Error
    ? error.message
    : error !== null && typeof error === "object"
      ? readString(error, "message")
      : null;
  if (detail !== null) {
    return {
      kind: "provider-unavailable",
      providerId,
      reason: detail.slice(0, 500),
      recoverable: true,
      callerAction: "choose-different-route",
    };
  }
  return protocol("Provider returned an invalid or incomplete stream");
}

function reasoningValue(request: ProviderStreamRequest): OpenRouterBoundaryRequest["reasoning"] {
  switch (request.route.reasoning.mode) {
    case "off":
      return "none";
    case "effort":
      return request.route.reasoning.effort;
    case "token-budget":
      return undefined;
  }
}

function modelSettings(request: ProviderStreamRequest): OpenRouterChatSettings {
  const selection = request.route.selection;
  if (selection.kind !== "openrouter") {
    return { extraBody: JSON.parse(JSON.stringify(selection.options)) as Record<string, JsonValue> };
  }
  const sort = selection.mode === "nitro" ? "throughput" : selection.mode === "exacto" ? "price" : null;
  const reasoning: NonNullable<OpenRouterChatSettings["reasoning"]> = request.route.reasoning.mode === "token-budget"
    ? { max_tokens: request.route.reasoning.maxTokens }
    : request.route.reasoning.mode === "effort"
      ? { effort: request.route.reasoning.effort }
      : { effort: "none" };
  return {
    provider: {
      order: [...selection.providerOrder],
      allow_fallbacks: selection.allowFallbacks,
      require_parameters: selection.requireParameters,
      data_collection: selection.dataCollection,
      ...(selection.zeroDataRetention === null ? {} : { zdr: selection.zeroDataRetention }),
      ...(sort === null ? {} : { sort }),
    },
    reasoning,
    usage: { include: true },
  };
}

const AI_SDK_BOUNDARY: OpenRouterBoundary = {
  stream(request) {
    const provider = createOpenRouter({
      apiKey: request.apiKey,
      baseURL: request.baseURL,
      compatibility: "strict",
    });
    const model = provider.chat(request.modelId, request.modelSettings);
    const instructions = request.messages
      .filter((message) => message.role === "system")
      .map((message) => typeof message.content === "string" ? message.content : "")
      .filter((message) => message.length > 0)
      .join("\n\n");
    const messages = request.messages.filter((message) => message.role !== "system");
    const result = streamText({
      model,
      messages: [...messages],
      ...(instructions.length === 0 ? {} : { instructions }),
      tools: request.tools,
      maxOutputTokens: request.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { topP: request.topP }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
      abortSignal: request.signal,
      timeout: { totalMs: request.timeoutMs, chunkMs: request.timeoutMs },
      maxRetries: 0,
      onError: () => undefined,
    });
    async function* normalized(): AsyncIterable<OpenRouterBoundaryChunk> {
      for await (const part of result.stream) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text-delta", text: part.text };
            break;
          case "reasoning-delta":
            yield { type: "reasoning-delta", text: part.text };
            break;
          case "tool-call":
            yield {
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: typeof part.input === "object" || typeof part.input === "string" || typeof part.input === "number" || typeof part.input === "boolean" || part.input === null
                ? part.input
                : String(part.input),
            };
            break;
          case "finish-step":
            yield {
              type: "finish-step",
              responseId: part.response.id,
              usage: part.usage,
              providerMetadata: part.providerMetadata,
            };
            break;
          case "finish":
            yield { type: "finish", finishReason: part.finishReason, totalUsage: part.totalUsage };
            break;
          case "abort":
            yield { type: "abort" };
            break;
          case "error":
            yield { type: "error", error: part.error };
            break;
          default:
            break;
        }
      }
    }
    return { stream: normalized() };
  },
};

export function createOpenRouterAdapter(boundary: OpenRouterBoundary = AI_SDK_BOUNDARY): ProviderAdapter {
  return {
    async start(request) {
      if (request.credential === null) {
        return { ok: false, error: protocol("OpenRouter requires a credential") };
      }
      if (request.route.selection.kind !== "openrouter") {
        return { ok: false, error: protocol("OpenRouter routes require OpenRouter provider selection") };
      }

      const messages = toAiMessages(request.request.messages);
      if (!messages.ok) {
        return messages;
      }
      const toolError = validateTools(request.request.tools);
      if (toolError !== null) {
        return { ok: false, error: toolError };
      }

      let source: AiStream;
      try {
        source = boundary.stream({
          apiKey: request.credential,
          baseURL: request.provider.baseUrl,
          modelId: request.route.modelId,
          messages: messages.value,
          tools: toTools(request.request.tools),
          maxOutputTokens: Math.min(request.route.maxOutputTokens, request.request.maxOutputTokens),
          temperature: request.route.temperature ?? undefined,
          topP: request.route.topP ?? undefined,
          seed: request.route.seed ?? undefined,
          reasoning: reasoningValue(request),
          modelSettings: modelSettings(request),
          signal: request.signal,
          timeoutMs: request.timeoutMs,
        });
      } catch (error) {
        return {
          ok: false,
          error: providerError(error instanceof Error ? error : new Error("Provider start failed"), request.provider.providerId),
        };
      }

      const initialRoute: ModelRouteSignature = {
        role: request.route.role,
        providerId: request.route.providerId,
        modelId: request.route.modelId,
        variant: request.route.modelId.includes(":") ? request.route.modelId.slice(request.route.modelId.lastIndexOf(":") + 1) : null,
        servingProvider: null,
        quantization: null,
        reasoning: request.route.reasoning,
        temperature: request.route.temperature,
        topP: request.route.topP,
        seed: request.route.seed,
        contextLimit: request.route.contextLimit,
        outputLimit: request.route.maxOutputTokens,
        equivalentListPrice: request.route.equivalentListPrice,
      };
      const startedAt = new Date().toISOString() as Timestamp;
      const content: ModelContentPart[] = [];

      async function* events(): AsyncIterable<ModelStreamEvent> {
        let firstTokenAt: Timestamp | null = null;
        let finalUsage = ZERO_USAGE;
        let finalMetadata: OpenRouterMetadata = metadata(undefined, null);
        try {
          for await (const part of source.stream) {
            if (part.type === "text-delta") {
              firstTokenAt ??= new Date().toISOString() as Timestamp;
              content.push({ kind: "text", text: part.text });
              yield { kind: "text-delta", streamId: request.streamId, delta: part.text };
            } else if (part.type === "reasoning-delta") {
              firstTokenAt ??= new Date().toISOString() as Timestamp;
              content.push({ kind: "reasoning", text: part.text });
              yield { kind: "reasoning-delta", streamId: request.streamId, delta: part.text };
            } else if (part.type === "tool-call") {
              const input = typeof part.input === "object" && part.input !== null ? jsonObject(part.input) : null;
              if (input === null) {
                yield { kind: "failed", streamId: request.streamId, error: protocol(`Malformed input for tool ${part.toolName}`), partialArtifactId: null };
                return;
              }
              const call: ModelToolCallPart = {
                kind: "tool-call",
                callId: part.toolCallId,
                toolName: part.toolName,
                input,
              };
              content.push(call);
              yield { kind: "tool-call", streamId: request.streamId, call };
            } else if (part.type === "finish-step") {
              finalMetadata = metadata(part.providerMetadata, part.responseId);
              finalUsage = usage(part.usage, finalMetadata.costUsdMicros);
            } else if (part.type === "error") {
              yield {
                kind: "failed",
                streamId: request.streamId,
                error: providerError(part.error, request.provider.providerId),
                partialArtifactId: null,
              };
              return;
            } else if (part.type === "abort") {
              yield {
                kind: "completed",
                completion: {
                  streamId: request.streamId,
                  providerGenerationId: finalMetadata.generationId,
                  route: { ...initialRoute, servingProvider: finalMetadata.servingProvider, quantization: finalMetadata.quantization },
                  content,
                  usage: finalUsage,
                  startedAt,
                  firstTokenAt,
                  completedAt: new Date().toISOString() as Timestamp,
                  finishReason: "cancelled",
                },
              };
              return;
            } else if (part.type === "finish") {
              finalUsage = usage(part.totalUsage, finalMetadata.costUsdMicros);
              yield { kind: "usage", streamId: request.streamId, usage: finalUsage };
              yield {
                kind: "completed",
                completion: {
                  streamId: request.streamId,
                  providerGenerationId: finalMetadata.generationId,
                  route: { ...initialRoute, servingProvider: finalMetadata.servingProvider, quantization: finalMetadata.quantization },
                  content,
                  usage: finalUsage,
                  startedAt,
                  firstTokenAt,
                  completedAt: new Date().toISOString() as Timestamp,
                  finishReason: mapFinishReason(part.finishReason),
                },
              };
              return;
            }
          }
          yield { kind: "failed", streamId: request.streamId, error: protocol("Provider stream ended without a finish event"), partialArtifactId: null };
        } catch (error) {
          yield {
            kind: "failed",
            streamId: request.streamId,
            error: providerError(error instanceof Error ? error : new Error("Provider stream failed"), request.provider.providerId),
            partialArtifactId: null,
          };
        }
      }

      return {
        ok: true,
        value: {
          route: initialRoute,
          events: events(),
          async cancel(reason) {
            void reason;
          },
        },
      };
    },
  };
}
