import type {
  HarnessActivationService,
  HarnessError,
  HarnessUpdate,
  ProcessId,
  ProjectRepository,
  Result,
  RunnerHost,
  SessionError,
  SessionEvent,
  SessionRepository,
  SessionService,
} from "../contracts/index.js";
import { readAllEvents } from "../sessions/handoffs.js";
import { recoverExistingSession } from "../sessions/recovery.js";

const PAGE_LIMIT = 100;

type ActivationDependencies = {
  readonly activation: HarnessActivationService;
  readonly repository: Pick<SessionRepository, "list" | "get">;
  readonly sessions: Pick<SessionService, "recordRunnerEvent" | "publishRunnerEvent" | "cancel">;
  readonly runners: Pick<RunnerHost, "send">;
};

type RecoveryDependencies = {
  readonly projects: Pick<ProjectRepository, "listProjects">;
  readonly repository: SessionRepository;
  readonly sessions: Pick<SessionService, "publishRunnerEvent">;
};

export function createCoordinatedActivationService(options: ActivationDependencies): HarnessActivationService {
  async function notify(update: HarnessUpdate): Promise<Result<HarnessUpdate, HarnessError>> {
    let cursor: string | null = null;
    do {
      const page = await options.repository.list(update.projectId, { cursor, limit: PAGE_LIMIT });
      if (!page.ok) return page;
      for (const snapshot of page.value.items) {
        if (snapshot.outcome !== null) continue;
        const current = await options.repository.get(snapshot.header.id);
        if (!current.ok) return current;
        if (current.value.outcome !== null) continue;
        const appended = await options.sessions.recordRunnerEvent(
          current.value.header.id,
          { kind: "harness.updated", update },
          update.previousHarnessId,
        );
        if (!appended.ok) {
          const raced = await options.repository.get(current.value.header.id);
          if (raced.ok && raced.value.outcome !== null) continue;
          await options.sessions.cancel(current.value.header.id, "Harness activation event could not be persisted");
          continue;
        }
        options.sessions.publishRunnerEvent({ kind: "harness-nudge", sessionId: current.value.header.id, update });
        // A persisted update is authoritative. Delivery is best effort because
        // a nonterminal record can briefly exist before/after its runner.
        const delivered = await options.runners.send(current.value.header.id, {
          protocol: "omega-runner-jsonl",
          version: 1,
          message: { kind: "kernel.event", event: { kind: "harness.updated", update } },
        });
        if (!delivered.ok) {
          // The project pointer and persisted session event are authoritative.
          // A runner that cannot accept the safe-boundary update is terminated
          // so no live session continues on the previous harness. On restart,
          // nonterminal sessions are terminal-failed by recovery as the same
          // final consistency backstop.
          await options.sessions.cancel(current.value.header.id, "Runner could not adopt the active harness");
        }
      }
      cursor = page.value.nextCursor;
    } while (cursor !== null);
    return { ok: true, value: update };
  }

  return {
    async promote(scorecard, commitGuard) {
      const activated = await options.activation.promote(scorecard, commitGuard);
      return activated.ok ? notify(activated.value) : activated;
    },
    async pin(projectId, target, reason) {
      const activated = await options.activation.pin(projectId, target, reason);
      return activated.ok ? notify(activated.value) : activated;
    },
    async rollback(projectId, target, reason) {
      const activated = await options.activation.rollback(projectId, target, reason);
      return activated.ok ? notify(activated.value) : activated;
    },
  };
}

export async function recoverPersistedSessions(options: RecoveryDependencies): Promise<Result<void, SessionError>> {
  let projectCursor: string | null = null;
  do {
    const projects = await options.projects.listProjects({ cursor: projectCursor, limit: PAGE_LIMIT });
    if (!projects.ok) return projects;
    for (const project of projects.value.items) {
      let sessionCursor: string | null = null;
      do {
        const sessions = await options.repository.list(project.id, { cursor: sessionCursor, limit: PAGE_LIMIT });
        if (!sessions.ok) return sessions;
        for (const session of sessions.value.items) {
          if (session.outcome !== null) continue;
          const events = await readAllEvents(options.repository, session.header.id);
          if (!events.ok) return events;
          const recovered = await recoverExistingSession(
            options.repository,
            session.header.id,
            unfinishedProcessIds(events.value),
            (event) => options.sessions.publishRunnerEvent(event),
          );
          if (!recovered.ok) return recovered;
        }
        sessionCursor = sessions.value.nextCursor;
      } while (sessionCursor !== null);
    }
    projectCursor = projects.value.nextCursor;
  } while (projectCursor !== null);
  return { ok: true, value: undefined };
}

function unfinishedProcessIds(events: readonly SessionEvent[]): readonly ProcessId[] {
  let runner: ProcessId | null = null;
  const tools = new Set<ProcessId>();
  for (const event of events) {
    switch (event.payload.kind) {
      case "runner.started":
        runner = event.payload.processId;
        break;
      case "runner.stopped":
        runner = null;
        break;
      case "process.started":
        tools.add(event.payload.handle.id);
        break;
      case "process.completed":
        tools.delete(event.payload.completion.processId);
        break;
      default:
        break;
    }
  }
  return runner === null ? [...tools] : [runner, ...tools].filter((id, index, values) => values.indexOf(id) === index);
}
