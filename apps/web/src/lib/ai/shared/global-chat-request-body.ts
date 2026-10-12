import type { ContextRef } from './buildContextRef';

/**
 * Pure builder for the Global Assistant (non-agent) chat request body.
 *
 * useChat's Chat instance is kept alive across conversation switches (a
 * stable id, per chat-config.ts, to avoid clobbering messages) — its
 * transport is captured once at construction and never updated. The URL
 * baked into that transport at construction time can go stale the moment the
 * user switches conversations. `conversationId` in this body is what the
 * server actually trusts (see apps/web/src/app/api/ai/global/[id]/messages/
 * route.ts), so it must reflect the CURRENT conversation on every call, not
 * just whatever the transport's URL still points at.
 *
 * `contextRef` is where the person is: callers build it from the current
 * pathname (`buildContextRef`, no fetch, no await) and the server resolves +
 * permission-checks it at request time. It is the only way a turn is inside a
 * drive; the server refuses the old client-computed `locationContext` field.
 */
export interface GlobalChatRequestBodyParams {
  conversationId: string | null;
  isReadOnly: boolean;
  webSearchEnabled: boolean;
  imageGenEnabled: boolean;
  showPageTree: boolean;
  contextRef?: ContextRef;
  selectedProvider: string | null;
  selectedModel: string | null;
  mcpTools?: unknown[];
}

export interface GlobalChatRequestBody {
  // Index signature so this satisfies sendMessage's Record<string, unknown>
  // body option — plain named interfaces aren't structurally assignable to
  // index-signature types without one, even with fully compatible fields.
  [key: string]: unknown;
  conversationId: string | null;
  isReadOnly: boolean;
  webSearchEnabled: boolean;
  imageGenEnabled: boolean;
  showPageTree: boolean;
  contextRef: ContextRef | undefined;
  selectedProvider: string | null;
  selectedModel: string | null;
  mcpTools: unknown[] | undefined;
}

export function buildGlobalChatRequestBody(
  params: GlobalChatRequestBodyParams
): GlobalChatRequestBody {
  return {
    conversationId: params.conversationId,
    isReadOnly: params.isReadOnly,
    webSearchEnabled: params.webSearchEnabled,
    imageGenEnabled: params.imageGenEnabled,
    showPageTree: params.showPageTree,
    contextRef: params.contextRef,
    selectedProvider: params.selectedProvider,
    selectedModel: params.selectedModel,
    mcpTools: params.mcpTools && params.mcpTools.length > 0 ? params.mcpTools : undefined,
  };
}
