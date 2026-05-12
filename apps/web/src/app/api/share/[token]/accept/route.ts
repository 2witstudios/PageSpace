import { NextResponse } from 'next/server';
import { authenticateWithEnforcedContext, isEnforcedAuthError } from '@/lib/auth';
import {
  resolveShareToken,
  redeemDriveShareLink,
  redeemPageShareLink,
} from '@pagespace/lib/permissions/share-link-service';

const AUTH_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const auth = await authenticateWithEnforcedContext(request, AUTH_WRITE);
  if (isEnforcedAuthError(auth)) return auth.error;

  const { token } = await context.params;

  const info = await resolveShareToken(token);
  if (!info) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (info.type === 'drive') {
    const result = await redeemDriveShareLink(auth.ctx, token);
    if (!result.ok) {
      if (result.error === 'ALREADY_MEMBER') {
        return NextResponse.json({ type: 'drive', driveId: info.driveId });
      }
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Failed to redeem share link' }, { status: 500 });
    }
    return NextResponse.json({ type: 'drive', driveId: info.driveId });
  }

  const result = await redeemPageShareLink(auth.ctx, token);
  if (!result.ok) {
    if (result.error === 'ALREADY_MEMBER') {
      return NextResponse.json({ type: 'page', pageId: info.pageId, driveId: info.driveId });
    }
    if (result.error === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Failed to redeem share link' }, { status: 500 });
  }
  return NextResponse.json({
    type: 'page',
    pageId: info.pageId,
    driveId: info.driveId,
  });
}
