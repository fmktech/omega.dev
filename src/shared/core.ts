/**
 * FROZEN SHARED HELPERS — immutable once fan-out has started.
 * These primitives are the only shared runtime logic available to leaf modules.
 */

import type { ByteCount, JsonValue } from "../contracts/index.js";

export function encodeJsonLine(value: JsonValue): string {
  return `${JSON.stringify(value)}\n`;
}

export function utf8ByteLength(value: string): ByteCount {
  return Buffer.byteLength(value, "utf8") as ByteCount;
}

export function assertNever(value: never, context: string): never {
  throw new Error(`Unreachable ${context}: ${String(value)}`);
}
