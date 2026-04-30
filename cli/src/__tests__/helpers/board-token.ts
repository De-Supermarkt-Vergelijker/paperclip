import { createHash, randomBytes } from "node:crypto";
import { boardApiKeys, createDb } from "@paperclipai/db";

const LOCAL_BOARD_USER_ID = "local-board";
const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface ClosableDb {
  $client?: {
    end?: (options?: { timeout?: number }) => Promise<void>;
  };
}

export interface AcquireBoardTokenOptions {
  databaseUrl: string;
  name?: string;
  expiresInMs?: number;
}

export interface AcquiredBoardToken {
  token: string;
  keyId: string;
  expiresAt: Date;
}

/**
 * Mint a board API key for the local-board principal so that test setups
 * acting as the implicit board can satisfy the local_trusted mutating-auth
 * guard introduced in f71a1bc + 9c44788 (AIU-307).
 *
 * The server's startup path inserts the local-board authUser before any
 * route is served (ensureLocalTrustedBoardPrincipal in server/src/index.ts),
 * so the foreign-key constraint on board_api_keys.user_id is satisfied as
 * long as the server has finished boot before this helper runs.
 */
export async function acquireBoardToken(
  opts: AcquireBoardTokenOptions,
): Promise<AcquiredBoardToken> {
  const token = `pcp_board_${randomBytes(24).toString("hex")}`;
  const keyHash = createHash("sha256").update(token).digest("hex");
  const ttlMs = opts.expiresInMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  const db = createDb(opts.databaseUrl);
  try {
    const inserted = await db
      .insert(boardApiKeys)
      .values({
        userId: LOCAL_BOARD_USER_ID,
        name: opts.name ?? "test-board-key",
        keyHash,
        expiresAt,
      })
      .returning({ id: boardApiKeys.id });

    const keyId = inserted[0]?.id;
    if (!keyId) {
      throw new Error("acquireBoardToken: failed to insert board_api_keys row");
    }
    return { token, keyId, expiresAt };
  } finally {
    const closable = db as unknown as ClosableDb;
    await closable.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
