/**
 * Repository for session and token management database operations.
 * Isolates socket tokens, device tokens, and MCP token CRUD from route handlers,
 * enabling proper unit testing without ORM chain mocking.
 */

import { db } from '@pagespace/db/db'
import { eq, and, inArray, isNull, count, type InferSelectModel } from '@pagespace/db/operators'
import { deviceTokens, mcpTokens, users } from '@pagespace/db/schema/auth'
import { mcpTokenDrives } from '@pagespace/db/schema/members'
import { drives } from '@pagespace/db/schema/core';

export type DeviceToken = InferSelectModel<typeof deviceTokens>;
export type McpToken = InferSelectModel<typeof mcpTokens>;

/** The row an MCP token mint writes: the token plus its drive scopes. */
interface McpTokenCreateInput {
  userId: string;
  tokenHash: string;
  tokenPrefix: string;
  name: string;
  isScoped: boolean;
  // role null = INHERIT (the key acts as its owner in that drive)
  drives: { id: string; role: 'ADMIN' | 'MEMBER' | null; customRoleId?: string }[];
}

export const sessionRepository = {
  /**
   * Update a device token's deviceId (one-time OAuth migration fix).
   * Returns the updated record, or null if not found.
   */
  async updateDeviceTokenDeviceId(
    deviceTokenId: string,
    deviceId: string
  ): Promise<DeviceToken | null> {
    const results = await db
      .update(deviceTokens)
      .set({ deviceId })
      .where(eq(deviceTokens.id, deviceTokenId))
      .returning();
    return results.at(0) ?? null;
  },

  /**
   * Create an MCP token with optional drive scopes in a transaction.
   * If drive scope insertion fails, the token is not created.
   *
   * `txClient`, when given, runs both inserts against that caller-owned
   * transaction instead of opening a new one — needed so a caller minting an
   * `mcp_tokens` row as a side effect of a LARGER atomic operation (e.g. the
   * OAuth authorization-code exchange, see `oauth-repository.ts`) gets a
   * single all-or-nothing commit, not two independent transactions where the
   * outer one could roll back after this one already committed.
   */
  async createMcpTokenWithDriveScopes(
    data: McpTokenCreateInput,
    txClient?: Pick<typeof db, 'insert'>,
  ): Promise<McpToken> {
    const run = async (tx: Pick<typeof db, 'insert'>): Promise<McpToken> => {
      const [token] = await tx
        .insert(mcpTokens)
        .values({
          userId: data.userId,
          tokenHash: data.tokenHash,
          tokenPrefix: data.tokenPrefix,
          name: data.name,
          isScoped: data.isScoped,
        })
        .returning();

      if (data.drives.length > 0) {
        await tx.insert(mcpTokenDrives).values(
          data.drives.map(({ id: driveId, role, customRoleId }) => ({
            tokenId: token.id,
            driveId,
            role,
            customRoleId: customRoleId ?? null,
            addedBy: data.userId,
          }))
        );
      }

      return token;
    };

    return txClient ? run(txClient) : db.transaction(run);
  },

  /**
   * Mint an MCP token for an AI agent's bearer caller (ADR 0007 Decision 6),
   * atomically with the two checks that must hold at commit time:
   *
   *  - the agent's credentials were not revoked since the caller authenticated
   *    (`users.tokenVersion` still equals the version on the caller's token);
   *  - the agent holds fewer than `maxLiveKeys` live keys.
   *
   * Both run under `SELECT … FOR NO KEY UPDATE` on the agent's `users` row — the row
   * `killAgentCredentials` updates when it revokes. So a revoke that commits
   * first makes this refuse, and a revoke that arrives while this holds the
   * lock waits and then revokes the key this inserted. Concurrent mints for
   * one agent serialise, so the cap cannot be overshot.
   */
  async createAgentMcpTokenGuarded(
    data: McpTokenCreateInput,
    guard: { expectedTokenVersion: number; maxLiveKeys: number },
  ): Promise<{ ok: true; token: McpToken } | { ok: false; reason: 'credentials_revoked' | 'key_limit_reached' }> {
    return db.transaction(async (tx) => {
      const [user] = await tx
        .select({ tokenVersion: users.tokenVersion })
        .from(users)
        .where(eq(users.id, data.userId))
        // NO KEY UPDATE: conflicts with the revoke's tokenVersion UPDATE (the
        // serialisation this needs) but not with FK KEY SHARE locks, so inserts
        // elsewhere that reference this user are not blocked by a mint.
        .for('no key update');
      if (!user || user.tokenVersion !== guard.expectedTokenVersion) {
        return { ok: false, reason: 'credentials_revoked' } as const;
      }

      const [live] = await tx
        .select({ n: count() })
        .from(mcpTokens)
        .where(and(eq(mcpTokens.userId, data.userId), isNull(mcpTokens.revokedAt)));
      if ((live?.n ?? 0) >= guard.maxLiveKeys) {
        return { ok: false, reason: 'key_limit_reached' } as const;
      }

      const token = await sessionRepository.createMcpTokenWithDriveScopes(data, tx);
      return { ok: true, token } as const;
    });
  },

  /**
   * Fetch drive names by IDs (for MCP token response formatting).
   */
  async findDrivesByIds(
    driveIds: string[]
  ): Promise<{ id: string; name: string }[]> {
    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    return db.query.drives.findMany({
      where: inArray(drives.id, driveIds),
      columns: { id: true, name: true },
    });
  },

  /**
   * List all non-revoked MCP tokens for a user with their drive scopes.
   * Filters out scopes where the drive has been deleted.
   */
  async findUserMcpTokensWithDrives(userId: string) {
    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    const tokens = await db.query.mcpTokens.findMany({
      where: (tokens, { eq, isNull, and }) =>
        and(eq(tokens.userId, userId), isNull(tokens.revokedAt)),
      columns: {
        id: true,
        name: true,
        tokenPrefix: true,
        lastUsed: true,
        createdAt: true,
        isScoped: true,
      },
      with: {
        driveScopes: {
          columns: { driveId: true, role: true, customRoleId: true },
          with: {
            drive: {
              columns: { id: true, name: true },
            },
            customRole: {
              columns: { id: true, name: true, color: true },
            },
          },
        },
      },
    });

    return tokens.map((token) => ({
      id: token.id,
      name: token.name,
      tokenPrefix: token.tokenPrefix,
      lastUsed: token.lastUsed,
      createdAt: token.createdAt,
      isScoped: token.isScoped,
      driveScopes: token.driveScopes
        .filter((scope) => scope.drive != null)
        .map((scope) => ({
          id: scope.drive.id,
          name: scope.drive.name,
          role: scope.role,
          customRoleId: scope.customRoleId,
          customRoleName: scope.customRole?.name ?? null,
        })),
    }));
  },

  /**
   * The metadata a key needs to describe ITSELF (`GET /api/auth/key`).
   *
   * Scoped by `userId` as well as `tokenId` for the same reason
   * `findMcpTokenByIdAndUser` is: the id comes from a validated credential, so
   * the owner check can only ever hold — and it stays here so a future caller
   * that gets its id from somewhere less trustworthy cannot read another
   * person's key row through this method. Deliberately narrow: no token hash,
   * and nothing about the owning USER, since the whole point of keeping
   * `/api/auth/me` closed to mcp_* tokens is that holding a key must not yield
   * the person behind it.
   *
   * `isScoped` is deliberately NOT selected. It records what the key was minted
   * as; whether the key is confined RIGHT NOW is `isDriveScopedPrincipal`, read
   * off the same `allowedDriveIds` every authorization decision uses. Returning
   * the stored flag beside a live answer derived from something else would
   * invite the two to disagree in the response — and the one case where they
   * could (a scoped key whose drives were all deleted) never reaches any route
   * at all: `validateMCPToken` fails it closed before authentication succeeds.
   */
  async findMcpTokenSelfById(tokenId: string, userId: string) {
    const token = await db.query.mcpTokens.findFirst({
      where: and(eq(mcpTokens.id, tokenId), eq(mcpTokens.userId, userId)),
      columns: {
        id: true,
        name: true,
        tokenPrefix: true,
        createdAt: true,
        lastUsed: true,
      },
    });
    return token ?? null;
  },

  /**
   * Find an MCP token by ID and user (ownership check).
   */
  async findMcpTokenByIdAndUser(
    tokenId: string,
    userId: string
  ): Promise<{ id: string; name: string } | null> {
    const token = await db.query.mcpTokens.findFirst({
      where: and(eq(mcpTokens.id, tokenId), eq(mcpTokens.userId, userId)),
      columns: { id: true, name: true },
    });
    return token ?? null;
  },

  /**
   * Ownership check that additionally requires the token to be un-revoked —
   * the gate for the `update_key` consent flow (an in-place re-scope of a
   * revoked key would silently resurrect a credential the user already killed).
   * A revoked, foreign, or nonexistent token are deliberately indistinguishable
   * (all `null`): the consent screen turns every one of them into the same
   * uniform `invalid_scope`, so probing token ids yields no oracle.
   */
  async findActiveMcpTokenByIdAndUser(
    tokenId: string,
    userId: string
  ): Promise<{ id: string; name: string } | null> {
    const token = await db.query.mcpTokens.findFirst({
      where: and(eq(mcpTokens.id, tokenId), eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)),
      columns: { id: true, name: true },
    });
    return token ?? null;
  },

  /**
   * Revoke an MCP token (soft delete by setting revokedAt).
   */
  async revokeMcpToken(tokenId: string, userId: string): Promise<void> {
    await db
      .update(mcpTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.userId, userId)));
  },

  /**
   * Replace all drive scopes on an existing MCP token transactionally.
   *
   * Once a token is scoped, it stays scoped (isScoped is never set to false).
   * If drives is empty, all existing scopes are removed but the token remains
   * scoped (fail-closed: scoped + no drives = deny all access).
   *
   * Returns the updated token record, or null if the token doesn't belong to
   * the given user or has been revoked (re-scoping a revoked key would
   * resurrect a credential the user already killed).
   *
   * `txClient`, when given, runs everything (ownership check included)
   * against that caller-owned transaction instead of opening a new one —
   * same reasoning as `createMcpTokenWithDriveScopes`: the OAuth
   * authorization-code exchange applies this update as part of a LARGER
   * atomic operation (consume code + re-scope, see `oauth-repository.ts`)
   * and needs a single all-or-nothing commit.
   */
  async updateMcpTokenDriveScopes(
    tokenId: string,
    userId: string,
    drives: { id: string; role: 'ADMIN' | 'MEMBER' | null; customRoleId?: string }[],
    txClient?: Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>,
  ): Promise<McpToken | null> {
    const run = async (tx: Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>): Promise<McpToken | null> => {
      // Ownership + un-revoked check and the "stays scoped" write are ONE
      // atomic UPDATE (row-locked until the transaction commits): a plain
      // SELECT-then-write would let a revoke that commits in between slip
      // through, silently re-scoping a just-killed credential. An empty
      // RETURNING is the not-owned/revoked/nonexistent result.
      const [updated] = await tx
        .update(mcpTokens)
        .set({ isScoped: true })
        .where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)))
        .returning();
      if (!updated) return null;

      // Delete all existing drive scopes for this token
      await tx.delete(mcpTokenDrives).where(eq(mcpTokenDrives.tokenId, tokenId));

      // Insert new scopes
      if (drives.length > 0) {
        await tx.insert(mcpTokenDrives).values(
          drives.map(({ id: driveId, role, customRoleId }) => ({
            tokenId,
            driveId,
            role,
            customRoleId: customRoleId ?? null,
            addedBy: userId,
          }))
        );
      }

      return updated;
    };

    return txClient ? run(txClient) : db.transaction(run);
  },
};
