import { NextResponse } from 'next/server';
import { verifyAuth, getClientIP } from '@/lib/auth';
import { sessionService } from '@pagespace/lib';

const WS_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour - connection is persistent

export async function POST(request: Request) {
  const user = await verifyAuth(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = await sessionService.createSession({
    userId: user.id,
    type: 'service',
    scopes: ['mcp:*'],
    expiresInMs: WS_TOKEN_EXPIRY_MS,
    createdByService: 'desktop',
    createdByIp: getClientIP(request),
  });

  return NextResponse.json({ token });
}
