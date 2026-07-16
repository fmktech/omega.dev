import { randomUUID } from "node:crypto";

import type {
  CapabilityDeniedError,
  CapabilityEnvelope,
  CapabilityGrant,
  ChildId,
  ChildSessionRecord,
  CredentialEnvName,
  EventId,
  SessionHeader,
  SessionId,
  SpawnChildRequest,
  Timestamp,
} from "../contracts/index.js";

export function attenuateChildCapabilities(
  parent: CapabilityEnvelope,
  requested: CapabilityEnvelope,
  createdAt: Timestamp,
): { readonly ok: true; readonly value: CapabilityEnvelope } | { readonly ok: false; readonly error: CapabilityDeniedError } {
  const limitsFit = requested.maxCostUsdMicros <= parent.maxCostUsdMicros
    && requested.maxModelCalls <= parent.maxModelCalls
    && requested.maxProcessStarts <= parent.maxProcessStarts
    && requested.maxInputTokens <= parent.maxInputTokens
    && requested.maxOutputTokens <= parent.maxOutputTokens
    && requested.wallTimeMs <= parent.wallTimeMs;
  if (!limitsFit) return denied("spawn-child", "A child resource limit exceeds its parent's immutable envelope");

  for (const role of requested.modelRoles) {
    if (!parent.modelRoles.includes(role)) return denied("model-call", `Child model role ${role} is not granted to its parent`);
  }
  for (const grant of requested.grants) {
    if (!parent.grants.some((candidate) => grantIsSubset(grant, candidate))) {
      return denied(grant.kind, `Child capability ${grant.kind} widens its parent's authority`);
    }
  }
  return {
    ok: true,
    value: {
      ...requested,
      grants: requested.grants.map(copyGrant),
      modelRoles: [...requested.modelRoles],
      createdAt,
    },
  };
}

export function childCredentialNames(
  parent: SessionHeader,
  envelope: CapabilityEnvelope,
): readonly CredentialEnvName[] {
  const requested = new Set<CredentialEnvName>();
  for (const grant of envelope.grants) {
    if (grant.kind === "inject-credential") {
      for (const name of grant.credentialEnvNames) requested.add(name);
    }
  }
  return parent.credentialEnvNames.filter((name) => requested.has(name));
}

export function newChildIdentity(
  parentSessionId: SessionId,
  request: SpawnChildRequest,
): Pick<ChildSessionRecord, "childId" | "sessionId" | "parentSessionId" | "spawnEventId" | "role"> {
  return {
    childId: `child_${randomUUID()}` as ChildId,
    sessionId: `session_${randomUUID()}` as SessionId,
    parentSessionId,
    spawnEventId: `spawn_${randomUUID()}` as EventId,
    role: request.role,
  };
}

function grantIsSubset(requested: CapabilityGrant, parent: CapabilityGrant): boolean {
  if (requested.kind !== parent.kind) return false;
  if ((requested.kind === "read-files" || requested.kind === "write-files")
    && (parent.kind === "read-files" || parent.kind === "write-files")) {
    return requested.pathPrefixes.every((path) => parent.pathPrefixes.some((prefix) => pathWithin(path, prefix)));
  }
  if (requested.kind === "start-process" && parent.kind === "start-process") {
    return parent.executableNames.length === 0
      || (requested.executableNames.length > 0 && requested.executableNames.every((name) => parent.executableNames.includes(name)));
  }
  if (requested.kind === "network-egress" && parent.kind === "network-egress") {
    return parent.allowedHosts.length === 0
      ? requested.allowedHosts.length === 0
      : requested.allowedHosts.every((host) => parent.allowedHosts.includes(host));
  }
  if (requested.kind === "inject-credential" && parent.kind === "inject-credential") {
    return requested.credentialEnvNames.every((name) => parent.credentialEnvNames.includes(name));
  }
  return true;
}

function pathWithin(path: string, prefix: string): boolean {
  return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
}

function copyGrant(grant: CapabilityGrant): CapabilityGrant {
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
    default:
      return { kind: grant.kind };
  }
}

function denied(
  capability: CapabilityDeniedError["capability"],
  reason: string,
): { readonly ok: false; readonly error: CapabilityDeniedError } {
  return {
    ok: false,
    error: {
      kind: "capability-denied",
      capability,
      reason,
      recoverable: true,
      callerAction: "request-new-child",
    },
  };
}
