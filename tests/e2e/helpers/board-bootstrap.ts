import fs from "node:fs";
import path from "node:path";
import { acquireBoardToken } from "../../../cli/src/__tests__/helpers/board-token.js";

/**
 * Resolve the embedded-postgres connection string the e2e webServer is using
 * for this run. Reads the config file that `paperclipai onboard --yes --run`
 * wrote into the throwaway PAPERCLIP_HOME exported by playwright.config.ts.
 *
 * Required because the spec needs DB access to bootstrap a board API key
 * (see acquireE2eBoardToken) — local_trusted mode rejects mutating requests
 * without a Bearer token (server/src/middleware/auth.ts; AIU-307 + AIU-662).
 */
export function resolveE2eEmbeddedPostgresDatabaseUrl(): string {
  const home = process.env.PAPERCLIP_E2E_HOME;
  const instanceId = process.env.PAPERCLIP_E2E_INSTANCE_ID;
  if (!home || !instanceId) {
    throw new Error(
      "PAPERCLIP_E2E_HOME / PAPERCLIP_E2E_INSTANCE_ID not set — playwright.config.ts must export them before spec workers boot.",
    );
  }
  const configPath = path.join(home, "instances", instanceId, "config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    database?: { mode?: string; embeddedPostgresPort?: number; connectionString?: string };
  };
  if (raw.database?.mode === "postgres" && raw.database.connectionString) {
    return raw.database.connectionString;
  }
  const port = raw.database?.embeddedPostgresPort ?? 54329;
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

/**
 * Mint a board API key for the implicit local-board principal so e2e specs
 * can satisfy the local_trusted mutating-auth guard. Use the returned token
 * as `Authorization: Bearer ...` on every board-context request.
 */
export async function acquireE2eBoardToken(): Promise<string> {
  const databaseUrl = resolveE2eEmbeddedPostgresDatabaseUrl();
  const { token } = await acquireBoardToken({ databaseUrl });
  return token;
}
