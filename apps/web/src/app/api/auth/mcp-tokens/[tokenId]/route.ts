import { NextRequest, NextResponse } from 'next/server';
import { db, mcpTokens, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { getActorInfo, logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

// DELETE: Revoke an MCP token
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ tokenId: string }> }
) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { tokenId } = await context.params;

  try {
    // Get the token first to capture its name for the audit log
    const existingToken = await db.query.mcpTokens.findFirst({
      where: and(eq(mcpTokens.id, tokenId), eq(mcpTokens.userId, userId)),
      columns: { id: true, name: true },
    });

    if (!existingToken) {
      return new NextResponse('Token not found', { status: 404 });
    }

    // Verify the token belongs to the user and revoke it
    await db
      .update(mcpTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mcpTokens.id, tokenId),
          eq(mcpTokens.userId, userId)
        )
      );

    // Log activity for audit trail (token revocation is a security event)
    const actorInfo = await getActorInfo(userId);
    logTokenActivity(userId, 'token_revoke', {
      tokenId,
      tokenType: 'mcp',
      tokenName: existingToken.name,
    }, actorInfo);

    return NextResponse.json({ message: 'Token revoked successfully' });
  } catch (error) {
    loggers.auth.error('Error revoking MCP token:', error as Error);
    return NextResponse.json({ error: 'Failed to revoke MCP token' }, { status: 500 });
  }
}