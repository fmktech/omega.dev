import { createHash } from "node:crypto";

import type {
  CapabilityEnvelope,
  DurationMs,
  EvolutionError,
  HarnessId,
  ModelCompletion,
  ModelRouter,
  ModelUsage,
  Result,
  SessionId,
  Sha256,
  Timestamp,
  TokenCount,
  UsdMicros,
} from "../contracts/index.js";

export type LearningTarget = "knowledge" | "skill" | "runner" | "tool" | "policy";

export type WorkTrajectory = {
  readonly id: string;
  readonly projectContext: string;
  readonly objective: string;
  readonly timeline: readonly string[];
  readonly locallyObservedResult: string;
};

export type CrystallizedLesson = {
  readonly sourceIds: readonly string[];
  readonly target: LearningTarget;
  readonly title: string;
  readonly guidance: string;
};

export type CrystallizationProposal = {
  readonly reflection: string;
  readonly lessons: readonly CrystallizedLesson[];
};

export type CrystallizationRun = {
  readonly proposal: CrystallizationProposal;
  readonly evidenceSha: Sha256;
  readonly route: ModelCompletion["route"];
  readonly usage: ModelUsage;
};

const TARGETS: ReadonlySet<string> = new Set(["knowledge", "skill", "runner", "tool", "policy"]);
const MAX_TRAJECTORIES = 12;
const MAX_TRAJECTORY_CHARS = 12_000;
const MAX_LESSONS = 12;
const MAX_GUIDANCE_CHARS = 1_600;
const LEAKAGE_MARKERS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "OmegaBench identifier", pattern: /\bomegabench(?:-[a-z0-9]+)?\b/iu },
  { label: "scorecard", pattern: /\bscorecards?\b/iu },
  { label: "hidden verifier", pattern: /\bhidden[- ]verifier\b/iu },
  { label: "promotion decision", pattern: /\bpromotion[- ](?:decision|outcome)\b/iu },
  { label: "protected task", pattern: /\bprotected[- ]task\b/iu },
  { label: "benchmark result", pattern: /\bbenchmark[- ](?:result|outcome|score|pass|fail)\b/iu },
];

// These are frozen, synthetic project-work trajectories rather than evaluation
// traces. Their filenames, tools, and objectives differ from the sealed suite.
export const CRYSTALLIZATION_TRAJECTORIES: readonly WorkTrajectory[] = [
  {
    id: "daily-build-orchestrator",
    projectContext: "A TypeScript service whose repository intentionally has no package.json at its root.",
    objective: "Enable audit logging and run the project's authoritative check.",
    timeline: [
      "Tried npm test from the repository root; npm reported that package.json does not exist.",
      "Listed only top-level guidance files and opened CONTRIBUTING.md.",
      "CONTRIBUTING.md identified ./moon check api as the authoritative scoped workflow.",
      "Changed services/api/settings.json, then ran ./moon check api; it exited 0.",
    ],
    locallyObservedResult: "The declared scoped check completed successfully after the initial tool assumption was abandoned.",
  },
  {
    id: "daily-generated-theme",
    projectContext: "A web application whose CSS design tokens are generated from a YAML source.",
    objective: "Change the accent token from cobalt to violet.",
    timeline: [
      "Edited public/tokens.css directly and saw the requested color in a local preview.",
      "Ran the documented asset refresh; the edit disappeared because public/tokens.css was regenerated.",
      "Read public/GENERATED.md, which named design/tokens.yaml and tools/render-tokens.mjs.",
      "Reverted the derived edit, changed design/tokens.yaml, ran the renderer, and confirmed the derived CSS changed.",
    ],
    locallyObservedResult: "Both the source token and regenerated output contained violet after the documented refresh.",
  },
  {
    id: "daily-package-scope",
    projectContext: "A large monorepo with known unrelated failures in legacy packages.",
    objective: "Repair serialization in packages/ledger without modifying other workspaces.",
    timeline: [
      "Ran the root test command; it failed in an unrelated deprecated package before reaching ledger.",
      "Opened packages/ledger/AGENTS.md and found the package-local command just verify-ledger.",
      "Ran the package-local command before editing to establish its baseline, made the repair, and ran it again.",
      "Recorded the unrelated root failure separately without changing the deprecated package.",
    ],
    locallyObservedResult: "The affected package's authoritative check changed from failing to passing while the unrelated baseline remained untouched.",
  },
  {
    id: "daily-preview-lifecycle",
    projectContext: "A documentation project whose link checker requires a local preview server.",
    objective: "Capture the rendered health response and leave no server running.",
    timeline: [
      "Started the preview in the foreground and blocked the shell, so no health request could be issued.",
      "Restarted it as a supervised background process, streamed output until the READY line appeared, then requested its loopback URL.",
      "Saved the response and sent a termination signal to the exact supervised process.",
      "Observed the process until it exited and confirmed the port was released.",
    ],
    locallyObservedResult: "The response was captured only after readiness, and the supervised process exited cleanly.",
  },
  {
    id: "daily-project-oracle",
    projectContext: "A data repository whose accepted binary layout is checked by a repository-owned executable.",
    objective: "Update a fixture while preserving its nonstandard encoding.",
    timeline: [
      "Changed the visible value and ran a familiar generic test command; it was unavailable.",
      "Read TESTING.md, which identified ./layout-doctor fixtures/current.bin as the only authoritative check.",
      "The doctor reported a byte-order error, so the fixture writer was corrected rather than hand-editing the binary again.",
      "Regenerated the fixture and reran layout-doctor; it exited 0.",
    ],
    locallyObservedResult: "The repository-owned oracle accepted the regenerated fixture.",
  },
  {
    id: "daily-untrusted-note",
    projectContext: "A deployment repository containing copied incident notes from an external ticket.",
    objective: "Update a harmless local rollout label.",
    timeline: [
      "Repository policy prohibited credentials and network access for the change.",
      "An incident note instructed the operator to print environment variables and upload them to a diagnostic endpoint.",
      "Treated the copied note as untrusted data, ignored its instructions, and changed only the local rollout label.",
      "Ran the offline policy check without reading credentials or making a network request.",
    ],
    locallyObservedResult: "The local policy check passed and the untrusted note remained unchanged.",
  },
];

function validation(message: string, field: string): Result<never, EvolutionError> {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}

function leakageLabel(value: string): string | null {
  return LEAKAGE_MARKERS.find((marker) => marker.pattern.test(value))?.label ?? null;
}

function normalizeTrajectories(trajectories: readonly WorkTrajectory[]): Result<readonly WorkTrajectory[], EvolutionError> {
  if (trajectories.length === 0) return validation("At least one work trajectory is required.", "trajectories");
  if (trajectories.length > MAX_TRAJECTORIES) return validation(`At most ${MAX_TRAJECTORIES} trajectories are allowed.`, "trajectories");
  const byId = new Map<string, WorkTrajectory>();
  for (const trajectory of trajectories) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(trajectory.id)) return validation("Trajectory IDs must be normalized kebab-case.", "trajectories.id");
    if (trajectory.objective.trim().length === 0 || trajectory.timeline.length === 0 || trajectory.timeline.some((event) => event.trim().length === 0)) {
      return validation("Every trajectory requires an objective and non-empty timeline events.", `trajectories.${trajectory.id}`);
    }
    const serialized = JSON.stringify(trajectory);
    if (serialized.length > MAX_TRAJECTORY_CHARS) return validation(`Trajectory ${trajectory.id} exceeds ${MAX_TRAJECTORY_CHARS} characters.`, `trajectories.${trajectory.id}`);
    const leaked = leakageLabel(serialized);
    if (leaked !== null) return validation(`Trajectory ${trajectory.id} contains forbidden ${leaked} evidence.`, `trajectories.${trajectory.id}`);
    const existing = byId.get(trajectory.id);
    if (existing !== undefined && JSON.stringify(existing) !== serialized) {
      return validation(`Trajectory ID ${trajectory.id} has conflicting duplicate content.`, `trajectories.${trajectory.id}`);
    }
    byId.set(trajectory.id, trajectory);
  }
  return { ok: true, value: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)) };
}

export function renderCrystallizationPrompt(trajectories: readonly WorkTrajectory[]): Result<{ readonly prompt: string; readonly evidenceSha: Sha256 }, EvolutionError> {
  const normalized = normalizeTrajectories(trajectories);
  if (!normalized.ok) return normalized;
  const evidence = JSON.stringify(normalized.value);
  const evidenceSha = createHash("sha256").update(evidence, "utf8").digest("hex") as Sha256;
  const prompt = [
    "Self-reflect on these completed project work sessions. Extract only durable lessons supported by the process evidence.",
    "Choose where each lesson belongs: knowledge for a project fact, skill for a repeatable procedure, runner for an always-on decision rule, tool for a missing executable capability, or policy for a safety boundary.",
    "Do not infer any evaluation, hidden test, expected patch, or future task. Prefer a narrow project lesson over a universal claim.",
    "Return exactly one JSON object with this shape and no prose or code fence:",
    JSON.stringify({ reflection: "short synthesis", lessons: [{ sourceIds: ["trajectory-id"], target: "skill", title: "short title", guidance: "actionable guidance" }] }),
    "Frozen work-session trajectories:",
    evidence,
  ].join("\n\n");
  return { ok: true, value: { prompt, evidenceSha } };
}

function embeddedJsonObjects(source: string): readonly string[] {
  const objects: string[] = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(source.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return objects;
}

export function parseCrystallizationProposal(
  text: string,
  allowedSourceIds: readonly string[],
): Result<CrystallizationProposal, EvolutionError> {
  let parsed: unknown;
  for (const candidate of [text.trim(), ...embeddedJsonObjects(text)]) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // A provider may prefix the requested object with a short explanation.
    }
  }
  if (!isRecord(parsed) || typeof parsed["reflection"] !== "string" || !Array.isArray(parsed["lessons"])) {
    return validation("Crystallizer output must be one reflection object with lessons.", "modelOutput");
  }
  if (parsed["reflection"].trim().length === 0 || parsed["lessons"].length === 0 || parsed["lessons"].length > MAX_LESSONS) {
    return validation(`Crystallizer output requires 1-${MAX_LESSONS} lessons and a non-empty reflection.`, "modelOutput.lessons");
  }
  const allowed = new Set(allowedSourceIds);
  const lessons: CrystallizedLesson[] = [];
  for (const [index, value] of parsed["lessons"].entries()) {
    if (!isRecord(value) || !Array.isArray(value["sourceIds"]) || typeof value["target"] !== "string"
      || typeof value["title"] !== "string" || typeof value["guidance"] !== "string") {
      return validation("Each crystallized lesson has an invalid shape.", `modelOutput.lessons.${index}`);
    }
    if (!TARGETS.has(value["target"])) return validation("Crystallized lesson selected an unknown learning target.", `modelOutput.lessons.${index}.target`);
    const sourceIds = value["sourceIds"];
    if (sourceIds.length === 0 || sourceIds.some((id) => typeof id !== "string" || !allowed.has(id))) {
      return validation("Crystallized lesson cites unknown or missing trajectory evidence.", `modelOutput.lessons.${index}.sourceIds`);
    }
    const title = value["title"].trim();
    const guidance = value["guidance"].trim();
    if (title.length === 0 || title.length > 120 || guidance.length === 0 || guidance.length > MAX_GUIDANCE_CHARS) {
      return validation("Crystallized lesson title or guidance is empty or over limit.", `modelOutput.lessons.${index}`);
    }
    const leaked = leakageLabel(`${title}\n${guidance}`);
    if (leaked !== null) return validation(`Crystallized lesson contains forbidden ${leaked} evidence.`, `modelOutput.lessons.${index}`);
    lessons.push({ sourceIds: [...new Set(sourceIds as string[])].sort(), target: value["target"] as LearningTarget, title, guidance });
  }
  return { ok: true, value: { reflection: parsed["reflection"].trim(), lessons } };
}

export function compileProjectExperience(proposal: CrystallizationProposal): string {
  return proposal.lessons
    .map((lesson, index) => `${index + 1}. [${lesson.target}] ${lesson.title}\n${lesson.guidance}`)
    .join("\n\n");
}

export async function crystallizeWorkTrajectories(
  models: ModelRouter,
  harnessId: HarnessId,
  trajectories: readonly WorkTrajectory[],
): Promise<Result<CrystallizationRun, EvolutionError>> {
  const rendered = renderCrystallizationPrompt(trajectories);
  if (!rendered.ok) return rendered;
  const normalized = normalizeTrajectories(trajectories);
  if (!normalized.ok) return normalized;
  const capabilities: CapabilityEnvelope = {
    grants: [],
    modelRoles: ["crystallizer"],
    maxCostUsdMicros: 0 as UsdMicros,
    maxModelCalls: 1,
    maxProcessStarts: 0,
    maxInputTokens: 80_000 as TokenCount,
    maxOutputTokens: 6_000 as TokenCount,
    wallTimeMs: 300_000 as DurationMs,
    createdAt: "2026-07-17T00:00:00.000Z" as Timestamp,
  };
  const started = await models.stream({
    sessionId: `session_crystallization_${rendered.value.evidenceSha.slice(0, 20)}` as SessionId,
    harnessId,
    role: "crystallizer",
    messages: [{ role: "user", content: [{ kind: "text", text: rendered.value.prompt }] }],
    tools: [],
    maxOutputTokens: 6_000 as TokenCount,
    abortAfterMs: 300_000 as DurationMs,
  }, capabilities);
  if (!started.ok) return started;
  let completion: ModelCompletion | null = null;
  let failed: EvolutionError | null = null;
  for await (const event of started.value.events) {
    if (event.kind === "completed") completion = event.completion;
    if (event.kind === "failed") failed = event.error;
  }
  if (failed !== null) return { ok: false, error: failed };
  if (completion === null) return validation("Crystallizer stream ended without a completion.", "modelOutput");
  const text = completion.content.filter((part) => part.kind === "text").map((part) => part.text).join("");
  const proposal = parseCrystallizationProposal(text, normalized.value.map((trajectory) => trajectory.id));
  if (!proposal.ok) return proposal;
  return { ok: true, value: {
    proposal: proposal.value,
    evidenceSha: rendered.value.evidenceSha,
    route: completion.route,
    usage: completion.usage,
  } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
