/**
 * Repository for session and token management database operations.
 * Isolates socket tokens, device tokens, and MCP token CRUD from route handlers,
 * enabling proper unit testing without ORM chain mocking.
 */

import { db } from '@pagespace/db/db'
import { eq, and, inArray, isNull, type InferSelectModel } from '@pagespace/db/operators'
import { deviceTokens, mcpTokens } from '@pagespace/db/schema/auth'
import { mcpTokenDrives } from '@pagespace/db/schema/members'
import { drives } from '@pagespace/db/schema/core';

export type DeviceToken = InferSelectModel<typeof deviceTokens>;
export type McpToken = InferSelectModel<typeof mcpTokens>;

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
    data: {
      userId: string;
      tokenHash: string;
      tokenPrefix: string;
      name: string;
      isScoped: boolean;
      // role null = INHERIT (the key acts as its owner in that drive)
      drives: { id: string; role: 'ADMIN' | 'MEMBER' | null; customRoleId?: string }[];
    },
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
   * Fetch drive names by IDs (for MCP token response formatting).
   */
  async findDrivesByIds(
    driveIds: string[]
  ): Promise<{ id: string; name: string }[]> {
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
