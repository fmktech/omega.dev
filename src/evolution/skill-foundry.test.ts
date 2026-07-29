import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  ArtifactId,
  ByteCount,
  ObjectDescriptor,
  ObjectHash,
  ObjectStore,
  ProjectId,
  SessionId,
  Timestamp,
} from "../contracts/index.js";
import { compileSkillEvalSuite } from "./skill-foundry.js";

const NOW = "2026-07-19T12:00:00.000Z" as Timestamp;

describe("skill foundry synthetic suite", () => {
  it("freezes exactly near-transfer, generalization, and negative-control workspace fixtures", async () => {
    const objects = memoryObjectStore();
    const result = await compileSkillEvalSuite(JSON.stringify({
      fixtures: [
        fixture("near-transfer", "Change the auth timeout to 45."),
        fixture("generalization", "Change the auth lockout threshold to 7."),
        fixture("negative-control", "Add an authentication troubleshooting note."),
      ],
    }), {
      projectId: "project_foundry" as ProjectId,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence" as ArtifactId],
      proposalArtifactId: "artifact_suite_proposal" as ArtifactId,
      budget: benchmarkBudget(),
      createdAt: NOW,
    }, objects);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.tasks).toHaveLength(3);
    expect(result.value.privateTasks.map((task) => task.variation)).toEqual([
      "near-transfer",
      "generalization",
      "negative-control",
    ]);
    expect(result.value.privateTasks.map((task) => task.skillUseExpectation)).toEqual([
      "required",
      "required",
      "forbidden",
    ]);
    expect(JSON.stringify(result.value.manifest.tasks)).not.toContain("checks");
    expect(JSON.stringify(result.value.manifest.tasks)).not.toContain("skillUseExpectation");
    expect(result.value.manifest.promotionPolicy).toMatchObject({
      replicatesPerHarness: 3,
      thresholds: { minimumComparablePairs: 9, minimumSuccessRateDelta: 0 },
    });
    for (const task of result.value.manifest.tasks) {
      expect(await objects.describe(task.fixtureObjectHash)).toMatchObject({ ok: true });
      expect(await objects.describe(task.environmentObjectHash)).toMatchObject({ ok: true });
    }
    for (const task of result.value.privateTasks) {
      expect(await objects.describe(task.verifierObjectHash)).toMatchObject({ ok: true });
      expect(await objects.describe(task.negativeInvariantObjectHash)).toMatchObject({ ok: true });
      expect(await storedJson(objects, task.verifierObjectHash)).toMatchObject({
        executable: {
          files: { "verify.mjs": expect.stringContaining("node:assert/strict") },
          command: { executable: "node", args: ["verify.mjs"] },
        },
      });
    }
  });

  it("rejects source-only proxy checks without an executable behavioral verifier", async () => {
    const withoutVerifier = fixture("near-transfer", "Change the auth timeout to 45.");
    const { verifier: _verifier, ...sourceOnly } = withoutVerifier;
    const result = await compileSkillEvalSuite(JSON.stringify({ fixtures: [
      sourceOnly,
      fixture("generalization", "Change the auth lockout threshold to 7."),
      fixture("negative-control", "Add an authentication troubleshooting note."),
    ] }), {
      projectId: "project_foundry" as ProjectId,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence" as ArtifactId],
      proposalArtifactId: "artifact_suite_proposal" as ArtifactId,
      budget: benchmarkBudget(),
      createdAt: NOW,
    }, memoryObjectStore());

    expect(result).toMatchObject({ ok: false, error: { kind: "validation", field: "fixtures.0.verifier" } });
  });

  it("rejects a suite without one isolated negative control", async () => {
    const result = await compileSkillEvalSuite(JSON.stringify({
      fixtures: [
        fixture("near-transfer", "First positive."),
        fixture("generalization", "Second positive."),
        fixture("generalization", "Duplicate variation."),
      ],
    }), {
      projectId: "project_foundry" as ProjectId,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence" as ArtifactId],
      proposalArtifactId: "artifact_suite_proposal" as ArtifactId,
      budget: benchmarkBudget(),
      createdAt: NOW,
    }, memoryObjectStore());

    expect(result).toMatchObject({ ok: false, error: { kind: "validation", field: "fixtures.variation" } });
  });

  it("does not let a static source sentinel veto an executable behavioral verifier", async () => {
    const solvedNearTransfer = {
      ...fixture("near-transfer", "Change the auth timeout to 45."),
      files: {
        "config/service.toml": "timeout = 45\nlockout = 5\n",
        "docs/auth.md": "# Authentication\n",
      },
    };
    const result = await compileSkillEvalSuite(JSON.stringify({
      fixtures: [
        solvedNearTransfer,
        fixture("generalization", "Change the auth lockout threshold to 7."),
        fixture("negative-control", "Add an authentication troubleshooting note."),
      ],
    }), {
      projectId: "project_foundry" as ProjectId,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence" as ArtifactId],
      proposalArtifactId: "artifact_suite_proposal" as ArtifactId,
      budget: benchmarkBudget(),
      createdAt: NOW,
    }, memoryObjectStore());

    expect(result.ok).toBe(true);
  });

  it("accepts mixed static diagnostics because they are not the capability oracle", async () => {
    const partiallySolved = {
      ...fixture("near-transfer", "Change the auth timeout to 45."),
      checks: [
        { path: "config/service.toml", contains: "timeout = 30" },
        { path: "config/service.toml", contains: "timeout = 45" },
      ],
    };
    const result = await compileSkillEvalSuite(JSON.stringify({ fixtures: [
      partiallySolved,
      fixture("generalization", "Change the auth lockout threshold to 7."),
      fixture("negative-control", "Add an authentication troubleshooting note."),
    ] }), {
      projectId: "project_foundry" as ProjectId,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence" as ArtifactId],
      proposalArtifactId: "artifact_suite_proposal" as ArtifactId,
      budget: benchmarkBudget(),
      createdAt: NOW,
    }, memoryObjectStore());

    expect(result.ok).toBe(true);
  });

  it("rejects a fixture whose starting files already violate a negative invariant", async () => {
    const invalidBaseline = {
      ...fixture("near-transfer", "Change the auth timeout to 45."),
      files: {
        "config/service.toml": "timeout = 30\nlockout = 5\n",
        "docs/auth.md": "changed before the task\n",
      },
    };
    const result = await compileSkillEvalSuite(JSON.stringify({
      fixtures: [
        invalidBaseline,
        fixture("generalization", "Change the auth lockout threshold to 7."),
        fixture("negative-control", "Add an authentication troubleshooting note."),
      ],
    }), {
      projectId: "project_foundry" as ProjectId,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence" as ArtifactId],
      proposalArtifactId: "artifact_suite_proposal" as ArtifactId,
      budget: benchmarkBudget(),
      createdAt: NOW,
    }, memoryObjectStore());

    expect(result).toMatchObject({ ok: false, error: { kind: "validation", field: "fixtures.0.invariants" } });
  });

  it("rejects a no-mutation verifier that hardcodes a collection length", async () => {
    const unsafe = fixture("near-transfer", "Reject deleting a referenced location without mutating storage.");
    unsafe.verifier.files["verify.mjs"] = [
      'import assert from "node:assert/strict";',
      "const store = { locations: [{ id: 'a' }, { id: 'b' }] };",
      "assert.strictEqual(store.locations.length, 1, 'Should not have deleted');",
    ].join("\n");
    const result = await compileSkillEvalSuite(JSON.stringify({ fixtures: [
      unsafe,
      fixture("generalization", "Change the auth lockout threshold to 7."),
      fixture("negative-control", "Add an authentication troubleshooting note."),
    ] }), {
      projectId: "project_foundry" as ProjectId,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence" as ArtifactId],
      proposalArtifactId: "artifact_suite_proposal" as ArtifactId,
      budget: benchmarkBudget(),
      createdAt: NOW,
    }, memoryObjectStore());

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "fixtures.0.verifier.files.verify.mjs" },
    });
  });

  it("accepts a no-mutation verifier that compares against a before-state snapshot", async () => {
    const safe = fixture("near-transfer", "Reject deleting a referenced location without mutating storage.");
    safe.verifier.files["verify.mjs"] = [
      'import assert from "node:assert/strict";',
      "const store = { locations: [{ id: 'a' }, { id: 'b' }] };",
      "const beforeLocations = structuredClone(store.locations);",
      "assert.deepStrictEqual(store.locations, beforeLocations, 'Should not have deleted');",
    ].join("\n");
    const result = await compileSkillEvalSuite(JSON.stringify({ fixtures: [
      safe,
      fixture("generalization", "Change the auth lockout threshold to 7."),
      fixture("negative-control", "Add an authentication troubleshooting note."),
    ] }), {
      projectId: "project_foundry" as ProjectId,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence" as ArtifactId],
      proposalArtifactId: "artifact_suite_proposal" as ArtifactId,
      budget: benchmarkBudget(),
      createdAt: NOW,
    }, memoryObjectStore());

    expect(result.ok).toBe(true);
  });
});

function fixture(variation: "near-transfer" | "generalization" | "negative-control", objective: string) {
  return {
    variation,
    title: `${variation} fixture`,
    objective,
    files: {
      "config/service.toml": "timeout = 30\nlockout = 5\n",
      "docs/auth.md": "# Authentication\n",
      "verify-auth": "#!/bin/sh\nexit 0\n",
    },
    checks: variation === "negative-control"
      ? [{ path: "docs/auth.md", contains: "troubleshooting" }]
      : [{ path: "config/service.toml", contains: variation === "near-transfer" ? "45" : "7" }],
    verifier: {
      files: {
        "verify.mjs": `import assert from "node:assert/strict";\nassert.ok(true, ${JSON.stringify(variation)});\n`,
      },
      command: { executable: "node", args: ["verify.mjs"] },
    },
    invariants: variation === "negative-control"
      ? [{ path: "config/service.toml", absent: "secret_override" }]
      : [{ path: "docs/auth.md", equals: "# Authentication\n" }],
  };
}

async function storedJson(objects: ObjectStore, hash: ObjectHash): Promise<unknown> {
  const found = await objects.get(hash);
  expect(found.ok).toBe(true);
  if (!found.ok) return null;
  const parts: Uint8Array[] = [];
  for await (const part of found.value) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

function benchmarkBudget() {
  return {
    wallTimeMs: 300_000 as import("../contracts/index.js").DurationMs,
    maxModelCalls: 24,
    maxInputTokens: 160_000 as import("../contracts/index.js").TokenCount,
    maxOutputTokens: 32_000 as import("../contracts/index.js").TokenCount,
    maxCostUsdMicros: 0 as import("../contracts/index.js").UsdMicros,
    maxProcessStarts: 24,
  };
}

function memoryObjectStore(): ObjectStore {
  const values = new Map<ObjectHash, Uint8Array>();
  const descriptors = new Map<ObjectHash, ObjectDescriptor>();
  return {
    async put(mediaType, chunks) {
      const parts: Uint8Array[] = [];
      for await (const chunk of chunks) parts.push(chunk);
      const bytes = Buffer.concat(parts);
      const hash = createHash("sha256").update(bytes).digest("hex") as ObjectHash;
      const descriptor: ObjectDescriptor = { hash, size: bytes.byteLength as ByteCount, mediaType, createdAt: NOW };
      values.set(hash, bytes);
      descriptors.set(hash, descriptor);
      return { ok: true, value: descriptor };
    },
    async get(hash) {
      const bytes = values.get(hash);
      return bytes === undefined
        ? { ok: false, error: { kind: "not-found", resource: "object", id: hash, recoverable: false, callerAction: "propagate" } }
        : { ok: true, value: (async function* (): AsyncIterable<Uint8Array> { yield bytes; })() };
    },
    async describe(hash) {
      const descriptor = descriptors.get(hash);
      return descriptor === undefined
        ? { ok: false, error: { kind: "not-found", resource: "object", id: hash, recoverable: false, callerAction: "propagate" } }
        : { ok: true, value: descriptor };
    },
  };
}
