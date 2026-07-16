import type {
  CreateHarnessActivationService,
  HarnessActivationService,
  HarnessError,
  HarnessId,
  HarnessManifest,
  HarnessUpdate,
  ProjectId,
  Result,
  ScorecardId,
  Timestamp,
} from "../contracts/index.js";

export const createHarnessActivationService: CreateHarnessActivationService = (projects, harnesses) => {
  const activate = async (
    projectId: ProjectId,
    target: HarnessId,
    activationReason: HarnessUpdate["reason"],
    scorecardId: ScorecardId | null,
    requireAncestor: boolean,
  ): Promise<Result<HarnessUpdate, HarnessError>> => {
    const current = await harnesses.getActiveHarness(projectId);
    if (!current.ok) {
      return current;
    }
    const candidate = await harnesses.getHarness(target);
    if (!candidate.ok) {
      return candidate;
    }
    if (candidate.value.projectId !== projectId) {
      return validation("Target harness belongs to another project", "target");
    }
    if (current.value.id === candidate.value.id) {
      return conflict("project-active-harness", current.value.id, candidate.value.id);
    }
    if (requireAncestor) {
      const ancestor = await isAncestor(current.value, candidate.value.id, harnesses);
      if (!ancestor.ok) {
        return ancestor;
      }
      if (!ancestor.value) {
        return validation("Rollback target must be an ancestor of the active harness", "target");
      }
    }
    const advanced = await projects.compareAndSetActiveHarness(projectId, current.value.id, candidate.value.id);
    if (!advanced.ok) {
      return advanced;
    }
    return {
      ok: true,
      value: {
        projectId,
        previousHarnessId: current.value.id,
        activeHarnessId: candidate.value.id,
        reason: activationReason,
        scorecardId,
        activatedAt: new Date().toISOString() as Timestamp,
      },
    };
  };

  const service: HarnessActivationService = {
    async promote(scorecard) {
      const incumbent = await harnesses.getHarness(scorecard.incumbentHarnessId);
      if (!incumbent.ok) {
        return incumbent;
      }
      const candidate = await harnesses.getHarness(scorecard.candidateHarnessId);
      if (!candidate.ok) {
        return candidate;
      }
      if (scorecard.decision.outcome !== "promote" || scorecard.evaluatorHarnessId !== incumbent.value.id
        || scorecard.projectId !== incumbent.value.projectId || candidate.value.projectId !== scorecard.projectId) {
        return validation("Promotion authority must be a promote decision evaluated by the incumbent for one project", "scorecard");
      }
      if (!candidate.value.parents.includes(incumbent.value.id)) {
        return validation("Promoted candidate must directly descend from the incumbent", "scorecard.candidateHarnessId");
      }
      const active = await harnesses.getActiveHarness(scorecard.projectId);
      if (!active.ok) {
        return active;
      }
      if (active.value.id !== incumbent.value.id) {
        return {
          ok: false,
          error: {
            kind: "harness-version-mismatch",
            expected: incumbent.value.id,
            active: active.value.id,
            recoverable: true,
            callerAction: "refresh-version-and-retry",
          },
        };
      }
      return activate(scorecard.projectId, candidate.value.id, "promotion", scorecard.id, false);
    },

    async pin(projectId, target, reason) {
      if (reason.trim().length === 0) {
        return validation("Pin reason must not be empty", "reason");
      }
      return activate(projectId, target, "manual-pin", null, false);
    },

    async rollback(projectId, target, reason) {
      if (reason.trim().length === 0) {
        return validation("Rollback reason must not be empty", "reason");
      }
      return activate(projectId, target, "rollback", null, true);
    },
  };
  return service;
};

async function isAncestor(
  current: HarnessManifest,
  target: HarnessId,
  harnesses: Parameters<CreateHarnessActivationService>[1],
): Promise<Result<boolean, HarnessError>> {
  const pending = [...current.parents];
  const visited = new Set<HarnessId>();
  while (pending.length > 0) {
    const id = pending.shift();
    if (id === undefined || visited.has(id)) {
      continue;
    }
    if (id === target) {
      return { ok: true, value: true };
    }
    visited.add(id);
    const parent = await harnesses.getHarness(id);
    if (!parent.ok) {
      return parent;
    }
    if (parent.value.projectId !== current.projectId) {
      return validation("Harness lineage crosses a project boundary", "parents");
    }
    pending.push(...parent.value.parents);
  }
  return { ok: true, value: false };
}

function validation(message: string, field: string | null): Result<never, HarnessError> {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}

function conflict(resource: string, expected: string, actual: string): Result<never, HarnessError> {
  return { ok: false, error: { kind: "conflict", resource, expected, actual, recoverable: true, callerAction: "refresh-version-and-retry" } };
}
