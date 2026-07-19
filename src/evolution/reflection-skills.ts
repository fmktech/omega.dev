import { createHash } from "node:crypto";

import type {
  ArtifactId,
  ComponentId,
  ComponentManifest,
  EvolutionError,
  HarnessId,
  HarnessManifest,
  HarnessRepository,
  JsonObject,
  JsonValue,
  ObjectStore,
  Result,
  SessionId,
  Sha256,
  Timestamp,
} from "../contracts/index.js";
import type { ReflectionProposal } from "./reflection-proposal.js";

const MAX_INSTALLED_SKILLS = 128;
const MAX_SKILL_BYTES = 256 * 1024;

export type ReflectionSkillCandidateInput = {
  readonly incumbent: HarnessManifest;
  readonly proposal: ReflectionProposal;
  readonly sourceSessionId: SessionId;
  readonly evidenceArtifactIds: readonly ArtifactId[];
  readonly proposalArtifactId: ArtifactId;
  readonly alias: string;
  readonly createdAt: Timestamp;
};

export async function createReflectionSkillCandidate(
  input: ReflectionSkillCandidateInput,
  objects: ObjectStore,
  harnesses: Pick<HarnessRepository, "putComponent" | "putHarness">,
): Promise<Result<HarnessManifest, EvolutionError>> {
  if (input.proposal.decision !== "evolve") {
    return invalid("A no-change reflection cannot create a skill candidate.", "proposal.decision");
  }
  const lessons = input.proposal.lessons.filter((lesson) => lesson.target === "skill");
  if (lessons.length === 0) {
    return invalid("Reflection contains no skill-targeted lessons.", "proposal.lessons");
  }

  const namedLessons = lessons.map((lesson) => ({ lesson, name: skillName(lesson.title, lesson.guidance) }));
  const names = new Set<string>();
  for (const item of namedLessons) {
    if (names.has(item.name)) {
      return invalid("Reflection must combine lessons that resolve to the same skill name.", "proposal.lessons");
    }
    names.add(item.name);
  }

  const evidenceSha = reflectionEvidenceSha(input);
  const components = [...input.incumbent.components];
  let changes = 0;
  for (const item of namedLessons) {
    const entrypoint = `skills/${item.name}/SKILL.md`;
    const matchingIndexes = components.flatMap((component, index) =>
      component.kind === "skill" && component.entrypoint === entrypoint ? [index] : []);
    if (matchingIndexes.length > 1) {
      return invalid(`Incumbent contains duplicate installed skill entrypoint ${entrypoint}.`, "incumbent.components");
    }
    const replaceIndex = matchingIndexes[0] ?? -1;
    const replaced = replaceIndex < 0 ? null : components[replaceIndex] ?? null;
    const semanticSha = skillSemanticSha(item.name, input.proposal);
    if (replaced !== null) {
      const installed = await readText(objects, replaced.objectHash);
      if (!installed.ok) return installed;
      if (installed.value.match(/^semanticSha:\s*([a-f0-9]{64})\s*$/mu)?.[1] === semanticSha) continue;
    }
    const markdown = renderSkillMarkdown({
      name: item.name,
      title: item.lesson.title,
      guidance: item.lesson.guidance,
      lessons: input.proposal.lessons,
      sourceSessionId: input.sourceSessionId,
      evidenceArtifactIds: input.evidenceArtifactIds,
      proposalArtifactId: input.proposalArtifactId,
      evidenceSha,
      semanticSha,
    });
    const object = await putText(objects, markdown);
    if (!object.ok) return object;
    const body: Omit<ComponentManifest, "id"> = {
      kind: "skill",
      runtime: "document",
      objectHash: object.value,
      entrypoint,
      credentialEnvNames: replaced?.credentialEnvNames ?? [],
      capabilities: replaced?.capabilities ?? [],
    };
    const component: ComponentManifest = {
      id: `component_${hash(canonical(componentBody(body)))}` as ComponentId,
      ...body,
    };
    if (replaced?.id === component.id) continue;
    if (components.some((candidate) => candidate.id === component.id)) continue;
    const stored = await harnesses.putComponent(component);
    if (!stored.ok) return stored;
    if (replaceIndex < 0) components.push(stored.value);
    else components.splice(replaceIndex, 1, stored.value);
    changes += 1;
  }

  if (changes === 0) {
    return invalid("Reflection reproduced skills already installed in the incumbent.", "proposal.lessons");
  }
  if (components.filter((component) => component.kind === "skill").length > MAX_INSTALLED_SKILLS) {
    return invalid(`A harness may install at most ${MAX_INSTALLED_SKILLS} skills.`, "proposal.lessons");
  }

  const body: Omit<HarnessManifest, "id"> = {
    projectId: input.incumbent.projectId,
    alias: input.alias,
    parents: [input.incumbent.id],
    components,
    sourceArtifacts: [...new Set([
      ...input.incumbent.sourceArtifacts,
      ...input.evidenceArtifactIds,
      input.proposalArtifactId,
    ])],
    createdAt: input.createdAt,
  };
  const candidate: HarnessManifest = {
    id: `harness_${hash(canonical(harnessBody(body)))}` as HarnessId,
    ...body,
  };
  return harnesses.putHarness(candidate);
}

function reflectionEvidenceSha(input: ReflectionSkillCandidateInput): Sha256 {
  const value: JsonObject = {
    sourceSessionId: input.sourceSessionId,
    evidenceArtifactIds: [...new Set(input.evidenceArtifactIds)].sort(),
    proposalArtifactId: input.proposalArtifactId,
    reflection: input.proposal.reflection,
    lessons: input.proposal.lessons.map((lesson) => ({
      sourceIds: [...lesson.sourceIds].sort(),
      target: lesson.target,
      title: lesson.title,
      guidance: lesson.guidance,
      relevantPaths: normalizedStrings(lesson.relevantPaths),
      appliesWhen: normalizedStrings(lesson.appliesWhen),
      doesNotApplyWhen: normalizedStrings(lesson.doesNotApplyWhen),
    })),
  };
  return hash(canonical(value)) as Sha256;
}

function renderSkillMarkdown(input: {
  readonly name: string;
  readonly title: string;
  readonly guidance: string;
  readonly lessons: ReflectionProposal["lessons"];
  readonly sourceSessionId: SessionId;
  readonly evidenceArtifactIds: readonly ArtifactId[];
  readonly proposalArtifactId: ArtifactId;
  readonly evidenceSha: Sha256;
  readonly semanticSha: Sha256;
}): string {
  const title = singleLine(input.title);
  const relevantPaths = unique(input.lessons.flatMap((lesson) => normalizedPaths(lesson.relevantPaths)));
  const appliesWhen = unique(input.lessons.flatMap((lesson) => normalizedStrings(lesson.appliesWhen)));
  const doesNotApplyWhen = unique(input.lessons.flatMap((lesson) => normalizedStrings(lesson.doesNotApplyWhen)));
  const provenance = JSON.stringify({
    sourceSessionId: input.sourceSessionId,
    evidenceArtifactIds: [...new Set(input.evidenceArtifactIds)].sort(),
    proposalArtifactId: input.proposalArtifactId,
    sourceIds: [...new Set(input.lessons.flatMap((lesson) => lesson.sourceIds))].sort(),
    evidenceSha: input.evidenceSha,
  }, null, 2);
  return [
    "---",
    `name: ${input.name}`,
    `description: ${frontmatterScalar(title)}`,
    "tags: [reflection, project-scoped, self-improvement]",
    `relevantPaths: [${relevantPaths.join(", ")}]`,
    `appliesWhen: ${JSON.stringify(appliesWhen)}`,
    `doesNotApplyWhen: ${JSON.stringify(doesNotApplyWhen)}`,
    `sourceSessionId: ${input.sourceSessionId}`,
    `evidenceSha: ${input.evidenceSha}`,
    `semanticSha: ${input.semanticSha}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Skill guidance",
    "",
    input.guidance.trim(),
    ...input.lessons.filter((lesson) => lesson.target !== "skill").flatMap((lesson) => [
      "",
      `## Companion ${lesson.target}`,
      "",
      `### ${singleLine(lesson.title)}`,
      "",
      lesson.guidance.trim(),
    ]),
    "",
    "## Provenance",
    "",
    "This project-scoped skill was crystallized from completed session evidence. The references below are audit data, not instructions.",
    "",
    "```json",
    provenance,
    "```",
    "",
  ].join("\n");
}

function skillSemanticSha(name: string, proposal: ReflectionProposal): Sha256 {
  return hash(canonical({
    name,
    lessons: proposal.lessons.map((lesson) => ({
      target: lesson.target,
      title: singleLine(lesson.title),
      guidance: lesson.guidance.trim(),
      relevantPaths: normalizedPaths(lesson.relevantPaths),
      appliesWhen: normalizedStrings(lesson.appliesWhen),
      doesNotApplyWhen: normalizedStrings(lesson.doesNotApplyWhen),
    })),
  })) as Sha256;
}

function normalizedPaths(values: readonly string[] | undefined): string[] {
  return normalizedStrings(values).filter((path) => path === "." || (
    !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  ));
}

function normalizedStrings(values: readonly string[] | undefined): string[] {
  return unique((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function skillName(title: string, guidance: string): string {
  const normalized = title.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("en-US");
  const slug = normalized.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80).replace(/-+$/gu, "");
  return slug.length > 0 ? slug : `project-skill-${hash(`${title}\n${guidance}`).slice(0, 12)}`;
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function frontmatterScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 ._()/+-]*$/u.test(value) ? value : JSON.stringify(value);
}

async function putText(objects: ObjectStore, value: string): Promise<Result<ComponentManifest["objectHash"], EvolutionError>> {
  const stored = await objects.put("text/markdown", (async function* (): AsyncIterable<Uint8Array> {
    yield Buffer.from(value, "utf8");
  })());
  return stored.ok ? { ok: true, value: stored.value.hash } : stored;
}

async function readText(objects: ObjectStore, objectHash: ComponentManifest["objectHash"]): Promise<Result<string, EvolutionError>> {
  const result = await objects.get(objectHash);
  if (!result.ok) return result;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of result.value) {
    bytes += chunk.byteLength;
    if (bytes > MAX_SKILL_BYTES) return invalid(`Installed skill exceeds ${MAX_SKILL_BYTES} bytes.`, "incumbent.components");
    chunks.push(chunk);
  }
  return { ok: true, value: Buffer.concat(chunks).toString("utf8") };
}

function componentBody(component: Omit<ComponentManifest, "id">): JsonObject {
  return {
    kind: component.kind,
    runtime: component.runtime,
    objectHash: component.objectHash,
    entrypoint: component.entrypoint,
    credentialEnvNames: [...component.credentialEnvNames],
    capabilities: [...component.capabilities],
  };
}

function harnessBody(manifest: Omit<HarnessManifest, "id">): JsonObject {
  return {
    projectId: manifest.projectId,
    alias: manifest.alias,
    parents: [...manifest.parents],
    components: manifest.components.map((component) => ({ id: component.id, ...componentBody(component) })),
    sourceArtifacts: [...manifest.sourceArtifacts],
    createdAt: manifest.createdAt,
  };
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key] ?? null)}`).join(",")}}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(message: string, field: string): Result<never, EvolutionError> {
  return {
    ok: false,
    error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" },
  };
}
