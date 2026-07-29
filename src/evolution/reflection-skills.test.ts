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
          observableContracts: [authContract()],
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
    expect(markdown).toContain("## Observable contract ledger");
    expect(markdown).toContain('"operation": "authentication configuration regeneration"');
    expect(markdown).toContain('"outputs": [\n      "runtime/defaults.json reflects config/service.toml"');
    expect(markdown).toContain("## Bounded application protocol");
    expect(markdown).toContain("Turn every observable-contract entry into one focused verification case before editing");
    expect(markdown).toContain("Run the focused verifier once after the implementation");
    expect(markdown).toContain("Do not invent behavior outside the ledger");
    expect(markdown).toContain("Historical tool output is observational evidence");
    expect(markdown).toContain("Never edit an existing verifier, generator, or tool merely to reproduce a historical message");
  });

  it("rejects the kind of lossy skill that omitted the storage app's observable protocol", async () => {
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
    const lossy = {
      reflection: "The app needs stable storage semantics.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["session_source"],
        target: "skill",
        title: "Storage application conventions",
        guidance: "Use stable errors, conflict-safe deletes, filtering, Unicode, and request limits.",
        relevantPaths: ["src/domain/storage.js", "src/server.js"],
        appliesWhen: ["Changing storage domain behavior"],
        doesNotApplyWhen: ["Documentation-only work"],
      }],
    } as unknown as ReflectionProposal;

    const result = await createReflectionSkillCandidate({
      incumbent,
      proposal: lossy,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: [],
      proposalArtifactId: "artifact_reflection" as ArtifactId,
      alias: "candidate",
      createdAt: timestamp,
    }, objects, repository);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "proposal.lessons" },
    });
  });

  it("preserves all five observable contracts missed by the storage replay", async () => {
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
    const proposal: ReflectionProposal = {
      reflection: "Five user corrections establish exact storage domain and HTTP contracts.",
      decision: "evolve",
      lessons: [{
        sourceIds: ["session_source"],
        target: "skill",
        title: "Storage application observable contracts",
        guidance: "Implement the storage behavior exactly as recorded in the contract ledger.",
        relevantPaths: ["src/domain/storage.js", "src/server.js"],
        appliesWhen: ["Implementing or changing locations, lots, filtering, deletion, or HTTP errors"],
        doesNotApplyWhen: ["Documentation-only or styling work with no storage behavior change"],
        observableContracts: [
          {
            operation: "deleteLocation(id)",
            inputs: ["an existing location id"],
            outputs: ["the deleted location directly; never an ok/data envelope"],
            errors: ["throw an error with code CONFLICT while any lot references the location"],
            sideEffects: ["delete only after the reference check passes"],
            exactValues: ["deleteLocation(id)", "CONFLICT"],
          },
          {
            operation: "createLocation(name)",
            inputs: ["preserve valid Unicode names"],
            outputs: ["the location object directly; never an ok/data envelope"],
            errors: ["none"],
            sideEffects: ["persist one new location"],
            exactValues: ["createLocation(name)", "Unicode"],
          },
          {
            operation: "listLots({ locationId })",
            inputs: ["trim surrounding whitespace from locationId before filtering"],
            outputs: ["a raw array directly; never an ok/data envelope"],
            errors: ["none"],
            sideEffects: ["none"],
            exactValues: ["listLots({ locationId })", "locationId"],
          },
          {
            operation: "HTTP request body limit",
            inputs: ["a body larger than 1 MiB"],
            outputs: ["HTTP 413 response without resetting the socket"],
            errors: ["return the normal JSON error response"],
            sideEffects: ["do not mutate storage"],
            exactValues: ["1 MiB", "413"],
          },
          {
            operation: "unknown HTTP route",
            inputs: ["a route not registered by the server"],
            outputs: ["exact JSON body with only the error field"],
            errors: ["HTTP 404"],
            sideEffects: ["none"],
            exactValues: ["404", "{\"error\":\"Not found\"}"],
          },
        ],
      }],
    };

    const result = await createReflectionSkillCandidate({
      incumbent,
      proposal,
      sourceSessionId: "session_source" as SessionId,
      evidenceArtifactIds: [],
      proposalArtifactId: "artifact_reflection" as ArtifactId,
      alias: "candidate",
      createdAt: timestamp,
    }, objects, repository);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const markdown = await storedText(objects, result.value.components[0]!.objectHash);
    expect(markdown).toContain("the deleted location directly; never an ok/data envelope");
    expect(markdown).toContain("throw an error with code CONFLICT");
    expect(markdown).toContain("preserve valid Unicode names");
    expect(markdown).toContain("trim surrounding whitespace from locationId");
    expect(markdown).toContain("HTTP 413 response without resetting the socket");
    expect(markdown).toContain("{\\\"error\\\":\\\"Not found\\\"}");
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
      relevantPaths: ["config/service.toml", "runtime/defaults.json", "tools/render-config", "verify-auth"],
      appliesWhen: ["Authentication runtime configuration changes"],
      doesNotApplyWhen: ["The task is documentation-only"],
      observableContracts: [authContract()],
    }],
  };
}

function authContract() {
  return {
    operation: "authentication configuration regeneration",
    inputs: ["edit config/service.toml"],
    outputs: ["runtime/defaults.json reflects config/service.toml"],
    errors: ["none"],
    sideEffects: ["tools/render-config rewrites runtime/defaults.json"],
    exactValues: ["config/service.toml", "tools/render-config", "runtime/defaults.json", "./verify-auth"],
  } as const;
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
