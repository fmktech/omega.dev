import type {
  HarnessId,
  LiveEventEnvelope,
  ProcessId,
  Result,
  SessionError,
  SessionEvent,
  SessionId,
  SessionRecord,
  SessionRepository,
} from "../contracts/index.js";
import { readAllEvents } from "./handoffs.js";

export type RecoveryPublisher = (event: LiveEventEnvelope) => void;

/**
 * Records daemon recovery in the existing append-only session. Unlike an
 * intentional resume, this never creates a session, thread, or handoff.
 */
export async function recoverExistingSession(
  repository: SessionRepository,
  sessionId: SessionId,
  interruptedProcessIds: readonly ProcessId[],
  publish: RecoveryPublisher = () => undefined,
): Promise<Result<SessionRecord, SessionError>> {
  const current = await repository.get(sessionId);
  if (!current.ok) return current;
  if (current.value.outcome !== null) return current;

  const previous = await readAllEvents(repository, sessionId);
  if (!previous.ok) return previous;
  const alreadyRecovered = previous.value.find((event) => event.payload.kind === "session.recovered"
    && sameProcessIds(event.payload.interruptedProcessIds, interruptedProcessIds));
  if (alreadyRecovered !== undefined) return repository.get(sessionId);

  const appended = await repository.append(
    sessionId,
    current.value.lastSequence,
    { kind: "session.recovered", interruptedProcessIds: [...interruptedProcessIds] },
    currentHarness(previous.value, current.value.header.initialHarnessId),
    null,
  );
  if (!appended.ok) return appended;
  publish({ kind: "session-event", sessionId, event: appended.value });
  return repository.get(sessionId);
}

function currentHarness(events: readonly SessionEvent[], initial: HarnessId): HarnessId {
  let harnessId = initial;
  for (const event of events) if (event.payload.kind === "harness.updated") harnessId = event.payload.update.activeHarnessId;
  return harnessId;
}

function sameProcessIds(left: readonly ProcessId[], right: readonly ProcessId[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((id) => values.has(id));
}
