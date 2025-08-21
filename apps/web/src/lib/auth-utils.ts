import { NextResponse } from 'next/server';
import { decodeToken } from '@pagespace/lib/server';

export async function authenticateRequest(request: Request): Promise<{ userId: string; error?: never } | { userId?: never; error: NextResponse }> {
  try {
    const token = request.headers.get('Authorization')?.replace('Bearer ', '') || 
                  request.headers.get('Cookie')?.split(';')
                    .find(cookie => cookie.trim().startsWith('accessToken='))
                    ?.split('=')[1];

    if (!token) {
      return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }

    const payload = await decodeToken(token);
    if (!payload || !payload.userId) {
      return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) };
    }

    return { userId: payload.userId };
  } catch (error) {
    console.error('Authentication error:', error);
    return { error: NextResponse.json({ error: 'Authentication failed' }, { status: 401 }) };
  }
}