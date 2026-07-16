import type {
  ActionFacts,
  BenchmarkSuiteId,
  CapabilityGrant,
  ComponentKind,
  FileWriteRequest,
  HarnessId,
  KnowledgeDocumentId,
  MarketplaceArtifactId,
  MarketplaceState,
  ProcessId,
  ProcessInput,
  ProcessSpec,
  ProjectId,
  SessionId,
  Sha256,
} from "../contracts/index.js";

export function deriveProcessActionFacts(spec: ProcessSpec): ActionFacts {
  return {
    kind: "process",
    executable: spec.executable,
    args: [...spec.args],
    cwd: spec.cwd,
    credentialEnvNames: [...spec.credentialEnvNames],
    sandbox: {
      ...spec.sandbox,
      allowedHosts: [...spec.sandbox.allowedHosts],
      runtime: { ...spec.sandbox.runtime },
    },
  };
}

export function deriveFileWriteActionFacts(request: FileWriteRequest): ActionFacts {
  return {
    kind: "file-write",
    workspaceId: request.workspaceId,
    path: request.path,
    expectedSha: request.expectedSha,
  };
}

export function deriveProcessInputActionFacts(processId: ProcessId, input: ProcessInput): ActionFacts {
  return { kind: "process-input", processId, input: { ...input } };
}

export function deriveChildSpawnActionFacts(
  parentSessionId: SessionId,
  requestedGrants: readonly CapabilityGrant[],
): ActionFacts {
  return {
    kind: "child-spawn",
    parentSessionId,
    requestedGrants: requestedGrants.map(copyCapabilityGrant),
  };
}

export function deriveKnowledgeWriteActionFacts(
  projectId: ProjectId,
  documentId: KnowledgeDocumentId,
  expectedSha: Sha256 | null,
): ActionFacts {
  return { kind: "knowledge-write", projectId, documentId, expectedSha };
}

export function deriveMarketplaceInstallActionFacts(
  artifactId: MarketplaceArtifactId,
  state: MarketplaceState,
): ActionFacts {
  return { kind: "marketplace-install", artifactId, state };
}

export function deriveMarketplacePublishActionFacts(
  artifactId: MarketplaceArtifactId,
  sourceProjectId: ProjectId,
): ActionFacts {
  return { kind: "marketplace-publish", artifactId, sourceProjectId };
}

export function deriveMarketplaceTransitionActionFacts(
  artifactId: MarketplaceArtifactId,
  from: MarketplaceState,
  to: MarketplaceState,
): ActionFacts {
  return { kind: "marketplace-transition", artifactId, from, to };
}

export function deriveMarketplaceActivationActionFacts(
  artifactId: MarketplaceArtifactId,
  projectId: ProjectId,
  candidateHarnessId: HarnessId,
): ActionFacts {
  return {
    kind: "marketplace-activate",
    artifactId,
    projectId,
    candidateHarnessId,
    canaryOutcome: "healthy",
  };
}

export function deriveHarnessCandidateActionFacts(
  projectId: ProjectId,
  componentKinds: readonly ComponentKind[],
): ActionFacts {
  return { kind: "harness-candidate", projectId, componentKinds: [...componentKinds] };
}

export function derivePromotionEvaluationActionFacts(
  projectId: ProjectId,
  suiteId: BenchmarkSuiteId,
  incumbentId: HarnessId,
  candidateId: HarnessId,
): ActionFacts {
  return { kind: "promotion-eval", projectId, suiteId, incumbentId, candidateId };
}

export function deriveHarnessActivationActionFacts(
  projectId: ProjectId,
  incumbentId: HarnessId,
  candidateId: HarnessId,
): ActionFacts {
  return { kind: "harness-activation", projectId, incumbentId, candidateId };
}

function copyCapabilityGrant(grant: CapabilityGrant): CapabilityGrant {
  switch (grant.kind) {
    case "read-files":
    case "write-files":
      return { kind: grant.kind, pathPrefixes: [...grant.pathPrefixes] };
    case "start-process":
      return { kind: grant.kind, executableNames: [...grant.executableNames] };
    case "network-egress":
      return { kind: grant.kind, allowedHosts: [...grant.allowedHosts] };
    case "inject-credential":
      return { kind: grant.kind, credentialEnvNames: [...grant.credentialEnvNames] };
    case "process-input":
    case "spawn-child":
    case "write-knowledge":
    case "install-marketplace":
    case "publish-marketplace":
    case "manage-marketplace":
    case "create-harness-candidate":
    case "run-promotion-eval":
    case "activate-harness":
      return { kind: grant.kind };
  }
}
