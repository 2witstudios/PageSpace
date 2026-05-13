import { NextResponse } from 'next/server';
import { authenticateWithEnforcedContext, isEnforcedAuthError } from '@/lib/auth';
import { revokePageShareLink } from '@pagespace/lib/permissions/share-link-service';

const AUTH_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function DELETE(
  request: Request,
  context: { params: Promise<{ pageId: string; linkId: string }> }
) {
  const auth = await authenticateWithEnforcedContext(request, AUTH_WRITE);
  if (isEnforcedAuthError(auth)) return auth.error;

  const { linkId } = await context.params;

  const result = await revokePageShareLink(auth.ctx, linkId);

  if (!result.ok) {
    if (result.error === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (result.error === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Share link not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Failed to revoke share link' }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
