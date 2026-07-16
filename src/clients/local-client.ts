import type {
  ClientRequest,
  ClientResponse,
  CreateOmegaClient,
  JsonObject,
  JsonValue,
  LiveEventEnvelope,
  OmegaClient,
  SessionId,
} from "../contracts/index.js";

type TransportFailureKind = "configuration" | "network" | "authentication" | "http" | "protocol";

class ClientTransportError extends Error {
  readonly kind: TransportFailureKind;
  readonly status: number | null;

  constructor(kind: TransportFailureKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ClientTransportError";
    this.kind = kind;
    this.status = status;
  }
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string, context: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new ClientTransportError("protocol", `${context} was not valid JSON`);
  }
}

function parseClientResponse(text: string, expectedRequestId: string): ClientResponse {
  const value = parseJson(text, "Daemon response");
  if (!isObject(value) || value["requestId"] !== expectedRequestId) {
    throw new ClientTransportError("protocol", "Daemon response did not match the Omega client protocol");
  }
  const result = value["result"];
  if (result === undefined || !isObject(result)) {
    throw new ClientTransportError("protocol", "Daemon response did not include a result");
  }
  if (result["ok"] !== true && result["ok"] !== false) {
    throw new ClientTransportError("protocol", "Daemon response contained an invalid result discriminator");
  }
  if ((result["ok"] === true && !("value" in result)) || (result["ok"] === false && !isObject(result["error"] ?? null))) {
    throw new ClientTransportError("protocol", "Daemon response contained an incomplete result");
  }
  return value as ClientResponse;
}

function boundaryMessage(text: string, status: number): string {
  if (text.length === 0) return `Omega daemon returned HTTP ${status}`;
  const value = parseJson(text, "HTTP error response");
  if (isObject(value)) {
    const error = value["error"];
    if (error === undefined || !isObject(error)) return `Omega daemon returned HTTP ${status}`;
    const kind = typeof error["kind"] === "string" ? error["kind"] : "boundary-error";
    const message = typeof error["message"] === "string" ? error["message"] : `HTTP ${status}`;
    return `${kind}: ${message}`;
  }
  return `Omega daemon returned HTTP ${status}`;
}

function normalizeBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ClientTransportError("configuration", "Omega daemon URL is invalid");
  }
  const loopbackHosts = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new ClientTransportError("configuration", "Omega clients only connect to a loopback HTTP daemon");
  }
  url.pathname = url.pathname.replace(/\/$/u, "");
  url.search = "";
  url.hash = "";
  return url;
}

function parseLiveEnvelope(data: string, expectedSessionId: SessionId): LiveEventEnvelope {
  const value = parseJson(data, "SSE data");
  if (!isObject(value) || typeof value["kind"] !== "string" || value["sessionId"] !== expectedSessionId) {
    throw new ClientTransportError("protocol", "SSE event did not match the requested session");
  }
  const kind = value["kind"];
  if (kind !== "session-event" && kind !== "model-delta" && kind !== "process-output" && kind !== "harness-nudge") {
    throw new ClientTransportError("protocol", "SSE event used an unsupported discriminator");
  }
  return value as LiveEventEnvelope;
}

type DecodedFrame = {
  readonly id: string;
  readonly envelope: LiveEventEnvelope;
};

function decodeSseBlock(block: string, sessionId: SessionId): DecodedFrame | null {
  let id: string | null = null;
  let event: string | null = null;
  const data: string[] = [];
  for (const sourceLine of block.split(/\r?\n/u)) {
    if (sourceLine.length === 0 || sourceLine.startsWith(":")) continue;
    const separator = sourceLine.indexOf(":");
    const field = separator < 0 ? sourceLine : sourceLine.slice(0, separator);
    const raw = separator < 0 ? "" : sourceLine.slice(separator + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (id === null && event === null && data.length === 0) return null;
  if (id === null || !/^\d+$/u.test(id) || event !== "omega.live" || data.length === 0) {
    throw new ClientTransportError("protocol", "Malformed Omega SSE frame");
  }
  return { id, envelope: parseLiveEnvelope(data.join("\n"), sessionId) };
}

async function* readSse(response: Response, sessionId: SessionId): AsyncIterable<DecodedFrame> {
  if (response.body === null) throw new ClientTransportError("protocol", "SSE response had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const match = /\r?\n\r?\n/u.exec(buffer);
        if (match === null || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = decodeSseBlock(block, sessionId);
        if (frame !== null) yield frame;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const frame = decodeSseBlock(buffer, sessionId);
      if (frame !== null) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function createClient(baseUrl: URL, bearerToken: string): OmegaClient {
  const requestsUrl = new URL("/api/v1/requests", baseUrl);
  return {
    async request(request: ClientRequest): Promise<ClientResponse> {
      let response: Response;
      try {
        response = await fetch(requestsUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearerToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(request),
        });
      } catch {
        throw new ClientTransportError("network", "Omega daemon is unavailable");
      }
      const text = await response.text();
      if (!response.ok) {
        const kind: TransportFailureKind = response.status === 401 ? "authentication" : "http";
        throw new ClientTransportError(kind, boundaryMessage(text, response.status), response.status);
      }
      return parseClientResponse(text, request.requestId);
    },

    events(sessionId: SessionId, afterSequence: number): AsyncIterable<LiveEventEnvelope> {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new ClientTransportError("configuration", "afterSequence must be a non-negative integer");
      }
      const controller = new AbortController();
      async function* generate(): AsyncGenerator<LiveEventEnvelope, void, undefined> {
        let lastPersistedSequence = afterSequence;
        let reconnectAttempt = 0;
        try {
          while (!controller.signal.aborted) {
          const url = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/events`, baseUrl);
          url.searchParams.set("afterSequence", String(lastPersistedSequence));
          try {
            const response = await fetch(url, {
              headers: {
                authorization: `Bearer ${bearerToken}`,
                accept: "text/event-stream",
              },
              signal: controller.signal,
            });
            if (!response.ok) {
              const text = await response.text();
              if (response.status === 400 || response.status === 401) {
                const kind: TransportFailureKind = response.status === 401 ? "authentication" : "http";
                throw new ClientTransportError(kind, boundaryMessage(text, response.status), response.status);
              }
              await delay(Math.min(25 * 2 ** reconnectAttempt, 1_000), controller.signal);
              reconnectAttempt += 1;
              continue;
            }
            reconnectAttempt = 0;
            for await (const frame of readSse(response, sessionId)) {
              if (frame.envelope.kind === "session-event") {
                const sequence = frame.envelope.event.sequence;
                if (!Number.isSafeInteger(sequence) || sequence < 0 || frame.id !== String(sequence)) {
                  throw new ClientTransportError("protocol", "Persisted SSE sequence was invalid");
                }
                if (sequence <= lastPersistedSequence) continue;
                lastPersistedSequence = sequence;
              }
              yield frame.envelope;
            }
          } catch (error) {
            if (controller.signal.aborted) return;
            if (error instanceof ClientTransportError && (error.kind === "authentication" || error.kind === "protocol" || error.status === 400)) {
              throw error;
            }
          }
            if (!controller.signal.aborted) {
              await delay(Math.min(25 * 2 ** reconnectAttempt, 1_000), controller.signal);
              reconnectAttempt += 1;
            }
          }
        } finally {
          controller.abort();
        }
      }
      const source = generate();
      const iterator: AsyncIterator<LiveEventEnvelope> = {
        next: () => source.next(),
        async return(value?: unknown) {
          // Abort before delegating. AsyncGenerator.return() alone queues behind
          // an outstanding next(), which leaves an idle SSE fetch hung.
          controller.abort();
          return source.return(value as void);
        },
        async throw(error?: unknown) {
          controller.abort();
          return source.throw(error);
        },
      };
      return { [Symbol.asyncIterator]: () => iterator };
    },
  };
}

export const createOmegaClient: CreateOmegaClient = (baseUrl, bearerToken) => {
  if (bearerToken.length === 0) {
    throw new ClientTransportError("configuration", "Omega bearer token is required");
  }
  return createClient(normalizeBaseUrl(baseUrl), bearerToken);
};
