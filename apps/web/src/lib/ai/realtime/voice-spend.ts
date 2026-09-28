/**
 * Where a realtime voice call spends, decided before the call connects (SPEND-1).
 *
 * A voice call is a second transport onto a conversation, so it spends where a typed turn
 * on that conversation spends: a page conversation in its page's drive (the page chat turn
 * spends in `page.driveId`), a Global Assistant conversation on the caller's own credits
 * (SPEND-8). The drive always comes from the server: the conversation row the caller may
 * read, or — for a fresh page-agent thread whose row does not exist until its first message
 * lands — the agent page the client names, and only after the caller's own view check on it.
 *
 * It never falls back to the caller's own credits inside a drive (SPEND-4). When the call
 * belongs to a drive that cannot be resolved — a page that cannot be read, a named page the
 * caller cannot view — it is refused with a named reason, before any call is made.
 */

import type { SeedConversation } from './binding-loader';

export type VoiceSpend =
  | { kind: 'personal' }
  | { kind: 'drive'; driveId: string }
  | { kind: 'refused'; reason: 'voice_spend_unresolved' | 'voice_conversation_forbidden' };

export type VoiceSpendDeps = {
  readonly loadConversation: (conversationId: string) => Promise<SeedConversation | undefined>;
  readonly canAccess: (userId: string, conversation: SeedConversation) => Promise<boolean>;
  readonly loadPage: (pageId: string) => Promise<{ id: string; type: string; driveId: string } | undefined>;
  /** The caller's own view check on a page, through the centralized permission layer. */
  readonly canViewPage: (pageId: string) => Promise<boolean>;
};

export type VoiceSpendRequest = {
  readonly userId: string;
  readonly conversationId?: string;
  /** The page agent the client says a FRESH thread belongs to. Ignored once the thread has a row. */
  readonly agentPageId?: string;
};

const PERSONAL: VoiceSpend = { kind: 'personal' };
const UNRESOLVED: VoiceSpend = { kind: 'refused', reason: 'voice_spend_unresolved' };

/** The drive of a page, or undefined when it cannot be read. */
const pageDrive = async (deps: VoiceSpendDeps, pageId: string): Promise<{ type: string; driveId: string } | undefined> => {
  try {
    return await deps.loadPage(pageId);
  } catch {
    return undefined;
  }
};

/** A fresh page-agent thread: the named agent page's drive, if the caller can view it. */
const fromAgentPage = async (deps: VoiceSpendDeps, agentPageId: string): Promise<VoiceSpend> => {
  if (!(await deps.canViewPage(agentPageId).catch(() => false))) return UNRESOLVED;
  const page = await pageDrive(deps, agentPageId);
  return page?.type === 'AI_CHAT' ? { kind: 'drive', driveId: page.driveId } : UNRESOLVED;
};

export async function resolveVoiceSpend(deps: VoiceSpendDeps, request: VoiceSpendRequest): Promise<VoiceSpend> {
  // An unbound call answers no conversation and no drive.
  if (!request.conversationId) return PERSONAL;

  let conversation: SeedConversation | undefined;
  try {
    conversation = await deps.loadConversation(request.conversationId);
  } catch {
    // Whether this thread belongs to a drive is unknowable: resolve from the named agent
    // page, or refuse rather than guess the caller's own credits.
    return request.agentPageId ? fromAgentPage(deps, request.agentPageId) : UNRESOLVED;
  }

  if (!conversation) {
    // A fresh thread: its row lands with the first message. A page agent's names its page;
    // a Global Assistant's names none and spends personal credits, as its typed turn does.
    return request.agentPageId ? fromAgentPage(deps, request.agentPageId) : PERSONAL;
  }

  if (!(await deps.canAccess(request.userId, conversation))) {
    return { kind: 'refused', reason: 'voice_conversation_forbidden' };
  }

  if (conversation.type === 'global') return PERSONAL;
  if (!conversation.contextId) return UNRESOLVED;
  if (conversation.type === 'drive') return { kind: 'drive', driveId: conversation.contextId };

  const page = await pageDrive(deps, conversation.contextId);
  return page ? { kind: 'drive', driveId: page.driveId } : UNRESOLVED;
}
