import type {
  EnvironmentVariables,
  ModelError,
  ModelRequest,
  ModelRole,
  ModelRoleRoute,
  ModelRouteSignature,
  ModelStreamId,
  ModelStreamEvent,
  OmegaConfig,
  ProviderConfig,
  Result,
} from "../contracts/index.js";

export type ProviderStreamRequest = {
  readonly provider: ProviderConfig;
  readonly route: ModelRoleRoute;
  readonly request: ModelRequest;
  readonly credential: string | null;
  readonly streamId: ModelStreamId;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
};

export type ProviderStream = {
  readonly route: ModelRouteSignature;
  readonly events: AsyncIterable<ModelStreamEvent>;
  cancel(reason: string): Promise<void>;
};

export interface ProviderAdapter {
  start(request: ProviderStreamRequest): Promise<Result<ProviderStream, ModelError>>;
}

export type ProviderAdapters = Readonly<Partial<Record<ProviderConfig["adapter"], ProviderAdapter>>>;

export interface ProviderRegistry {
  resolve(role: ModelRole): Result<ModelRouteSignature, ModelError>;
  start(
    request: ModelRequest,
    streamId: ModelStreamId,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Result<ProviderStream, ModelError>>;
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

function unavailable(providerId: string, reason: string): ModelError {
  return {
    kind: "provider-unavailable",
    providerId,
    reason,
    recoverable: true,
    callerAction: "choose-different-route",
  };
}

function routeSignature(route: ModelRoleRoute): ModelRouteSignature {
  return {
    role: route.role,
    providerId: route.providerId,
    modelId: route.modelId,
    variant: route.modelId.includes(":") ? route.modelId.slice(route.modelId.lastIndexOf(":") + 1) : null,
    servingProvider: null,
    quantization: null,
    reasoning: route.reasoning,
    temperature: route.temperature,
    topP: route.topP,
    seed: route.seed,
    contextLimit: route.contextLimit,
    outputLimit: route.maxOutputTokens,
    equivalentListPrice: route.equivalentListPrice,
  };
}

export function createProviderRegistry(
  config: OmegaConfig["models"],
  environment: EnvironmentVariables,
  adapters: ProviderAdapters,
): ProviderRegistry {
  const providers = new Map(config.providers.map((provider) => [provider.providerId, provider]));
  const routes = new Map<ModelRole, ModelRoleRoute>();
  const duplicateRoles = new Set<ModelRole>();

  for (const route of config.routes) {
    if (routes.has(route.role)) {
      duplicateRoles.add(route.role);
    } else {
      routes.set(route.role, route);
    }
  }

  function configured(role: ModelRole): Result<{ readonly route: ModelRoleRoute; readonly provider: ProviderConfig }, ModelError> {
    if (duplicateRoles.has(role)) {
      return { ok: false, error: validation(`Multiple model routes are configured for role ${role}`, "models.routes") };
    }

    const route = routes.get(role);
    if (route === undefined) {
      return { ok: false, error: validation(`No model route is configured for role ${role}`, "models.routes") };
    }

    const provider = providers.get(route.providerId);
    if (provider === undefined) {
      return {
        ok: false,
        error: unavailable(route.providerId, `The configured provider for role ${role} does not exist`),
      };
    }

    return { ok: true, value: { route, provider } };
  }

  return {
    resolve(role) {
      const result = configured(role);
      return result.ok ? { ok: true, value: routeSignature(result.value.route) } : result;
    },

    async start(request, streamId, signal, timeoutMs) {
      const result = configured(request.role);
      if (!result.ok) {
        return result;
      }

      const { provider, route } = result.value;
      const adapter = adapters[provider.adapter];
      if (adapter === undefined) {
        return { ok: false, error: unavailable(provider.providerId, `Adapter ${provider.adapter} is not installed`) };
      }

      const credentialName = provider.credentialEnvName;
      let credential: string | null;
      if (credentialName === null) {
        credential = null;
      } else {
        const injectedCredential = environment[credentialName];
        if (injectedCredential === undefined || injectedCredential.length === 0) {
          return {
            ok: false,
            error: unavailable(provider.providerId, `Credential environment variable ${credentialName} is not set`),
          };
        }
        credential = injectedCredential;
      }

      return adapter.start({
        provider,
        route,
        request,
        credential,
        streamId,
        signal,
        timeoutMs: Math.max(1, Math.min(timeoutMs, route.timeoutMs)),
      });
    },
  };
}
