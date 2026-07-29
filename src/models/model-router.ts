import { randomUUID } from "node:crypto";
import type {
  CapabilityEnvelope,
  CreateModelRouter,
  EnvironmentVariables,
  ModelError,
  ModelRequest,
  ModelRouter,
  ModelStream,
  ModelStreamEvent,
  ModelStreamId,
  OmegaConfig,
  Result,
  TokenCount,
} from "../contracts/index.js";
import { createOpenRouterAdapter } from "./openrouter-adapter.js";
import { createCodexAppServerAdapter } from "./codex-app-server-adapter.js";
import {
  createProviderRegistry,
  type ProviderAdapters,
  type ProviderRegistry,
} from "./provider-registry.js";

export type ModelRouterRuntime = {
  readonly createStreamId: () => ModelStreamId;
  readonly waitBeforeRetry?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

const DEFAULT_RUNTIME: ModelRouterRuntime = {
  createStreamId: () => randomUUID() as ModelStreamId,
  waitBeforeRetry: async (delayMs, signal) => {
    if (signal.aborted || delayMs <= 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timeout = setTimeout(done, delayMs);
      signal.addEventListener("abort", done, { once: true });
    });
  },
};

const MAX_PROVIDER_ATTEMPTS = 3;

function retryDelayMs(error: ModelError, failedAttempt: number): number | null {
  if (error.kind === "provider-rate-limited" && error.recoverable) {
    return error.retryAfterMs ?? failedAttempt * 250;
  }
  if (error.kind === "provider-unavailable" && error.recoverable) {
    return failedAttempt * 250;
  }
  return null;
}

function failedEvent(streamId: ModelStreamId, error: ModelError): ModelStreamEvent {
  return { kind: "failed", streamId, error, partialArtifactId: null };
}

function capabilityDenied(request: ModelRequest): ModelError {
  return {
    kind: "capability-denied",
    capability: "model-call",
    reason: `Model role ${request.role} is outside the session capability envelope`,
    recoverable: true,
    callerAction: "request-new-child",
  };
}

function budgetExceeded(limit: TokenCount, observed: TokenCount): ModelError {
  return {
    kind: "budget-exceeded",
    budget: "tokens",
    limit,
    observed,
    recoverable: false,
    callerAction: "abort",
  };
}

function validation(message: string, field: string): ModelError {
  return {
    kind: "validation",
    message,
    field,
    recoverable: true,
    callerAction: "fix-request",
  };
}

function effectiveTimeout(
  request: ModelRequest,
  capabilities: CapabilityEnvelope,
): number {
  return Math.max(1, Math.min(request.abortAfterMs, capabilities.wallTimeMs));
}

export function createModelRouterWithRegistry(
  registry: ProviderRegistry,
  runtime: ModelRouterRuntime = DEFAULT_RUNTIME,
): ModelRouter {
  return {
    async resolve(role) {
      return registry.resolve(role);
    },

    async stream(request, capabilities): Promise<Result<ModelStream, ModelError>> {
      if (!capabilities.modelRoles.includes(request.role)) {
        return { ok: false, error: capabilityDenied(request) };
      }
      if (capabilities.maxModelCalls < 1) {
        return {
          ok: false,
          error: {
            kind: "budget-exceeded",
            budget: "model-calls",
            limit: capabilities.maxModelCalls,
            observed: 1,
            recoverable: false,
            callerAction: "abort",
          },
        };
      }
      if (request.maxOutputTokens <= 0 || request.abortAfterMs <= 0) {
        return { ok: false, error: validation("Model output and timeout limits must be positive", "request") };
      }
      if (request.maxOutputTokens > capabilities.maxOutputTokens) {
        return { ok: false, error: budgetExceeded(capabilities.maxOutputTokens, request.maxOutputTokens) };
      }

      const resolved = registry.resolve(request.role);
      if (!resolved.ok) {
        return resolved;
      }
      if (request.maxOutputTokens > resolved.value.outputLimit) {
        return { ok: false, error: budgetExceeded(resolved.value.outputLimit, request.maxOutputTokens) };
      }

      const controller = new AbortController();
      const streamId = runtime.createStreamId();
      const timeoutMs = effectiveTimeout(request, capabilities);
      const deadlineMs = Date.now() + timeoutMs;
      const timeout = setTimeout(() => controller.abort("model timeout"), timeoutMs);
      timeout.unref();

      const waitBeforeRetry = runtime.waitBeforeRetry ?? DEFAULT_RUNTIME.waitBeforeRetry;
      let attempt = 1;
      let started = await registry.start(request, streamId, controller.signal, timeoutMs);
      while (!started.ok) {
        const delayMs = retryDelayMs(started.error, attempt);
        const remainingMs = deadlineMs - Date.now();
        if (
          delayMs === null
          || attempt >= MAX_PROVIDER_ATTEMPTS
          || controller.signal.aborted
          || delayMs >= remainingMs
        ) {
          clearTimeout(timeout);
          return started;
        }
        await waitBeforeRetry?.(delayMs, controller.signal);
        if (controller.signal.aborted) {
          clearTimeout(timeout);
          return started;
        }
        attempt += 1;
        started = await registry.start(request, streamId, controller.signal, Math.max(1, deadlineMs - Date.now()));
      }

      if (!started.ok) {
        clearTimeout(timeout);
        return started;
      }

      let providerStream = started.value;
      async function* events() {
        try {
          let visibleOutput = false;
          while (true) {
            let cleanFailure: ModelError | null = null;
            for await (const event of providerStream.events) {
              if (event.kind === "failed" && !visibleOutput && retryDelayMs(event.error, attempt) !== null) {
                cleanFailure = event.error;
                break;
              }
              visibleOutput = true;
              yield event;
            }

            if (cleanFailure === null) return;
            await providerStream.cancel("retrying recoverable provider failure");

            while (true) {
              const delayMs = retryDelayMs(cleanFailure, attempt);
              const remainingMs = deadlineMs - Date.now();
              if (
                delayMs === null
                || attempt >= MAX_PROVIDER_ATTEMPTS
                || controller.signal.aborted
                || delayMs >= remainingMs
              ) {
                yield failedEvent(streamId, cleanFailure);
                return;
              }

              await waitBeforeRetry?.(delayMs, controller.signal);
              if (controller.signal.aborted) {
                yield failedEvent(streamId, cleanFailure);
                return;
              }

              attempt += 1;
              const restarted = await registry.start(
                request,
                streamId,
                controller.signal,
                Math.max(1, deadlineMs - Date.now()),
              );
              if (restarted.ok) {
                providerStream = restarted.value;
                break;
              }
              cleanFailure = restarted.error;
            }
          }
        } finally {
          clearTimeout(timeout);
        }
      }

      return {
        ok: true,
        value: {
          id: streamId,
          route: providerStream.route,
          events: events(),
          async cancel(reason) {
            controller.abort(reason);
            clearTimeout(timeout);
            await providerStream.cancel(reason);
          },
        },
      };
    },
  };
}

export function createModelRouterWithAdapters(
  config: OmegaConfig["models"],
  environment: EnvironmentVariables,
  adapters: ProviderAdapters,
  runtime: ModelRouterRuntime = DEFAULT_RUNTIME,
): ModelRouter {
  return createModelRouterWithRegistry(createProviderRegistry(config, environment, adapters), runtime);
}

export const createModelRouter: CreateModelRouter = (config, environment) =>
  createModelRouterWithAdapters(config, environment, {
    openrouter: createOpenRouterAdapter(),
    "codex-app-server": createCodexAppServerAdapter(),
  });
