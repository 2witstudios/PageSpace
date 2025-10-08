import { NextRequest, NextResponse } from 'next/server';
import { db, mcpTokens, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

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
    // Verify the token belongs to the user and revoke it
    const result = await db
      .update(mcpTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mcpTokens.id, tokenId),
          eq(mcpTokens.userId, userId)
        )
      )
      .returning({ id: mcpTokens.id });

    if (result.length === 0) {
      return new NextResponse('Token not found', { status: 404 });
    }

    return NextResponse.json({ message: 'Token revoked successfully' });
  } catch (error) {
    loggers.auth.error('Error revoking MCP token:', error as Error);
    return NextResponse.json({ error: 'Failed to revoke MCP token' }, { status: 500 });
  }
}