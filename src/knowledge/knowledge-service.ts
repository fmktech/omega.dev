import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  CreateKnowledgeService,
  KnowledgeCatalogEntry,
  KnowledgeDocument,
  KnowledgeDocumentId,
  KnowledgeError,
  KnowledgeFrontmatter,
  KnowledgeQuery,
  KnowledgeWriteRequest,
  ObjectHash,
  ObjectStore,
  ProjectId,
  RelativePath,
  Result,
  Sha256,
  Timestamp,
  ValidationError,
} from "../contracts/index.js";
import {
  capabilityDenied,
  conflictError,
  ioError,
  readJsonState,
  sha256,
  stateFileName,
  validationError,
  withStateLock,
  writeJsonState,
  writeTextState,
} from "./artifact-state.js";

type StoredKnowledgeMetadata = {
  readonly projectId: ProjectId;
  readonly frontmatter: KnowledgeFrontmatter;
  readonly sha: Sha256;
  readonly objectHash: ObjectHash;
};

type ParsedFrontmatter = ReadonlyMap<string, string | readonly string[]>;

export const createKnowledgeService: CreateKnowledgeService = (root, objects) => {
  const projectsRoot = join(root, "knowledge", "projects");

  return {
    async catalog(query) {
      const queryError = validateQuery(query);
      if (queryError !== null) {
        return { ok: false, error: queryError };
      }
      const projectRoot = join(projectsRoot, stateFileName(query.projectId));
      let names: readonly string[];
      try {
        names = await readdir(projectRoot);
      } catch (error) {
        if (isMissingFile(error)) {
          return { ok: true, value: [] };
        }
        return { ok: false, error: ioError("list project knowledge", error) };
      }

      const entries: KnowledgeCatalogEntry[] = [];
      for (const name of [...names].sort()) {
        if (!name.endsWith(".json")) {
          continue;
        }
        const metadata = await readJsonState(
          join(projectRoot, name),
          "knowledge-document",
          name,
          isStoredKnowledgeMetadata,
        );
        if (!metadata.ok) {
          return metadata;
        }
        if (metadata.value.projectId !== query.projectId || !matchesQuery(metadata.value.frontmatter, query)) {
          continue;
        }
        const { id, title, summary, tags, confidence, verifiedAt, relevantPaths } = metadata.value.frontmatter;
        entries.push({ id, title, summary, tags, confidence, verifiedAt, relevantPaths });
      }

      entries.sort((left, right) => {
        const confidenceOrder = right.confidence - left.confidence;
        return confidenceOrder !== 0 ? confidenceOrder : left.title.localeCompare(right.title);
      });
      return { ok: true, value: entries.slice(0, query.limit) };
    },

    async read(projectId, id) {
      const path = metadataPath(projectsRoot, projectId, id);
      const metadata = await readJsonState(path, "knowledge-document", id, isStoredKnowledgeMetadata);
      if (!metadata.ok) {
        return metadata;
      }
      if (metadata.value.projectId !== projectId || metadata.value.frontmatter.id !== id) {
        return { ok: false, error: ioError("validate knowledge ownership", new Error("Knowledge state key mismatch")) };
      }
      const content = await readObjectText(objects, metadata.value.objectHash);
      if (!content.ok) {
        return content;
      }
      const actualSha = sha256(content.value);
      if (actualSha !== metadata.value.sha) {
        return {
          ok: false,
          error: {
            kind: "integrity-failure",
            resource: `knowledge-document:${id}`,
            expected: metadata.value.sha,
            actual: actualSha,
            recoverable: false,
            callerAction: "abort",
          },
        };
      }
      return {
        ok: true,
        value: {
          projectId,
          frontmatter: metadata.value.frontmatter,
          markdown: content.value,
          sha: metadata.value.sha,
        },
      };
    },

    async write(request, capabilities) {
      if (!capabilities.grants.some((grant) => grant.kind === "write-knowledge")) {
        return { ok: false, error: capabilityDenied("write-knowledge", "Knowledge writes require the write-knowledge capability") };
      }
      const requestError = validateWriteRequest(request);
      if (requestError !== null) {
        return { ok: false, error: requestError };
      }

      const documentSha = sha256(request.document.markdown);
      const storedObject = await objects.put("text/markdown; charset=utf-8", singleChunk(request.document.markdown));
      if (!storedObject.ok) {
        return storedObject;
      }
      if (String(storedObject.value.hash) !== documentSha) {
        return {
          ok: false,
          error: {
            kind: "integrity-failure",
            resource: `knowledge-document:${request.document.frontmatter.id}`,
            expected: documentSha,
            actual: String(storedObject.value.hash) as Sha256,
            recoverable: false,
            callerAction: "abort",
          },
        };
      }

      const path = metadataPath(projectsRoot, request.projectId, request.document.frontmatter.id);
      return withStateLock(path, async (): Promise<Result<KnowledgeDocument, KnowledgeError>> => {
        const existing = await readJsonState(
          path,
          "knowledge-document",
          request.document.frontmatter.id,
          isStoredKnowledgeMetadata,
        );
        if (request.expectedSha === null) {
          if (existing.ok) {
            return {
              ok: false,
              error: conflictError("knowledge-document", "absent", existing.value.sha),
            };
          }
          if (existing.error.kind !== "not-found") {
            return existing;
          }
        } else {
          if (!existing.ok) {
            return existing;
          }
          if (existing.value.sha !== request.expectedSha) {
            return {
              ok: false,
              error: {
                kind: "stale-read",
                path: `knowledge/${request.document.frontmatter.id}.md` as RelativePath,
                expectedSha: request.expectedSha,
                actualSha: existing.value.sha,
                recoverable: true,
                callerAction: "reread-and-retry",
              },
            };
          }
        }

        const mirror = await writeTextState(markdownPath(projectsRoot, request.projectId, request.document.frontmatter.id), request.document.markdown);
        if (!mirror.ok) {
          return mirror;
        }
        const metadata: StoredKnowledgeMetadata = {
          projectId: request.projectId,
          frontmatter: request.document.frontmatter,
          sha: documentSha,
          objectHash: storedObject.value.hash,
        };
        const persisted = await writeJsonState(path, metadata);
        if (!persisted.ok) {
          return persisted;
        }
        return {
          ok: true,
          value: {
            projectId: request.projectId,
            frontmatter: request.document.frontmatter,
            markdown: request.document.markdown,
            sha: documentSha,
          },
        };
      });
    },
  };
};

function metadataPath(root: string, projectId: ProjectId, id: KnowledgeDocumentId): string {
  return join(root, stateFileName(projectId), `${stateFileName(id)}.json`);
}

function markdownPath(root: string, projectId: ProjectId, id: KnowledgeDocumentId): string {
  return join(root, stateFileName(projectId), `${stateFileName(id)}.md`);
}

function validateQuery(query: KnowledgeQuery): ValidationError | null {
  if (query.limit < 1 || !Number.isSafeInteger(query.limit)) {
    return validationError("Knowledge query limit must be a positive integer", "limit");
  }
  if (query.tags.some((tag) => tag.trim().length === 0)) {
    return validationError("Knowledge query tags cannot be empty", "tags");
  }
  if (query.relevantPaths.some((path) => !isRelativePath(path))) {
    return validationError("Knowledge query contains an invalid repository path", "relevantPaths");
  }
  return null;
}

function validateWriteRequest(request: KnowledgeWriteRequest): ValidationError | null {
  if (request.projectId !== request.document.projectId) {
    return validationError("Knowledge document project does not match the write target", "document.projectId");
  }
  const frontmatterError = validateFrontmatter(request.document.frontmatter);
  if (frontmatterError !== null) {
    return frontmatterError;
  }
  const parsed = parseMarkdownFrontmatter(request.document.markdown);
  if (!parsed.ok) {
    return parsed.error;
  }
  const mismatch = compareFrontmatter(request.document.frontmatter, parsed.value);
  if (mismatch !== null) {
    return validationError(`Markdown frontmatter does not match document.${mismatch}`, `document.frontmatter.${mismatch}`);
  }
  return null;
}

function validateFrontmatter(frontmatter: KnowledgeFrontmatter): ValidationError | null {
  if (frontmatter.id.trim().length === 0) {
    return validationError("Knowledge document ID is required", "document.frontmatter.id");
  }
  if (frontmatter.title.trim().length === 0 || frontmatter.summary.trim().length === 0) {
    return validationError("Knowledge title and summary are required", "document.frontmatter");
  }
  if (!Number.isFinite(frontmatter.confidence) || frontmatter.confidence < 0 || frontmatter.confidence > 1) {
    return validationError("Knowledge confidence must be between 0 and 1", "document.frontmatter.confidence");
  }
  if (!isTimestamp(frontmatter.verifiedAt)) {
    return validationError("Knowledge verification time must be an ISO-8601 timestamp", "document.frontmatter.verifiedAt");
  }
  if (frontmatter.tags.some((tag) => tag.trim().length === 0) || new Set(frontmatter.tags).size !== frontmatter.tags.length) {
    return validationError("Knowledge tags must be non-empty and unique", "document.frontmatter.tags");
  }
  if (frontmatter.relevantPaths.some((path) => !isRelativePath(path))) {
    return validationError("Knowledge paths must be repository-relative POSIX paths", "document.frontmatter.relevantPaths");
  }
  if (frontmatter.sourceSessionIds.length === 0 && frontmatter.sourceArtifactIds.length === 0) {
    return validationError("Knowledge must retain at least one source session or artifact", "document.frontmatter.sourceSessionIds");
  }
  if (
    frontmatter.sourceSessionIds.some((id) => id.trim().length === 0) ||
    frontmatter.sourceArtifactIds.some((id) => id.trim().length === 0)
  ) {
    return validationError("Knowledge provenance IDs cannot be empty", "document.frontmatter");
  }
  return null;
}

function parseMarkdownFrontmatter(markdown: string): Result<ParsedFrontmatter, ValidationError> {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") {
    return { ok: false, error: validationError("Knowledge Markdown must begin with YAML frontmatter", "document.markdown") };
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex < 0) {
    return { ok: false, error: validationError("Knowledge Markdown frontmatter is not closed", "document.markdown") };
  }
  if (lines.slice(closingIndex + 1).join("\n").trim().length === 0) {
    return { ok: false, error: validationError("Knowledge Markdown body cannot be empty", "document.markdown") };
  }

  const values = new Map<string, string | readonly string[]>();
  let index = 1;
  while (index < closingIndex) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line);
    if (match === null || match[1] === undefined) {
      return { ok: false, error: validationError(`Unsupported frontmatter line: ${line}`, "document.markdown") };
    }
    const key = match[1];
    if (values.has(key)) {
      return { ok: false, error: validationError(`Duplicate frontmatter field: ${key}`, "document.markdown") };
    }
    const raw = match[2] ?? "";
    if (raw.trim().length > 0) {
      const inline = parseInlineValue(raw.trim());
      if (inline === null) {
        return { ok: false, error: validationError(`Invalid frontmatter value for ${key}`, "document.markdown") };
      }
      values.set(key, inline);
      index += 1;
      continue;
    }
    const items: string[] = [];
    index += 1;
    while (index < closingIndex) {
      const itemLine = lines[index];
      const itemMatch = itemLine === undefined ? null : /^\s+-\s+(.+)$/.exec(itemLine);
      if (itemMatch === null || itemMatch[1] === undefined) {
        break;
      }
      items.push(unquote(itemMatch[1].trim()));
      index += 1;
    }
    values.set(key, items);
  }
  return { ok: true, value: values };
}

function parseInlineValue(value: string): string | readonly string[] | null {
  if (value.startsWith("[") && value.endsWith("]")) {
    const content = value.slice(1, -1).trim();
    if (content.length === 0) {
      return [];
    }
    return content.split(",").map((item) => unquote(item.trim()));
  }
  if (value.startsWith("[") || value.endsWith("]")) {
    return null;
  }
  return unquote(value);
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function compareFrontmatter(frontmatter: KnowledgeFrontmatter, parsed: ParsedFrontmatter): keyof KnowledgeFrontmatter | null {
  const scalarFields: readonly (keyof Pick<KnowledgeFrontmatter, "id" | "title" | "summary" | "verifiedAt">)[] = [
    "id",
    "title",
    "summary",
    "verifiedAt",
  ];
  for (const field of scalarFields) {
    if (parsed.get(field) !== frontmatter[field]) {
      return field;
    }
  }
  if (parsed.get("confidence") !== String(frontmatter.confidence)) {
    return "confidence";
  }
  const arrayFields: readonly (keyof Pick<KnowledgeFrontmatter, "tags" | "sourceSessionIds" | "sourceArtifactIds" | "relevantPaths" | "invalidationConditions">)[] = [
    "tags",
    "sourceSessionIds",
    "sourceArtifactIds",
    "relevantPaths",
    "invalidationConditions",
  ];
  for (const field of arrayFields) {
    const actual = parsed.get(field);
    if (!Array.isArray(actual) || !arraysEqual(actual, frontmatter[field])) {
      return field;
    }
  }
  return null;
}

function matchesQuery(frontmatter: KnowledgeFrontmatter, query: KnowledgeQuery): boolean {
  const requestedTags = query.tags.map((tag) => tag.toLocaleLowerCase());
  const tags = frontmatter.tags.map((tag) => tag.toLocaleLowerCase());
  if (!requestedTags.every((tag) => tags.includes(tag))) {
    return false;
  }
  if (
    query.relevantPaths.length > 0 &&
    !query.relevantPaths.some((queryPath) =>
      frontmatter.relevantPaths.some((documentPath) => pathsOverlap(queryPath, documentPath)),
    )
  ) {
    return false;
  }
  const text = query.text.trim().toLocaleLowerCase();
  if (text.length === 0) {
    return true;
  }
  const searchable = [
    frontmatter.title,
    frontmatter.summary,
    ...frontmatter.tags,
    ...frontmatter.relevantPaths,
  ].join("\n").toLocaleLowerCase();
  return searchable.includes(text);
}

function pathsOverlap(left: RelativePath, right: RelativePath): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

function isTimestamp(value: string): value is Timestamp {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function isStoredKnowledgeMetadata(value: unknown): value is StoredKnowledgeMetadata {
  if (
    !isRecord(value) ||
    typeof value["projectId"] !== "string" ||
    typeof value["sha"] !== "string" ||
    typeof value["objectHash"] !== "string"
  ) {
    return false;
  }
  if (
    !/^[a-f0-9]{64}$/.test(value["sha"]) ||
    !/^[a-f0-9]{64}$/.test(value["objectHash"]) ||
    !isRecord(value["frontmatter"])
  ) {
    return false;
  }
  const frontmatter = value["frontmatter"];
  return (
    typeof frontmatter["id"] === "string" &&
    typeof frontmatter["title"] === "string" &&
    typeof frontmatter["summary"] === "string" &&
    isStringArray(frontmatter["tags"]) &&
    typeof frontmatter["confidence"] === "number" &&
    typeof frontmatter["verifiedAt"] === "string" &&
    isStringArray(frontmatter["sourceSessionIds"]) &&
    isStringArray(frontmatter["sourceArtifactIds"]) &&
    isStringArray(frontmatter["relevantPaths"]) &&
    isStringArray(frontmatter["invalidationConditions"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readObjectText(objects: ObjectStore, hash: ObjectHash): Promise<Result<string, KnowledgeError>> {
  const stored = await objects.get(hash);
  if (!stored.ok) {
    return stored;
  }
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of stored.value) {
      chunks.push(chunk);
    }
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch (error) {
    return { ok: false, error: ioError("read knowledge object", error) };
  }
}

async function* singleChunk(value: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(value);
}
