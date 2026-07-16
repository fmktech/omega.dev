import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  CapabilityEnvelope,
  CreateMarketplaceService,
  HarnessId,
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

export const createMarketplaceService: CreateMarketplaceService = (root, objects) => {
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
          return existing;
        }
        if (existing.error.kind !== "not-found") {
          return existing;
        }

        const requiresCanary = artifact.value.state === "experimental";
        const installedAt = nowTimestamp();
        const installation: MarketplaceInstallation = {
          artifactId,
          projectId,
          installedComponentIds: artifact.value.kind === "harness" ? [] : artifact.value.componentIds,
          candidateHarnessId: candidateHarnessId(projectId, artifact.value),
          compatibility: compatibility.value,
          requiresCanary,
          activation: requiresCanary ? "installed-inactive" : "active",
          canary: null,
          installedAt,
          activatedAt: requiresCanary ? null : installedAt,
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
          return installed;
        }
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

function candidateHarnessId(projectId: ProjectId, artifact: MarketplaceArtifact): HarnessId {
  return `candidate-${sha256(`${projectId}\u0000${artifact.id}\u0000${artifact.objectHash}`).slice(0, 48)}` as HarnessId;
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
