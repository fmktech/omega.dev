import type { LiveEventEnvelope, SessionId, SseFrame } from "../contracts/index.js";

export interface SseBroker {
  open(sessionId: SessionId, afterSequence: number, events: AsyncIterable<LiveEventEnvelope>): AsyncIterable<SseFrame>;
}

export function createSseBroker(): SseBroker {
  return {
    async *open(sessionId, afterSequence, events) {
      let sequence = afterSequence;
      for await (const data of events) {
        if (data.sessionId !== sessionId) throw new Error("SSE event session did not match the requested session");
        if (data.kind === "session-event") {
          if (!Number.isSafeInteger(data.event.sequence) || data.event.sequence < 0) {
            throw new Error("SSE persisted event sequence was invalid");
          }
          if (data.event.sequence <= sequence) continue;
          sequence = data.event.sequence;
        }
        yield { id: String(sequence), event: "omega.live", data };
      }
    },
  };
}

export function encodeSseFrame(frame: SseFrame): string {
  if (!/^\d+$/u.test(frame.id)) throw new Error("SSE frame id must be a decimal sequence");
  return `id: ${frame.id}\nevent: omega.live\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
