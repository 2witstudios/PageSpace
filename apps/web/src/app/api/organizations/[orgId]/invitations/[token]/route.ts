import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { acceptInvitation } from '@pagespace/lib/server';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string; token: string }> }
) {
  const { token } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const result = await acceptInvitation(token, auth.userId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to accept invitation';
    const status = message.includes('not found') ? 404
      : message.includes('expired') ? 410
      : message.includes('already') ? 409
      : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
