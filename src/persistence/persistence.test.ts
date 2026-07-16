import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AbsolutePath,
  ArtifactId,
  ArtifactRecord,
  ByteCount,
  CredentialEnvName,
  DurationMs,
  EventId,
  HarnessId,
  ObjectStore,
  ProjectId,
  SessionHeader,
  SessionId,
  ThreadId,
  Timestamp,
  TokenCount,
  UsdMicros,
  WorkspaceId,
} from "../contracts/index.js";
import { safeStorageKey } from "./artifact-store.js";
import { createFileObjectStore } from "./object-store.js";
import { createFileProjectRepository } from "./project-repository.js";
import { createFileSessionRepository } from "./session-repository.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env["TEST_OMEGA_SECRET"];
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe("filesystem persistence", () => {
  it("stores immutable SHA-256 objects idempotently and detects later corruption", async () => {
    const root = await temporaryRoot();
    const objects = createFileObjectStore(root as AbsolutePath);
    const first = await putText(objects, "the same bytes");
    const duplicate = await putText(objects, "the same bytes");

    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    if (!first.ok || !duplicate.ok) {
      return;
    }
    expect(duplicate.value).toEqual(first.value);
    expect(first.value.hash).toBe(createHash("sha256").update("the same bytes").digest("hex"));

    const dataPath = join(root, "objects", "sha256", first.value.hash.slice(0, 2), `${first.value.hash}.data`);
    await writeFile(dataPath, "corrupted", "utf8");
    const corrupt = await objects.get(first.value.hash);
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) {
      expect(corrupt.error.kind).toBe("integrity-failure");
    }
  });

  it("returns typed not-found and validation failures for object lookups", async () => {
    const root = await temporaryRoot();
    const objects = createFileObjectStore(root as AbsolutePath);
    const malformed = await objects.describe("../escape" as never);
    const missing = await objects.describe("a".repeat(64) as never);

    expect(malformed.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!malformed.ok && !missing.ok) {
      expect(malformed.error.kind).toBe("validation");
      expect(missing.error.kind).toBe("not-found");
    }
  });

  it("registers project/workspace state, paginates, and compare-and-sets the active harness", async () => {
    const root = await temporaryRoot();
    const objects = createFileObjectStore(root as AbsolutePath);
    const projects = createFileProjectRepository(root as AbsolutePath, objects);
    const workspacePaths = await Promise.all(["alpha", "beta", "gamma"].map(async (name) => {
      const path = join(root, "workspaces", name);
      await mkdir(path, { recursive: true });
      return path;
    }));
    const registrations = await Promise.all(workspacePaths.map(async (path) => projects.registerWorkspace(path as AbsolutePath)));
    expect(registrations.every((registration) => registration.ok)).toBe(true);

    const firstPage = await projects.listProjects({ cursor: null, limit: 2 });
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok || firstPage.value.nextCursor === null) {
      return;
    }
    expect(firstPage.value.items).toHaveLength(2);
    const finalPage = await projects.listProjects({ cursor: firstPage.value.nextCursor, limit: 2 });
    expect(finalPage.ok).toBe(true);
    if (!finalPage.ok || !registrations[0]?.ok) {
      return;
    }
    expect(finalPage.value.items).toHaveLength(1);
    expect(finalPage.value.nextCursor).toBeNull();

    const firstRegistration = registrations[0];
    if (firstRegistration === undefined || !firstRegistration.ok) {
      return;
    }
    const projectId = firstRegistration.value.project.id;
    const harness = "harness_one" as HarnessId;
    const activated = await projects.compareAndSetActiveHarness(projectId, null, harness);
    const stale = await projects.compareAndSetActiveHarness(projectId, null, "harness_two" as HarnessId);
    expect(activated.ok).toBe(true);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.kind).toBe("conflict");
    }
  });

  it("maps a Git worktree and its primary checkout to one logical project", async () => {
    const base = await temporaryRoot();
    const repository = join(base, "repository");
    const worktree = join(base, "secondary");
    await mkdir(repository);
    git(repository, ["init", "-b", "main"]);
    await writeFile(join(repository, "README.md"), "omega\n", "utf8");
    git(repository, ["add", "README.md"]);
    git(repository, ["-c", "user.name=Omega Test", "-c", "user.email=omega@example.test", "commit", "-m", "initial"]);
    git(repository, ["remote", "add", "origin", "git@github.com:fmktech/example.git"]);
    git(repository, ["worktree", "add", "-b", "secondary", worktree]);

    const stateRoot = join(base, "state");
    const objects = createFileObjectStore(stateRoot as AbsolutePath);
    const projects = createFileProjectRepository(stateRoot as AbsolutePath, objects);
    const primary = await projects.registerWorkspace(repository as AbsolutePath);
    const secondary = await projects.registerWorkspace(worktree as AbsolutePath);

    expect(primary.ok).toBe(true);
    expect(secondary.ok).toBe(true);
    if (primary.ok && secondary.ok) {
      expect(secondary.value.project.id).toBe(primary.value.project.id);
      expect(secondary.value.workspace.id).not.toBe(primary.value.workspace.id);
      expect(primary.value.project.repository.canonicalRemote).toBe("github.com/fmktech/example");
    }
  });

  it("serializes concurrent event appends with a typed sequence conflict", async () => {
    const fixture = await sessionFixture();
    const attempts = await Promise.all([
      fixture.sessions.append(fixture.header.id, 0, { kind: "session.started" }, fixture.header.initialHarnessId, null),
      fixture.sessions.append(fixture.header.id, 0, { kind: "session.started" }, fixture.header.initialHarnessId, null),
    ]);

    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
    const rejected = attempts.find((attempt) => !attempt.ok);
    expect(rejected?.ok).toBe(false);
    if (rejected !== undefined && !rejected.ok) {
      expect(rejected.error.kind).toBe("conflict");
    }
    const events = await fixture.sessions.read(fixture.header.id, 0, 10);
    expect(events.ok).toBe(true);
    if (events.ok) {
      expect(events.value.map((event) => event.sequence)).toEqual([1]);
    }
  });

  it("drops only a trailing partial JSONL record and preserves valid history", async () => {
    const fixture = await sessionFixture();
    const reserved = "event_reserved_by_parent" as EventId;
    const appended = await fixture.sessions.append(
      fixture.header.id,
      0,
      { kind: "session.started" },
      fixture.header.initialHarnessId,
      reserved,
    );
    expect(appended.ok && appended.value.id === reserved).toBe(true);
    const eventsPath = join(
      fixture.root,
      "projects",
      safeStorageKey(fixture.header.projectId),
      "sessions",
      safeStorageKey(fixture.header.id),
      "events.jsonl",
    );
    const before = await stat(eventsPath);
    const handle = await import("node:fs/promises").then(({ open }) => open(eventsPath, "a"));
    await handle.writeFile('{"id":"partial"', "utf8");
    await handle.close();

    const recovered = await fixture.sessions.read(fixture.header.id, 0, 10);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value).toHaveLength(1);
    }
    expect((await stat(eventsPath)).size).toBe(before.size);
  });

  it("records artifacts and returns exact UTF-8 and binary-safe byte ranges", async () => {
    const fixture = await sessionFixture();
    const stored = await putBytes(fixture.objects, Buffer.from([0x41, 0xff, 0x42, 0x43]));
    expect(stored.ok).toBe(true);
    if (!stored.ok) {
      return;
    }
    const artifact: ArtifactRecord = {
      id: "artifact_binary" as ArtifactId,
      kind: "diagnostic",
      object: stored.value,
      sessionId: fixture.header.id,
      createdAt: now(),
      metadata: {},
    };
    const recorded = await fixture.sessions.recordArtifact(artifact);
    expect(recorded.ok).toBe(true);

    const first = await fixture.sessions.readArtifact(artifact.id, 0 as ByteCount, 1 as ByteCount);
    const binary = await fixture.sessions.readArtifact(artifact.id, 1 as ByteCount, 2 as ByteCount);
    const end = await fixture.sessions.readArtifact(artifact.id, 4 as ByteCount, 10 as ByteCount);
    expect(first.ok && first.value.data === "A" && !first.value.complete).toBe(true);
    expect(binary.ok && binary.value.encoding === "base64" && binary.value.data === "/0I=").toBe(true);
    expect(end.ok && end.value.data === "" && end.value.complete).toBe(true);
  });

  it("persists credential names but never reads or stores credential values", async () => {
    const secretValue = "must-not-appear-on-disk";
    process.env["TEST_OMEGA_SECRET"] = secretValue;
    const fixture = await sessionFixture(["TEST_OMEGA_SECRET" as CredentialEnvName]);
    await fixture.sessions.append(fixture.header.id, 0, { kind: "session.started" }, fixture.header.initialHarnessId, null);
    const recordPath = join(
      fixture.root,
      "projects",
      safeStorageKey(fixture.header.projectId),
      "sessions",
      safeStorageKey(fixture.header.id),
      "session.json",
    );
    const record = await readFile(recordPath, "utf8");
    expect(record).toContain("TEST_OMEGA_SECRET");
    expect(record).not.toContain(secretValue);
    delete process.env["TEST_OMEGA_SECRET"];
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omega-persistence-"));
  roots.push(root);
  return root;
}

async function putText(objects: ObjectStore, value: string) {
  return putBytes(objects, Buffer.from(value, "utf8"));
}

async function putBytes(objects: ObjectStore, value: Uint8Array) {
  return objects.put("application/octet-stream", (async function* chunks(): AsyncIterable<Uint8Array> {
    yield value;
  })());
}

async function sessionFixture(credentialEnvNames: readonly CredentialEnvName[] = []) {
  const root = await temporaryRoot();
  const objects = createFileObjectStore(root as AbsolutePath);
  const sessions = createFileSessionRepository(root as AbsolutePath, objects);
  const header = makeHeader(credentialEnvNames);
  const created = await sessions.create(header);
  if (!created.ok) {
    throw new Error(`Failed to create test session: ${created.error.kind}`);
  }
  return { root, objects, sessions, header };
}

function makeHeader(credentialEnvNames: readonly CredentialEnvName[]): SessionHeader {
  const at = now();
  return {
    id: "session_test" as SessionId,
    threadId: "thread_test" as ThreadId,
    parentSessionId: null,
    continuation: null,
    projectId: "project_test" as ProjectId,
    workspaceId: "workspace_test" as WorkspaceId,
    role: "main",
    objective: "Verify persistence",
    initialHarnessId: "harness_test" as HarnessId,
    initialModelRoutes: [],
    policyProfile: "guarded",
    capabilityEnvelope: {
      grants: [],
      modelRoles: [],
      maxCostUsdMicros: 0 as UsdMicros,
      maxModelCalls: 0,
      maxProcessStarts: 0,
      maxInputTokens: 0 as TokenCount,
      maxOutputTokens: 0 as TokenCount,
      wallTimeMs: 1_000 as DurationMs,
      createdAt: at,
    },
    credentialEnvNames,
    eventSchemaVersion: 1,
    createdAt: at,
  };
}

function now(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}
