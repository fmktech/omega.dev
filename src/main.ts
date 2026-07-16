import { pathToFileURL } from "node:url";

import { startHttpServer } from "./app/http-server.js";
import { createOmegaApplication } from "./app/omega-app.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import type { EnvironmentVariables, HttpServerHandle, OmegaApplication, OmegaConfig, Result, Timestamp } from "./contracts/index.js";

export interface OmegaDaemonHandle {
  readonly application: OmegaApplication;
  readonly server: HttpServerHandle;
  stop(): Promise<void>;
}

export async function startDaemon(
  config: OmegaConfig = DEFAULT_CONFIG,
  environment: EnvironmentVariables = process.env,
): Promise<Result<OmegaDaemonHandle, Error>> {
  const application = createOmegaApplication(config, environment);
  const started = await application.start();
  if (!started.ok) return { ok: false, error: new Error(`Omega application failed to start: ${started.error.kind}`) };
  const listener = await startHttpServer(application, config.server, environment);
  if (!listener.ok) {
    const deadline = new Date(Date.now() + Number(config.processes.gracefulShutdownMs)).toISOString() as Timestamp;
    await application.stop(deadline);
    return { ok: false, error: new Error(`Omega listener failed to start: ${listener.error.kind}`) };
  }
  let stopped = false;
  return {
    ok: true,
    value: {
      application,
      server: listener.value,
      async stop() {
        if (stopped) return;
        stopped = true;
        const deadline = new Date(Date.now() + Number(config.processes.gracefulShutdownMs)).toISOString() as Timestamp;
        await listener.value.stop(deadline);
        await application.stop(deadline);
      },
    },
  };
}

async function main(): Promise<number> {
  const daemon = await startDaemon();
  if (!daemon.ok) {
    process.stderr.write(`${daemon.error.message}\n`);
    return 1;
  }
  process.stdout.write(`Omega daemon listening on http://${daemon.value.server.host}:${daemon.value.server.port}\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => { void daemon.value.stop().finally(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().then((code) => { process.exitCode = code; });
}

export { createOmegaApplication, startHttpServer };
