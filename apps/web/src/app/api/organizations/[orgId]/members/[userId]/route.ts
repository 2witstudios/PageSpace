import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkOrgAccess, removeOrgMember } from '@pagespace/lib/server';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function DELETE(
  request: Request,
  context: { params: Promise<{ orgId: string; userId: string }> }
) {
  const { orgId, userId: targetUserId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const access = await checkOrgAccess(orgId, auth.userId);

    if (!access.org) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }

    // Users can remove themselves; owners/admins can remove others
    const isSelf = auth.userId === targetUserId;
    if (!isSelf && !access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only owners and admins can remove members' }, { status: 403 });
    }

    // Cannot remove the org owner
    if (targetUserId === access.org.ownerId) {
      return NextResponse.json({ error: 'Cannot remove the organization owner' }, { status: 400 });
    }

    await removeOrgMember(orgId, targetUserId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 });
  }
}
