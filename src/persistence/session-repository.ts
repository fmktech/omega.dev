import { randomUUID } from "node:crypto";
import { open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  CreateFileSessionRepository,
  EventId,
  ObjectStore,
  Page,
  PageRequest,
  ProjectId,
  Result,
  SessionError,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionRecord,
} from "../contracts/index.js";
import {
  atomicWriteFile,
  fileExists,
  ioError,
  loadArtifactSlice,
  safeStorageKey,
  storeArtifactRecord,
  timestampNow,
  validationError,
  withFileLock,
} from "./artifact-store.js";

type SessionIndexEntry = {
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
};

const EVENT_KINDS: ReadonlySet<string> = new Set([
  "session.started",
  "runner.started",
  "runner.stopped",
  "model.started",
  "model.completed",
  "model.failed",
  "policy.decided",
  "policy.escalated",
  "policy.resolved",
  "process.started",
  "process.observed",
  "process.completed",
  "child.spawned",
  "child.completed",
  "artifact.recorded",
  "knowledge.updated",
  "marketplace.published",
  "evolution.updated",
  "benchmark.completed",
  "harness.updated",
  "handoff.created",
  "session.recovered",
  "session.completed",
]);

export const createFileSessionRepository: CreateFileSessionRepository = (root, objects) => ({
  async create(header) {
    const headerValidation = validateHeader(header);
    if (!headerValidation.ok) {
      return headerValidation;
    }
    const indexPath = sessionIndexPath(root, header.id);
    const paths = sessionPaths(root, header.projectId, header.id);
    try {
      return await withFileLock(indexPath, async () => {
        if (await fileExists(indexPath)) {
          return {
            ok: false,
            error: {
              kind: "conflict",
              resource: "session",
              expected: "absent",
              actual: header.id,
              recoverable: true,
              callerAction: "refresh-version-and-retry",
            },
          };
        }
        const record: SessionRecord = {
          header,
          state: "starting",
          lastSequence: 0,
          completedAt: null,
          outcome: null,
        };
        const persisted = await persistJsonObject(objects, record);
        if (!persisted.ok) {
          return persisted;
        }
        await atomicWriteFile(paths.record, `${JSON.stringify(record)}\n`);
        await atomicWriteFile(paths.events, "");
        const index: SessionIndexEntry = { sessionId: header.id, projectId: header.projectId };
        await atomicWriteFile(indexPath, `${JSON.stringify(index)}\n`);
        return { ok: true, value: record };
      });
    } catch (error) {
      return { ok: false, error: ioError("create-session", error) };
    }
  },

  async get(id) {
    const located = await locateSession(root, id);
    if (!located.ok) {
      return located;
    }
    try {
      return await withFileLock(located.value.record, async () => loadRecoveredRecord(located.value, objects));
    } catch (error) {
      return { ok: false, error: ioError("get-session", error) };
    }
  },

  async list(projectId, page) {
    const pageValidation = validatePage(page);
    if (!pageValidation.ok) {
      return pageValidation;
    }
    try {
      const directory = join(root, "session-index");
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
        if (isMissing(error)) {
          return [];
        }
        throw error;
      });
      const records: SessionRecord[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const index = parseSessionIndex(await readFile(join(directory, entry.name), "utf8"));
        if (!index.ok) {
          return index;
        }
        if (index.value.projectId !== projectId) {
          continue;
        }
        const paths = sessionPaths(root, projectId, index.value.sessionId);
        const record = await withFileLock(paths.record, async () => loadRecoveredRecord(paths, objects));
        if (!record.ok) {
          return record;
        }
        records.push(record.value);
      }
      records.sort((left, right) => left.header.id.localeCompare(right.header.id));
      const afterCursor = page.cursor === null
        ? records
        : records.filter((record) => record.header.id.localeCompare(page.cursor ?? "") > 0);
      const selected = afterCursor.slice(0, page.limit);
      const value: Page<SessionRecord> = {
        items: selected,
        nextCursor: afterCursor.length > selected.length && selected.length > 0
          ? selected[selected.length - 1]?.header.id ?? null
          : null,
      };
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: ioError("list-sessions", error) };
    }
  },

  async append(id, expectedSequence, payload, harnessId, reservedEventId) {
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
      return { ok: false, error: validationError("Expected sequence must be a non-negative integer", "expectedSequence") };
    }
    const located = await locateSession(root, id);
    if (!located.ok) {
      return located;
    }
    try {
      return await withFileLock(located.value.record, async () => {
        const recordResult = await loadRecoveredRecord(located.value, objects);
        if (!recordResult.ok) {
          return recordResult;
        }
        const current = recordResult.value;
        if (current.lastSequence !== expectedSequence) {
          return {
            ok: false,
            error: {
              kind: "conflict",
              resource: "session-event-sequence",
              expected: String(expectedSequence),
              actual: String(current.lastSequence),
              recoverable: true,
              callerAction: "refresh-version-and-retry",
            },
          };
        }
        const sequence = expectedSequence + 1;
        const event: SessionEvent = {
          id: reservedEventId ?? `event_${randomUUID()}` as EventId,
          sequence,
          at: timestampNow(),
          harnessId,
          payload,
        };
        const persisted = await persistJsonObject(objects, event);
        if (!persisted.ok) {
          return persisted;
        }
        const handle = await open(located.value.events, "a", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        const updated = applyEvent(current, event);
        const statePersisted = await persistJsonObject(objects, updated);
        if (!statePersisted.ok) {
          return statePersisted;
        }
        await atomicWriteFile(located.value.record, `${JSON.stringify(updated)}\n`);
        return { ok: true, value: event };
      });
    } catch (error) {
      return { ok: false, error: ioError("append-session-event", error) };
    }
  },

  async read(id, afterSequence, limit) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return { ok: false, error: validationError("afterSequence must be a non-negative integer", "afterSequence") };
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      return { ok: false, error: validationError("Event limit must be an integer from 1 to 10000", "limit") };
    }
    const located = await locateSession(root, id);
    if (!located.ok) {
      return located;
    }
    try {
      return await withFileLock(located.value.record, async () => {
        const parsed = await readAndRecoverEvents(located.value.events);
        if (!parsed.ok) {
          return parsed;
        }
        return {
          ok: true,
          value: parsed.value.events.filter((event) => event.sequence > afterSequence).slice(0, limit),
        };
      });
    } catch (error) {
      return { ok: false, error: ioError("read-session-events", error) };
    }
  },

  async recordArtifact(record) {
    const located = await locateSession(root, record.sessionId);
    if (!located.ok) {
      return located;
    }
    return storeArtifactRecord(root, objects, record, safeStorageKey(located.value.projectId));
  },

  async readArtifact(id, offset, limit) {
    return loadArtifactSlice(root, objects, id, offset, limit);
  },
});

type SessionPaths = {
  readonly record: string;
  readonly events: string;
  readonly projectId: ProjectId;
};

function sessionPaths(root: string, projectId: ProjectId, sessionId: SessionId): SessionPaths {
  const directory = join(root, "projects", safeStorageKey(projectId), "sessions", safeStorageKey(sessionId));
  return { record: join(directory, "session.json"), events: join(directory, "events.jsonl"), projectId };
}

function sessionIndexPath(root: string, id: SessionId): string {
  return join(root, "session-index", `${safeStorageKey(id)}.json`);
}

async function locateSession(root: string, id: SessionId): Promise<Result<SessionPaths, SessionError>> {
  const path = sessionIndexPath(root, id);
  try {
    if (!(await fileExists(path))) {
      return { ok: false, error: notFound("session", id) };
    }
    const index = parseSessionIndex(await readFile(path, "utf8"));
    return index.ok ? { ok: true, value: sessionPaths(root, index.value.projectId, id) } : index;
  } catch (error) {
    return { ok: false, error: ioError("locate-session", error) };
  }
}

async function loadRecoveredRecord(paths: SessionPaths, objects: ObjectStore): Promise<Result<SessionRecord, SessionError>> {
  try {
    if (!(await fileExists(paths.record))) {
      return { ok: false, error: notFound("session-record", paths.record) };
    }
    const parsedRecord = parseSessionRecord(await readFile(paths.record, "utf8"));
    if (!parsedRecord.ok) {
      return parsedRecord;
    }
    const parsedEvents = await readAndRecoverEvents(paths.events);
    if (!parsedEvents.ok) {
      return parsedEvents;
    }
    let recovered: SessionRecord = {
      ...parsedRecord.value,
      state: "starting",
      lastSequence: 0,
      completedAt: null,
      outcome: null,
    };
    for (const event of parsedEvents.value.events) {
      recovered = applyEvent(recovered, event);
    }
    if (JSON.stringify(recovered) !== JSON.stringify(parsedRecord.value)) {
      const persisted = await persistJsonObject(objects, recovered);
      if (!persisted.ok) {
        return persisted;
      }
      await atomicWriteFile(paths.record, `${JSON.stringify(recovered)}\n`);
    }
    return { ok: true, value: recovered };
  } catch (error) {
    return { ok: false, error: ioError("recover-session", error) };
  }
}

async function readAndRecoverEvents(path: string): Promise<Result<{ readonly events: readonly SessionEvent[] }, SessionError>> {
  try {
    if (!(await fileExists(path))) {
      await atomicWriteFile(path, "");
      return { ok: true, value: { events: [] } };
    }
    const bytes = await readFile(path);
    const events: SessionEvent[] = [];
    let cursor = 0;
    let validBytes = 0;
    while (cursor < bytes.byteLength) {
      const newline = bytes.indexOf(0x0a, cursor);
      if (newline === -1) {
        break;
      }
      const line = bytes.subarray(cursor, newline).toString("utf8");
      if (line.length === 0) {
        return { ok: false, error: protocolError("Empty complete line in session event log") };
      }
      const event = parseSessionEvent(line);
      if (!event.ok) {
        return event;
      }
      const expected = events.length + 1;
      if (event.value.sequence !== expected) {
        return { ok: false, error: protocolError(`Session event sequence ${event.value.sequence} does not follow ${expected - 1}`) };
      }
      events.push(event.value);
      validBytes = newline + 1;
      cursor = newline + 1;
    }
    if (validBytes !== bytes.byteLength) {
      const handle = await open(path, "r+");
      try {
        await handle.truncate(validBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return { ok: true, value: { events } };
  } catch (error) {
    return { ok: false, error: ioError("read-session-jsonl", error) };
  }
}

function applyEvent(record: SessionRecord, event: SessionEvent): SessionRecord {
  if (event.payload.kind === "session.completed") {
    return {
      ...record,
      state: event.payload.outcome === "succeeded" ? "completed" : event.payload.outcome,
      lastSequence: event.sequence,
      completedAt: event.at,
      outcome: event.payload.outcome,
    };
  }
  return {
    ...record,
    state: event.payload.kind === "session.started" ? "running" : record.state,
    lastSequence: event.sequence,
  };
}

function parseSessionIndex(encoded: string): Result<SessionIndexEntry, SessionError> {
  try {
    const value: unknown = JSON.parse(encoded);
    return isPlainRecord(value) && typeof value["sessionId"] === "string" && typeof value["projectId"] === "string"
      ? { ok: true, value: value as SessionIndexEntry }
      : { ok: false, error: protocolError("Stored session index is malformed") };
  } catch {
    return { ok: false, error: protocolError("Stored session index is not valid JSON") };
  }
}

function parseSessionRecord(encoded: string): Result<SessionRecord, SessionError> {
  try {
    const value: unknown = JSON.parse(encoded);
    if (!isPlainRecord(value) || !isPlainRecord(value["header"]) || typeof value["header"]["id"] !== "string"
      || typeof value["header"]["projectId"] !== "string" || typeof value["header"]["workspaceId"] !== "string"
      || typeof value["state"] !== "string" || typeof value["lastSequence"] !== "number"
      || !(value["completedAt"] === null || typeof value["completedAt"] === "string")
      || !(value["outcome"] === null || typeof value["outcome"] === "string")) {
      return { ok: false, error: protocolError("Stored session record is malformed") };
    }
    return { ok: true, value: value as SessionRecord };
  } catch {
    return { ok: false, error: protocolError("Stored session record is not valid JSON") };
  }
}

function parseSessionEvent(encoded: string): Result<SessionEvent, SessionError> {
  try {
    const value: unknown = JSON.parse(encoded);
    if (!isPlainRecord(value) || typeof value["id"] !== "string" || typeof value["sequence"] !== "number"
      || !Number.isSafeInteger(value["sequence"]) || value["sequence"] <= 0 || typeof value["at"] !== "string"
      || typeof value["harnessId"] !== "string" || !isPlainRecord(value["payload"])
      || typeof value["payload"]["kind"] !== "string" || !EVENT_KINDS.has(value["payload"]["kind"])) {
      return { ok: false, error: protocolError("Stored session event is malformed") };
    }
    return { ok: true, value: value as SessionEvent };
  } catch {
    return { ok: false, error: protocolError("Stored session event is not valid JSON") };
  }
}

function validateHeader(header: SessionHeader): Result<void, SessionError> {
  if (header.objective.trim().length === 0) {
    return { ok: false, error: validationError("Session objective must not be empty", "objective") };
  }
  if (header.eventSchemaVersion !== 1) {
    return { ok: false, error: validationError("Unsupported event schema version", "eventSchemaVersion") };
  }
  return { ok: true, value: undefined };
}

function validatePage(page: PageRequest): Result<void, SessionError> {
  return Number.isSafeInteger(page.limit) && page.limit > 0 && page.limit <= 1_000
    ? { ok: true, value: undefined }
    : { ok: false, error: validationError("Page limit must be an integer from 1 to 1000", "limit") };
}

async function persistJsonObject(objects: ObjectStore, value: SessionRecord | SessionEvent): Promise<Result<void, SessionError>> {
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  const stored = await objects.put("application/json", (async function* bytes(): AsyncIterable<Uint8Array> {
    yield encoded;
  })());
  return stored.ok ? { ok: true, value: undefined } : stored;
}

function notFound(resource: string, id: string): SessionError {
  return { kind: "not-found", resource, id, recoverable: false, callerAction: "propagate" };
}

function protocolError(message: string): SessionError {
  return { kind: "protocol-error", protocol: "session-jsonl", message, recoverable: false, callerAction: "abort" };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
