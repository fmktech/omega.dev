import { randomUUID } from "node:crypto";
import type {
  CapabilityEnvelope,
  CreateModelRouter,
  EnvironmentVariables,
  ModelError,
  ModelRequest,
  ModelRouter,
  ModelStream,
  ModelStreamId,
  OmegaConfig,
  Result,
  TokenCount,
} from "../contracts/index.js";
import { createOpenRouterAdapter } from "./openrouter-adapter.js";
import {
  createProviderRegistry,
  type ProviderAdapters,
  type ProviderRegistry,
} from "./provider-registry.js";

export type ModelRouterRuntime = {
  readonly createStreamId: () => ModelStreamId;
};

const DEFAULT_RUNTIME: ModelRouterRuntime = {
  createStreamId: () => randomUUID() as ModelStreamId,
};

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
      const timeout = setTimeout(() => controller.abort("model timeout"), timeoutMs);
      timeout.unref();

      const started = await registry.start(request, streamId, controller.signal, timeoutMs);
      if (!started.ok) {
        clearTimeout(timeout);
        return started;
      }

      const providerStream = started.value;
      async function* events() {
        try {
          yield* providerStream.events;
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
  });
