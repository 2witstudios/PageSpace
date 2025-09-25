import { NextRequest, NextResponse } from 'next/server';
import { db, mcpTokens } from '@pagespace/db';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import * as crypto from 'crypto';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';

// Generate a secure MCP token with prefix
function generateMCPToken(): string {
  const randomBytes = crypto.randomBytes(32).toString('base64url');
  return `mcp_${randomBytes}`;
}

// Schema for creating a new MCP token
const createTokenSchema = z.object({
  name: z.string().min(1).max(100),
});

// POST: Create a new MCP token
export async function POST(req: NextRequest) {
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
    const body = await req.json();
    const { name } = createTokenSchema.parse(body);

    // Generate a new MCP token
    const token = generateMCPToken();
    
    // Store the token in the database
    const [newToken] = await db.insert(mcpTokens).values({
      userId: decoded.userId,
      token,
      name,
    }).returning();

    // Return the token (only shown once to the user)
    return NextResponse.json({
      id: newToken.id,
      name: newToken.name,
      token: newToken.token,
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
    // Fetch all non-revoked tokens for the user
    const tokens = await db.query.mcpTokens.findMany({
      where: (tokens, { eq, isNull, and }) => and(
        eq(tokens.userId, decoded.userId),
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