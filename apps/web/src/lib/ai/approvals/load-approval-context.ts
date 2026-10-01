/**
 * The per-turn reads behind the approval policy — the user's mode and their
 * standing grants — with ONE failure direction.
 *
 * A gate that turns itself off when its own lookup fails is not a gate. So a
 * read error here never becomes `auto` or a phantom grant: the turn proceeds in
 * `ask` mode with no grants (the user is asked once more than they would have
 * been), and the failure is logged where someone will see it. The turn itself
 * is not failed — approvals are a safety layer over the conversation, not a
 * dependency the conversation cannot run without.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { getConfig as getGlobalAssistantConfig } from '@pagespace/lib/integrations/repositories/config-repository';
import { toolApprovalRepository } from '@/lib/repositories/tool-approval-repository';
import {
  DEFAULT_TOOL_APPROVAL_MODE,
  isToolApprovalMode,
  type ApprovalPolicyContext,
  type ToolApprovalGrant,
  type ToolApprovalMode,
} from './approval-policy';

interface WarnLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

/** The global assistant's per-user mode; `ask` when unset or unreadable. */
export async function loadGlobalToolApprovalMode(userId: string, logger: WarnLogger): Promise<ToolApprovalMode> {
  try {
    const config = await getGlobalAssistantConfig(db, userId);
    return isToolApprovalMode(config?.toolApprovalMode) ? config.toolApprovalMode : DEFAULT_TOOL_APPROVAL_MODE;
  } catch (error) {
    logger.warn('tool approvals: could not read the global assistant mode; proceeding in ask mode', {
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_TOOL_APPROVAL_MODE;
  }
}

/** The grants that apply to this turn; none when unreadable. */
export async function loadToolApprovalGrants(
  userId: string,
  conversationId: string | null,
  logger: WarnLogger,
): Promise<ToolApprovalGrant[]> {
  try {
    const rows = await toolApprovalRepository.listGrants(userId, conversationId);
    // Only the two fields the policy reads, and only well-formed rows: a
    // malformed row must not become a grant for `undefined`.
    return rows
      .filter((row) => typeof row.toolName === 'string' && row.toolName.length > 0)
      .map((row) => ({ toolName: row.toolName, conversationId: row.conversationId ?? null }));
  } catch (error) {
    logger.warn('tool approvals: could not read grants; proceeding with none', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** A page agent's mode (`pages.toolApprovalMode`); `ask` when missing or unreadable. */
export async function loadPageToolApprovalMode(pageId: string, logger: WarnLogger): Promise<ToolApprovalMode> {
  try {
    const [row] = await db
      .select({ toolApprovalMode: pages.toolApprovalMode })
      .from(pages)
      .where(eq(pages.id, pageId));
    return isToolApprovalMode(row?.toolApprovalMode) ? row.toolApprovalMode : DEFAULT_TOOL_APPROVAL_MODE;
  } catch (error) {
    logger.warn('tool approvals: could not read the page agent mode; proceeding in ask mode', {
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_TOOL_APPROVAL_MODE;
  }
}

/**
 * The approval context for a VOICE call — the mode and grants the text turn on
 * the same binding would read: the bound page agent's mode, else the Global
 * Assistant's; this user's standing grants, plus the conversation's own when
 * the call is bound to one. Grants are read only in `ask` mode, the only mode
 * where they matter. Never throws: every read fails safe (`ask`, no grants).
 *
 * `interactive: true` — a person is on the call. Voice has no approval card,
 * so the caller STRIPS what would ask (`withoutApprovalGatedTools`) instead of
 * wrapping it with `needsApproval`.
 */
export async function loadVoiceApprovalPolicy(
  scope: { userId: string; agentPageId?: string; conversationId?: string },
  logger: WarnLogger,
): Promise<ApprovalPolicyContext> {
  const conversationId = scope.conversationId ?? null;
  const mode = scope.agentPageId
    ? await loadPageToolApprovalMode(scope.agentPageId, logger)
    : await loadGlobalToolApprovalMode(scope.userId, logger);
  const grants = mode === 'ask' ? await loadToolApprovalGrants(scope.userId, conversationId, logger) : [];
  return { mode, interactive: true, conversationId, grants };
}
