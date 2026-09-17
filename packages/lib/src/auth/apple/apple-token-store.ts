/**
 * Persistence seam for Sign in with Apple refresh tokens. Stores and returns
 * CIPHERTEXT only — encryption and decryption happen in the callers
 * (`capture-apple-refresh-token`, `revoke-apple-tokens`), so this module never
 * holds a plaintext token.
 */
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { appleSignInTokens } from '@pagespace/db/schema/auth';

export interface StoredAppleToken {
  clientId: string;
  /** AES-256-GCM ciphertext. */
  refreshToken: string;
}

export const appleTokenStore = {
  /** Insert or replace the user's token for this Apple client. */
  async upsert(args: { userId: string; clientId: string; encryptedRefreshToken: string }): Promise<void> {
    const now = new Date();
    await db
      .insert(appleSignInTokens)
      .values({
        userId: args.userId,
        clientId: args.clientId,
        refreshToken: args.encryptedRefreshToken,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [appleSignInTokens.userId, appleSignInTokens.clientId],
        set: { refreshToken: args.encryptedRefreshToken, updatedAt: now },
      });
  },

  async listForUser(userId: string): Promise<StoredAppleToken[]> {
    // A user has at most one row per Apple client (native + web), so this is bounded.
    return db
      .select({ clientId: appleSignInTokens.clientId, refreshToken: appleSignInTokens.refreshToken })
      .from(appleSignInTokens)
      .where(eq(appleSignInTokens.userId, userId));
  },

  async hasForUser(userId: string): Promise<boolean> {
    const row = await db.query.appleSignInTokens.findFirst({
      where: eq(appleSignInTokens.userId, userId),
      columns: { id: true },
    });
    return row !== undefined;
  },

  /** Delete every stored token for the user; returns how many rows went. */
  async deleteForUser(userId: string): Promise<number> {
    const deleted = await db
      .delete(appleSignInTokens)
      .where(eq(appleSignInTokens.userId, userId))
      .returning({ id: appleSignInTokens.id });
    return deleted.length;
  },
};
