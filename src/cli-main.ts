#!/usr/bin/env node

import { createOmegaClient } from "./clients/local-client.js";
import { runCli } from "./clients/cli.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";

const DEFAULT_DAEMON_URL = `http://${DEFAULT_CONFIG.server.host}:${DEFAULT_CONFIG.server.port}`;

async function main(): Promise<number> {
  const tokenName = String(DEFAULT_CONFIG.server.bearerTokenEnvName);
  const token = process.env[tokenName];
  if (token === undefined || token.length === 0) {
    process.stderr.write(`omega: ${tokenName} is required\n`);
    return 1;
  }
  const baseUrl = process.env["OMEGA_DAEMON_URL"] ?? DEFAULT_DAEMON_URL;
  return runCli(process.argv.slice(2), createOmegaClient(baseUrl, token));
}

void main().then((code) => {
  process.exitCode = code;
}, (error: unknown) => {
  const message = error instanceof Error ? error.message : "Omega CLI failed";
  process.stderr.write(`omega: ${message}\n`);
  process.exitCode = 1;
});
