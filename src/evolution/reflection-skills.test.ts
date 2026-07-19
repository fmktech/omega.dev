import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  ArtifactId,
  ByteCount,
  ComponentManifest,
  HarnessId,
  HarnessManifest,
  HarnessRepository,
  ObjectDescriptor,
  ObjectHash,
  ObjectStore,
  ProjectId,
  SessionId,
  Timestamp,
} from "../contracts/index.js";
import type { ReflectionProposal } from "./reflection-proposal.js";
import { createReflectionSkillCandidate } from "./reflection-skills.js";

const timestamp = "2026-07-18T00:00:00.000Z" as Timestamp;

describe("reflection skill crystallization", () => {
  it("deduplicates repeated lessons and replaces a revised skill without growing the harness", async () => {
    const objects = memoryObjectStore();
    const components: ComponentManifest[] = [];
    const harnesses: HarnessManifest[] = [];
    const repository: Pick<HarnessRepository, "putComponent" | "putHarness"> = {
      putComponent: vi.fn(async (component) => {
        components.push(component);
        return { ok: true as const, value: component };
      }),
      putHarness: vi.fn(async (harness) => {
        harnesses.push(harness);
        return { ok: true as const, value: harness };
      }),
    };
    const incumbent: HarnessManifest = {
      id: "harness_initial" as HarnessId,
      projectId: "project_reflection" as ProjectId,
      alias: "initial",
      parents: [],
      components: [],
      sourceArtifacts: [],
      createdAt: timestamp,
    };
    const proposal = skillProposal("Edit config/service.toml, regenerate, and run ./verify-auth.");
    const first = await createReflectionSkillCandidate({
      incumbent,
      proposal,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence" as ArtifactId],
      proposalArtifactId: "artifact_reflection_1" as ArtifactId,
      alias: "candidate-1",
      createdAt: timestamp,
    }, objects, repository);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const repeated = await createReflectionSkillCandidate({
      incumbent: first.value,
      proposal,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence" as ArtifactId],
      proposalArtifactId: "artifact_reflection_2" as ArtifactId,
      alias: "candidate-2",
      createdAt: timestamp,
    }, objects, repository);
    expect(repeated).toMatchObject({ ok: false, error: { kind: "validation", field: "proposal.lessons" } });
    expect(components).toHaveLength(1);
    expect(harnesses).toHaveLength(1);

    const revised = await createReflectionSkillCandidate({
      incumbent: first.value,
      proposal: skillProposal("Edit config/service.toml, run tools/render-config, then run ./verify-auth and preserve the web workspace."),
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence_2" as ArtifactId],
      proposalArtifactId: "artifact_reflection_3" as ArtifactId,
      alias: "candidate-3",
      createdAt: timestamp,
    }, objects, repository);
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.value.parents).toEqual([first.value.id]);
    expect(revised.value.components).toHaveLength(1);
    expect(revised.value.components[0]?.entrypoint).toBe("skills/regenerate-authentication-configuration/SKILL.md");
    expect(revised.value.components[0]?.id).not.toBe(first.value.components[0]?.id);
    expect(revised.value.sourceArtifacts).toEqual([
      "artifact_evidence",
      "artifact_reflection_1",
      "artifact_evidence_2",
      "artifact_reflection_3",
    ]);
  });
});

function skillProposal(guidance: string): ReflectionProposal {
  return {
    reflection: "The completed correction established a durable project procedure.",
    decision: "evolve",
    lessons: [{
      sourceIds: ["turn_4", "turn_6"],
      target: "skill",
      title: "Regenerate authentication configuration",
      guidance,
    }],
  };
}

function memoryObjectStore(): ObjectStore {
  const contents = new Map<ObjectHash, Uint8Array>();
  const descriptors = new Map<ObjectHash, ObjectDescriptor>();
  return {
    async put(mediaType, chunks) {
      const parts: Uint8Array[] = [];
      for await (const chunk of chunks) parts.push(chunk);
      const content = Buffer.concat(parts);
      const hash = createHash("sha256").update(content).digest("hex") as ObjectHash;
      const descriptor: ObjectDescriptor = {
        hash,
        size: content.byteLength as ByteCount,
        mediaType,
        createdAt: timestamp,
      };
      contents.set(hash, content);
      descriptors.set(hash, descriptor);
      return { ok: true, value: descriptor };
    },
    async get(hash) {
      const content = contents.get(hash);
      if (content === undefined) return missing(hash);
      return { ok: true, value: (async function* (): AsyncIterable<Uint8Array> { yield content; })() };
    },
    async describe(hash) {
      const descriptor = descriptors.get(hash);
      return descriptor === undefined ? missing(hash) : { ok: true, value: descriptor };
    },
  };
}

function missing(hash: ObjectHash) {
  return {
    ok: false as const,
    error: {
      kind: "not-found" as const,
      resource: "object",
      id: hash,
      recoverable: false as const,
      callerAction: "propagate" as const,
    },
  };
}
