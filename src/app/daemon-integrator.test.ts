import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type {
  ArtifactId,
  AbsolutePath,
  ByteCount,
  ClientRequest,
  ClientResponse,
  EventId,
  HarnessId,
  HarnessManifest,
  HarnessRepository,
  LiveEventEnvelope,
  OmegaApplication,
  ObjectDescriptor,
  ObjectHash,
  ProjectId,
  ProjectRecord,
  ProjectRepository,
  RequestId,
  SessionRecord,
  SessionId,
  Timestamp,
  WorkspaceId,
} from "../contracts/index.js";
import { startHttpServer } from "./http-server.js";
import { createBenchmarkRunLauncher, ensureProjectHarness } from "./omega-app.js";

const TOKEN_NAME = String(DEFAULT_CONFIG.server.bearerTokenEnvName);
const TOKEN = "daemon-test-token";
function success(request: ClientRequest): ClientResponse {
  return {
    requestId: request.requestId,
    result: { ok: true, value: { kind: "projects", page: { items: [], nextCursor: null } } },
  };
}

function fakeApplication(overrides: Partial<OmegaApplication> = {}): OmegaApplication {
  return {
    execute: async (request) => success(request),
    async *events() { return; },
    async recordDiagnostic() { return { ok: true, value: "diagnostic_test" as ArtifactId }; },
    async start() { return { ok: true, value: undefined }; },
    async stop() { return { ok: true, value: undefined }; },
    ...overrides,
  };
}

async function withServer(application: OmegaApplication, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const started = await startHttpServer(application, { ...DEFAULT_CONFIG.server, port: 0 }, { [TOKEN_NAME]: TOKEN });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  try {
    await run(`http://${started.value.host}:${started.value.port}`);
  } finally {
    await started.value.stop(new Date(Date.now() + 2_000).toISOString() as Timestamp);
  }
}

describe("daemon HTTP integration", () => {
  it("serves the HTML shell and unauthenticated health route", async () => {
    await withServer(fakeApplication(), async (baseUrl) => {
      const health = await fetch(`${baseUrl}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok", protocolVersion: 1 });
      const html = await fetch(`${baseUrl}/`);
      expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await html.text()).toContain('type="password"');
    });
  });

  it("authenticates RPC and rejects malformed discriminators at the boundary", async () => {
    await withServer(fakeApplication(), async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/v1/requests`, { method: "POST", body: "{}" });
      expect(missing.status).toBe(401);
      const unknown = await fetch(`${baseUrl}/api/v1/requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ kind: "unknown", requestId: "request-1" }),
      });
      expect(unknown.status).toBe(400);
      const valid = await fetch(`${baseUrl}/api/v1/requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ kind: "project.list", requestId: "request-1", page: { cursor: null, limit: 10 } }),
      });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toMatchObject({ requestId: "request-1", result: { ok: true } });
      const malformedNested = await fetch(`${baseUrl}/api/v1/requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ kind: "task.start", requestId: "request-2", request: {} }),
      });
      expect(malformedNested.status).toBe(400);
    });
  });

  it("frames persisted and live-only SSE events with decimal sequence IDs", async () => {
    const sessionId = "session-1" as SessionId;
    const persisted: LiveEventEnvelope = {
      kind: "session-event",
      sessionId,
      event: {
        id: "event-4" as EventId,
        sequence: 4,
        at: "2026-07-16T00:00:00.000Z" as Timestamp,
        harnessId: "harness-1" as HarnessId,
        payload: { kind: "session.started" },
      },
    };
    const app = fakeApplication({
      async *events() {
        yield persisted;
        yield {
          kind: "harness-nudge",
          sessionId,
          update: {
            projectId: "project-1" as ProjectId,
            previousHarnessId: "harness-0" as HarnessId,
            activeHarnessId: "harness-1" as HarnessId,
            reason: "manual-pin",
            scorecardId: null,
            activatedAt: "2026-07-16T00:00:00.000Z" as Timestamp,
          },
        };
      },
    });
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/events?afterSequence=3`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.match(/id: 4/g)).toHaveLength(2);
      expect(text.match(/event: omega.live/g)).toHaveLength(2);
      expect(text).toContain(`data: ${JSON.stringify(persisted)}`);
    });
  });

  it("persists and sanitizes implementation defects", async () => {
    const recorded: string[] = [];
    await withServer(fakeApplication({
      async execute() { throw new Error("secret provider credential detail"); },
      async recordDiagnostic(input) { recorded.push(input.message); return { ok: true, value: "diagnostic_saved" as ArtifactId }; },
    }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ kind: "project.list", requestId: "request-2" as RequestId, page: { cursor: null, limit: 10 } }),
      });
      expect(response.status).toBe(500);
      const body = JSON.stringify(await response.json());
      expect(body).toContain("diagnostic_saved");
      expect(body).not.toContain("secret provider");
      expect(recorded).toEqual(["secret provider credential detail"]);
    });
  });

  it("fails startup without a configured token", async () => {
    const result = await startHttpServer(fakeApplication(), { ...DEFAULT_CONFIG.server, port: 0 }, {});
    expect(result).toMatchObject({ ok: false, error: { kind: "validation" } });
  });
});

describe("project harness bootstrap", () => {
  it("indexes a deterministic initial harness before activation and safely repairs a retry", async () => {
    const project: ProjectRecord = {
      id: "project-bootstrap" as ProjectId,
      displayName: "bootstrap",
      repository: { canonicalRemote: null, initialRootHash: "0".repeat(64) as ProjectRecord["repository"]["initialRootHash"] },
      activeHarnessId: null,
      createdAt: "2026-07-16T00:00:00.000Z" as Timestamp,
      updatedAt: "2026-07-16T00:00:00.000Z" as Timestamp,
    };
    const order: string[] = [];
    let active: HarnessId | null = null;
    let failIndex = true;
    const manifests = new Map<HarnessId, HarnessManifest>();
    const objects = {
      async put(mediaType: string, chunks: AsyncIterable<Uint8Array>) {
        const bytes: Uint8Array[] = [];
        for await (const chunk of chunks) bytes.push(chunk);
        const value = Buffer.concat(bytes);
        const hash = createHash("sha256").update(value).digest("hex") as ObjectHash;
        return { ok: true as const, value: { hash, size: value.byteLength as ByteCount, mediaType, createdAt: project.createdAt } };
      },
      async get(hash: ObjectHash) { return { ok: false as const, error: { kind: "not-found" as const, resource: "object", id: hash, recoverable: false as const, callerAction: "propagate" as const } }; },
      async describe(hash: ObjectHash) { return { ok: false as const, error: { kind: "not-found" as const, resource: "object", id: hash, recoverable: false as const, callerAction: "propagate" as const } }; },
    };
    const projects: ProjectRepository = {
      async registerWorkspace() { return { ok: false, error: { kind: "validation", message: "unused", field: null, recoverable: true, callerAction: "fix-request" } }; },
      async registerBenchmarkWorkspace() { return { ok: false, error: { kind: "validation", message: "unused", field: null, recoverable: true, callerAction: "fix-request" } }; },
      async getProject() { return { ok: true, value: { ...project, activeHarnessId: active } }; },
      async getWorkspace(id) { return { ok: false, error: { kind: "not-found", resource: "workspace", id, recoverable: false, callerAction: "propagate" } }; },
      async listProjects() { return { ok: true, value: { items: [], nextCursor: null } }; },
      async compareAndSetActiveHarness(_id, expected, next) {
        order.push("activate");
        if (active !== expected) return { ok: false, error: { kind: "conflict", resource: "project-active-harness", expected: String(expected), actual: String(active), recoverable: true, callerAction: "refresh-version-and-retry" } };
        active = next;
        return { ok: true, value: { ...project, activeHarnessId: next } };
      },
    };
    const harnesses: HarnessRepository = {
      async putComponent(component) { return { ok: true, value: component }; },
      async putHarness(manifest) {
        order.push("index");
        if (failIndex) {
          failIndex = false;
          return { ok: false, error: { kind: "io-error", operation: "index-harness", code: "EIO", recoverable: true, callerAction: "retry-with-backoff" } };
        }
        manifests.set(manifest.id, manifest);
        return { ok: true, value: manifest };
      },
      async getHarness(id) {
        const manifest = manifests.get(id);
        return manifest === undefined ? { ok: false, error: { kind: "not-found", resource: "harness", id, recoverable: false, callerAction: "propagate" } } : { ok: true, value: manifest };
      },
      async getActiveHarness() { return active === null ? { ok: false, error: { kind: "not-found", resource: "harness", id: "active", recoverable: false, callerAction: "propagate" } } : this.getHarness(active); },
      async listProjectHarnesses() { return { ok: true, value: { items: [...manifests.values()], nextCursor: null } }; },
    };

    expect((await ensureProjectHarness(project, objects, projects, harnesses)).ok).toBe(false);
    expect(active).toBeNull();
    expect(order).toEqual(["index"]);
    const repaired = await ensureProjectHarness(project, objects, projects, harnesses);
    expect(repaired.ok).toBe(true);
    expect(order.slice(-2)).toEqual(["index", "activate"]);
    if (!repaired.ok) return;
    const repeated = await ensureProjectHarness(project, objects, projects, harnesses);
    expect(repeated.ok && repeated.value.id).toBe(repaired.value.id);
  });
});

describe("trusted benchmark launcher", () => {
  it("runs an inactive requested harness without exposing private verifier material to the session", async () => {
    const root = await mkdtemp(join(tmpdir(), "omega-launcher-"));
    const fixtureHash = "fixture" as ObjectHash;
    const verifierHash = "verifier" as ObjectHash;
    const invariantHash = "invariants" as ObjectHash;
    const values = new Map<ObjectHash, Uint8Array>([
      [fixtureHash, Buffer.from(JSON.stringify({ files: { "README.md": "candidate output" } }))],
      [verifierHash, Buffer.from(JSON.stringify({ checks: [{ path: "README.md", equals: "candidate output" }] }))],
      [invariantHash, Buffer.from(JSON.stringify({ checks: [{ path: "forbidden.txt", absent: true }] }))],
    ]);
    let stored = 0;
    const objects = {
      async put(mediaType: string, chunks: AsyncIterable<Uint8Array>) {
        const collected: Uint8Array[] = [];
        for await (const chunk of chunks) collected.push(chunk);
        const data = Buffer.concat(collected);
        const hash = createHash("sha256").update(data).digest("hex") as ObjectHash;
        values.set(hash, data);
        stored += 1;
        return { ok: true as const, value: { hash, size: data.byteLength as ByteCount, mediaType, createdAt: "2026-07-16T00:00:00.000Z" as Timestamp } };
      },
      async get(hash: ObjectHash) {
        const data = values.get(hash);
        if (data === undefined) return { ok: false as const, error: { kind: "not-found" as const, resource: "object", id: hash, recoverable: false as const, callerAction: "propagate" as const } };
        return { ok: true as const, value: (async function* (): AsyncIterable<Uint8Array> { yield data; })() };
      },
      async describe(hash: ObjectHash) {
        const data = values.get(hash);
        if (data === undefined) return { ok: false as const, error: { kind: "not-found" as const, resource: "object", id: hash, recoverable: false as const, callerAction: "propagate" as const } };
        const value: ObjectDescriptor = { hash, size: data.byteLength as ByteCount, mediaType: "application/json", createdAt: "2026-07-16T00:00:00.000Z" as Timestamp };
        return { ok: true as const, value };
      },
    };
    const projectId = "project-candidate" as ProjectId;
    const incumbentId = "harness-incumbent" as HarnessId;
    const candidateId = "harness-inactive-candidate" as HarnessId;
    const harness: HarnessManifest = {
      id: candidateId,
      projectId,
      alias: "candidate",
      parents: [incumbentId],
      components: [],
      sourceArtifacts: [],
      createdAt: "2026-07-16T00:00:00.000Z" as Timestamp,
    };
    const routeConfig = DEFAULT_CONFIG.models.routes[0];
    expect(routeConfig).toBeDefined();
    if (routeConfig === undefined) return;
    const route = {
      role: routeConfig.role,
      providerId: routeConfig.providerId,
      modelId: routeConfig.modelId,
      variant: null,
      servingProvider: null,
      quantization: null,
      reasoning: routeConfig.reasoning,
      temperature: routeConfig.temperature,
      topP: routeConfig.topP,
      seed: routeConfig.seed,
      contextLimit: routeConfig.contextLimit,
      outputLimit: routeConfig.maxOutputTokens,
      equivalentListPrice: routeConfig.equivalentListPrice,
    } as const;
    const session: SessionRecord = {
      header: {
        id: "session-benchmark" as SessionId,
        threadId: "thread-benchmark" as SessionRecord["header"]["threadId"],
        parentSessionId: null,
        continuation: null,
        projectId,
        workspaceId: "workspace-fixture" as WorkspaceId,
        role: "promotion-eval",
        objective: "verify candidate",
        initialHarnessId: candidateId,
        initialModelRoutes: [route],
        policyProfile: "guarded",
        capabilityEnvelope: { ...DEFAULT_CONFIG.sessions.mainCapabilities, createdAt: "2026-07-16T00:00:00.000Z" as Timestamp },
        credentialEnvNames: [],
        eventSchemaVersion: 1,
        createdAt: "2026-07-16T00:00:00.000Z" as Timestamp,
      },
      state: "completed",
      lastSequence: 1,
      completedAt: "2026-07-16T00:00:01.000Z" as Timestamp,
      outcome: "succeeded",
    };
    const sessionRequests: string[] = [];
    const benchmarkRegistrations: string[] = [];
    const launcher = createBenchmarkRunLauncher({
      root: root as AbsolutePath,
      objects,
      projects: {
        async registerBenchmarkWorkspace(requestedProjectId, path, fixtureHash) {
          benchmarkRegistrations.push(JSON.stringify({ requestedProjectId, path, fixtureHash, activeHarnessId: incumbentId }));
          return { ok: true, value: { id: session.header.workspaceId, projectId, path, registeredAt: session.header.createdAt, lastSeenAt: session.header.createdAt } };
        },
      },
      sessions: {
        async startBenchmarkTask(request) { sessionRequests.push(JSON.stringify(request)); return { ok: true, value: session }; },
        async cancel() { return { ok: true, value: session }; },
      },
      repository: {
        async get() { return { ok: true, value: session }; },
        async read() { return { ok: true, value: [] }; },
        async recordArtifact(record) { return { ok: true, value: record }; },
      },
      config: DEFAULT_CONFIG,
    });
    try {
      const execution: Parameters<typeof launcher.execute>[0] = {
        suiteId: "suite" as Parameters<typeof launcher.execute>[0]["suiteId"],
        manifestVersion: "1",
        promotionPolicy: DEFAULT_CONFIG.benchmarks.developmentPromotionPolicy,
        task: { id: "task" as Parameters<typeof launcher.execute>[0]["task"]["id"], title: "task", objective: "verify candidate", fixtureObjectHash: fixtureHash, environmentObjectHash: "environment" as ObjectHash, budget: { wallTimeMs: 1_000 as Parameters<typeof launcher.execute>[0]["task"]["budget"]["wallTimeMs"], maxModelCalls: 1, maxInputTokens: 100 as Parameters<typeof launcher.execute>[0]["task"]["budget"]["maxInputTokens"], maxOutputTokens: 100 as Parameters<typeof launcher.execute>[0]["task"]["budget"]["maxOutputTokens"], maxCostUsdMicros: 0 as Parameters<typeof launcher.execute>[0]["task"]["budget"]["maxCostUsdMicros"], maxProcessStarts: 1 } },
        privateTask: { taskId: "task" as Parameters<typeof launcher.execute>[0]["task"]["id"], verifierObjectHash: verifierHash, negativeInvariantObjectHash: invariantHash, diagnosticTags: ["private-secret-tag"] },
        harness,
        route,
      };
      const result = await launcher.execute(execution);
      expect(result).toMatchObject({ ok: true, value: { sessionId: session.header.id, outcome: "passed" } });
      expect(sessionRequests).toHaveLength(1);
      expect(benchmarkRegistrations).toHaveLength(1);
      expect(benchmarkRegistrations[0]).toContain(projectId);
      expect(benchmarkRegistrations[0]).toContain(fixtureHash);
      expect(benchmarkRegistrations[0]).toContain(incumbentId);
      expect(sessionRequests[0]).toContain(candidateId);
      expect(sessionRequests[0]).not.toContain(incumbentId);
      expect(sessionRequests[0]).not.toContain(verifierHash);
      expect(sessionRequests[0]).not.toContain(invariantHash);
      expect(sessionRequests[0]).not.toContain("private-secret-tag");
      expect(stored).toBeGreaterThanOrEqual(3);

      const pending: SessionRecord = { ...session, state: "running", completedAt: null, outcome: null };
      const benchmarkStarted = Promise.withResolvers<void>();
      const cancellationReasons: string[] = [];
      const abortingLauncher = createBenchmarkRunLauncher({
        root: root as AbsolutePath,
        objects,
        projects: {
          async registerBenchmarkWorkspace(_requestedProjectId, path) {
            return { ok: true, value: { id: pending.header.workspaceId, projectId, path, registeredAt: pending.header.createdAt, lastSeenAt: pending.header.createdAt } };
          },
        },
        sessions: {
          async startBenchmarkTask() { benchmarkStarted.resolve(); return { ok: true, value: pending }; },
          async cancel(_sessionId, reason) {
            cancellationReasons.push(reason);
            return { ok: true, value: { ...pending, state: "cancelled", completedAt: pending.header.createdAt, outcome: "cancelled" } };
          },
        },
        repository: {
          async get() { return { ok: true, value: pending }; },
          async read() { return { ok: true, value: [] }; },
          async recordArtifact(record) { return { ok: true, value: record }; },
        },
        config: DEFAULT_CONFIG,
      });
      const controller = new AbortController();
      const running = abortingLauncher.execute(execution, controller.signal);
      await benchmarkStarted.promise;
      controller.abort("operator cancellation");
      const aborted = await running;
      expect(aborted).toMatchObject({ ok: false, error: { field: "signal" } });
      expect(cancellationReasons).toEqual(["benchmark evaluation cancelled"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
