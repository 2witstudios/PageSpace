import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalEditPage } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { countOpenConversationsForSession, withSessionListingLock } from '@/lib/agent-workspaces/agent-sessions-runtime';
import { broadcastAiConversationAdded, broadcastAiConversationRenamed, broadcastAiConversationDeleted } from '@/lib/websocket/socket-utils';
import { resolveTriggeredBy } from '@/lib/websocket/broadcast-triggered-by';
import { maskIdentifier } from '@/lib/logging/mask';

// Auth options: PATCH and DELETE are write operations requiring CSRF protection
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * PATCH /api/ai/page-agents/[agentId]/conversations/[conversationId]
 *
 * Updates conversation metadata such as title. Persists the title to the
 * conversations table via upsert (insert or update).
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ agentId: string; conversationId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent_conversation', resourceId: 'update', details: { reason: 'auth_failed', method: 'PATCH', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }

    const { agentId, conversationId } = await context.params;

    // Verify agent exists and is AI_CHAT type
    const agent = await conversationRepository.getAiAgent(agentId);

    if (!agent) {
      return NextResponse.json(
        { error: 'AI agent not found' },
        { status: 404 }
      );
    }

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, agentId);
    if (scopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: conversationId, details: { reason: 'mcp_page_scope_denied', agentId, method: 'PATCH' }, riskScore: 0.5 });
      return scopeError;
    }

    // Check permissions (need edit to modify conversations)
    const canEdit = await canPrincipalEditPage(auth, agentId);
    if (!canEdit) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: conversationId, details: { reason: 'no_edit_permission', agentId, method: 'PATCH' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'Insufficient permissions to modify this conversation' },
        { status: 403 }
      );
    }

    // Parse request body
    const body = await request.json();
    const { title, isShared } = body;

    const hasTitle = typeof title === 'string';
    const hasIsShared = typeof isShared === 'boolean';

    if (!hasTitle && !hasIsShared) {
      return NextResponse.json(
        { error: 'Request must include title or isShared' },
        { status: 400 }
      );
    }

    if (hasTitle && title.trim().length === 0) {
      return NextResponse.json(
        { error: 'Title is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    if (hasTitle && title.length > 255) {
      return NextResponse.json(
        { error: 'Title must be 255 characters or fewer' },
        { status: 400 }
      );
    }

    // Validate that the conversation exists (has at least one active message)
    const exists = await conversationRepository.conversationExists(agentId, conversationId);

    if (!exists) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // isShared toggle: only the conversation owner may change sharing
    if (hasIsShared) {
      const conversation = await conversationRepository.getConversation(conversationId);
      if (conversation && conversation.userId !== auth.userId) {
        auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: conversationId, details: { reason: 'not_conversation_owner', agentId, method: 'PATCH' }, riskScore: 0.5 });
        return NextResponse.json(
          { error: 'Only the conversation owner can change sharing' },
          { status: 403 }
        );
      }
      await conversationRepository.setConversationShared(conversationId, isShared);
    }

    let persisted: { id: string; title: string | null } = { id: conversationId, title: null };
    if (hasTitle) {
      persisted = await conversationRepository.upsertConversationTitle(
        conversationId,
        auth.userId,
        agentId,
        title
      );
    }

    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: conversationId, details: {
      action: 'update_conversation',
      agentId,
    } });

    void (async () => {
      try {
        const triggeredBy = await resolveTriggeredBy(auth.userId, request);
        if (hasTitle) {
          await broadcastAiConversationRenamed({ agentId, conversationId, title, triggeredBy });
        }
        if (hasIsShared && isShared) {
          await broadcastAiConversationAdded({
            agentId,
            conversation: { id: conversationId, title: persisted.title || 'New conversation', createdAt: new Date().toISOString() },
            triggeredBy,
          });
        } else if (hasIsShared && !isShared) {
          await broadcastAiConversationDeleted({ agentId, conversationId, triggeredBy });
        }
      } catch (broadcastError) {
        loggers.ai.error('Failed to broadcast conversation update', broadcastError as Error, {
          agentId: maskIdentifier(agentId),
          conversationId: maskIdentifier(conversationId),
        });
      }
    })();

    return NextResponse.json({
      success: true,
      conversationId: persisted.id,
      title: persisted.title,
    });

  } catch (error) {
    loggers.ai.error('Error updating conversation:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update conversation' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/ai/page-agents/[agentId]/conversations/[conversationId]
 *
 * Soft-deletes a conversation by marking all its messages as inactive.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ agentId: string; conversationId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent_conversation', resourceId: 'delete', details: { reason: 'auth_failed', method: 'DELETE', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }

    const { agentId, conversationId } = await context.params;

    // Verify agent exists and is AI_CHAT type
    const agent = await conversationRepository.getAiAgent(agentId);

    if (!agent) {
      return NextResponse.json(
        { error: 'AI agent not found' },
        { status: 404 }
      );
    }

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, agentId);
    if (scopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: conversationId, details: { reason: 'mcp_page_scope_denied', agentId, method: 'DELETE' }, riskScore: 0.5 });
      return scopeError;
    }

    // Verify conversation exists before attempting deletion
    const exists = await conversationRepository.conversationExists(agentId, conversationId);
    if (!exists) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Owners may always delete their own conversations; editors may delete any
    const [canEdit, conversationRow] = await Promise.all([
      canPrincipalEditPage(auth, agentId),
      conversationRepository.getConversation(conversationId),
    ]);
    const isOwner = conversationRow?.userId === auth.userId;
    if (!isOwner && !canEdit) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: conversationId, details: { reason: 'not_owner_or_editor', agentId, method: 'DELETE' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'Insufficient permissions to delete this conversation' },
        { status: 403 }
      );
    }

    // Get conversation metadata before deletion for audit log
    const metadata = await conversationRepository.getConversationMetadata(agentId, conversationId);

    // History-deleting a session-bound conversation now also deactivates its
    // CANONICAL row (`softDeleteConversation` below) — which, unlike the
    // console's own "Close" action, does not go through
    // `closeConversationInSessionWith`'s never-empty guard. Refusing here
    // when this is the session's LAST open listing keeps that same
    // invariant true regardless of which route emptied it: an active session
    // left with a live sandbox and zero reachable conversations is worse
    // than a plain 409 telling the user to close the pane (which offers to
    // end the session) or delete history from a different conversation
    // first.
    //
    // EVERY session-bound deletion takes the lock — not just open-listing
    // ones — and re-reads the row's live state once inside it, rather than
    // branching on `conversationRow`'s pre-lock snapshot. An already-CLOSED
    // conversation still needs the lock: without it, this delete could
    // interleave with a concurrent reopen's own lock-held critical section
    // arbitrarily (they'd never even contend for the same lock), so a delete
    // racing a reopen could commit `isActive: false` right as the reopen's
    // stale-free `isActive` read passed, letting the reopen's UPDATE clear
    // `closedInWorkspaceAt` on a row that never got a listing slot back —
    // "reopened successfully" but invisible to every session listing (review
    // finding — chatgpt-codex-connector on PR #2296, filed after the
    // previous round's open-only guard). Re-reading inside the lock also
    // means a stale pre-lock snapshot can never smuggle a since-reopened
    // conversation past the never-empty guard.
    if (conversationRow?.workspaceId) {
      const workspaceId = conversationRow.workspaceId;
      const outcome = await withSessionListingLock(workspaceId, async () => {
        const fresh = await conversationRepository.getConversation(conversationId);
        if (!fresh || !fresh.isActive) {
          // Already history-deleted by a concurrent request — nothing left
          // to guard or delete.
          return 'already_deleted' as const;
        }
        // A row whose session was cleared (`conversations.workspaceId` is
        // `ON DELETE SET NULL`) is still an active conversation that must
        // be deleted — it's merely detached from `workspaceId`'s cap, not
        // history-deleted. Only weigh the never-empty guard when the row is
        // STILL bound to the session this lock is keyed on (review finding
        // — coderabbitai on PR #2296: the prior version folded "detached"
        // into "already deleted" and silently skipped the soft-delete).
        if (fresh.workspaceId === workspaceId && fresh.closedInWorkspaceAt === null) {
          // Still open — occupies a listing slot, so the never-empty guard applies.
          const openCount = await countOpenConversationsForSession(workspaceId);
          if (openCount <= 1) return 'last_conversation' as const;
        }
        await conversationRepository.softDeleteConversation(agentId, conversationId);
        return 'deleted' as const;
      });

      if (outcome === 'last_conversation') {
        auditRequest(request, {
          eventType: 'security.rate.limited',
          userId: auth.userId,
          resourceType: 'page_agent_conversation',
          resourceId: conversationId,
          details: { reason: 'last_session_conversation', agentId, workspaceId, method: 'DELETE' },
          riskScore: 0,
        });
        return NextResponse.json(
          {
            error: 'This is the only open conversation in its session — close the pane (or end the session) instead of deleting it from History.',
            reason: 'last_conversation',
          },
          { status: 409 },
        );
      }
      // 'already_deleted' falls through to the success response below —
      // idempotent from the caller's point of view, since the end state
      // (isActive: false) is exactly what a DELETE asks for.
    } else {
      // Not session-bound at all — no listing to protect, no lock needed.
      await conversationRepository.softDeleteConversation(agentId, conversationId);
    }

    // Audit log the deletion for security and compliance
    await conversationRepository.logConversationDeletion({
      userId: auth.userId,
      conversationId,
      agentId,
      metadata,
    });

    loggers.ai.info('Conversation deleted', {
      conversationId,
      agentId,
      userId: auth.userId,
      messageCount: metadata?.messageCount || 0,
    });

    auditRequest(request, { eventType: 'data.delete', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: conversationId, details: {
      action: 'delete_conversation',
      agentId,
    } });

    void (async () => {
      try {
        const triggeredBy = await resolveTriggeredBy(auth.userId, request);
        await broadcastAiConversationDeleted({ agentId, conversationId, triggeredBy });
      } catch (broadcastError) {
        loggers.ai.error('Failed to broadcast chat conversation-deleted', broadcastError as Error, {
          agentId: maskIdentifier(agentId),
          conversationId: maskIdentifier(conversationId),
        });
      }
    })();

    return NextResponse.json({
      success: true,
      conversationId,
      message: 'Conversation deleted successfully',
    });

  } catch (error) {
    loggers.ai.error('Error deleting conversation:', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete conversation' },
      { status: 500 }
    );
  }
}
