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
  it("atomically bundles every related lesson and exposes narrow applicability metadata", async () => {
    const objects = memoryObjectStore();
    const repository: Pick<HarnessRepository, "putComponent" | "putHarness"> = {
      async putComponent(component) { return { ok: true, value: component }; },
      async putHarness(harness) { return { ok: true, value: harness }; },
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
    const proposal = {
      reflection: "The correction established one procedure with a companion safety boundary.",
      decision: "evolve",
      lessons: [
        {
          sourceIds: ["turn_4", "turn_6"],
          target: "skill",
          title: "Regenerate authentication configuration",
          guidance: "Edit config/service.toml, run tools/render-config, and never edit runtime/defaults.json directly.",
          relevantPaths: ["config/service.toml", "runtime/defaults.json", "tools/render-config"],
          appliesWhen: ["Runtime authentication configuration changes"],
          doesNotApplyWhen: ["The task is documentation-only"],
        },
        {
          sourceIds: ["turn_4", "turn_6"],
          target: "policy",
          title: "Keep verification scoped",
          guidance: "Run only ./verify-auth and leave the web workspace untouched.",
          relevantPaths: ["verify-auth", "web"],
          appliesWhen: ["The authentication configuration workflow is used"],
          doesNotApplyWhen: [],
        },
      ],
    } as unknown as ReflectionProposal;

    const result = await createReflectionSkillCandidate({
      incumbent,
      proposal,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: ["artifact_evidence" as ArtifactId],
      proposalArtifactId: "artifact_reflection" as ArtifactId,
      alias: "candidate",
      createdAt: timestamp,
    }, objects, repository);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components).toHaveLength(1);
    const markdown = await storedText(objects, result.value.components[0]!.objectHash);
    expect(markdown).toContain("relevantPaths: [config/service.toml, runtime/defaults.json, tools/render-config, verify-auth, web]");
    expect(markdown).toContain('appliesWhen: ["Runtime authentication configuration changes","The authentication configuration workflow is used"]');
    expect(markdown).toContain('doesNotApplyWhen: ["The task is documentation-only"]');
    expect(markdown).toContain("## Skill guidance");
    expect(markdown).toContain("never edit runtime/defaults.json directly");
    expect(markdown).toContain("## Companion policy");
    expect(markdown).toContain("Run only ./verify-auth and leave the web workspace untouched.");
  });

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

async function storedText(objects: ObjectStore, hash: ObjectHash): Promise<string> {
  const found = await objects.get(hash);
  if (!found.ok) throw new Error(`Missing test object ${hash}`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of found.value) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
