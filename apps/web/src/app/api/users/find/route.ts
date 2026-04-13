import { NextResponse } from 'next/server';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { users, db, eq } from '@pagespace/db';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false } as const;

export async function GET(request: Request) {
  // Support both Bearer tokens (desktop) and cookies (web)
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');

  if (!email) {
    return NextResponse.json({ error: 'Email parameter is missing' }, { status: 400 });
  }

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true, name: true, email: true, image: true },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'user_search', resourceId: user.id, details: { queryLength: email.length, resultCount: 1 } });

    return NextResponse.json(user);
  } catch (error) {
    loggers.api.error('Error finding user:', error as Error);
    return NextResponse.json({ error: 'Failed to find user' }, { status: 500 });
  }
}