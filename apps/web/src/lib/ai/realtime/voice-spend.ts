/**
 * Where a voice call — a realtime call or a TTS synthesis — spends, decided before it runs
 * (SPEND-1).
 *
 * Voice is a second transport onto a conversation, so it spends where a typed turn on that
 * conversation spends: a page conversation in its page's drive (the page chat turn spends in
 * `page.driveId`), a drive conversation in its drive, and a Global Assistant conversation in
 * the drive the person is standing in — the server-resolved `contextDriveId`, exactly the
 * drive the global turn spends in — or on their own credits with no drive at all (SPEND-8).
 * The drive always comes from the server: the conversation row the caller may read, the
 * caller's context resolved behind its own permission check, or — for a fresh page-agent
 * thread whose row does not exist until its first message lands — the agent page the client
 * names, and only after the caller's own view check on it.
 *
 * It never falls back to the caller's own credits inside a drive (SPEND-4). When the call
 * belongs to a drive that cannot be resolved — a page that cannot be read, a named page the
 * caller cannot view — it is refused with a named reason, before any call is made.
 */

import type { SeedConversation } from './binding-loader';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import type { VoiceLocationContext } from '@pagespace/lib/realtime/voice-bridge-contract';

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
  /**
   * The drive the caller stands in, SERVER-resolved from their context (resolveRequestContext:
   * a page or drive they can view), never a drive id the client claimed. It places only a call
   * with no drive of its own — a Global Assistant conversation, a fresh Global Assistant thread,
   * an unbound call — as the global turn does; a page or drive conversation keeps its own drive.
   */
  readonly contextDriveId?: string;
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

/** A call with no drive of its own: the drive the caller stands in, else personal credits (SPEND-8). */
const placed = (request: VoiceSpendRequest): VoiceSpend =>
  request.contextDriveId ? { kind: 'drive', driveId: request.contextDriveId } : PERSONAL;

export async function resolveVoiceSpend(deps: VoiceSpendDeps, request: VoiceSpendRequest): Promise<VoiceSpend> {
  // An unbound call answers no conversation: it spends where the caller stands.
  if (!request.conversationId) return placed(request);

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
    // a Global Assistant's names none and spends where the caller stands, as its typed turn does.
    return request.agentPageId ? fromAgentPage(deps, request.agentPageId) : placed(request);
  }

  if (!(await deps.canAccess(request.userId, conversation))) {
    return { kind: 'refused', reason: 'voice_conversation_forbidden' };
  }

  if (conversation.type === 'global') return placed(request);
  if (!conversation.contextId) return UNRESOLVED;
  if (conversation.type === 'drive') return { kind: 'drive', driveId: conversation.contextId };

  const page = await pageDrive(deps, conversation.contextId);
  return page ? { kind: 'drive', driveId: page.driveId } : UNRESOLVED;
}

/**
 * The reference a voice call's context is resolved from (resolveRequestContext): the page the
 * caller stands on, else their drive. The location is the client's CLAIM, so this is only ever
 * a reference the server permission-checks — the drive a call spends in is what that check
 * returns, never an id read off the body.
 */
export function voiceContextRef(location: VoiceLocationContext | undefined): ContextRef | undefined {
  if (location?.currentPage) return { routeType: 'page', pageId: location.currentPage.id };
  if (location?.currentDrive) return { routeType: 'drive', driveId: location.currentDrive.id };
  return undefined;
}
