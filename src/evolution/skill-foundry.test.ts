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
      replicatesPerHarness: 1,
      thresholds: { minimumComparablePairs: 3, minimumSuccessRateDelta: 1 / 3 },
    });
    for (const task of result.value.manifest.tasks) {
      expect(await objects.describe(task.fixtureObjectHash)).toMatchObject({ ok: true });
      expect(await objects.describe(task.environmentObjectHash)).toMatchObject({ ok: true });
    }
    for (const task of result.value.privateTasks) {
      expect(await objects.describe(task.verifierObjectHash)).toMatchObject({ ok: true });
      expect(await objects.describe(task.negativeInvariantObjectHash)).toMatchObject({ ok: true });
    }
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
    invariants: variation === "negative-control"
      ? [{ path: "config/service.toml", equals: "timeout = 30\nlockout = 5\n" }]
      : [{ path: "docs/auth.md", equals: "# Authentication\n" }],
  };
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
