import { NextRequest, NextResponse } from 'next/server';
import { db, mcpTokens } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';
import { getActorInfo, logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';
import { generateToken } from '@pagespace/lib/auth';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

// Schema for creating a new MCP token
const createTokenSchema = z.object({
  name: z.string().min(1).max(100),
});

// POST: Create a new MCP token
export async function POST(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { name } = createTokenSchema.parse(body);

    // P1-T3: Generate token with hash and prefix for secure storage
    // SECURITY: Only the hash is stored - plaintext token is returned once and never persisted
    const { token: rawToken, hash: tokenHash, tokenPrefix } = generateToken('mcp');

    // Store ONLY the hash in the database - never store plaintext tokens
    // The 'token' column stores the hash to satisfy the NOT NULL + UNIQUE constraints
    const [newToken] = await db.insert(mcpTokens).values({
      userId,
      token: tokenHash, // Store hash, NOT plaintext
      tokenHash,
      tokenPrefix,
      name,
    }).returning();

    // Log activity for audit trail (token creation is a security event)
    const actorInfo = await getActorInfo(userId);
    logTokenActivity(userId, 'token_create', {
      tokenId: newToken.id,
      tokenType: 'mcp',
      tokenName: newToken.name,
    }, actorInfo);

    // Return the raw token ONCE to the user - this is the only time they'll see it
    return NextResponse.json({
      id: newToken.id,
      name: newToken.name,
      token: rawToken, // Return the actual token, not the hash
      createdAt: newToken.createdAt,
    });
  } catch (error) {
    loggers.auth.error('Error creating MCP token:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to create MCP token' }, { status: 500 });
  }
}

// GET: List user's MCP tokens (without the actual token values)
export async function GET(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    // Fetch all non-revoked tokens for the user
    const tokens = await db.query.mcpTokens.findMany({
      where: (tokens, { eq, isNull, and }) => and(
        eq(tokens.userId, userId),
        isNull(tokens.revokedAt)
      ),
      columns: {
        id: true,
        name: true,
        lastUsed: true,
        createdAt: true,
      },
    });

    return NextResponse.json(tokens);
  } catch (error) {
    loggers.auth.error('Error fetching MCP tokens:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch MCP tokens' }, { status: 500 });
  }
}