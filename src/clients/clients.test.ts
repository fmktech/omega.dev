import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type {
  ArtifactId,
  ByteCount,
  ClientResponse,
  EventId,
  HarnessId,
  LiveEventEnvelope,
  OmegaClient,
  RequestId,
  SessionId,
  Timestamp,
} from "../contracts/index.js";
import { runCli } from "./cli.js";
import { renderHtmlApp } from "./html-app.js";
import { createOmegaClient } from "./local-client.js";

const BASE_URL = "http://127.0.0.1:7337";

function jsonResponse(value: ClientResponse, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function success(requestId: RequestId): ClientResponse {
  return {
    requestId,
    result: { ok: true, value: { kind: "projects", page: { items: [], nextCursor: null } } },
  };
}

function sseResponse(frames: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function eventFrame(sessionId: SessionId, sequence: number): string {
  const data: LiveEventEnvelope = {
    kind: "session-event",
    sessionId,
    event: {
      id: `event-${sequence}` as EventId,
      sequence,
      at: "2026-07-16T12:00:00.000Z" as Timestamp,
      harnessId: "harness-1" as HarnessId,
      payload: { kind: "session.started" },
    },
  };
  return `id: ${sequence}\nevent: omega.live\ndata: ${JSON.stringify(data)}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createOmegaClient", () => {
  it("posts typed requests with bearer authentication and preserves the correlation ID", async () => {
    const requestId = "request-1" as RequestId;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(requestId));
    vi.stubGlobal("fetch", fetchMock);

    const response = await createOmegaClient(BASE_URL, "secret-token").request({
      kind: "project.list",
      requestId,
      page: { cursor: null, limit: 20 },
    });

    expect(response).toEqual(success(requestId));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
    expect(JSON.parse(String(init?.body))).toMatchObject({ kind: "project.list", requestId });
  });

  it("surfaces sanitized authentication and daemon-unavailable failures", async () => {
    const unauthorized = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { kind: "unauthorized", message: "Invalid bearer token", recoverable: false, callerAction: "abort" },
    }), { status: 401 }));
    vi.stubGlobal("fetch", unauthorized);
    const client = createOmegaClient(BASE_URL, "incorrect");
    await expect(client.request({ kind: "project.list", requestId: "r1" as RequestId, page: { cursor: null, limit: 1 } })).rejects.toThrow("unauthorized: Invalid bearer token");

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("sensitive socket diagnostic")));
    await expect(client.request({ kind: "project.list", requestId: "r2" as RequestId, page: { cursor: null, limit: 1 } })).rejects.toThrow("Omega daemon is unavailable");
  });

  it("reconnects SSE after interruption and deduplicates persisted sequences", async () => {
    const sessionId = "session-1" as SessionId;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse([eventFrame(sessionId, 1)]))
      .mockResolvedValueOnce(sseResponse([eventFrame(sessionId, 1), eventFrame(sessionId, 2)]));
    vi.stubGlobal("fetch", fetchMock);
    const observed: LiveEventEnvelope[] = [];

    for await (const event of createOmegaClient(BASE_URL, "token").events(sessionId, 0)) {
      observed.push(event);
      if (observed.length === 2) break;
    }

    expect(observed.map((entry) => entry.kind === "session-event" ? entry.event.sequence : -1)).toEqual([1, 2]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("afterSequence=1");
  });

  it("keeps base64 artifact slices encoded rather than interpreting binary as text", async () => {
    const requestId = "artifact-request" as RequestId;
    const wire = {
      requestId,
      result: {
        ok: true,
        value: {
          kind: "artifact",
          slice: {
            artifact: { id: "a1", kind: "process-stdout", object: { hash: "o1", size: 3, mediaType: "application/octet-stream", createdAt: "2026-07-16T12:00:00.000Z" }, sessionId: "s1", createdAt: "2026-07-16T12:00:00.000Z", metadata: {} },
            range: { startInclusive: 0, endExclusive: 3 }, encoding: "base64", data: "AP+A", complete: true,
          },
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(wire))));
    const response = await createOmegaClient(BASE_URL, "token").request({ kind: "artifact.read", requestId, artifactId: "a1" as ArtifactId, offset: 0 as ByteCount, limit: 10 as ByteCount });
    expect(response.result.ok && response.result.value.kind === "artifact" ? response.result.value.slice : null).toMatchObject({ encoding: "base64", data: "AP+A" });
  });
});

function successResponse(requestId: RequestId): Response {
  return jsonResponse(success(requestId));
}

describe("runCli", () => {
  it("dispatches a project-scoped session listing command", async () => {
    const calls: string[] = [];
    const client: OmegaClient = {
      async request(request) {
        calls.push(request.kind);
        expect(request).toMatchObject({ kind: "session.list", projectId: "project-1", page: { cursor: null, limit: 25 } });
        return { requestId: request.requestId, result: { ok: true, value: { kind: "sessions", page: { items: [], nextCursor: null } } } };
      },
      async *events() {
        return;
      },
    };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli(["sessions", "project-1", "-", "25"], client)).resolves.toBe(0);
    expect(calls).toEqual(["session.list"]);
  });
});

describe("renderHtmlApp", () => {
  it("renders an in-memory unlock flow and every v0 control surface", () => {
    const html = renderHtmlApp(DEFAULT_CONFIG.server);

    expect(html).toContain('type="password"');
    expect(html).toContain("Your harness,");
    expect(html).toContain("Projects");
    expect(html).toContain("Execution policy");
    expect(html).toContain("Local marketplace");
    expect(html).toContain("Promotion scorecards");
    expect(html).toContain("Reconnecting after interruption");
    expect(html).toContain("Binary artifact · base64");
    expect(html).toContain(DEFAULT_CONFIG.server.requestPath);
    expect(html).not.toContain("local" + "Storage");
    expect(html).not.toContain("session" + "Storage");
  });
});
