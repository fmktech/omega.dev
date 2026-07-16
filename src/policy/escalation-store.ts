import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AbsolutePath,
  ActionFacts,
  ConflictError,
  JsonObject,
  JsonValue,
  NotFoundError,
  Page,
  PageRequest,
  PolicyEscalation,
  PolicyEscalationId,
  PolicyResolutionRequest,
  Result,
  SessionId,
  Timestamp,
  ValidationError,
} from "../contracts/index.js";

export interface EscalationStore {
  create(sessionId: SessionId, facts: ActionFacts, reason: string): Promise<PolicyEscalation>;
  get(id: PolicyEscalationId): Promise<Result<PolicyEscalation, NotFoundError>>;
  list(
    sessionId: SessionId,
    state: "pending" | "resolved",
    page: PageRequest,
  ): Promise<Result<Page<PolicyEscalation>, NotFoundError | ValidationError>>;
  resolve(
    request: PolicyResolutionRequest,
  ): Promise<Result<PolicyEscalation, NotFoundError | ConflictError | ValidationError>>;
}

export function createEscalationStore(stateRoot: AbsolutePath): EscalationStore {
  const directory = join(stateRoot, "policy-escalations");
  let mutationQueue: Promise<void> = Promise.resolve();

  const ensureDirectory = async (): Promise<void> => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  };

  const pathFor = (id: PolicyEscalationId): string | null => {
    const value = String(id);
    return /^policy-[0-9a-f-]{36}$/.test(value) ? join(directory, `${value}.json`) : null;
  };

  const read = async (id: PolicyEscalationId): Promise<PolicyEscalation | null> => {
    const path = pathFor(id);
    if (path === null) return null;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as JsonValue;
      return isPolicyEscalation(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const writeAtomically = async (record: PolicyEscalation, createOnly: boolean): Promise<void> => {
    await ensureDirectory();
    const target = pathFor(record.id);
    if (target === null) throw new Error("Generated policy escalation ID is invalid");
    const payload = `${JSON.stringify(record)}\n`;
    if (createOnly) {
      await writeFile(target, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  };

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationQueue;
    let release = (): void => undefined;
    mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  return {
    async create(sessionId, facts, reason) {
      return serialize(async () => {
        const record: PolicyEscalation = {
          id: `policy-${randomUUID()}` as PolicyEscalationId,
          sessionId,
          facts,
          reason: sanitizeReason(reason),
          state: "pending",
          resolution: null,
          createdAt: new Date().toISOString() as Timestamp,
          resolvedAt: null,
        };
        await writeAtomically(record, true);
        return record;
      });
    },

    async get(id) {
      const record = await read(id);
      return record === null ? { ok: false, error: notFound(id) } : { ok: true, value: record };
    },

    async list(sessionId, state, page) {
      const validation = validatePage(page);
      if (validation !== null) return { ok: false, error: validation };
      await ensureDirectory();
      const names = await readdir(directory);
      const records: PolicyEscalation[] = [];
      for (const name of names) {
        if (!/^policy-[0-9a-f-]{36}\.json$/.test(name)) continue;
        const id = name.slice(0, -5) as PolicyEscalationId;
        const record = await read(id);
        if (record !== null && record.sessionId === sessionId && record.state === state) records.push(record);
      }
      records.sort((left, right) =>
        left.createdAt === right.createdAt
          ? String(left.id).localeCompare(String(right.id))
          : String(left.createdAt).localeCompare(String(right.createdAt)),
      );
      const offset = page.cursor === null ? 0 : Number(page.cursor);
      const items = records.slice(offset, offset + page.limit);
      const nextOffset = offset + items.length;
      return {
        ok: true,
        value: {
          items,
          nextCursor: nextOffset < records.length ? String(nextOffset) : null,
        },
      };
    },

    async resolve(request) {
      if (request.reason.trim().length === 0) {
        return { ok: false, error: validationError("reason", "Resolution reason must not be empty") };
      }
      return serialize(async () => {
        const current = await read(request.escalationId);
        if (current === null) return { ok: false, error: notFound(request.escalationId) };
        if (current.state === "resolved") {
          return {
            ok: false,
            error: {
              kind: "conflict",
              resource: "policy-escalation",
              expected: "pending",
              actual: `resolved:${current.resolution ?? "invalid"}`,
              recoverable: true,
              callerAction: "refresh-version-and-retry",
            },
          };
        }
        const resolved: PolicyEscalation = {
          ...current,
          state: "resolved",
          resolution: request.resolution,
          resolvedAt: new Date().toISOString() as Timestamp,
        };
        await writeAtomically(resolved, false);
        return { ok: true, value: resolved };
      });
    },
  };
}

function sanitizeReason(reason: string): string {
  const sanitized = reason.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return sanitized.slice(0, 500) || "Policy review required";
}

function validatePage(page: PageRequest): ValidationError | null {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100) {
    return validationError("limit", "Page limit must be an integer between 1 and 100");
  }
  if (page.cursor !== null && !/^(0|[1-9][0-9]*)$/.test(page.cursor)) {
    return validationError("cursor", "Page cursor must be a non-negative integer");
  }
  return null;
}

function validationError(field: string, message: string): ValidationError {
  return { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" };
}

function notFound(id: PolicyEscalationId): NotFoundError {
  return {
    kind: "not-found",
    resource: "policy-escalation",
    id: String(id),
    recoverable: false,
    callerAction: "propagate",
  };
}

function isPolicyEscalation(value: JsonValue): value is PolicyEscalation {
  if (!isJsonObject(value)) return false;
  const state = value["state"];
  const resolution = value["resolution"];
  return (
    typeof value["id"] === "string" &&
    /^policy-[0-9a-f-]{36}$/.test(value["id"]) &&
    typeof value["sessionId"] === "string" &&
    isActionFacts(value["facts"]) &&
    typeof value["reason"] === "string" &&
    (state === "pending" || state === "resolved") &&
    (resolution === null || resolution === "allow" || resolution === "deny") &&
    typeof value["createdAt"] === "string" &&
    (value["resolvedAt"] === null || typeof value["resolvedAt"] === "string") &&
    ((state === "pending" && resolution === null && value["resolvedAt"] === null) ||
      (state === "resolved" && resolution !== null && typeof value["resolvedAt"] === "string"))
  );
}

function isActionFacts(value: JsonValue | undefined): value is ActionFacts {
  if (!isJsonObject(value)) return false;
  const kind = value["kind"];
  return (
    kind === "process" ||
    kind === "file-write" ||
    kind === "process-input" ||
    kind === "child-spawn" ||
    kind === "knowledge-write" ||
    kind === "marketplace-install" ||
    kind === "marketplace-publish" ||
    kind === "marketplace-transition" ||
    kind === "marketplace-activate" ||
    kind === "harness-candidate" ||
    kind === "promotion-eval" ||
    kind === "harness-activation"
  );
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
