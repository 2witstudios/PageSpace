import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { expelConversationFromSession, findWorkspaceOfConversation } from '@/lib/agent-workspaces/agent-workspaces-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * GET - Get a specific conversation with its messages
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'global_chat', resourceId: 'get', details: { reason: 'auth_failed', method: 'GET', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { id } = await context.params;

    const conversation = await globalConversationRepository.getConversationById(userId, id);

    if (!conversation) {
      return NextResponse.json({
        error: 'Conversation not found'
      }, { status: 404 });
    }

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'global_chat', resourceId: id, details: {
      action: 'get_conversation',
    } });

    return NextResponse.json(conversation);
  } catch (error) {
    loggers.api.error('Error fetching conversation:', error as Error);
    return NextResponse.json({
      error: 'Failed to fetch conversation'
    }, { status: 500 });
  }
}

/**
 * PATCH - Update conversation (e.g., title)
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'global_chat', resourceId: 'update', details: { reason: 'auth_failed', method: 'PATCH', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { id } = await context.params;
    const body = await request.json();
    const { title } = body;

    const updatedConversation = await globalConversationRepository.updateConversationTitle(
      userId,
      id,
      title
    );

    if (!updatedConversation) {
      return NextResponse.json({
        error: 'Conversation not found'
      }, { status: 404 });
    }

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'global_chat', resourceId: id, details: {
      action: 'update_conversation',
    } });

    return NextResponse.json(updatedConversation);
  } catch (error) {
    loggers.api.error('Error updating conversation:', error as Error);
    return NextResponse.json({
      error: 'Failed to update conversation'
    }, { status: 500 });
  }
}

/**
 * DELETE - Delete a conversation
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'global_chat', resourceId: 'delete', details: { reason: 'auth_failed', method: 'DELETE', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { id } = await context.params;

    const conversation = await globalConversationRepository.getConversationById(userId, id);
    if (!conversation) {
      return NextResponse.json({
        error: 'Conversation not found'
      }, { status: 404 });
    }

    // A global-assistant conversation can be a workspace member exactly like a
    // page-agent one (`createConversationInSession`'s `createGlobalConversation`
    // arm), so it shares the same never-empty invariant AND the same reopen
    // race: deleting it here while a reopen POST
    // (`/api/agent-workspaces/[workspaceId]/conversations/[id]/reopen`) is in
    // flight could otherwise commit `isActive: false` right as the reopen's
    // unguarded read passes, leaving a "reopened" conversation invisible to
    // every listing (review finding — chatgpt-codex-connector on PR #2296).
    // Both halves of that are now the same lock on the same tree.
    const membership = await findWorkspaceOfConversation(id);
    if (membership) {
      const workspaceId = membership;
      // EXPEL FIRST, THEN DELETE. The membership write takes the workspace's
      // own lock, reads the tree inside it, and refuses when this is the last
      // conversation — so the never-empty guard is a count over the very tree
      // the same transaction is about to change, where it used to be a separate
      // read under a separate lock. It also closes the reopen race by
      // construction: a concurrent reopen is a write to this same tree under
      // this same lock, so the two serialize rather than interleaving.
      const outcome = await expelConversationFromSession({
        conversationId: id,
        workspaceId,
        actingUserId: userId,
        requireSurvivor: true,
      });

      if (outcome === 'refused') {
        return NextResponse.json({ error: 'Could not delete this conversation' }, { status: 500 });
      }
      if (outcome === 'expelled') {
        // Ordered deliberately — see `expelConversationFromSession`'s doc for
        // why the survivable failure is the one that can happen here.
        await globalConversationRepository.softDeleteConversation(userId, id);
      }

      if (outcome === 'last_conversation') {
        auditRequest(request, {
          eventType: 'security.rate.limited',
          userId,
          resourceType: 'global_chat',
          resourceId: id,
          details: { reason: 'last_session_conversation', workspaceId, method: 'DELETE' },
          riskScore: 0,
        });
        return NextResponse.json(
          {
            error: 'This is the only conversation in its session — close the pane (or end the session) instead of deleting it from History.',
            reason: 'last_conversation',
          },
          { status: 409 },
        );
      }
    } else {
      await globalConversationRepository.softDeleteConversation(userId, id);
    }

    auditRequest(request, { eventType: 'data.delete', userId, resourceType: 'global_chat', resourceId: id, details: {
      action: 'delete_conversation',
    } });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting conversation:', error as Error);
    return NextResponse.json({
      error: 'Failed to delete conversation'
    }, { status: 500 });
  }
}
