import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { db, eq, and, mcpTokens, isNull, users } from '@pagespace/db';

// Validate MCP token and return user ID
async function validateMCPToken(token: string): Promise<string | null> {
  try {
    if (!token || !token.startsWith('mcp_')) {
      return null;
    }

    const tokenData = await db.query.mcpTokens.findFirst({
      where: and(
        eq(mcpTokens.token, token),
        isNull(mcpTokens.revokedAt)
      ),
    });

    if (!tokenData) {
      return null;
    }

    await db
      .update(mcpTokens)
      .set({ lastUsed: new Date() })
      .where(eq(mcpTokens.id, tokenData.id));

    return tokenData.userId;
  } catch (error) {
    console.error('MCP token validation error:', error);
    return null;
  }
}

// Verify authentication and return user info
export async function verifyAuth(request: Request): Promise<{ id: string } | null> {
  // Check for Bearer token (MCP authentication) first
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer mcp_')) {
    const mcpToken = authHeader.substring(7); // Remove "Bearer " prefix
    const userId = await validateMCPToken(mcpToken);
    if (userId) {
      return { id: userId };
    }
  }

  // Fallback to cookie-based authentication
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) {
    return null;
  }

  const cookies = parse(cookieHeader);
  const authToken = cookies['accessToken'];
  if (!authToken) {
    return null;
  }

  const decoded = await decodeToken(authToken);
  if (!decoded || !decoded.userId) {
    return null;
  }

  return { id: decoded.userId };
}

// Check if user is an admin
export async function isUserAdmin(userId: string): Promise<boolean> {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        role: true
      }
    });

    return user?.role === 'admin';
  } catch (error) {
    console.error('Error checking admin status:', error);
    return false;
  }
}

// Verify authentication and check if user is admin
export async function verifyAdminAuth(request: Request): Promise<{ id: string; isAdmin: boolean } | null> {
  const authUser = await verifyAuth(request);
  
  if (!authUser) {
    return null;
  }

  const isAdmin = await isUserAdmin(authUser.id);
  
  if (!isAdmin) {
    return null;
  }

  return { id: authUser.id, isAdmin };
}