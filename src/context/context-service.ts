import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  ComponentManifest,
  ContextError,
  CreateContextService,
  HarnessManifest,
  ObjectStore,
  ProjectInstruction,
  RelativePath,
  Result,
  Sha256,
  SkillCatalogEntry,
  SkillDocument,
  WorkspaceRecord,
} from "../contracts/index.js";

const AGENTS_FILE = "AGENTS.md";
const MAX_INSTRUCTION_FILES = 64;
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const MAX_TOTAL_INSTRUCTION_BYTES = 256 * 1024;
const MAX_INSTALLED_SKILLS = 128;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_BOOTSTRAP_BYTES = 512 * 1024;
const MAX_SKILL_NAME_CHARS = 120;
const MAX_SKILL_DESCRIPTION_CHARS = 500;
const MAX_SKILL_TAGS = 32;
const MAX_SKILL_PATHS = 64;
const MAX_SKILL_APPLICABILITY_ITEMS = 32;
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn", ".omega", ".next", ".turbo", "build", "coverage", "dist", "node_modules", "vendor",
]);

type SkillFrontmatter = ReadonlyMap<string, string | readonly string[]>;

export const createContextService: CreateContextService = ({ objects, knowledge, harnesses }) => ({
  async bootstrap(workspace, harness) {
    if (workspace.projectId !== harness.projectId) {
      return validation("Workspace and harness must belong to the same project", "workspace.projectId");
    }
    const instructions = await discoverInstructions(workspace);
    if (!instructions.ok) return instructions;
    const knowledgeCatalog = await knowledge.catalog({
      projectId: workspace.projectId,
      text: "",
      tags: [],
      relevantPaths: [],
      limit: 100,
    });
    if (!knowledgeCatalog.ok) return knowledgeCatalog;
    const skillCatalog = await installedSkillCatalog(objects, harness);
    if (!skillCatalog.ok) return skillCatalog;
    const value = {
      instructions: instructions.value,
      knowledgeCatalog: knowledgeCatalog.value,
      skillCatalog: skillCatalog.value,
    };
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BOOTSTRAP_BYTES) {
      return validation(`Serialized bootstrap context exceeds ${MAX_BOOTSTRAP_BYTES} bytes`, "context.bootstrap");
    }
    return {
      ok: true,
      value,
    };
  },

  async readSkill(harnessId, componentId) {
    const harness = await harnesses.getHarness(harnessId);
    if (!harness.ok) return harness;
    const component = harness.value.components.find((candidate) => candidate.id === componentId);
    if (component === undefined || component.kind !== "skill") {
      return validation("Requested component is not an installed skill in this harness", "componentId");
    }
    return readSkillDocument(objects, component);
  },
});

async function discoverInstructions(workspace: WorkspaceRecord): Promise<Result<readonly ProjectInstruction[], ContextError>> {
  const instructions: ProjectInstruction[] = [];
  let totalBytes = 0;

  async function visit(absoluteDirectory: string, relativeDirectory: string): Promise<Result<void, ContextError>> {
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      return io("discover project instructions", error);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const agents = entries.find((entry) => entry.name === AGENTS_FILE && entry.isFile() && !entry.isSymbolicLink());
    if (agents !== undefined) {
      if (instructions.length >= MAX_INSTRUCTION_FILES) {
        return validation(`A workspace may contain at most ${MAX_INSTRUCTION_FILES} ${AGENTS_FILE} files`, "workspace.path");
      }
      const path = relativeDirectory.length === 0 ? AGENTS_FILE : `${relativeDirectory}/${AGENTS_FILE}`;
      const content = await readBoundedFile(join(absoluteDirectory, AGENTS_FILE), MAX_INSTRUCTION_BYTES);
      if (!content.ok) return content;
      totalBytes += Buffer.byteLength(content.value, "utf8");
      if (totalBytes > MAX_TOTAL_INSTRUCTION_BYTES) {
        return validation(`Combined ${AGENTS_FILE} content exceeds ${MAX_TOTAL_INSTRUCTION_BYTES} bytes`, "workspace.path");
      }
      instructions.push({
        path: path as RelativePath,
        scope: (relativeDirectory.length === 0 ? "." : relativeDirectory) as RelativePath,
        content: content.value,
        sha: sha256(content.value),
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const relative = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      const nested = await visit(join(absoluteDirectory, entry.name), relative);
      if (!nested.ok) return nested;
    }
    return { ok: true, value: undefined };
  }

  const visited = await visit(String(workspace.path), "");
  return visited.ok ? { ok: true, value: instructions } : visited;
}

async function installedSkillCatalog(
  objects: ObjectStore,
  harness: HarnessManifest,
): Promise<Result<readonly SkillCatalogEntry[], ContextError>> {
  const skills = harness.components.filter((component) => component.kind === "skill");
  if (skills.length > MAX_INSTALLED_SKILLS) {
    return validation(`A harness may install at most ${MAX_INSTALLED_SKILLS} skills`, "harness.components");
  }
  const catalog: SkillCatalogEntry[] = [];
  for (const component of skills) {
    const document = await readSkillDocument(objects, component);
    if (!document.ok) return document;
    catalog.push(document.value.catalog);
  }
  catalog.sort((left, right) => left.name.localeCompare(right.name) || left.componentId.localeCompare(right.componentId));
  return { ok: true, value: catalog };
}

async function readSkillDocument(objects: ObjectStore, component: ComponentManifest): Promise<Result<SkillDocument, ContextError>> {
  const markdown = await readObjectText(objects, component.objectHash, MAX_SKILL_BYTES);
  if (!markdown.ok) return markdown;
  const catalog = skillCatalogEntry(component, markdown.value);
  if (!catalog.ok) return catalog;
  return {
    ok: true,
    value: {
      componentId: component.id,
      objectHash: component.objectHash,
      catalog: catalog.value,
      markdown: markdown.value,
    },
  };
}

function skillCatalogEntry(component: ComponentManifest, markdown: string): Result<SkillCatalogEntry, ContextError> {
  const frontmatter = parseSkillFrontmatter(markdown);
  if (!frontmatter.ok) return frontmatter;
  const name = scalar(frontmatter.value, "name") ?? String(component.id);
  const description = scalar(frontmatter.value, "description") ?? fallbackDescription(markdown);
  if (name.trim().length === 0 || name.trim().length > MAX_SKILL_NAME_CHARS
    || description.trim().length === 0 || description.trim().length > MAX_SKILL_DESCRIPTION_CHARS) {
    return validation("Skill name or description is empty or exceeds its catalog bound", "skill.frontmatter");
  }
  const tags = array(frontmatter.value, "tags");
  const relevantPaths = array(frontmatter.value, "relevantPaths");
  const appliesWhen = array(frontmatter.value, "appliesWhen");
  const doesNotApplyWhen = array(frontmatter.value, "doesNotApplyWhen");
  if (tags.length > MAX_SKILL_TAGS || relevantPaths.length > MAX_SKILL_PATHS
    || appliesWhen.length > MAX_SKILL_APPLICABILITY_ITEMS || doesNotApplyWhen.length > MAX_SKILL_APPLICABILITY_ITEMS) {
    return validation("Skill catalog metadata exceeds its item bounds", "skill.frontmatter");
  }
  if (relevantPaths.some((path) => !isRelativePath(path))) {
    return validation("Skill relevantPaths must be repository-relative POSIX paths", "skill.frontmatter.relevantPaths");
  }
  return {
    ok: true,
    value: {
      componentId: component.id,
      name: name.trim(),
      description: description.trim(),
      tags: unique(tags),
      relevantPaths: unique(relevantPaths) as readonly RelativePath[],
      appliesWhen: unique(appliesWhen),
      doesNotApplyWhen: unique(doesNotApplyWhen),
    },
  };
}

function parseSkillFrontmatter(markdown: string): Result<SkillFrontmatter, ContextError> {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") return { ok: true, value: new Map() };
  const closing = lines.indexOf("---", 1);
  if (closing < 0) return validation("Skill Markdown frontmatter is not closed", "skill.markdown");
  const values = new Map<string, string | readonly string[]>();
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(line);
    if (match === null || match[1] === undefined) return validation(`Unsupported skill frontmatter line: ${line}`, "skill.markdown");
    const key = match[1];
    if (values.has(key)) return validation(`Duplicate skill frontmatter field: ${key}`, "skill.markdown");
    const raw = (match[2] ?? "").trim();
    if (raw.length > 0) {
      values.set(key, parseInline(raw));
      continue;
    }
    const items: string[] = [];
    while (index + 1 < closing) {
      const next = lines[index + 1];
      const item = next === undefined ? null : /^\s+-\s+(.+)$/u.exec(next);
      if (item?.[1] === undefined) break;
      items.push(unquote(item[1].trim()));
      index += 1;
    }
    values.set(key, items);
  }
  return { ok: true, value: values };
}

function parseInline(value: string): string | readonly string[] {
  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
    } catch {
      // YAML flow arrays may use unquoted simple scalars; parse those below.
    }
    const body = value.slice(1, -1).trim();
    return body.length === 0 ? [] : body.split(",").map((item) => unquote(item.trim()));
  }
  return unquote(value);
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function scalar(values: SkillFrontmatter, key: string): string | null {
  const value = values.get(key);
  return typeof value === "string" ? value : null;
}

function array(values: SkillFrontmatter, key: string): readonly string[] {
  const value = values.get(key);
  return Array.isArray(value) ? value : [];
}

function fallbackDescription(markdown: string): string {
  const body = markdown.startsWith("---") ? markdown.slice(markdown.indexOf("\n---", 3) + 4) : markdown;
  const line = body.split("\n").map((candidate) => candidate.trim()).find((candidate) => candidate.length > 0);
  return (line ?? "Installed project skill").replace(/^#+\s*/u, "").slice(0, 240);
}

async function readBoundedFile(path: string, limit: number): Promise<Result<string, ContextError>> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return validation(`Instruction file exceeds ${limit} bytes or is not regular`, "workspace.path");
    return { ok: true, value: await handle.readFile("utf8") };
  } catch (error) {
    return io("read project instruction", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readObjectText(objects: ObjectStore, hash: ComponentManifest["objectHash"], limit: number): Promise<Result<string, ContextError>> {
  const descriptor = await objects.describe(hash);
  if (!descriptor.ok) return descriptor;
  if (Number(descriptor.value.size) > limit) return validation(`Skill document exceeds ${limit} bytes`, "skill.objectHash");
  const opened = await objects.get(hash);
  if (!opened.ok) return opened;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of opened.value) {
    size += chunk.byteLength;
    if (size > limit) return validation(`Skill document exceeds ${limit} bytes`, "skill.objectHash");
    chunks.push(chunk);
  }
  return { ok: true, value: Buffer.concat(chunks).toString("utf8") };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

function sha256(value: string): Sha256 {
  return createHash("sha256").update(value, "utf8").digest("hex") as Sha256;
}

function validation(message: string, field: string): Result<never, ContextError> {
  return { ok: false, error: { kind: "validation", message, field, recoverable: true, callerAction: "fix-request" } };
}

function io(operation: string, error: unknown): Result<never, ContextError> {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
  const recoverable = code === "EAGAIN" || code === "EBUSY" || code === "EMFILE" || code === "ENFILE";
  return { ok: false, error: { kind: "io-error", operation, code, recoverable, callerAction: recoverable ? "retry-with-backoff" : "propagate" } };
}
