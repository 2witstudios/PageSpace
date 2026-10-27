import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { credentialActor, type AccessActor } from '../../access-actor';

/**
 * The credential a key's resolvers are asked through (D-OW-45): the key's OWNER presenting it. No fixture org sets a
 * sign-in policy, so the owner's actor carries no evidence.
 */
export async function tokenOwnerActor(tokenId: string): Promise<AccessActor> {
  const [row] = await db.select({ userId: mcpTokens.userId }).from(mcpTokens).where(eq(mcpTokens.id, tokenId)).limit(1);
  if (!row) throw new Error(`No MCP token ${tokenId}`);
  return credentialActor(row.userId, null);
}
