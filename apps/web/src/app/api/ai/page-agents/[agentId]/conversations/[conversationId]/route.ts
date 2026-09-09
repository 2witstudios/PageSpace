import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalEditPage } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import {
  expelAfterDelete,
  expelConversationFromSession,
  findWorkspaceOfConversation,
} from '@/lib/agent-workspaces/agent-workspaces-runtime';
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
    const membership = await findWorkspaceOfConversation(conversationId);
    if (membership) {
      const workspaceId = membership;
      // EXPEL FIRST, THEN DELETE. The membership write takes the workspace's
      // own lock and removes the node inside it, which also closes the reopen
      // race by construction: a concurrent reopen is a write to this same tree
      // under this same lock, so the two serialize rather than interleaving
      // arbitrarily as two operations under two different locks could.
      //
      // **The `last_conversation` 409 is gone** with the never-empty invariant
      // it enforced — see the global route's twin for the full reasoning. In
      // one line: emptiness stopped meaning anything, so a guard against it only
      // ever refused legitimate deletions.
      const outcome = await expelConversationFromSession({
        conversationId,
        workspaceId,
        actingUserId: auth.userId,
      });

      if (outcome === 'refused') {
        return NextResponse.json({ error: 'Could not delete this conversation' }, { status: 500 });
      }
      // Ordered deliberately — see `expelConversationFromSession`'s doc for
      // why the survivable failure is the one that can happen here.
      await conversationRepository.softDeleteConversation(agentId, conversationId);
    } else {
      await conversationRepository.softDeleteConversation(agentId, conversationId);
    }

    // THE SWEEP — the twin of the global route's, and out here for the same
    // reason: the membership read above is true of the moment of the READ, and
    // "no listing to protect, no lock needed" was a false statement about the
    // WRITE. A thread with no workspace is exactly what
    // `claimConversationInSession` admits, so a conditional call could never
    // reach the branch that needed it most.
    await expelAfterDelete({ conversationId, actingUserId: auth.userId });

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
