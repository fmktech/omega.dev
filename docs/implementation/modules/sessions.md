# Module: sessions

## Owns

`src/sessions/session-service.ts`, `child-sessions.ts`, `handoffs.ts`, `recovery.ts`, and `sessions.test.ts`.

## Implements

Implement `SessionService`. Start tasks, create child sessions with immutable narrowed capabilities, aggregate child results, create handoffs, resume into a new linked session, publish live events, cancel work, and recover infrastructure interruptions in the existing session. Intentional resume and daemon recovery must remain distinct.

## Edge cases and gates

Test parent/thread linkage, child spawn event assignment, prohibited capability widening, handoff artifact completeness, empty and deep session histories, resume from missing artifacts, duplicate completion, cancellation with active processes, live subscriber reconnect sequence, and crash recovery event ordering.

