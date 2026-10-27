/**
 * The chat POST body for an agent session — the one place it is shaped.
 *
 * Pure successor to the machine pane's `buildPaneChatRequestBody` (agent-mode
 * branch): a session chat surface always has a fixed agent (no dual-mode
 * selector), so there is only ever one shape to build. `chatId` is the
 * agent's page id — the server derives everything else (permissions, tool
 * set) from it — and `conversationId` names the thread; the server resolves
 * the thread's SESSION (and therefore its sandbox) from the row's own
 * binding, so no session field ever rides the request.
 */
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';

export interface BuildSessionChatRequestBodyParams {
  agentId: string;
  conversationId: string;
  isReadOnly: boolean;
  webSearchEnabled: boolean;
  imageGenEnabled: boolean;
  /** The agent's own configuration — omitted (not written as null) when absent. */
  provider?: string;
  model?: string;
  systemPrompt?: string;
  enabledTools?: string[];
  contextRef: ContextRef;
}

export function buildSessionChatRequestBody(
  params: BuildSessionChatRequestBodyParams,
): Record<string, unknown> {
  return {
    chatId: params.agentId,
    conversationId: params.conversationId,
    isReadOnly: params.isReadOnly,
    webSearchEnabled: params.webSearchEnabled,
    imageGenEnabled: params.imageGenEnabled,
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.enabledTools !== undefined ? { enabledTools: params.enabledTools } : {}),
    contextRef: params.contextRef,
  };
}
