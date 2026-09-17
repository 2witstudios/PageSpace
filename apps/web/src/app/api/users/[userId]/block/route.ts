import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { blockUser, unblockUser } from '@/lib/repositories/user-block-repository';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

// POST /api/users/[userId]/block - Block a user (no messages either way)
export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId: targetId } = await context.params;

    if (targetId === auth.userId) {
      return NextResponse.json({ error: 'You cannot block yourself' }, { status: 400 });
    }

    await blockUser(auth.userId, targetId);
    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'user_block', resourceId: targetId, details: { action: 'block' } });
    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error blocking user:', error as Error);
    return NextResponse.json({ error: 'Failed to block user' }, { status: 500 });
  }
}

// DELETE /api/users/[userId]/block - Lift a block this user placed
export async function DELETE(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId: targetId } = await context.params;

    const lifted = await unblockUser(auth.userId, targetId);
    if (!lifted) {
      return NextResponse.json({ error: 'No block found' }, { status: 404 });
    }
    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'user_block', resourceId: targetId, details: { action: 'unblock' } });
    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error unblocking user:', error as Error);
    return NextResponse.json({ error: 'Failed to unblock user' }, { status: 500 });
  }
}
