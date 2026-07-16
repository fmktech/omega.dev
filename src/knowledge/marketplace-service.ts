import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  CapabilityEnvelope,
  ComponentManifest,
  CreateMarketplaceService,
  HarnessError,
  HarnessId,
  HarnessManifest,
  KnowledgeError,
  MarketplaceArtifact,
  MarketplaceArtifactId,
  MarketplaceCanaryEvidence,
  MarketplaceInstallation,
  MarketplaceQuery,
  MarketplaceTransitionRequest,
  ProjectId,
  Result,
  ValidationError,
} from "../contracts/index.js";
import {
  canTransitionMarketplaceState,
  capabilityDenied,
  conflictError,
  credentialsArePermitted,
  evaluateCompatibility,
  hasCapability,
  ioError,
  isMarketplaceArtifact,
  isMarketplaceInstallation,
  nowTimestamp,
  readJsonState,
  sha256,
  stateFileName,
  validateMarketplaceArtifact,
  validationError,
  withStateLock,
  writeJsonState,
} from "./artifact-state.js";

export const createMarketplaceService: CreateMarketplaceService = (options) => {
  const { root, objects, harnesses, activation } = options;
  const marketplaceRoot = join(root, "marketplace");
  const artifactsRoot = join(marketplaceRoot, "artifacts");
  const installationsRoot = join(marketplaceRoot, "installations");

  async function getArtifact(id: MarketplaceArtifactId): Promise<Result<MarketplaceArtifact, KnowledgeError>> {
    const result = await readJsonState(
      artifactPath(artifactsRoot, id),
      "marketplace-artifact",
      id,
      isMarketplaceArtifact,
    );
    if (!result.ok) {
      return result;
    }
    if (result.value.id !== id) {
      return { ok: false, error: ioError("validate marketplace artifact key", new Error("Artifact state key mismatch")) };
    }
    return result;
  }

  return {
    async search(query) {
      const queryError = validateQuery(query);
      if (queryError !== null) {
        return { ok: false, error: queryError };
      }
      let names: readonly string[];
      try {
        names = await readdir(artifactsRoot);
      } catch (error) {
        if (isMissingFile(error)) {
          return { ok: true, value: [] };
        }
        return { ok: false, error: ioError("list marketplace artifacts", error) };
      }

      const matches: MarketplaceArtifact[] = [];
      for (const name of [...names].sort()) {
        if (!name.endsWith(".json")) {
          continue;
        }
        const artifact = await readJsonState(
          join(artifactsRoot, name),
          "marketplace-artifact",
          name,
          isMarketplaceArtifact,
        );
        if (!artifact.ok) {
          return artifact;
        }
        if (artifact.value.state !== "quarantined" && matchesMarketplaceQuery(artifact.value, query)) {
          matches.push(artifact.value);
        }
      }
      matches.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) || left.title.localeCompare(right.title));
      return { ok: true, value: matches.slice(0, query.limit) };
    },

    async publish(artifact) {
      const artifactError = validateMarketplaceArtifact(artifact);
      if (artifactError !== null) {
        return { ok: false, error: artifactError };
      }
      const object = await objects.describe(artifact.objectHash);
      if (!object.ok) {
        return object;
      }
      const path = artifactPath(artifactsRoot, artifact.id);
      return withStateLock(path, async (): Promise<Result<MarketplaceArtifact, KnowledgeError>> => {
        const existing = await readJsonState(path, "marketplace-artifact", artifact.id, isMarketplaceArtifact);
        if (existing.ok) {
          if (sameArtifact(existing.value, artifact)) {
            return existing;
          }
          return {
            ok: false,
            error: conflictError("marketplace-artifact", artifactFingerprint(existing.value), artifactFingerprint(artifact)),
          };
        }
        if (existing.error.kind !== "not-found") {
          return existing;
        }
        const persisted = await writeJsonState(path, artifact);
        if (!persisted.ok) {
          return persisted;
        }
        return { ok: true, value: artifact };
      });
    },

    async install(projectId, artifactId, capabilities) {
      const capabilityError = validateInstallCapabilities(capabilities);
      if (capabilityError !== null) {
        return { ok: false, error: capabilityError };
      }
      const artifact = await getArtifact(artifactId);
      if (!artifact.ok) {
        return artifact;
      }
      if (artifact.value.state === "quarantined") {
        return { ok: false, error: capabilityDenied("install-marketplace", "Quarantined marketplace artifacts cannot be installed") };
      }
      if (artifact.value.state === "deprecated") {
        return { ok: false, error: capabilityDenied("install-marketplace", "Deprecated marketplace artifacts cannot be newly installed") };
      }
      if (!credentialsArePermitted(capabilities, artifact.value.credentialEnvNames)) {
        return {
          ok: false,
          error: capabilityDenied("inject-credential", "The capability envelope does not permit every declared artifact credential"),
        };
      }
      const compatibility = await evaluateCompatibility(artifact.value);
      if (!compatibility.ok) {
        return compatibility;
      }

      const path = installationPath(installationsRoot, projectId, artifactId);
      return withStateLock(path, async (): Promise<Result<MarketplaceInstallation, KnowledgeError>> => {
        const existing = await readJsonState(path, "marketplace-installation", `${projectId}:${artifactId}`, isMarketplaceInstallation);
        if (existing.ok) {
          if (existing.value.projectId !== projectId || existing.value.artifactId !== artifactId) {
            return { ok: false, error: ioError("validate marketplace installation key", new Error("Installation state key mismatch")) };
          }
          if (existing.value.activation !== "active") return existing;
          const active = await harnesses.getActiveHarness(projectId);
          if (active.ok && active.value.id === existing.value.candidateHarnessId) return existing;
          const inactive: MarketplaceInstallation = {
            ...existing.value,
            activation: "installed-inactive",
            activatedAt: null,
          };
          const persisted = await writeJsonState(path, inactive);
          return persisted.ok ? { ok: true, value: inactive } : persisted;
        }
        if (existing.error.kind !== "not-found") {
          return existing;
        }

        const incumbent = await harnesses.getActiveHarness(projectId);
        if (!incumbent.ok) return { ok: false, error: asKnowledgeError(incumbent.error) };
        const source = await harnesses.getHarness(artifact.value.sourceHarnessId);
        if (!source.ok) return { ok: false, error: asKnowledgeError(source.error) };
        const selected = selectMarketplaceComponents(source.value, artifact.value);
        if (!selected.ok) return selected;
        const candidate = candidateHarness(incumbent.value, artifact.value, selected.value);
        const storedCandidate = await harnesses.putHarness(candidate);
        if (!storedCandidate.ok) return { ok: false, error: asKnowledgeError(storedCandidate.error) };

        const requiresCanary = artifact.value.state === "experimental";
        const installedAt = nowTimestamp();
        let isActive = false;
        if (!requiresCanary) {
          const activated = await activateCandidate(projectId, storedCandidate.value.id, artifactId, harnesses, activation);
          if (!activated.ok) return activated;
          isActive = true;
        }
        const installation: MarketplaceInstallation = {
          artifactId,
          projectId,
          installedComponentIds: selected.value.map((component) => component.id),
          candidateHarnessId: storedCandidate.value.id,
          compatibility: compatibility.value,
          requiresCanary,
          activation: isActive ? "active" : "installed-inactive",
          canary: null,
          installedAt,
          activatedAt: isActive ? installedAt : null,
        };
        const persisted = await writeJsonState(path, installation);
        if (!persisted.ok) {
          return persisted;
        }
        return { ok: true, value: installation };
      });
    },

    async activateInstallation(evidence, capabilities) {
      if (!hasCapability(capabilities, "activate-harness")) {
        return { ok: false, error: capabilityDenied("activate-harness", "Marketplace activation requires the activate-harness capability") };
      }
      const evidenceError = validateCanaryEvidence(evidence);
      if (evidenceError !== null) {
        return { ok: false, error: evidenceError };
      }
      const artifact = await getArtifact(evidence.artifactId);
      if (!artifact.ok) {
        return artifact;
      }
      if (artifact.value.state === "quarantined" || artifact.value.state === "deprecated") {
        return {
          ok: false,
          error: capabilityDenied("activate-harness", `${artifact.value.state} marketplace artifacts cannot be activated`),
        };
      }

      const path = installationPath(installationsRoot, evidence.projectId, evidence.artifactId);
      return withStateLock(path, async (): Promise<Result<MarketplaceInstallation, KnowledgeError | ValidationError>> => {
        const installed = await readJsonState(
          path,
          "marketplace-installation",
          `${evidence.projectId}:${evidence.artifactId}`,
          isMarketplaceInstallation,
        );
        if (!installed.ok) {
          return installed;
        }
        if (
          installed.value.projectId !== evidence.projectId ||
          installed.value.artifactId !== evidence.artifactId ||
          installed.value.candidateHarnessId !== evidence.candidateHarnessId
        ) {
          return {
            ok: false,
            error: validationError("Canary evidence does not belong to this project installation", "candidateHarnessId"),
          };
        }
        if (installed.value.activation === "active") {
          const active = await harnesses.getActiveHarness(evidence.projectId);
          if (active.ok && active.value.id === installed.value.candidateHarnessId) return installed;
        }
        const activatedCandidate = await activateCandidate(
          evidence.projectId,
          installed.value.candidateHarnessId,
          evidence.artifactId,
          harnesses,
          activation,
        );
        if (!activatedCandidate.ok) return activatedCandidate;
        const activated: MarketplaceInstallation = {
          ...installed.value,
          activation: "active",
          canary: evidence,
          activatedAt: nowTimestamp(),
        };
        const persisted = await writeJsonState(path, activated);
        if (!persisted.ok) {
          return persisted;
        }
        return { ok: true, value: activated };
      });
    },

    async transition(request, capabilities) {
      if (!hasCapability(capabilities, "manage-marketplace")) {
        return { ok: false, error: capabilityDenied("manage-marketplace", "Marketplace transitions require the manage-marketplace capability") };
      }
      const requestError = validateTransition(request);
      if (requestError !== null) {
        return { ok: false, error: requestError };
      }
      return updateArtifactState(artifactsRoot, request.artifactId, async (artifact) => {
        if (artifact.state !== request.expectedState) {
          return {
            ok: false,
            error: conflictError("marketplace-state", request.expectedState, artifact.state),
          };
        }
        if (!canTransitionMarketplaceState(artifact.state, request.nextState)) {
          return {
            ok: false,
            error: validationError(`Marketplace state cannot transition from ${artifact.state} to ${request.nextState}`, "nextState"),
          };
        }
        return { ok: true, value: { ...artifact, state: request.nextState } };
      });
    },

    async quarantine(artifactId, reason) {
      if (reason.trim().length === 0) {
        return { ok: false, error: validationError("Quarantine reason is required", "reason") };
      }
      return updateArtifactState(artifactsRoot, artifactId, async (artifact) => ({
        ok: true,
        value: artifact.state === "quarantined" ? artifact : { ...artifact, state: "quarantined" },
      }));
    },
  };
};

async function updateArtifactState(
  root: string,
  id: MarketplaceArtifactId,
  update: (artifact: MarketplaceArtifact) => Promise<Result<MarketplaceArtifact, KnowledgeError>>,
): Promise<Result<MarketplaceArtifact, KnowledgeError>> {
  const path = artifactPath(root, id);
  return withStateLock(path, async () => {
    const existing = await readJsonState(path, "marketplace-artifact", id, isMarketplaceArtifact);
    if (!existing.ok) {
      return existing;
    }
    const updated = await update(existing.value);
    if (!updated.ok) {
      return updated;
    }
    const persisted = await writeJsonState(path, updated.value);
    if (!persisted.ok) {
      return persisted;
    }
    return updated;
  });
}

function validateQuery(query: MarketplaceQuery): ValidationError | null {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
    return validationError("Marketplace query limit must be a positive integer", "limit");
  }
  return null;
}

function validateInstallCapabilities(capabilities: CapabilityEnvelope): ReturnType<typeof capabilityDenied> | null {
  if (!hasCapability(capabilities, "install-marketplace")) {
    return capabilityDenied("install-marketplace", "Marketplace installation requires the install-marketplace capability");
  }
  if (!hasCapability(capabilities, "create-harness-candidate")) {
    return capabilityDenied("create-harness-candidate", "Marketplace installation requires an independent project candidate lineage");
  }
  return null;
}

function validateTransition(request: MarketplaceTransitionRequest): ValidationError | null {
  if (request.reason.trim().length === 0) {
    return validationError("Marketplace transition reason is required", "reason");
  }
  return null;
}

function validateCanaryEvidence(evidence: MarketplaceCanaryEvidence): ValidationError | null {
  if (evidence.result.harnessId !== evidence.candidateHarnessId) {
    return validationError("Canary result harness does not match the candidate installation", "result.harnessId");
  }
  if (evidence.result.source.kind !== "project-session") {
    return validationError("Marketplace activation requires a project-scoped session canary", "result.source");
  }
  if (evidence.result.outcome !== "healthy" || evidence.result.action !== "retain") {
    return validationError("Only a healthy retained canary can activate an installation", "result.outcome");
  }
  return null;
}

function matchesMarketplaceQuery(artifact: MarketplaceArtifact, query: MarketplaceQuery): boolean {
  if (artifact.state === "quarantined") {
    return false;
  }
  if (query.kinds.length > 0 && !query.kinds.includes(artifact.kind)) {
    return false;
  }
  if (query.states.length > 0 && !query.states.includes(artifact.state)) {
    return false;
  }
  const text = query.text.trim().toLocaleLowerCase();
  if (text.length === 0) {
    return true;
  }
  return [artifact.title, artifact.summary, artifact.kind, ...artifact.componentIds]
    .join("\n")
    .toLocaleLowerCase()
    .includes(text);
}

function selectMarketplaceComponents(
  source: HarnessManifest,
  artifact: MarketplaceArtifact,
): Result<readonly ComponentManifest[], KnowledgeError> {
  if (source.id !== artifact.sourceHarnessId || source.projectId !== artifact.sourceProjectId) {
    return { ok: false, error: validationError("Marketplace source harness provenance does not match the artifact", "sourceHarnessId") };
  }
  if (artifact.componentIds.length === 0) {
    return { ok: false, error: validationError("Marketplace installation must select at least one source component", "componentIds") };
  }
  const byId = new Map(source.components.map((component) => [component.id, component] as const));
  const selected: ComponentManifest[] = [];
  for (const id of artifact.componentIds) {
    const component = byId.get(id);
    if (component === undefined) {
      return { ok: false, error: validationError("Marketplace component is absent from its source harness", "componentIds") };
    }
    selected.push(component);
  }
  return { ok: true, value: selected };
}

function candidateHarness(
  incumbent: HarnessManifest,
  artifact: MarketplaceArtifact,
  selected: readonly ComponentManifest[],
): HarnessManifest {
  const selectedIds = new Set(selected.map((component) => component.id));
  const replacesRunner = selected.some((component) => component.kind === "runner");
  const components = [
    ...incumbent.components.filter((component) => !selectedIds.has(component.id) && !(replacesRunner && component.kind === "runner")),
    ...selected,
  ];
  const body = {
    projectId: incumbent.projectId,
    alias: `${incumbent.alias}+marketplace:${artifact.id}`,
    parents: [incumbent.id],
    components,
    sourceArtifacts: [...incumbent.sourceArtifacts],
    // Artifact publication is immutable, making retries produce one candidate.
    createdAt: artifact.publishedAt,
  } as const;
  return { id: `harness_${sha256(encodeCanonical(body))}` as HarnessId, ...body };
}

async function activateCandidate(
  projectId: ProjectId,
  candidateId: HarnessId,
  artifactId: MarketplaceArtifactId,
  harnesses: Parameters<CreateMarketplaceService>[0]["harnesses"],
  activation: Parameters<CreateMarketplaceService>[0]["activation"],
): Promise<Result<void, KnowledgeError>> {
  const current = await harnesses.getActiveHarness(projectId);
  if (!current.ok) return { ok: false, error: asKnowledgeError(current.error) };
  if (current.value.id !== candidateId) {
    const candidate = await harnesses.getHarness(candidateId);
    if (!candidate.ok) return { ok: false, error: asKnowledgeError(candidate.error) };
    if (!candidate.value.parents.includes(current.value.id)) {
      return { ok: false, error: conflictError("project-active-harness", candidate.value.parents[0] ?? candidateId, current.value.id) };
    }
    const pinned = await activation.pin(projectId, candidateId, `Installed trusted marketplace artifact ${artifactId}`);
    if (!pinned.ok) return { ok: false, error: asKnowledgeError(pinned.error) };
  }
  const active = await harnesses.getActiveHarness(projectId);
  if (!active.ok) return { ok: false, error: asKnowledgeError(active.error) };
  return active.value.id === candidateId
    ? { ok: true, value: undefined }
    : { ok: false, error: conflictError("project-active-harness", candidateId, active.value.id) };
}

function asKnowledgeError(error: HarnessError): KnowledgeError {
  if (error.kind === "harness-version-mismatch") {
    return validationError("Harness activation raced with another project update", "candidateHarnessId");
  }
  if (error.kind === "protocol-error") {
    return validationError(error.message, "harness");
  }
  return error;
}

function encodeCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${encodeCanonical(record[key] ?? null)}`).join(",")}}`;
}

function artifactPath(root: string, id: MarketplaceArtifactId): string {
  return join(root, `${stateFileName(id)}.json`);
}

function installationPath(root: string, projectId: ProjectId, artifactId: MarketplaceArtifactId): string {
  return join(root, stateFileName(projectId), `${stateFileName(artifactId)}.json`);
}

function artifactFingerprint(artifact: MarketplaceArtifact): string {
  return sha256(JSON.stringify(artifact));
}

function sameArtifact(left: MarketplaceArtifact, right: MarketplaceArtifact): boolean {
  return artifactFingerprint(left) === artifactFingerprint(right);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
