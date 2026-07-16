import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isAbsolute } from "node:path";

import type {
  ClientRequest,
  CredentialEnvName,
  InternalError,
  IoError,
  JsonObject,
  JsonValue,
  LocalHttpErrorResponse,
  OmegaApplication,
  OmegaConfig,
  Result,
  SessionId,
  StartHttpServer,
  ValidationError,
} from "../contracts/index.js";
import { renderHtmlApp } from "../clients/html-app.js";
import { createSseBroker, encodeSseFrame } from "./sse-broker.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const REQUEST_KINDS: ReadonlySet<string> = new Set([
  "project.list", "project.register-workspace", "task.start", "thread.resume", "session.get", "session.list",
  "artifact.read", "session.cancel", "policy.list", "policy.resolve", "evolution.start", "evolution.get",
  "evolution.list", "evolution.cancel", "benchmark.run-paired", "scorecard.get", "scorecard.list",
  "knowledge.catalog", "knowledge.read", "marketplace.search", "marketplace.transition", "harness.get",
  "harness.list", "harness.rollback", "harness.pin",
]);

class BoundaryFailure extends Error {
  readonly status: 400 | 401;
  readonly body: LocalHttpErrorResponse;

  constructor(status: 400 | 401, body: LocalHttpErrorResponse) {
    super(body.error.message);
    this.status = status;
    this.body = body;
  }
}

function validation(message: string, field: string | null): ValidationError {
  return { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" };
}

function boundaryValidation(message: string, field: string | null): BoundaryFailure {
  return new BoundaryFailure(400, { error: validation(message, field) });
}

function unauthorized(): BoundaryFailure {
  return new BoundaryFailure(401, {
    error: { kind: "unauthorized", message: "Invalid bearer token", recoverable: false, callerAction: "abort" },
  });
}

async function internal(
  application: OmegaApplication,
  boundary: "http" | "sse",
  error: unknown,
): Promise<Result<InternalError, IoError>> {
  const recorded = await application.recordDiagnostic({
    boundary,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
    at: new Date().toISOString() as Parameters<OmegaApplication["recordDiagnostic"]>[0]["at"],
  });
  if (!recorded.ok) return recorded;
  return { ok: true, value: {
    kind: "internal",
    message: "An internal Omega error occurred",
    diagnosticArtifactId: recorded.value,
    recoverable: false,
    callerAction: "propagate",
  } };
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: JsonValue | undefined, field: string): JsonObject {
  if (value === undefined || !isObject(value)) throw boundaryValidation(`${field} must be an object`, field);
  return value;
}

function requireString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw boundaryValidation(`${field} must be a non-empty string`, field);
  return value;
}

function requireId(value: JsonValue | undefined, field: string): string {
  const id = requireString(value, field);
  if (!ID_PATTERN.test(id)) throw boundaryValidation(`${field} has an invalid branded-ID encoding`, field);
  return id;
}

function requireNonNegativeInteger(value: JsonValue | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw boundaryValidation(`${field} must be a non-negative integer`, field);
  }
  return value;
}

function validatePage(value: JsonValue | undefined, field = "page"): void {
  const page = requireObject(value, field);
  if (page["cursor"] !== null && typeof page["cursor"] !== "string") {
    throw boundaryValidation(`${field}.cursor must be a string or null`, `${field}.cursor`);
  }
  const limit = requireNonNegativeInteger(page["limit"], `${field}.limit`);
  if (limit < 1 || limit > 1_000) throw boundaryValidation(`${field}.limit must be between 1 and 1000`, `${field}.limit`);
}

function validateEncodedIds(value: JsonValue, path = "request"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateEncodedIds(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key.endsWith("Id") && typeof item === "string" && !ID_PATTERN.test(item)) {
      throw boundaryValidation(`${childPath} has an invalid branded-ID encoding`, childPath);
    }
    if (key.endsWith("Ids") && Array.isArray(item)) {
      for (const candidate of item) if (typeof candidate !== "string" || !ID_PATTERN.test(candidate)) {
        throw boundaryValidation(`${childPath} has an invalid branded-ID encoding`, childPath);
      }
    }
    validateEncodedIds(item, childPath);
  }
}

function parseClientRequest(text: string): ClientRequest {
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch {
    throw boundaryValidation("Request body must be valid JSON", "body");
  }
  const request = requireObject(value, "body");
  const kind = requireString(request["kind"], "kind");
  if (!REQUEST_KINDS.has(kind)) throw boundaryValidation("Unknown client request discriminator", "kind");
  requireId(request["requestId"], "requestId");
  validateEncodedIds(request);
  switch (kind) {
    case "project.list":
      validatePage(request["page"]);
      break;
    case "project.register-workspace": {
      const path = requireString(request["path"], "path");
      if (!isAbsolute(path)) throw boundaryValidation("path must be absolute", "path");
      break;
    }
    case "task.start":
    case "thread.resume":
    case "policy.resolve":
    case "evolution.start":
    case "marketplace.transition":
      requireObject(request["request"], "request");
      break;
    case "session.get": requireId(request["sessionId"], "sessionId"); break;
    case "session.list":
    case "evolution.list":
    case "scorecard.list":
    case "harness.list":
      requireId(request["projectId"], "projectId");
      validatePage(request["page"]);
      break;
    case "artifact.read":
      requireId(request["artifactId"], "artifactId");
      requireNonNegativeInteger(request["offset"], "offset");
      requireNonNegativeInteger(request["limit"], "limit");
      break;
    case "session.cancel": requireId(request["sessionId"], "sessionId"); requireString(request["reason"], "reason"); break;
    case "policy.list":
      requireId(request["sessionId"], "sessionId");
      if (request["state"] !== "pending" && request["state"] !== "resolved") throw boundaryValidation("state is invalid", "state");
      validatePage(request["page"]);
      break;
    case "evolution.get": requireId(request["jobId"], "jobId"); break;
    case "evolution.cancel": requireId(request["jobId"], "jobId"); requireString(request["reason"], "reason"); break;
    case "benchmark.run-paired":
      requireId(request["suiteId"], "suiteId"); requireId(request["incumbentId"], "incumbentId"); requireId(request["candidateId"], "candidateId");
      break;
    case "scorecard.get": requireId(request["scorecardId"], "scorecardId"); break;
    case "knowledge.catalog":
    case "marketplace.search": requireObject(request["query"], "query"); break;
    case "knowledge.read": requireId(request["projectId"], "projectId"); requireId(request["documentId"], "documentId"); break;
    case "harness.get": requireId(request["harnessId"], "harnessId"); break;
    case "harness.rollback":
    case "harness.pin":
      requireId(request["projectId"], "projectId"); requireId(request["targetHarnessId"], "targetHarnessId"); requireString(request["reason"], "reason");
      break;
  }
  return request as ClientRequest;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw boundaryValidation("Request body exceeds 1 MiB", "body");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, value: JsonValue): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function authenticate(request: IncomingMessage, token: string): void {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) throw unauthorized();
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) throw unauthorized();
}

function tokenFromEnvironment(name: CredentialEnvName): string | null {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? null : value;
}

function io(operation: string, error: unknown): IoError {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
  return { kind: "io-error", operation, code, recoverable: false, callerAction: "propagate" };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  application: OmegaApplication,
  config: OmegaConfig["server"],
  token: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${config.host}`);
  if (request.method === "GET" && url.pathname === "/" && url.search === "") {
    const html = renderHtmlApp(config);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
    response.end(html);
    return;
  }
  if (request.method === "GET" && url.pathname === config.healthPath && url.search === "") {
    sendJson(response, 200, { status: "ok", protocolVersion: config.protocolVersion });
    return;
  }
  if (request.method === "POST" && url.pathname === config.requestPath && url.search === "") {
    authenticate(request, token);
    const parsed = parseClientRequest(await readBody(request));
    sendJson(response, 200, await application.execute(parsed) as unknown as JsonValue);
    return;
  }
  const eventPattern = /^\/api\/v1\/sessions\/([^/]+)\/events$/u;
  const eventMatch = eventPattern.exec(url.pathname);
  if (request.method === "GET" && eventMatch !== null) {
    authenticate(request, token);
    if ([...url.searchParams.keys()].some((key) => key !== "afterSequence") || !url.searchParams.has("afterSequence")) {
      throw boundaryValidation("SSE query must contain only afterSequence", "afterSequence");
    }
    const rawSessionId = decodeURIComponent(eventMatch[1] ?? "");
    requireId(rawSessionId, "sessionId");
    const rawSequence = url.searchParams.get("afterSequence") ?? "";
    if (!/^\d+$/u.test(rawSequence)) throw boundaryValidation("afterSequence must be a non-negative integer", "afterSequence");
    const afterSequence = Number(rawSequence);
    if (!Number.isSafeInteger(afterSequence)) throw boundaryValidation("afterSequence must be a safe integer", "afterSequence");
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    const sessionId = rawSessionId as SessionId;
    const iterator = createSseBroker().open(sessionId, afterSequence, application.events(sessionId, afterSequence))[Symbol.asyncIterator]();
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(": heartbeat\n\n"); }, 15_000);
    try {
      while (!response.destroyed) {
        const next = await iterator.next();
        if (next.done) break;
        if (!response.write(encodeSseFrame(next.value))) await new Promise<void>((resolve) => response.once("drain", resolve));
      }
    } finally {
      clearInterval(heartbeat);
      await iterator.return?.();
      if (!response.destroyed) response.end();
    }
    return;
  }
  sendJson(response, 404, { error: { kind: "protocol-error", protocol: "http", message: "Unknown Omega HTTP route", recoverable: false, callerAction: "abort" } });
}

export const startHttpServer: StartHttpServer = async (application, config) => {
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65_535) {
    return { ok: false, error: validation("Server port must be an integer between 0 and 65535", "server.port") };
  }
  const token = tokenFromEnvironment(config.bearerTokenEnvName);
  if (token === null) return { ok: false, error: validation("Bearer token environment variable is required", String(config.bearerTokenEnvName)) };
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, application, config, token).catch((error: unknown) => {
      void (async (): Promise<void> => {
        if (error instanceof BoundaryFailure && !response.headersSent) {
          sendJson(response, error.status, error.body as unknown as JsonValue);
          return;
        }
        const boundary = request.url?.includes("/events") === true ? "sse" : "http";
        const recorded = await internal(application, boundary, error);
        if (!recorded.ok || response.headersSent) {
          response.destroy();
          return;
        }
        sendJson(response, 500, { error: recorded.value } as unknown as JsonValue);
      })().catch(() => response.destroy());
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const listening = await new Promise<Result<void, IoError>>((resolve) => {
    const onError = (error: Error): void => resolve({ ok: false, error: io("listen", error) });
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      resolve({ ok: true, value: undefined });
    });
  });
  if (!listening.ok) return listening;
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    return { ok: false, error: io("resolve-listener-address", new Error("Listener address unavailable")) };
  }
  let stopped = false;
  return {
    ok: true,
    value: {
      host: config.host,
      port: address.port,
      async stop(deadline) {
        if (stopped) return { ok: true, value: undefined };
        stopped = true;
        return new Promise((resolve) => {
          const remaining = Math.max(0, Date.parse(String(deadline)) - Date.now());
          const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, remaining);
          server.close((error) => {
            clearTimeout(timer);
            if (error !== undefined) resolve({ ok: false, error: io("close-listener", error) });
            else resolve({ ok: true, value: undefined });
          });
        });
      },
    },
  };
};
