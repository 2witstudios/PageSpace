import { handleChatTurn } from '@/lib/ai/chat-pipeline/handle-chat-turn';
import { getAiChatSettings, patchAiChatSettings } from './chat-settings-handlers';

// Allow streaming responses up to 5 minutes for complex AI agent interactions
export const maxDuration = 300;

/**
 * POST — one chat turn.
 *
 * This URL is the SINGLE INTERNAL ENTRY for the chat pipeline (epic
 * "Agent-Session Single Source of Truth", Phase 5): `handleChatTurn` decides
 * from the CONVERSATION, not the URL, whether the turn is a page-agent turn or
 * a global-assistant one. `POST /api/ai/global/[id]/messages` calls the same
 * entry, so both public URLs keep their exact wire contract — what collapsed is
 * the implementation behind them, and the `agentPageId === null` URL branch
 * that server-side dispatch used to carry.
 */
export async function POST(request: Request) {
  return handleChatTurn(request, { surface: 'page-chat' });
}

/**
 * GET/PATCH — AI PROVIDER SETTINGS, which have nothing to do with a chat turn.
 *
 * Re-exported rather than moved to their own URL: the wire contract is frozen
 * and the churn would buy nothing. What this does buy is that the file named
 * after the chat route is about the chat route again — the settings CRUD that
 * made up 250 of its 306 lines now lives beside it, under its own name.
 */
export { getAiChatSettings as GET, patchAiChatSettings as PATCH };
