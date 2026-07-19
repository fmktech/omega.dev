import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AbsolutePath,
  BenchmarkSuiteId,
  ByteCount,
  DurationMs,
  HarnessId,
  HarnessManifest,
  JsonObject,
  JsonValue,
  ObjectDescriptor,
  ObjectHash,
  ObjectStore,
  ProcessCompletion,
  ProcessHandle,
  ProcessId,
  ProcessObservation,
  ProcessSpec,
  ProcessSupervisor,
  ProjectId,
  ProjectRecord,
  ProjectRepository,
  PromotableScorecard,
  RequestId,
  Result,
  ScorecardId,
  SessionHeader,
  SessionId,
  Sha256,
  StoreError,
  ThreadId,
  Timestamp,
  TokenCount,
  UsdMicros,
  WorkspaceId,
  WorkspaceRecord,
} from "../contracts/index.js";
import { createHarnessActivationService } from "./activation-service.js";
import { createHarnessRepository } from "./harness-repository.js";
import { createInitialHarness } from "./initial-harness.js";
import {
  createExperienceFedMiniSweCandidate,
  createMiniSweBaselineCandidate,
} from "./mini-swe-baseline.js";
import { createRunnerHost } from "./runner-host.js";

const roots: string[] = [];
const NOW = "2026-07-16T12:00:00.000Z" as Timestamp;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("harness runtime", () => {
  it("bootstraps a content-addressed minimal harness and lists the active version", async () => {
    const fixture = await repositoryFixture("alpha");
    const created = await createInitialHarness(fixture.project, fixture.objects, fixture.projects);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(created.value.components.filter((component) => component.kind === "runner")).toHaveLength(1);
    expect(created.value.components.filter((component) => component.kind === "tool").map((component) => component.entrypoint)).toEqual([
      "artifact.read", "file.read", "file.write", "process.start", "process.observe", "process.input", "process.cancel", "subagent.spawn",
      "subagent.observe", "knowledge.catalog", "knowledge.read", "skill.read", "knowledge.write", "marketplace.search", "marketplace.install",
      "harness.evolve", "harness.status",
    ]);
    const beforeActivation = await fixture.projects.getProject(fixture.project.id);
    const beforeIndex = await fixture.harnesses.listProjectHarnesses(fixture.project.id, { cursor: null, limit: 10 });
    expect(beforeActivation.ok && beforeActivation.value).toMatchObject({ activeHarnessId: null });
    expect(beforeIndex.ok && beforeIndex.value).toMatchObject({ items: [] });

    expect((await fixture.harnesses.putHarness(created.value)).ok).toBe(true);
    expect((await fixture.projects.compareAndSetActiveHarness(fixture.project.id, null, created.value.id)).ok).toBe(true);
    const active = await fixture.harnesses.getActiveHarness(fixture.project.id);
    const listed = await fixture.harnesses.listProjectHarnesses(fixture.project.id, { cursor: null, limit: 10 });
    expect(active.ok && active.value.id).toBe(created.value.id);
    expect(listed.ok && listed.value.items.map((manifest) => manifest.id)).toEqual([created.value.id]);

    const repeated = await createInitialHarness(fixture.project, fixture.objects, fixture.projects);
    expect(repeated.ok && repeated.value.id).toBe(created.value.id);
  });

  it("ships a bootstrap runner that starts a model turn and completes a no-tool response", async () => {
    const fixture = await repositoryFixture("bootstrap-loop");
    const created = await createInitialHarness(fixture.project, fixture.objects, fixture.projects);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const runner = created.value.components.find((component) => component.kind === "runner");
    expect(runner?.entrypoint.startsWith("inline-base64:")).toBe(true);
    if (runner === undefined) return;
    const source = Buffer.from(runner.entrypoint.slice("inline-base64:".length), "base64").toString("utf8");
    expect(source).toContain("cpuTimeLimitMs:1800000");
    expect(source).not.toContain("cpuTimeLimitMs:3600000");
    expect(source).toContain('role:route?.role||"main-coder"');
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = lineReader(child.stdout);
    child.stdin.write(`${JSON.stringify({ protocol: "omega-runner-jsonl", version: 1, message: { kind: "kernel.start", start: runnerStart(created.value, fixture.workspace) } })}\n`);
    await expect(lines.next()).resolves.toMatchObject({ message: { kind: "runner.ready", harnessId: created.value.id } });
    const bootstrap = await lines.next();
    expect(bootstrap).toMatchObject({ message: { kind: "runner.request", request: { kind: "context.bootstrap" } } });
    const bootstrapId = ((bootstrap["message"] as JsonObject)["request"] as JsonObject)["requestId"] as string;
    child.stdin.write(`${JSON.stringify({ protocol: "omega-runner-jsonl", version: 1, message: { kind: "kernel.reply", reply: {
      kind: "context.bootstrapped",
      requestId: bootstrapId,
      result: { ok: true, value: {
        instructions: [{ path: "AGENTS.md", scope: ".", content: "Use just verify.\n", sha: "a".repeat(64) }],
        knowledgeCatalog: [{ id: "project-environment", title: "Local environment", summary: "Use rootless Podman", tags: ["environment"], confidence: 1, verifiedAt: NOW, relevantPaths: ["."] }],
        skillCatalog: [{ componentId: "component_verify", name: "verify-project", description: "Run the project verifier", tags: ["verify"], relevantPaths: ["src"] }],
      } },
    } } })}\n`);
    const modelStart = await lines.next();
    expect(modelStart).toMatchObject({ message: { kind: "runner.request", request: { kind: "model.start", request: { tools: expect.arrayContaining([expect.objectContaining({ name: "skill.read" })]) } } } });
    const modelRequest = ((modelStart["message"] as JsonObject)["request"] as JsonObject)["request"] as JsonObject;
    const systemText = (((modelRequest["messages"] as readonly JsonObject[])[0]?.["content"] as readonly JsonObject[])[0]?.["text"] as string);
    expect(systemText).toContain("Instruction file: AGENTS.md");
    expect(systemText).toContain("Use just verify.");
    expect(systemText).toContain("Local environment");
    expect(systemText).toContain("verify-project");
    const requestId = ((modelStart["message"] as JsonObject)["request"] as JsonObject)["requestId"] as string;
    const route = modelRoute();
    child.stdin.write(`${JSON.stringify({ protocol: "omega-runner-jsonl", version: 1, message: { kind: "kernel.reply", reply: { kind: "model.started", requestId, result: { ok: true, value: { streamId: "stream-bootstrap", route } } } } })}\n`);
    child.stdin.write(`${JSON.stringify({ protocol: "omega-runner-jsonl", version: 1, message: { kind: "kernel.event", event: { kind: "model.event", event: { kind: "completed", completion: modelCompletion(route) } } } })}\n`);
    await expect(lines.next()).resolves.toMatchObject({ message: { kind: "runner.request", request: { kind: "session.complete", outcome: "succeeded" } } });
    child.kill("SIGTERM");
  });

  it("serves repeated immutable skill reads from the session cache", async () => {
    const fixture = await repositoryFixture("skill-read-cache");
    const created = await createInitialHarness(fixture.project, fixture.objects, fixture.projects);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const runner = created.value.components.find((component) => component.kind === "runner");
    if (runner === undefined) return;
    const source = Buffer.from(runner.entrypoint.slice("inline-base64:".length), "base64").toString("utf8");
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = lineReader(child.stdout);
    const send = (message: JsonObject): void => {
      child.stdin.write(`${JSON.stringify({ protocol: "omega-runner-jsonl", version: 1, message })}\n`);
    };
    send({ kind: "kernel.start", start: runnerStart(created.value, fixture.workspace) });
    await lines.next();
    const bootstrap = await lines.next();
    const bootstrapId = ((bootstrap["message"] as JsonObject)["request"] as JsonObject)["requestId"] as string;
    send({ kind: "kernel.reply", reply: { kind: "context.bootstrapped", requestId: bootstrapId, result: { ok: true, value: {
      instructions: [],
      knowledgeCatalog: [],
      skillCatalog: [{
        componentId: "component_verify",
        name: "verify-project",
        description: "Run the scoped verifier",
        tags: ["verify"],
        relevantPaths: ["src"],
        appliesWhen: ["Source changes"],
        doesNotApplyWhen: ["Documentation-only changes"],
      }],
    } } } });
    const firstModel = await lines.next();
    const firstModelId = ((firstModel["message"] as JsonObject)["request"] as JsonObject)["requestId"] as string;
    const route = modelRoute();
    send({ kind: "kernel.reply", reply: { kind: "model.started", requestId: firstModelId, result: { ok: true, value: { streamId: "stream-skill-cache", route } } } });
    send({
      kind: "kernel.event",
      event: {
        kind: "model.event",
        event: {
          kind: "completed",
          completion: {
            ...modelCompletion(route),
            streamId: "stream-skill-cache",
            content: [
              { kind: "tool-call", callId: "read-one", toolName: "skill.read", input: { componentId: "component_verify" } },
              { kind: "tool-call", callId: "read-two", toolName: "skill.read", input: { componentId: "component_verify" } },
            ],
          },
        },
      },
    });
    const skillRead = await lines.next();
    expect(skillRead).toMatchObject({ message: { request: { kind: "skill.read", componentId: "component_verify" } } });
    const skillReadId = ((skillRead["message"] as JsonObject)["request"] as JsonObject)["requestId"] as string;
    send({ kind: "kernel.reply", reply: { kind: "skill.read", requestId: skillReadId, result: { ok: true, value: {
      componentId: "component_verify",
      objectHash: "b".repeat(64),
      catalog: {
        componentId: "component_verify",
        name: "verify-project",
        description: "Run the scoped verifier",
        tags: ["verify"],
        relevantPaths: ["src"],
        appliesWhen: ["Source changes"],
        doesNotApplyWhen: ["Documentation-only changes"],
      },
      markdown: "# Verify project\n\nRun ./verify.\n",
    } } } });

    const next = await lines.next();
    expect(next).toMatchObject({ message: { request: { kind: "model.start" } } });
    const nextModelRequest = ((next["message"] as JsonObject)["request"] as JsonObject)["request"] as JsonObject;
    const messages = nextModelRequest["messages"] as readonly JsonObject[];
    const toolMessage = messages.at(-1);
    expect(toolMessage).toMatchObject({ role: "tool", content: [
      expect.objectContaining({ callId: "read-one", isError: false }),
      expect.objectContaining({ callId: "read-two", isError: false }),
    ] });
    child.kill("SIGTERM");
  });

  it("materializes a deterministic mini-swe baseline without activating it", async () => {
    const fixture = await repositoryFixture("mini-baseline");
    const initial = await createInitialHarness(fixture.project, fixture.objects, fixture.projects);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect((await fixture.harnesses.putHarness(initial.value)).ok).toBe(true);
    expect((await fixture.projects.compareAndSetActiveHarness(fixture.project.id, null, initial.value.id)).ok).toBe(true);

    const first = await createMiniSweBaselineCandidate(initial.value, fixture.objects, fixture.harnesses);
    const repeated = await createMiniSweBaselineCandidate(initial.value, fixture.objects, fixture.harnesses);
    expect(first.ok && repeated.ok).toBe(true);
    if (!first.ok || !repeated.ok) return;
    expect(repeated.value.id).toBe(first.value.id);
    expect(first.value.parents).toEqual([initial.value.id]);
    expect(first.value.components.filter((component) => component.kind === "runner")).toHaveLength(1);
    expect(first.value.components.filter((component) => component.kind === "tool")).toEqual(
      initial.value.components.filter((component) => component.kind === "tool"),
    );
    const runner = first.value.components.find((component) => component.kind === "runner");
    expect(runner?.entrypoint.startsWith("inline-base64:")).toBe(true);
    const source = Buffer.from(runner?.entrypoint.slice("inline-base64:".length) ?? "", "base64").toString("utf8");
    expect(source).toContain('name:"bash"');
    expect(source).not.toContain('name:"file.read"');
    const active = await fixture.harnesses.getActiveHarness(fixture.project.id);
    expect(active.ok && active.value.id).toBe(initial.value.id);
  });

  it("runs the mini-swe baseline as a bash-only linear agent", async () => {
    const fixture = await repositoryFixture("mini-loop");
    const initial = await createInitialHarness(fixture.project, fixture.objects, fixture.projects);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const candidate = await createMiniSweBaselineCandidate(initial.value, fixture.objects, fixture.harnesses);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const runner = candidate.value.components.find((component) => component.kind === "runner");
    if (runner === undefined) return;
    const source = Buffer.from(runner.entrypoint.slice("inline-base64:".length), "base64").toString("utf8");
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = lineReader(child.stdout);
    child.stdin.write(`${JSON.stringify({ protocol: "omega-runner-jsonl", version: 1, message: { kind: "kernel.start", start: runnerStart(candidate.value, fixture.workspace) } })}\n`);
    await expect(lines.next()).resolves.toMatchObject({ message: { kind: "runner.ready", harnessId: candidate.value.id } });
    const modelStart = await lines.next();
    expect(modelStart).toMatchObject({ message: { kind: "runner.request", request: { kind: "model.start", request: { tools: [{ name: "bash" }] } } } });
    const requestId = ((modelStart["message"] as JsonObject)["request"] as JsonObject)["requestId"] as string;
    const route = modelRoute();
    child.stdin.write(`${JSON.stringify({ protocol: "omega-runner-jsonl", version: 1, message: { kind: "kernel.reply", reply: { kind: "model.started", requestId, result: { ok: true, value: { streamId: "stream-bootstrap", route } } } } })}\n`);
    child.stdin.write(`${JSON.stringify({
      protocol: "omega-runner-jsonl",
      version: 1,
      message: {
        kind: "kernel.event",
        event: {
          kind: "model.event",
          event: {
            kind: "completed",
            completion: {
              ...modelCompletion(route),
              content: [{ kind: "tool-call", callId: "submit", toolName: "bash", input: { command: "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT" } }],
            },
          },
        },
      },
    })}\n`);
    await expect(lines.next()).resolves.toMatchObject({ message: { kind: "runner.request", request: { kind: "session.complete", outcome: "succeeded" } } });
    child.kill("SIGTERM");
  });

  it("returns one result for every bash call before requesting another model turn", async () => {
    const fixture = await repositoryFixture("mini-multi-call");
    const initial = await createInitialHarness(fixture.project, fixture.objects, fixture.projects);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const candidate = await createMiniSweBaselineCandidate(initial.value, fixture.objects, fixture.harnesses);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const runner = candidate.value.components.find((component) => component.kind === "runner");
    if (runner === undefined) return;
    const source = Buffer.from(runner.entrypoint.slice("inline-base64:".length), "base64").toString("utf8");
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = lineReader(child.stdout);
    const send = (message: JsonObject): void => {
      child.stdin.write(`${JSON.stringify({ protocol: "omega-runner-jsonl", version: 1, message })}\n`);
    };
    send({ kind: "kernel.start", start: runnerStart(candidate.value, fixture.workspace) });
    await lines.next();
    const initialModel = await lines.next();
    const initialModelId = ((initialModel["message"] as JsonObject)["request"] as JsonObject)["requestId"] as string;
    const route = modelRoute();
    send({ kind: "kernel.reply", reply: { kind: "model.started", requestId: initialModelId, result: { ok: true, value: { streamId: "stream-multi", route } } } });
    send({
      kind: "kernel.event",
      event: {
        kind: "model.event",
        event: {
          kind: "completed",
          completion: {
            ...modelCompletion(route),
            streamId: "stream-multi",
            content: [
              { kind: "tool-call", callId: "call-one", toolName: "bash", input: { command: "printf one" } },
              { kind: "tool-call", callId: "call-two", toolName: "bash", input: { command: "printf two" } },
            ],
          },
        },
      },
    });

    const firstStart = await lines.next();
    expect(firstStart).toMatchObject({ message: { request: { kind: "process.start", spec: { args: expect.arrayContaining(["printf one"]) } } } });
    const firstStartId = ((firstStart["message"] as JsonObject)["request"] as JsonObject)["requestId"] as string;
    send({ kind: "kernel.reply", reply: { kind: "process.started", requestId: firstStartId, result: { ok: true, value: { id: "process-one" } } } });
    const firstObserve = await lines.next();
    const firstObserveId = ((firstObserve["message"] as JsonObject)["request"] as JsonObject)["requestId"] as string;
    send({ kind: "kernel.reply", reply: { kind: "process.observed", requestId: firstObserveId, result: { ok: true, value: { state: "exited", slices: [{ stream: "stdout", range: { startInclusive: 0, endExclusive: 24 }, data: "one\n__OMEGA_MINI_RC__=0\n" }] } } } });

    const secondStart = await lines.next();
    expect(secondStart).toMatchObject({ message: { request: { kind: "process.start", spec: { args: expect.arrayContaining(["printf two"]) } } } });
    const secondStartId = ((secondStart["message"] as JsonObject)["request"] as JsonObject)["requestId"] as string;
    send({ kind: "kernel.reply", reply: { kind: "process.started", requestId: secondStartId, result: { ok: true, value: { id: "process-two" } } } });
    const secondObserve = await lines.next();
    const secondObserveId = ((secondObserve["message"] as JsonObject)["request"] as JsonObject)["requestId"] as string;
    send({ kind: "kernel.reply", reply: { kind: "process.observed", requestId: secondObserveId, result: { ok: true, value: { state: "exited", slices: [{ stream: "stdout", range: { startInclusive: 0, endExclusive: 24 }, data: "two\n__OMEGA_MINI_RC__=0\n" }] } } } });

    const nextModel = await lines.next();
    const nextRequest = ((nextModel["message"] as JsonObject)["request"] as JsonObject)["request"] as JsonObject;
    const messages = nextRequest["messages"] as readonly JsonObject[];
    expect(nextModel).toMatchObject({ message: { request: { kind: "model.start" } } });
    expect(messages.at(-1)).toMatchObject({
      role: "tool",
      content: [
        { kind: "tool-result", callId: "call-one", result: expect.objectContaining({ returncode: 0 }) },
        { kind: "tool-result", callId: "call-two", result: expect.objectContaining({ returncode: 0 }) },
      ],
    });
    child.kill("SIGTERM");
  });

  it("materializes identical project experience once without activating it", async () => {
    const fixture = await repositoryFixture("crystallized-mini");
    const initial = await createInitialHarness(fixture.project, fixture.objects, fixture.projects);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect((await fixture.harnesses.putHarness(initial.value)).ok).toBe(true);
    expect((await fixture.projects.compareAndSetActiveHarness(fixture.project.id, null, initial.value.id)).ok).toBe(true);
    const baseline = await createMiniSweBaselineCandidate(initial.value, fixture.objects, fixture.harnesses);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const guidance = "Read project guidance before assuming a familiar build command.";

    const first = await createExperienceFedMiniSweCandidate(baseline.value, fixture.objects, fixture.harnesses, guidance);
    const repeated = await createExperienceFedMiniSweCandidate(baseline.value, fixture.objects, fixture.harnesses, `  ${guidance}\n`);

    expect(first.ok && repeated.ok).toBe(true);
    if (!first.ok || !repeated.ok) return;
    expect(repeated.value.id).toBe(first.value.id);
    expect(first.value.parents).toEqual([baseline.value.id]);
    const runner = first.value.components.find((component) => component.kind === "runner");
    const source = Buffer.from(runner?.entrypoint.slice("inline-base64:".length) ?? "", "base64").toString("utf8");
    expect(source).toContain("Project-scoped experience crystallized from earlier work sessions");
    expect(source).toContain(guidance);
    const active = await fixture.harnesses.getActiveHarness(fixture.project.id);
    expect(active.ok && active.value.id).toBe(initial.value.id);
    expect((await createExperienceFedMiniSweCandidate(baseline.value, fixture.objects, fixture.harnesses, "")).ok).toBe(false);
  });

  it("stores immutable lineage, rejects cross-project parents, and detects activation CAS conflicts", async () => {
    const first = await repositoryFixture("first");
    const second = await repositoryFixture("second", first.objects, first.projects);
    const initial = await createInitialHarness(first.project, first.objects, first.projects);
    const foreignInitial = await createInitialHarness(second.project, second.objects, second.projects);
    expect(initial.ok && foreignInitial.ok).toBe(true);
    if (!initial.ok || !foreignInitial.ok) {
      return;
    }
    await first.harnesses.putHarness(initial.value);
    await first.projects.compareAndSetActiveHarness(first.project.id, null, initial.value.id);
    const storedInitial = await first.harnesses.getHarness(initial.value.id);
    expect(storedInitial.ok).toBe(true);
    if (!storedInitial.ok) {
      return;
    }
    const candidate = candidateHarness(initial.value, [initial.value.id], "candidate");
    const stored = await first.harnesses.putHarness(candidate);
    const duplicate = await first.harnesses.putHarness(candidate);
    expect(stored.ok && duplicate.ok && duplicate.value).toEqual(candidate);

    const crossProject = candidateHarness(initial.value, [foreignInitial.value.id], "bad-parent");
    expect((await first.harnesses.putHarness(crossProject)).ok).toBe(false);

    const staleProjects = projectRepository({ ...first.project, activeHarnessId: initial.value.id }, true);
    const staleActivation = createHarnessActivationService(staleProjects.repository, first.harnesses);
    const conflict = await staleActivation.pin(first.project.id, candidate.id, "operator pin");
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.kind).toBe("conflict");
    }
  });

  it("promotes only incumbent-authorized children and rolls back through ancestry", async () => {
    const fixture = await repositoryFixture("activation");
    const initial = await createInitialHarness(fixture.project, fixture.objects, fixture.projects);
    expect(initial.ok).toBe(true);
    if (!initial.ok) {
      return;
    }
    await fixture.harnesses.putHarness(initial.value);
    await fixture.projects.compareAndSetActiveHarness(fixture.project.id, null, initial.value.id);
    const candidate = candidateHarness(initial.value, [initial.value.id], "candidate");
    expect((await fixture.harnesses.putHarness(candidate)).ok).toBe(true);
    const activation = createHarnessActivationService(fixture.projects, fixture.harnesses);
    const invalid = await activation.promote(scorecard(initial.value, candidate, candidate.id));
    expect(invalid.ok).toBe(false);

    const promoted = await activation.promote(scorecard(initial.value, candidate, initial.value.id));
    expect(promoted.ok && promoted.value.reason).toBe("promotion");
    const rolledBack = await activation.rollback(fixture.project.id, initial.value.id, "candidate regressed");
    expect(rolledBack.ok && rolledBack.value).toMatchObject({
      previousHarnessId: candidate.id,
      activeHarnessId: initial.value.id,
      reason: "rollback",
    });
  });

  it("frames runner JSONL, reports malformed and partial records, rejects stale calls, and defers updates to safe boundaries", async () => {
    const fixture = await repositoryFixture("runner");
    const initial = await createInitialHarness(fixture.project, fixture.objects, fixture.projects);
    expect(initial.ok).toBe(true);
    if (!initial.ok) {
      return;
    }
    const candidate = candidateHarness(initial.value, [initial.value.id], "next");
    await fixture.harnesses.putHarness(candidate);
    const supervisor = new FakeProcessSupervisor();
    const host = createRunnerHost(supervisor, fixture.harnesses);
    const started = await host.start(runnerStart(initial.value, fixture.workspace));
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(supervisor.startedSpecs[0]?.executable).toBe("node");
    expect(supervisor.startedSpecs[0]?.sandbox.filesystem).toBe("workspace-read-only");
    expect(supervisor.startedSpecs[0]?.sandbox.cpuTimeLimitMs).toBeLessThanOrEqual(1_800_000);
    const received = host.receive("session-runner" as SessionId)[Symbol.asyncIterator]();
    expect((await received.next()).value?.message.kind).toBe("runner.ready");

    supervisor.emit('{not-json}\n');
    const malformed = await received.next();
    expect(malformed.value?.message.kind).toBe("runner.protocol-error");

    supervisor.emit(JSON.stringify({
      protocol: "omega-runner-jsonl",
      version: 1,
      message: {
        kind: "runner.request",
        request: {
          kind: "process.start",
          requestId: "request-hostile",
          spec: {
            sessionId: "session-runner",
            harnessId: initial.value.id,
          },
        },
      },
    }) + "\n");
    const hostile = await received.next();
    expect(hostile.value?.message.kind).toBe("runner.protocol-error");

    supervisor.emit(JSON.stringify({
      protocol: "omega-runner-jsonl",
      version: 1,
      message: { kind: "runner.request", request: { kind: "harness.status", requestId: "request-pending", projectId: fixture.project.id } },
    }) + "\n");
    expect((await received.next()).value?.message.kind).toBe("runner.request");
    const update = {
      protocol: "omega-runner-jsonl",
      version: 1,
      message: {
        kind: "kernel.event",
        event: {
          kind: "harness.updated",
          update: {
            projectId: fixture.project.id,
            previousHarnessId: initial.value.id,
            activeHarnessId: candidate.id,
            reason: "manual-pin",
            scorecardId: null,
            activatedAt: NOW,
          },
        },
      },
    } as const;
    await host.send("session-runner" as SessionId, update);
    expect(supervisor.stdin.join("")).not.toContain("harness.updated");
    await host.send("session-runner" as SessionId, {
      protocol: "omega-runner-jsonl",
      version: 1,
      message: {
        kind: "kernel.reply",
        reply: { kind: "harness.status", requestId: "request-pending" as RequestId, result: { ok: true, value: initial.value } },
      },
    });
    expect(supervisor.stdin.join("")).toContain("harness.updated");
    expect(supervisor.startedSpecs).toHaveLength(1);
    expect(supervisor.startedSpecs[0]?.harnessId).toBe(initial.value.id);

    supervisor.emit(JSON.stringify({
      protocol: "omega-runner-jsonl",
      version: 1,
      message: {
        kind: "runner.request",
        request: {
          kind: "model.start",
          requestId: "request-stale",
          request: {
            sessionId: "session-runner",
            harnessId: initial.value.id,
            role: "main-coder",
            messages: [],
            tools: [],
            maxOutputTokens: 1,
            abortAfterMs: 1,
          },
        },
      },
    }) + "\n");
    const afterStale = received.next();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(supervisor.stdin.join("")).toContain("harness-version-mismatch");

    supervisor.emit('{"protocol":"omega-runner-jsonl"');
    supervisor.state = "exited";
    const partial = await afterStale;
    expect(partial.value?.message.kind).toBe("runner.protocol-error");
    await host.stop("session-runner" as SessionId, "test complete");
  });
});

class MemoryObjectStore implements ObjectStore {
  readonly values = new Map<ObjectHash, { readonly descriptor: ObjectDescriptor; readonly bytes: Buffer }>();

  async put(mediaType: string, chunks: AsyncIterable<Uint8Array>) {
    const collected: Uint8Array[] = [];
    for await (const chunk of chunks) {
      collected.push(chunk);
    }
    const bytes = Buffer.concat(collected);
    const hash = createHash("sha256").update(bytes).digest("hex") as ObjectHash;
    const descriptor: ObjectDescriptor = { hash, size: bytes.byteLength as ByteCount, mediaType, createdAt: NOW };
    this.values.set(hash, { descriptor, bytes });
    return { ok: true as const, value: descriptor };
  }

  async get(hash: ObjectHash) {
    const stored = this.values.get(hash);
    if (stored === undefined) {
      return notFoundObject(hash);
    }
    const bytes = stored.bytes;
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield bytes;
    }
    return { ok: true as const, value: chunks() };
  }

  async describe(hash: ObjectHash) {
    const stored = this.values.get(hash);
    return stored === undefined ? notFoundObject(hash) : { ok: true as const, value: stored.descriptor };
  }
}

class FakeProcessSupervisor implements ProcessSupervisor {
  readonly stdin: string[] = [];
  readonly startedSpecs: ProcessSpec[] = [];
  readonly handle: ProcessHandle = {
    id: "process-runner" as ProcessId,
    state: "running",
    harnessId: "pending" as HarnessId,
    sandbox: {
      backend: "docker",
      backendVersion: "test",
      image: "omega-runner:local",
      imageDigest: "0".repeat(64) as Sha256,
      containerUser: "1000:1000",
    },
    startedAt: NOW,
  };
  state: ProcessObservation["state"] = "running";
  private stdout = Buffer.alloc(0);

  async start(spec: ProcessSpec) {
    this.startedSpecs.push(spec);
    return { ok: true as const, value: { ...this.handle, harnessId: spec.harnessId } };
  }

  async observe(_processId: ProcessId, after: readonly { readonly stream: "stdout" | "stderr"; readonly offset: ByteCount }[]) {
    const offset = after.find((cursor) => cursor.stream === "stdout")?.offset ?? 0 as ByteCount;
    const data = this.stdout.subarray(offset);
    return {
      ok: true as const,
      value: {
        processId: this.handle.id,
        state: this.state,
        slices: data.byteLength === 0 ? [] : [{
          stream: "stdout" as const,
          range: { startInclusive: offset, endExclusive: this.stdout.byteLength as ByteCount },
          encoding: "utf8" as const,
          data: data.toString("utf8"),
        }],
        observedAt: NOW,
      },
    };
  }

  async input(_processId: ProcessId, input: Parameters<ProcessSupervisor["input"]>[1]) {
    if (input.kind === "data") {
      const data = input.encoding === "base64" ? Buffer.from(input.data, "base64").toString("utf8") : input.data;
      this.stdin.push(data);
      const parsed = JSON.parse(data) as JsonObject;
      if ((parsed["message"] as JsonObject | undefined)?.["kind"] === "kernel.start") {
        const message = parsed["message"] as JsonObject;
        const start = message["start"] as JsonObject;
        const harness = start["harness"] as JsonObject;
        this.emit(JSON.stringify({ protocol: "omega-runner-jsonl", version: 1, message: { kind: "runner.ready", harnessId: harness["id"] } }) + "\n");
      }
    }
    return { ok: true as const, value: { acceptedBytes: 0 as ByteCount } };
  }

  async cancel() {
    this.state = "cancelled";
    return { ok: true as const, value: completion(this.handle.id) };
  }

  async listActive() { return { ok: true as const, value: [this.handle] }; }
  async recoverOrphans() { return { ok: true as const, value: [] }; }
  async shutdown() { return { ok: true as const, value: [] }; }

  emit(value: string): void {
    this.stdout = Buffer.concat([this.stdout, Buffer.from(value, "utf8")]);
  }
}

async function repositoryFixture(name: string, existingObjects?: MemoryObjectStore, existingProjects?: ProjectRepository) {
  const root = await mkdtemp(join(tmpdir(), "omega-harness-"));
  roots.push(root);
  const objects = existingObjects ?? new MemoryObjectStore();
  const project: ProjectRecord = {
    id: `project-${name}` as ProjectId,
    displayName: name,
    repository: { canonicalRemote: null, initialRootHash: createHash("sha256").update(name).digest("hex") as Sha256 },
    activeHarnessId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const workspace: WorkspaceRecord = {
    id: `workspace-${name}` as WorkspaceId,
    projectId: project.id,
    path: root as AbsolutePath,
    registeredAt: NOW,
    lastSeenAt: NOW,
  };
  const state = existingProjects === undefined ? projectRepository(project, false) : addProject(existingProjects, project);
  const projects = state.repository;
  return { root, objects, projects, project, workspace, harnesses: createHarnessRepository(root as AbsolutePath, objects, projects) };
}

function projectRepository(initial: ProjectRecord, forceCasConflict: boolean) {
  const records = new Map<ProjectId, ProjectRecord>([[initial.id, initial]]);
  const repository: ProjectRepository = {
    async registerWorkspace() { return { ok: false, error: validationStore("unused") }; },
    async registerBenchmarkWorkspace(id, path, fixtureHash) {
      if (!records.has(id)) {
        return notFoundProject(id);
      }
      return {
        ok: true,
        value: {
          id: `benchmark-workspace-${fixtureHash}` as WorkspaceId,
          projectId: id,
          path,
          registeredAt: NOW,
          lastSeenAt: NOW,
        },
      };
    },
    async getProject(id) { return records.has(id) ? { ok: true, value: records.get(id)! } : notFoundProject(id); },
    async getWorkspace(id) { return { ok: false, error: { kind: "not-found", resource: "workspace", id, recoverable: false, callerAction: "propagate" } }; },
    async listProjects() { return { ok: true, value: { items: [...records.values()], nextCursor: null } }; },
    async compareAndSetActiveHarness(id, expected, next) {
      const current = records.get(id);
      if (current === undefined) {
        return notFoundProject(id);
      }
      if (forceCasConflict || current.activeHarnessId !== expected) {
        return { ok: false, error: { kind: "conflict", resource: "project-active-harness", expected: expected ?? "null", actual: current.activeHarnessId ?? "null", recoverable: true, callerAction: "refresh-version-and-retry" } };
      }
      const updated = { ...current, activeHarnessId: next, updatedAt: NOW };
      records.set(id, updated);
      return { ok: true, value: updated };
    },
  };
  return { repository, records };
}

function addProject(repository: ProjectRepository, project: ProjectRecord) {
  const original = repository.getProject.bind(repository);
  const local = projectRepository(project, false);
  local.repository.getProject = async (id) => id === project.id ? { ok: true, value: local.records.get(id)! } : original(id);
  return local;
}

function candidateHarness(base: HarnessManifest, parents: readonly HarnessId[], alias: string): HarnessManifest {
  const body = { projectId: base.projectId, alias, parents, components: base.components, sourceArtifacts: [], createdAt: NOW } as const;
  const encoded: JsonObject = {
    projectId: body.projectId,
    alias: body.alias,
    parents: body.parents,
    components: body.components.map((component) => ({
      id: component.id,
      kind: component.kind,
      runtime: component.runtime,
      objectHash: component.objectHash,
      entrypoint: component.entrypoint,
      credentialEnvNames: component.credentialEnvNames,
      capabilities: component.capabilities,
    })),
    sourceArtifacts: body.sourceArtifacts,
    createdAt: body.createdAt,
  };
  const hash = createHash("sha256").update(canonical(encoded)).digest("hex");
  return { id: `harness_${hash}` as HarnessId, ...body };
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key] ?? null)}`).join(",")}}`;
}

function scorecard(incumbent: HarnessManifest, candidate: HarnessManifest, evaluatorHarnessId: HarnessId): PromotableScorecard {
  return {
    id: "scorecard-1" as ScorecardId,
    projectId: incumbent.projectId,
    suiteId: "suite-1" as BenchmarkSuiteId,
    incumbentHarnessId: incumbent.id,
    candidateHarnessId: candidate.id,
    evaluatorHarnessId,
    promotionPolicyId: "policy-1",
    pairedResults: [],
    thresholds: { minimumComparablePairs: 0, minimumSuccessRateDelta: 0, maximumProtectedRegressions: 0, confidenceLevel: 0.95 },
    observedSuccessRateDelta: 1,
    decision: { outcome: "promote", reason: "verified" },
    createdAt: NOW,
  };
}

function runnerStart(harness: HarnessManifest, workspace: WorkspaceRecord) {
  const session: SessionHeader = {
    id: "session-runner" as SessionId,
    threadId: "thread-runner" as ThreadId,
    parentSessionId: null,
    continuation: null,
    projectId: harness.projectId,
    workspaceId: workspace.id,
    role: "main",
    objective: "test runner",
    initialHarnessId: harness.id,
    initialModelRoutes: [],
    policyProfile: "guarded",
    capabilityEnvelope: {
      grants: [{ kind: "start-process", executableNames: [] }],
      modelRoles: ["main-coder"],
      maxCostUsdMicros: 0 as UsdMicros,
      maxModelCalls: 1,
      maxProcessStarts: 1,
      maxInputTokens: 1_000 as TokenCount,
      maxOutputTokens: 1_000 as TokenCount,
      wallTimeMs: 60_000 as DurationMs,
      createdAt: NOW,
    },
    credentialEnvNames: [],
    eventSchemaVersion: 1,
    createdAt: NOW,
  };
  return { session, workspace, harness, handoffArtifactId: null };
}

function modelRoute() {
  return {
    role: "main-coder" as const,
    providerId: "scripted",
    modelId: "bootstrap-test",
    variant: null,
    servingProvider: "scripted",
    quantization: null,
    reasoning: "off" as const,
    temperature: 0,
    topP: null,
    seed: 1,
    contextLimit: 4_096 as TokenCount,
    outputLimit: 1_024 as TokenCount,
    equivalentListPrice: { inputUsdMicrosPerMillionTokens: 0 as UsdMicros, cachedInputUsdMicrosPerMillionTokens: 0 as UsdMicros, outputUsdMicrosPerMillionTokens: 0 as UsdMicros },
  };
}

function modelCompletion(route: ReturnType<typeof modelRoute>) {
  return {
    streamId: "stream-bootstrap",
    providerGenerationId: "generation-bootstrap",
    route,
    content: [{ kind: "text" as const, text: "done" }],
    usage: { inputTokens: 1 as TokenCount, cachedInputTokens: 0 as TokenCount, reasoningTokens: 0 as TokenCount, outputTokens: 1 as TokenCount, costUsdMicros: 0 as UsdMicros },
    startedAt: NOW,
    firstTokenAt: NOW,
    completedAt: NOW,
    finishReason: "stop" as const,
  };
}

function lineReader(stream: NodeJS.ReadableStream): { next(): Promise<JsonObject> } {
  let buffer = "";
  const queued: JsonObject[] = [];
  const waiters: ((value: JsonObject) => void)[] = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const value = JSON.parse(line) as JsonObject;
      const waiter = waiters.shift();
      if (waiter === undefined) queued.push(value);
      else waiter(value);
    }
  });
  return {
    next() {
      const value = queued.shift();
      return value === undefined ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(value);
    },
  };
}

function completion(processId: ProcessId): ProcessCompletion {
  const descriptor: ObjectDescriptor = { hash: "0".repeat(64) as ObjectHash, size: 0 as ByteCount, mediaType: "text/plain", createdAt: NOW };
  return { processId, state: "cancelled", exitCode: null, signal: "SIGTERM", durationMs: 1 as DurationMs, stdout: descriptor, stderr: descriptor };
}

function notFoundObject(hash: ObjectHash): Result<never, StoreError> {
  return { ok: false, error: { kind: "not-found", resource: "object", id: hash, recoverable: false, callerAction: "propagate" } };
}

function notFoundProject(id: ProjectId): Result<never, StoreError> {
  return { ok: false, error: { kind: "not-found", resource: "project", id, recoverable: false, callerAction: "propagate" } };
}

function validationStore(message: string): StoreError {
  return { kind: "validation", message, field: null, recoverable: true, callerAction: "fix-request" };
}
