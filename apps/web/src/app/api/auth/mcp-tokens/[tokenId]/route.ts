import { NextRequest, NextResponse } from 'next/server';
import { db, mcpTokens, eq, and } from '@pagespace/db';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { loggers } from '@pagespace/lib/server';

// DELETE: Revoke an MCP token
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ tokenId: string }> }
) {
  const { tokenId } = await context.params;
  
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const decoded = await decodeToken(accessToken);
  if (!decoded) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    // Verify the token belongs to the user and revoke it
    const result = await db
      .update(mcpTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mcpTokens.id, tokenId),
          eq(mcpTokens.userId, decoded.userId)
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