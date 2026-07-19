import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AbsolutePath,
  ByteCount,
  ComponentId,
  HarnessId,
  HarnessManifest,
  HarnessRepository,
  KnowledgeDocumentId,
  KnowledgeService,
  ObjectHash,
  ObjectStore,
  ProjectId,
  RelativePath,
  Timestamp,
  WorkspaceId,
  WorkspaceRecord,
} from "../contracts/index.js";
import { createContextService } from "./context-service.js";

const roots: string[] = [];
const NOW = "2026-07-18T00:00:00.000Z" as Timestamp;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("project context service", () => {
  it("bootstraps root-to-nested AGENTS instructions plus compact knowledge and skill catalogs", async () => {
    const root = await mkdtemp(join(tmpdir(), "omega-context-"));
    roots.push(root);
    await mkdir(join(root, "packages", "api"), { recursive: true });
    await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root instruction\n", "utf8");
    await writeFile(join(root, "packages", "AGENTS.md"), "packages instruction\n", "utf8");
    await writeFile(join(root, "packages", "api", "AGENTS.md"), "api instruction\n", "utf8");
    await writeFile(join(root, "node_modules", "ignored", "AGENTS.md"), "must not load\n", "utf8");

    const skillMarkdown = [
      "---",
      "name: api-client-release",
      "description: Prepare and verify the api-client release artifact.",
      "tags: [release, api-client]",
      "relevantPaths: [packages/api-client]",
      'appliesWhen: ["The api-client release artifact changes, not docs"]',
      'doesNotApplyWhen: ["The task only changes API documentation"]',
      "---",
      "",
      "# API client release",
      "",
      "Run the scoped release preparation sequence.",
    ].join("\n");
    const fixture = contextFixture(root, skillMarkdown);
    const service = createContextService({
      objects: fixture.objects,
      knowledge: fixture.knowledge,
      harnesses: fixture.harnesses,
    });

    const result = await service.bootstrap(fixture.workspace, fixture.harness);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instructions.map((instruction) => ({ path: instruction.path, scope: instruction.scope, content: instruction.content }))).toEqual([
      { path: "AGENTS.md", scope: ".", content: "root instruction\n" },
      { path: "packages/AGENTS.md", scope: "packages", content: "packages instruction\n" },
      { path: "packages/api/AGENTS.md", scope: "packages/api", content: "api instruction\n" },
    ]);
    expect(result.value.knowledgeCatalog).toEqual([expect.objectContaining({ id: "project-environment", title: "Local environment" })]);
    expect(result.value.skillCatalog).toEqual([{
      componentId: fixture.skillId,
      name: "api-client-release",
      description: "Prepare and verify the api-client release artifact.",
      tags: ["release", "api-client"],
      relevantPaths: ["packages/api-client"],
      appliesWhen: ["The api-client release artifact changes, not docs"],
      doesNotApplyWhen: ["The task only changes API documentation"],
    }]);
    expect(fixture.catalogQueries).toEqual([{
      projectId: fixture.projectId,
      text: "",
      tags: [],
      relevantPaths: [],
      limit: 100,
    }]);
  });

  it("returns a selected installed skill in full and rejects non-skill components", async () => {
    const root = await mkdtemp(join(tmpdir(), "omega-context-skill-"));
    roots.push(root);
    const skillMarkdown = "---\nname: verify-api\ndescription: Verify the API.\n---\n\n# Verify\n\nRun just verify.\n";
    const fixture = contextFixture(root, skillMarkdown);
    const service = createContextService({ objects: fixture.objects, knowledge: fixture.knowledge, harnesses: fixture.harnesses });

    const selected = await service.readSkill(fixture.harness.id, fixture.skillId);
    expect(selected).toMatchObject({
      ok: true,
      value: {
        componentId: fixture.skillId,
        markdown: skillMarkdown,
        catalog: { name: "verify-api", description: "Verify the API." },
      },
    });

    const rejected = await service.readSkill(fixture.harness.id, fixture.runnerId);
    expect(rejected).toMatchObject({ ok: false, error: { kind: "validation", field: "componentId" } });
  });

  it("rejects compact catalogs that would exceed the JSONL bootstrap budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "omega-context-budget-"));
    roots.push(root);
    const fixture = contextFixture(root, "# Skill\n");
    const oversizedKnowledge: KnowledgeService = {
      ...fixture.knowledge,
      async catalog() {
        return { ok: true, value: [{
          id: "oversized" as KnowledgeDocumentId,
          title: "Oversized",
          summary: "x".repeat(600 * 1024),
          tags: [],
          confidence: 1,
          verifiedAt: NOW,
          relevantPaths: [],
        }] };
      },
    };
    const service = createContextService({ objects: fixture.objects, knowledge: oversizedKnowledge, harnesses: fixture.harnesses });

    expect(await service.bootstrap(fixture.workspace, fixture.harness)).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "context.bootstrap" },
    });
  });
});

function contextFixture(root: string, skillMarkdown: string) {
  const projectId = "project_context" as ProjectId;
  const skillId = "component_skill" as ComponentId;
  const runnerId = "component_runner" as ComponentId;
  const skillHash = createHash("sha256").update(skillMarkdown).digest("hex") as ObjectHash;
  const values = new Map<ObjectHash, Uint8Array>([[skillHash, Buffer.from(skillMarkdown)]]);
  const objects: ObjectStore = {
    async put(mediaType, chunks) {
      const parts: Uint8Array[] = [];
      for await (const chunk of chunks) parts.push(chunk);
      const bytes = Buffer.concat(parts);
      const hash = createHash("sha256").update(bytes).digest("hex") as ObjectHash;
      values.set(hash, bytes);
      return { ok: true, value: { hash, size: bytes.byteLength as ByteCount, mediaType, createdAt: NOW } };
    },
    async get(hash) {
      const bytes = values.get(hash);
      if (bytes === undefined) return { ok: false, error: { kind: "not-found", resource: "object", id: hash, recoverable: false, callerAction: "propagate" } };
      return { ok: true, value: (async function* () { yield bytes; })() };
    },
    async describe(hash) {
      const bytes = values.get(hash);
      if (bytes === undefined) return { ok: false, error: { kind: "not-found", resource: "object", id: hash, recoverable: false, callerAction: "propagate" } };
      return { ok: true, value: { hash, size: bytes.byteLength as ByteCount, mediaType: "text/markdown", createdAt: NOW } };
    },
  };
  const catalogQueries: unknown[] = [];
  const knowledge: KnowledgeService = {
    async catalog(query) {
      catalogQueries.push(query);
      return { ok: true, value: [{
        id: "project-environment" as KnowledgeDocumentId,
        title: "Local environment",
        summary: "Use rootless Podman.",
        tags: ["environment"],
        confidence: 1,
        verifiedAt: NOW,
        relevantPaths: ["." as RelativePath],
      }] };
    },
    async read(_projectId, id) { return { ok: false, error: { kind: "not-found", resource: "knowledge-document", id, recoverable: false, callerAction: "propagate" } }; },
    async write(request) { return { ok: false, error: { kind: "not-found", resource: "knowledge-document", id: request.document.frontmatter.id, recoverable: false, callerAction: "propagate" } }; },
  };
  const harness: HarnessManifest = {
    id: "harness_context" as HarnessId,
    projectId,
    alias: "context",
    parents: [],
    components: [
      { id: runnerId, kind: "runner", runtime: "node", objectHash: "a".repeat(64) as ObjectHash, entrypoint: "runner.js", credentialEnvNames: [], capabilities: [] },
      { id: skillId, kind: "skill", runtime: "document", objectHash: skillHash, entrypoint: "SKILL.md", credentialEnvNames: [], capabilities: [] },
    ],
    sourceArtifacts: [],
    createdAt: NOW,
  };
  const harnesses: HarnessRepository = {
    async putComponent(component) { return { ok: true, value: component }; },
    async putHarness(manifest) { return { ok: true, value: manifest }; },
    async getHarness(id) { return id === harness.id ? { ok: true, value: harness } : { ok: false, error: { kind: "not-found", resource: "harness", id, recoverable: false, callerAction: "propagate" } }; },
    async getActiveHarness() { return { ok: true, value: harness }; },
    async listProjectHarnesses() { return { ok: true, value: { items: [harness], nextCursor: null } }; },
  };
  const workspace: WorkspaceRecord = {
    id: "workspace_context" as WorkspaceId,
    projectId,
    path: root as AbsolutePath,
    registeredAt: NOW,
    lastSeenAt: NOW,
  };
  return { projectId, skillId, runnerId, objects, knowledge, catalogQueries, harness, harnesses, workspace };
}
