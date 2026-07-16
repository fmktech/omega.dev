import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AbsolutePath,
  ArtifactId,
  ByteCount,
  CapabilityEnvelope,
  CapabilityGrant,
  ComponentId,
  CredentialEnvName,
  DurationMs,
  HarnessId,
  KnowledgeDocument,
  KnowledgeDocumentId,
  MarketplaceArtifact,
  MarketplaceArtifactId,
  MarketplaceCanaryEvidence,
  ObjectDescriptor,
  ObjectHash,
  ObjectStore,
  ProjectId,
  RelativePath,
  Result,
  SessionId,
  Sha256,
  StoreError,
  Timestamp,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";
import { createKnowledgeService } from "./knowledge-service.js";
import { createMarketplaceService } from "./marketplace-service.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project knowledge", () => {
  it("validates skill-like frontmatter and provenance", async () => {
    const { root, objects } = await fixture();
    const service = createKnowledgeService(root, objects);
    const valid = knowledgeDocument("project-a", "build-notes", 0.9, ["build"], ["src"], "Build conventions.");
    const result = await service.write(
      {
        projectId: valid.projectId,
        document: { ...valid, markdown: "Build commands without frontmatter" },
        expectedSha: null,
      },
      capabilities("write-knowledge"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }

    const missingProvenance = await service.write(
      {
        projectId: valid.projectId,
        document: {
          ...valid,
          frontmatter: { ...valid.frontmatter, sourceSessionIds: [], sourceArtifactIds: [] },
        },
        expectedSha: null,
      },
      capabilities("write-knowledge"),
    );
    expect(missingProvenance.ok).toBe(false);
    if (!missingProvenance.ok) {
      expect(missingProvenance.error.kind).toBe("validation");
    }
  });

  it("stores immutable content, rejects stale writes, and filters a lightweight catalog", async () => {
    const { root, objects } = await fixture();
    const service = createKnowledgeService(root, objects);
    const document = knowledgeDocument("project-a", "build-notes", 0.9, ["build", "typescript"], ["src/core"], "Use pnpm for builds.");
    const created = await service.write(
      { projectId: document.projectId, document, expectedSha: null },
      capabilities("write-knowledge"),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const stale = await service.write(
      {
        projectId: document.projectId,
        document: { ...document, markdown: document.markdown.replace("builds", "all builds") },
        expectedSha: "0".repeat(64) as Sha256,
      },
      capabilities("write-knowledge"),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.kind).toBe("stale-read");
    }

    const catalog = await service.catalog({
      projectId: document.projectId,
      text: "pnpm",
      tags: ["typescript"],
      relevantPaths: ["src/core/parser.ts" as RelativePath],
      limit: 10,
    });
    expect(catalog.ok && catalog.value.map((entry) => entry.id)).toEqual(["build-notes"]);

    const unrelated = await service.catalog({
      projectId: document.projectId,
      text: "",
      tags: ["typescript"],
      relevantPaths: ["docs" as RelativePath],
      limit: 10,
    });
    expect(unrelated.ok && unrelated.value).toEqual([]);

    const read = await service.read(document.projectId, document.frontmatter.id);
    expect(read.ok && read.value.markdown).toBe(document.markdown);
    expect(created.value.sha).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("local marketplace", () => {
  it("automatically publishes valid local artifacts and makes duplicate publication idempotent", async () => {
    const { root, objects } = await fixture();
    const service = createMarketplaceService(root, objects);
    const artifact = await marketplaceArtifact(objects, "jira", "experimental");

    const first = await service.publish(artifact);
    const duplicate = await service.publish(artifact);
    const search = await service.search({ text: "jira", kinds: ["connector"], states: ["experimental"], limit: 5 });

    expect(first).toEqual({ ok: true, value: artifact });
    expect(duplicate).toEqual(first);
    expect(search.ok && search.value.map((item) => item.id)).toEqual([artifact.id]);

    const conflicting = await service.publish({ ...artifact, title: "Different title" });
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) {
      expect(conflicting.error.kind).toBe("conflict");
    }
  });

  it("rejects missing provenance and malformed credential declarations", async () => {
    const { root, objects } = await fixture();
    const service = createMarketplaceService(root, objects);
    const artifact = await marketplaceArtifact(objects, "invalid", "experimental");

    const missingProvenance = await service.publish({ ...artifact, sourceHarnessId: "" as HarnessId });
    expect(missingProvenance.ok).toBe(false);
    const invalidCredential = await service.publish({
      ...artifact,
      id: "invalid-credential" as MarketplaceArtifactId,
      credentialEnvNames: ["jira-token" as CredentialEnvName],
    });
    expect(invalidCredential.ok).toBe(false);
  });

  it("enforces state transitions and permanently denies quarantined installs", async () => {
    const { root, objects } = await fixture();
    const service = createMarketplaceService(root, objects);
    const artifact = await marketplaceArtifact(objects, "stateful", "experimental");
    expect((await service.publish(artifact)).ok).toBe(true);

    const managed = capabilities("manage-marketplace", "install-marketplace", "create-harness-candidate");
    const proven = await service.transition(
      { artifactId: artifact.id, expectedState: "experimental", nextState: "proven", reason: "passed paired evaluation" },
      managed,
    );
    expect(proven.ok && proven.value.state).toBe("proven");
    const deprecated = await service.transition(
      { artifactId: artifact.id, expectedState: "proven", nextState: "deprecated", reason: "superseded" },
      managed,
    );
    expect(deprecated.ok && deprecated.value.state).toBe("deprecated");
    const quarantined = await service.quarantine(artifact.id, "regressed in project canary");
    expect(quarantined.ok && quarantined.value.state).toBe("quarantined");

    const installation = await service.install("project-a" as ProjectId, artifact.id, managed);
    expect(installation.ok).toBe(false);
    if (!installation.ok) {
      expect(installation.error.kind).toBe("capability-denied");
    }
    const search = await service.search({ text: "", kinds: [], states: [], limit: 10 });
    expect(search.ok && search.value).toEqual([]);
  });

  it("checks manifest compatibility and credential grants before installation", async () => {
    const { root, objects } = await fixture();
    const service = createMarketplaceService(root, objects);
    const artifact = await marketplaceArtifact(objects, "credentialed", "proven");
    const credentialed: MarketplaceArtifact = {
      ...artifact,
      credentialEnvNames: ["JIRA_API_TOKEN" as CredentialEnvName],
    };
    expect((await service.publish(credentialed)).ok).toBe(true);

    const missingCredential = await service.install(
      "project-a" as ProjectId,
      credentialed.id,
      capabilities("install-marketplace", "create-harness-candidate"),
    );
    expect(missingCredential.ok).toBe(false);
    if (!missingCredential.ok) {
      expect(missingCredential.error.kind).toBe("capability-denied");
    }

    const permitted = await service.install(
      "project-a" as ProjectId,
      credentialed.id,
      capabilitiesWithCredential("JIRA_API_TOKEN" as CredentialEnvName),
    );
    expect(permitted.ok && permitted.value.activation).toBe("active");

    const incompatibleArtifact = await marketplaceArtifact(objects, "incompatible", "proven");
    const incompatible: MarketplaceArtifact = {
      ...incompatibleArtifact,
      compatibility: { ...incompatibleArtifact.compatibility, omegaSchemaVersions: [] },
    };
    expect((await service.publish(incompatible)).ok).toBe(true);
    const rejected = await service.install(
      "project-a" as ProjectId,
      incompatible.id,
      capabilities("install-marketplace", "create-harness-candidate"),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.kind).toBe("validation");
    }
  });

  it("binds experimental canaries to an isolated project, artifact, and candidate lineage", async () => {
    const { root, objects } = await fixture();
    const service = createMarketplaceService(root, objects);
    const artifact = await marketplaceArtifact(objects, "isolated", "experimental");
    expect((await service.publish(artifact)).ok).toBe(true);
    const grants = capabilities("install-marketplace", "create-harness-candidate", "activate-harness");
    const first = await service.install("project-a" as ProjectId, artifact.id, grants);
    const second = await service.install("project-b" as ProjectId, artifact.id, grants);
    expect(first.ok && first.value.activation).toBe("installed-inactive");
    expect(second.ok && second.value.activation).toBe("installed-inactive");
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.value.candidateHarnessId).not.toBe(second.value.candidateHarnessId);

    const crossProject = await service.activateInstallation(
      canaryEvidence("project-a", artifact.id, second.value.candidateHarnessId),
      grants,
    );
    expect(crossProject.ok).toBe(false);

    const activated = await service.activateInstallation(
      canaryEvidence("project-a", artifact.id, first.value.candidateHarnessId),
      grants,
    );
    expect(activated.ok && activated.value.activation).toBe("active");
    const stillInactive = await service.install("project-b" as ProjectId, artifact.id, grants);
    expect(stillInactive.ok && stillInactive.value.activation).toBe("installed-inactive");
  });
});

class MemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<ObjectHash, Uint8Array>();
  readonly #descriptors = new Map<ObjectHash, ObjectDescriptor>();

  async put(mediaType: string, chunks: AsyncIterable<Uint8Array>): Promise<Result<ObjectDescriptor, StoreError>> {
    const collected: Uint8Array[] = [];
    for await (const chunk of chunks) {
      collected.push(chunk);
    }
    const content = Buffer.concat(collected);
    const hash = createHash("sha256").update(content).digest("hex") as ObjectHash;
    const descriptor: ObjectDescriptor = {
      hash,
      size: content.byteLength as ByteCount,
      mediaType,
      createdAt: timestamp(),
    };
    this.#objects.set(hash, content);
    this.#descriptors.set(hash, descriptor);
    return { ok: true, value: descriptor };
  }

  async get(hash: ObjectHash): Promise<Result<AsyncIterable<Uint8Array>, StoreError>> {
    const content = this.#objects.get(hash);
    if (content === undefined) {
      return { ok: false, error: missingObject(hash) };
    }
    return { ok: true, value: yieldChunk(content) };
  }

  async describe(hash: ObjectHash): Promise<Result<ObjectDescriptor, StoreError>> {
    const descriptor = this.#descriptors.get(hash);
    return descriptor === undefined ? { ok: false, error: missingObject(hash) } : { ok: true, value: descriptor };
  }
}

async function fixture(): Promise<{ readonly root: AbsolutePath; readonly objects: MemoryObjectStore }> {
  const root = await mkdtemp(join(tmpdir(), "omega-knowledge-test-"));
  temporaryRoots.push(root);
  return { root: root as AbsolutePath, objects: new MemoryObjectStore() };
}

function knowledgeDocument(
  project: string,
  id: string,
  confidence: number,
  tags: readonly string[],
  paths: readonly string[],
  body: string,
): Omit<KnowledgeDocument, "sha"> {
  const projectId = project as ProjectId;
  const documentId = id as KnowledgeDocumentId;
  const verifiedAt = timestamp();
  const sourceSessionIds = ["session-1" as SessionId];
  const relevantPaths = paths.map((path) => path as RelativePath);
  const markdown = [
    "---",
    `id: ${documentId}`,
    `title: Build notes`,
    `summary: Project build conventions using pnpm`,
    `tags: [${tags.join(", ")}]`,
    `confidence: ${confidence}`,
    `verifiedAt: ${verifiedAt}`,
    `sourceSessionIds: [${sourceSessionIds.join(", ")}]`,
    "sourceArtifactIds: []",
    `relevantPaths: [${relevantPaths.join(", ")}]`,
    "invalidationConditions: []",
    "---",
    body,
  ].join("\n");
  return {
    projectId,
    frontmatter: {
      id: documentId,
      title: "Build notes",
      summary: "Project build conventions using pnpm",
      tags,
      confidence,
      verifiedAt,
      sourceSessionIds,
      sourceArtifactIds: [],
      relevantPaths,
      invalidationConditions: [],
    },
    markdown,
  };
}

async function marketplaceArtifact(
  objects: MemoryObjectStore,
  id: string,
  state: MarketplaceArtifact["state"],
): Promise<MarketplaceArtifact> {
  const stored = await objects.put("application/json", yieldChunk(new TextEncoder().encode(`{\"artifact\":\"${id}\"}`)));
  if (!stored.ok) {
    throw new Error("Test fixture object could not be stored");
  }
  return {
    id: id as MarketplaceArtifactId,
    kind: "connector",
    state,
    title: `${id} connector`,
    summary: `Local ${id} integration`,
    objectHash: stored.value.hash,
    componentIds: [`component-${id}` as ComponentId],
    sourceProjectId: "source-project" as ProjectId,
    sourceHarnessId: "source-harness" as HarnessId,
    scorecardIds: [],
    credentialEnvNames: [],
    compatibility: {
      omegaSchemaVersions: [1],
      operatingSystems: [hostOperatingSystem()],
      runtimes: ["document"],
      requiredExecutables: [],
    },
    publishedAt: timestamp(),
  };
}

function capabilities(...kinds: CapabilityEnvelope["grants"][number]["kind"][]): CapabilityEnvelope {
  return {
    grants: kinds.map((kind): CapabilityGrant => {
      if (kind === "inject-credential") {
        return { kind, credentialEnvNames: [] };
      }
      if (kind === "read-files" || kind === "write-files") {
        return { kind, pathPrefixes: ["." as RelativePath] };
      }
      if (kind === "start-process") {
        return { kind, executableNames: [] };
      }
      if (kind === "network-egress") {
        return { kind, allowedHosts: [] };
      }
      return { kind };
    }),
    modelRoles: [],
    maxCostUsdMicros: 0 as UsdMicros,
    maxModelCalls: 0,
    maxProcessStarts: 0,
    maxInputTokens: 0 as TokenCount,
    maxOutputTokens: 0 as TokenCount,
    wallTimeMs: 1_000 as DurationMs,
    createdAt: timestamp(),
  };
}

function capabilitiesWithCredential(name: CredentialEnvName): CapabilityEnvelope {
  const base = capabilities("install-marketplace", "create-harness-candidate");
  return { ...base, grants: [...base.grants, { kind: "inject-credential", credentialEnvNames: [name] }] };
}

function canaryEvidence(
  project: string,
  artifactId: MarketplaceArtifactId,
  candidateHarnessId: HarnessId,
): MarketplaceCanaryEvidence {
  return {
    projectId: project as ProjectId,
    artifactId,
    candidateHarnessId,
    result: {
      harnessId: candidateHarnessId,
      source: {
        kind: "project-session" as const,
        sessionId: `session-${project}` as SessionId,
        verificationArtifactId: `verification-${project}` as ArtifactId,
      },
      outcome: "healthy" as const,
      action: "retain" as const,
    },
  };
}

function hostOperatingSystem(): MarketplaceArtifact["compatibility"]["operatingSystems"][number] {
  if (process.platform === "win32") {
    return "windows";
  }
  return process.platform === "darwin" ? "darwin" : "linux";
}

function timestamp(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

function missingObject(hash: ObjectHash): StoreError {
  return {
    kind: "not-found",
    resource: "object",
    id: hash,
    recoverable: false,
    callerAction: "propagate",
  };
}

async function* yieldChunk(content: Uint8Array): AsyncIterable<Uint8Array> {
  yield content;
}
