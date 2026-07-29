import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";

import type {
  JsonObject,
  ModelError,
  ModelMessage,
  ModelRouteSignature,
  ModelStreamEvent,
  ModelUsage,
  Result,
  Timestamp,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";
import type { ProviderAdapter, ProviderStreamRequest } from "./provider-registry.js";

export type CodexSubscriptionEvidence = {
  readonly authType: "chatgpt";
  readonly planType: string;
};

export interface CodexAppServerTransport {
  readonly messages: AsyncIterable<JsonObject>;
  send(message: JsonObject): Promise<void>;
  close(): Promise<void>;
}

export type CodexAppServerTransportFactory = (
  signal?: AbortSignal,
) => Promise<Result<CodexAppServerTransport, ModelError>>;

type AdapterOptions = {
  readonly cwd?: string;
};

const EMPTY_USAGE: ModelUsage = {
  inputTokens: 0 as TokenCount,
  cachedInputTokens: 0 as TokenCount,
  reasoningTokens: 0 as TokenCount,
  outputTokens: 0 as TokenCount,
  costUsdMicros: 0 as UsdMicros,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocol(message: string): ModelError {
  return {
    kind: "protocol-error",
    protocol: "codex-app-server",
    message,
    recoverable: false,
    callerAction: "abort",
  };
}

function unavailable(reason: string): ModelError {
  return {
    kind: "provider-unavailable",
    providerId: "openai-codex",
    reason,
    recoverable: true,
    callerAction: "choose-different-route",
  };
}

function jsonLine(value: JsonObject): string {
  return `${JSON.stringify(value)}\n`;
}

export const createCodexProcessTransport: CodexAppServerTransportFactory = async (signal) => {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("codex", ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
  } catch (error) {
    return { ok: false, error: unavailable(error instanceof Error ? error.message : "Could not start codex app-server") };
  }

  const stderr: string[] = [];
  let spawnError: Error | null = null;
  child.on("error", (error) => { spawnError = error; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.join("").length < 8_192) stderr.push(chunk);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", () => { void close(); }, { once: true });

  async function* messages(): AsyncIterable<JsonObject> {
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error("codex app-server emitted malformed JSONL");
        }
        if (!isRecord(parsed)) throw new Error("codex app-server emitted a non-object message");
        yield parsed as JsonObject;
      }
      if (!closed && child.exitCode !== 0) {
        const detail = stderr.join("").trim();
        throw spawnError ?? new Error(detail.length > 0 ? detail : `codex app-server exited with ${String(child.exitCode)}`);
      }
    } finally {
      await close();
    }
  }

  return {
    ok: true,
    value: {
      messages: messages(),
      async send(message) {
        if (closed || child.stdin.destroyed) throw new Error("codex app-server stdin is closed");
        await new Promise<void>((resolve, reject) => {
          child.stdin.write(jsonLine(message), (error) => { if (error === null || error === undefined) resolve(); else reject(error); });
        });
      },
      close,
    },
  };
};

async function response(
  iterator: AsyncIterator<JsonObject>,
  id: number,
): Promise<Result<JsonObject, ModelError>> {
  while (true) {
    let next: IteratorResult<JsonObject>;
    try {
      next = await iterator.next();
    } catch (error) {
      return { ok: false, error: unavailable(error instanceof Error ? error.message : "Codex transport failed") };
    }
    if (next.done) return { ok: false, error: unavailable("codex app-server closed before replying") };
    if (next.value["id"] !== id) continue;
    if (isRecord(next.value["error"])) {
      const message = next.value["error"]["message"];
      return { ok: false, error: protocol(typeof message === "string" ? message : "codex app-server request failed") };
    }
    const result = next.value["result"];
    return isRecord(result)
      ? { ok: true, value: result as JsonObject }
      : { ok: false, error: protocol(`codex app-server response ${id} has no result object`) };
  }
}

async function initialize(
  transport: CodexAppServerTransport,
  iterator: AsyncIterator<JsonObject>,
): Promise<Result<CodexSubscriptionEvidence, ModelError>> {
  await transport.send({
    method: "initialize",
    id: 1,
    params: {
      clientInfo: { name: "omega_dev", title: "Omega.dev", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    },
  });
  const initialized = await response(iterator, 1);
  if (!initialized.ok) return initialized;
  await transport.send({ method: "initialized", params: {} });
  await transport.send({ method: "account/read", id: 2, params: { refreshToken: true } });
  const accountRead = await response(iterator, 2);
  if (!accountRead.ok) return accountRead;
  const account = accountRead.value["account"];
  if (!isRecord(account) || account["type"] !== "chatgpt") {
    return { ok: false, error: unavailable("Codex must be logged in with a ChatGPT subscription") };
  }
  return {
    ok: true,
    value: {
      authType: "chatgpt",
      planType: typeof account["planType"] === "string" ? account["planType"] : "unknown",
    },
  };
}

export async function inspectCodexSubscription(
  factory: CodexAppServerTransportFactory = createCodexProcessTransport,
): Promise<Result<CodexSubscriptionEvidence, ModelError>> {
  const opened = await factory();
  if (!opened.ok) return opened;
  const iterator = opened.value.messages[Symbol.asyncIterator]();
  try {
    return await initialize(opened.value, iterator);
  } finally {
    await opened.value.close();
  }
}

function messageText(messages: readonly ModelMessage[]): Result<string, ModelError> {
  const sections: string[] = [];
  for (const message of messages) {
    const text: string[] = [];
    for (const part of message.content) {
      if (part.kind !== "text") return { ok: false, error: protocol("Codex crystallizer supports text messages only") };
      text.push(part.text);
    }
    sections.push(`[${message.role.toUpperCase()}]\n${text.join("\n")}`);
  }
  return { ok: true, value: sections.join("\n\n") };
}

function routeSignature(request: ProviderStreamRequest, servingProvider: string | null): ModelRouteSignature {
  return {
    role: request.route.role,
    providerId: request.route.providerId,
    modelId: request.route.modelId,
    variant: null,
    servingProvider,
    quantization: null,
    reasoning: request.route.reasoning,
    temperature: request.route.temperature,
    topP: request.route.topP,
    seed: request.route.seed,
    contextLimit: request.route.contextLimit,
    outputLimit: request.route.maxOutputTokens,
    equivalentListPrice: request.route.equivalentListPrice,
  };
}

function usageFrom(message: JsonObject): ModelUsage | null {
  const params = message["params"];
  if (!isRecord(params)) return null;
  const tokenUsage = params["tokenUsage"];
  if (!isRecord(tokenUsage)) return null;
  const last = tokenUsage["last"];
  if (!isRecord(last)) return null;
  const number = (key: string) => typeof last[key] === "number" ? Math.max(0, Math.trunc(last[key])) : 0;
  return {
    inputTokens: number("inputTokens") as TokenCount,
    cachedInputTokens: number("cachedInputTokens") as TokenCount,
    outputTokens: number("outputTokens") as TokenCount,
    reasoningTokens: number("reasoningOutputTokens") as TokenCount,
    costUsdMicros: 0 as UsdMicros,
  };
}

function notification(message: JsonObject, method: string): JsonObject | null {
  if (message["method"] !== method) return null;
  const params = message["params"];
  return isRecord(params) ? params as JsonObject : null;
}

function timestamp(seconds: unknown, fallback: Timestamp): Timestamp {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1_000).toISOString() as Timestamp
    : fallback;
}

export function createCodexAppServerAdapter(
  factory: CodexAppServerTransportFactory = createCodexProcessTransport,
  options: AdapterOptions = {},
): ProviderAdapter {
  return {
    async start(request) {
      if (request.credential !== null) return { ok: false, error: protocol("Codex app-server owns subscription credentials") };
      if (request.route.role !== "crystallizer") return { ok: false, error: protocol("Codex app-server is currently restricted to the crystallizer role") };
      if (request.request.tools.length > 0) return { ok: false, error: protocol("Codex crystallizer does not expose tools") };
      const prompt = messageText(request.request.messages);
      if (!prompt.ok) return prompt;

      let active: CodexAppServerTransport | null = null;
      let cancelled = false;
      const events = async function* (): AsyncIterable<ModelStreamEvent> {
        const startedAt = new Date().toISOString() as Timestamp;
        const opened = await factory(request.signal);
        if (!opened.ok) {
          yield { kind: "failed", streamId: request.streamId, error: opened.error, partialArtifactId: null };
          return;
        }
        active = opened.value;
        const iterator = active.messages[Symbol.asyncIterator]();
        let usage = EMPTY_USAGE;
        let streamedText = "";
        let finalText = "";
        let firstTokenAt: Timestamp | null = null;
        let turnId: string | null = null;
        try {
          const auth = await initialize(active, iterator);
          if (!auth.ok) {
            yield { kind: "failed", streamId: request.streamId, error: auth.error, partialArtifactId: null };
            return;
          }
          await active.send({
            method: "thread/start",
            id: 3,
            params: {
              model: request.route.modelId,
              cwd: options.cwd ?? tmpdir(),
              approvalPolicy: "never",
              sandbox: "read-only",
              ephemeral: true,
              serviceName: "omega-dev",
              baseInstructions: "You are Omega's text-only reflection crystallizer. Do not use tools, inspect files, browse, run commands, or spawn agents. Answer only from the supplied user input.",
            },
          });
          const threadStarted = await response(iterator, 3);
          if (!threadStarted.ok) {
            yield { kind: "failed", streamId: request.streamId, error: threadStarted.error, partialArtifactId: null };
            return;
          }
          const thread = threadStarted.value["thread"];
          const threadId = isRecord(thread) && typeof thread["id"] === "string" ? thread["id"] : null;
          if (threadId === null) {
            yield { kind: "failed", streamId: request.streamId, error: protocol("thread/start returned no thread id"), partialArtifactId: null };
            return;
          }
          await active.send({
            method: "turn/start",
            id: 4,
            params: {
              threadId,
              input: [{ type: "text", text: prompt.value }],
              model: request.route.modelId,
              effort: request.route.reasoning.mode === "effort" ? request.route.reasoning.effort : null,
            },
          });
          const turnStarted = await response(iterator, 4);
          if (!turnStarted.ok) {
            yield { kind: "failed", streamId: request.streamId, error: turnStarted.error, partialArtifactId: null };
            return;
          }
          const turn = turnStarted.value["turn"];
          turnId = isRecord(turn) && typeof turn["id"] === "string" ? turn["id"] : null;
          if (turnId === null) {
            yield { kind: "failed", streamId: request.streamId, error: protocol("turn/start returned no turn id"), partialArtifactId: null };
            return;
          }

          while (!cancelled) {
            let next: IteratorResult<JsonObject>;
            try {
              next = await iterator.next();
            } catch (error) {
              yield { kind: "failed", streamId: request.streamId, error: unavailable(error instanceof Error ? error.message : "Codex transport failed"), partialArtifactId: null };
              return;
            }
            if (next.done) {
              yield { kind: "failed", streamId: request.streamId, error: unavailable("codex app-server closed before turn completion"), partialArtifactId: null };
              return;
            }
            const delta = notification(next.value, "item/agentMessage/delta");
            if (delta !== null && typeof delta["delta"] === "string") {
              firstTokenAt ??= new Date().toISOString() as Timestamp;
              streamedText += delta["delta"];
              yield { kind: "text-delta", streamId: request.streamId, delta: delta["delta"] };
              continue;
            }
            if (next.value["method"] === "thread/tokenUsage/updated") {
              usage = usageFrom(next.value) ?? usage;
              continue;
            }
            const completedItem = notification(next.value, "item/completed");
            const item = completedItem?.["item"];
            if (isRecord(item) && item["type"] === "agentMessage" && typeof item["text"] === "string") {
              finalText = item["text"];
              firstTokenAt ??= new Date().toISOString() as Timestamp;
              continue;
            }
            const completedTurn = notification(next.value, "turn/completed");
            const terminal = completedTurn?.["turn"];
            if (!isRecord(terminal) || terminal["id"] !== turnId) continue;
            if (terminal["status"] !== "completed") {
              const error = isRecord(terminal["error"]) && typeof terminal["error"]["message"] === "string"
                ? terminal["error"]["message"]
                : `Codex turn ended with status ${String(terminal["status"])}`;
              yield { kind: "failed", streamId: request.streamId, error: unavailable(error), partialArtifactId: null };
              return;
            }
            const answer = finalText.length > 0 ? finalText : streamedText;
            if (streamedText.length === 0 && answer.length > 0) {
              yield { kind: "text-delta", streamId: request.streamId, delta: answer };
            }
            yield { kind: "usage", streamId: request.streamId, usage };
            const completedAt = timestamp(terminal["completedAt"], new Date().toISOString() as Timestamp);
            yield {
              kind: "completed",
              completion: {
                streamId: request.streamId,
                providerGenerationId: turnId,
                route: routeSignature(request, "chatgpt-subscription"),
                content: answer.length === 0 ? [] : [{ kind: "text", text: answer }],
                usage,
                startedAt: timestamp(terminal["startedAt"], startedAt),
                firstTokenAt,
                completedAt,
                finishReason: "stop",
              },
            };
            return;
          }
          yield {
            kind: "completed",
            completion: {
              streamId: request.streamId,
              providerGenerationId: turnId,
              route: routeSignature(request, "chatgpt-subscription"),
              content: streamedText.length === 0 ? [] : [{ kind: "text", text: streamedText }],
              usage,
              startedAt,
              firstTokenAt,
              completedAt: new Date().toISOString() as Timestamp,
              finishReason: "cancelled",
            },
          };
        } finally {
          await active.close();
          active = null;
        }
      };

      return {
        ok: true,
        value: {
          route: routeSignature(request, null),
          events: events(),
          async cancel() {
            cancelled = true;
            await active?.close();
          },
        },
      };
    },
  };
}
