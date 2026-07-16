import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AbsolutePath,
  EventId,
  HarnessActivationService,
  HarnessId,
  HarnessUpdate,
  LiveEventEnvelope,
  ProcessId,
  ProjectId,
  ProjectRecord,
  PromotableScorecard,
  SessionEvent,
  SessionId,
  SessionRecord,
  Timestamp,
} from "../contracts/index.js";
import { createFileObjectStore } from "../persistence/object-store.js";
import { createFileSessionRepository } from "../persistence/session-repository.js";
import { createCoordinatedActivationService, recoverPersistedSessions } from "./lifecycle.js";

const PROJECT_ID = "project-lifecycle" as ProjectId;
const ACTIVE_SESSION_ID = "session-active" as SessionId;
const TERMINAL_SESSION_ID = "session-terminal" as SessionId;
const NOW = "2026-07-16T00:00:00.000Z" as Timestamp;

function session(id: SessionId, outcome: SessionRecord["outcome"]): SessionRecord {
  return {
    header: {
      id,
      threadId: `thread-${id}` as SessionRecord["header"]["threadId"],
      parentSessionId: null,
      continuation: null,
      projectId: PROJECT_ID,
      workspaceId: "workspace-lifecycle" as SessionRecord["header"]["workspaceId"],
      role: "main",
      objective: "observe harness activation",
      initialHarnessId: "harness-old" as HarnessId,
      initialModelRoutes: [],
      policyProfile: "guarded",
      capabilityEnvelope: {
        grants: [], modelRoles: [], maxCostUsdMicros: 0 as never, maxModelCalls: 0, maxProcessStarts: 0,
        maxInputTokens: 0 as never, maxOutputTokens: 0 as never, wallTimeMs: 1 as never, createdAt: NOW,
      },
      credentialEnvNames: [],
      eventSchemaVersion: 1,
      createdAt: NOW,
    },
    state: outcome === null ? "running" : outcome === "succeeded" ? "completed" : outcome,
    lastSequence: outcome === null ? 1 : 2,
    completedAt: outcome === null ? null : NOW,
    outcome,
  };
}

function update(reason: HarnessUpdate["reason"]): HarnessUpdate {
  return {
    projectId: PROJECT_ID,
    previousHarnessId: "harness-old" as HarnessId,
    activeHarnessId: "harness-new" as HarnessId,
    reason,
    scorecardId: null,
    activatedAt: NOW,
  };
}

describe("activation lifecycle coordination", () => {
  it("persists and nudges every activation kind only for nonterminal project sessions", async () => {
    const active = session(ACTIVE_SESSION_ID, null);
    const terminal = session(TERMINAL_SESSION_ID, "succeeded");
    const persisted: Array<{ readonly sessionId: SessionId; readonly update: HarnessUpdate }> = [];
    const live: SessionId[] = [];
    const sent: SessionId[] = [];
    const inner: HarnessActivationService = {
      async pin() { return { ok: true, value: update("manual-pin") }; },
      async rollback() { return { ok: true, value: update("rollback") }; },
      async promote() { return { ok: true, value: update("promotion") }; },
    };
    const coordinated = createCoordinatedActivationService({
      activation: inner,
      repository: {
        async list() { return { ok: true, value: { items: [active, terminal], nextCursor: null } }; },
        async get(id) { return { ok: true, value: id === ACTIVE_SESSION_ID ? active : terminal }; },
      },
      sessions: {
        async recordRunnerEvent(sessionId, payload, harnessId) {
          if (payload.kind !== "harness.updated") throw new Error("unexpected event");
          persisted.push({ sessionId, update: payload.update });
          const event: SessionEvent = { id: `event-${persisted.length}` as EventId, sequence: persisted.length, at: NOW, harnessId, payload };
          return { ok: true, value: event };
        },
        publishRunnerEvent(event) { if (event.kind === "harness-nudge") live.push(event.sessionId); },
        async cancel() { return { ok: true, value: session(ACTIVE_SESSION_ID, "cancelled") }; },
      },
      runners: {
        async send(sessionId) { sent.push(sessionId); return { ok: true, value: undefined }; },
      },
    });

    await coordinated.pin(PROJECT_ID, "harness-new" as HarnessId, "pin");
    await coordinated.rollback(PROJECT_ID, "harness-new" as HarnessId, "rollback");
    await coordinated.promote({} as unknown as PromotableScorecard);

    expect(persisted.map((entry) => entry.sessionId)).toEqual([ACTIVE_SESSION_ID, ACTIVE_SESSION_ID, ACTIVE_SESSION_ID]);
    expect(persisted.map((entry) => entry.update.reason)).toEqual(["manual-pin", "rollback", "promotion"]);
    expect(live).toEqual([ACTIVE_SESSION_ID, ACTIVE_SESSION_ID, ACTIVE_SESSION_ID]);
    expect(sent).toEqual([ACTIVE_SESSION_ID, ACTIVE_SESSION_ID, ACTIVE_SESSION_ID]);
  });

  it("terminates a session whose runner cannot adopt the new active harness", async () => {
    const active = session(ACTIVE_SESSION_ID, null);
    const cancelled: SessionId[] = [];
    const coordinated = createCoordinatedActivationService({
      activation: {
        async pin() { return { ok: true, value: update("manual-pin") }; },
        async rollback() { return { ok: true, value: update("rollback") }; },
        async promote() { return { ok: true, value: update("promotion") }; },
      },
      repository: {
        async list() { return { ok: true, value: { items: [active], nextCursor: null } }; },
        async get() { return { ok: true, value: active }; },
      },
      sessions: {
        async recordRunnerEvent(_sessionId, payload, harnessId) {
          return { ok: true, value: { id: "event-update" as EventId, sequence: 2, at: NOW, harnessId, payload } };
        },
        publishRunnerEvent() { return; },
        async cancel(sessionId) { cancelled.push(sessionId); return { ok: true, value: session(sessionId, "cancelled") }; },
      },
      runners: {
        async send() {
          return { ok: false, error: {
            kind: "protocol-error", protocol: "runner-jsonl", message: "runner pipe closed",
            recoverable: false, callerAction: "abort",
          } };
        },
      },
    });

    const result = await coordinated.pin(PROJECT_ID, "harness-new" as HarnessId, "pin");

    expect(result.ok).toBe(true);
    expect(cancelled).toEqual([ACTIVE_SESSION_ID]);
  });

  it("recovers every persisted nonterminal session with persisted unfinished process IDs exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "omega-lifecycle-recovery-"));
    try {
      const objects = createFileObjectStore(root as AbsolutePath);
      const repository = createFileSessionRepository(root as AbsolutePath, objects);
      const active = session(ACTIVE_SESSION_ID, null);
      const terminal = session(TERMINAL_SESSION_ID, null);
      await repository.create(active.header);
      await repository.create(terminal.header);
      await repository.append(ACTIVE_SESSION_ID, 0, { kind: "session.started" }, active.header.initialHarnessId, null);
      await repository.append(ACTIVE_SESSION_ID, 1, {
        kind: "runner.started",
        harnessId: active.header.initialHarnessId,
        processId: "process-orphaned-runner" as ProcessId,
      }, active.header.initialHarnessId, null);
      await repository.append(TERMINAL_SESSION_ID, 0, { kind: "session.started" }, terminal.header.initialHarnessId, null);
      await repository.append(TERMINAL_SESSION_ID, 1, { kind: "session.completed", outcome: "succeeded" }, terminal.header.initialHarnessId, null);
      const project: ProjectRecord = {
        id: PROJECT_ID,
        displayName: "lifecycle",
        repository: { canonicalRemote: null, initialRootHash: "0".repeat(64) as ProjectRecord["repository"]["initialRootHash"] },
        activeHarnessId: active.header.initialHarnessId,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const published: SessionEvent[] = [];
      const options = {
        projects: { async listProjects() { return { ok: true as const, value: { items: [project], nextCursor: null } }; } },
        repository,
        sessions: { publishRunnerEvent(event: LiveEventEnvelope) {
          if (event.kind === "session-event") published.push(event.event);
        } },
      };

      const recovered = await recoverPersistedSessions(options);
      const repeated = await recoverPersistedSessions(options);

      expect(recovered.ok && repeated.ok).toBe(true);
      const activeAfter = await repository.get(ACTIVE_SESSION_ID);
      expect(activeAfter.ok && activeAfter.value.outcome).toBe("failed");
      const activeEvents = await repository.read(ACTIVE_SESSION_ID, 0, 10);
      expect(activeEvents.ok && activeEvents.value.map((event) => event.payload.kind)).toEqual([
        "session.started", "runner.started", "session.recovered", "session.completed",
      ]);
      if (activeEvents.ok) {
        const recovery = activeEvents.value.find((event) => event.payload.kind === "session.recovered");
        expect(recovery?.payload.kind === "session.recovered" && recovery.payload.interruptedProcessIds).toEqual(["process-orphaned-runner"]);
      }
      expect(published.map((event) => event.payload.kind)).toEqual(["session.recovered", "session.completed"]);
      const terminalEvents = await repository.read(TERMINAL_SESSION_ID, 0, 10);
      expect(terminalEvents.ok && terminalEvents.value).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
