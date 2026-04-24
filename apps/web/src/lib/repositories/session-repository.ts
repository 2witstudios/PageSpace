/**
 * Repository for session and token management database operations.
 * Isolates socket tokens, device tokens, and MCP token CRUD from route handlers,
 * enabling proper unit testing without ORM chain mocking.
 */

import { db } from '@pagespace/db/db'
import { eq, and, inArray, type InferSelectModel } from '@pagespace/db/operators'
import { socketTokens, deviceTokens, mcpTokens, mcpTokenDrives } from '@pagespace/db/schema/auth'
import { drives } from '@pagespace/db/schema/core';

export type DeviceToken = InferSelectModel<typeof deviceTokens>;
export type McpToken = InferSelectModel<typeof mcpTokens>;

export const sessionRepository = {
  /**
   * Store a hashed socket token for Socket.IO authentication.
   */
  async createSocketToken(data: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
  }): Promise<void> {
    await db.insert(socketTokens).values(data);
  },

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
   */
  async createMcpTokenWithDriveScopes(data: {
    userId: string;
    tokenHash: string;
    tokenPrefix: string;
    name: string;
    isScoped: boolean;
    driveIds: string[];
  }): Promise<McpToken> {
    return db.transaction(async (tx) => {
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

      if (data.driveIds.length > 0) {
        await tx.insert(mcpTokenDrives).values(
          data.driveIds.map((driveId) => ({
            tokenId: token.id,
            driveId,
          }))
        );
      }

      return token;
    });
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
        lastUsed: true,
        createdAt: true,
        isScoped: true,
      },
      with: {
        driveScopes: {
          columns: { driveId: true },
          with: {
            drive: {
              columns: { id: true, name: true },
            },
          },
        },
      },
    });

    return tokens.map((token) => ({
      id: token.id,
      name: token.name,
      lastUsed: token.lastUsed,
      createdAt: token.createdAt,
      isScoped: token.isScoped,
      driveScopes: token.driveScopes
        .filter((scope) => scope.drive != null)
        .map((scope) => ({
          id: scope.drive.id,
          name: scope.drive.name,
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
   * Revoke an MCP token (soft delete by setting revokedAt).
   */
  async revokeMcpToken(tokenId: string, userId: string): Promise<void> {
    await db
      .update(mcpTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.userId, userId)));
  },
};

export type SessionRepository = typeof sessionRepository;
