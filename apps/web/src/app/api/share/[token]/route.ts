import { NextResponse } from 'next/server';
import { resolveShareToken } from '@pagespace/lib/permissions/share-link-service';
import { authenticateWithEnforcedContext } from '@/lib/auth/request-auth';
import { isEnforcedAuthError } from '@/lib/auth/auth-core';

const AUTH_READ = { allow: ['session'] as const, requireCSRF: false };

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const auth = await authenticateWithEnforcedContext(request, AUTH_READ);
  if (isEnforcedAuthError(auth)) return auth.error;

  const { token } = await context.params;

  const info = await resolveShareToken(token);
  if (!info) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(info);
}
