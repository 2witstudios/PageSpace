import type { LocationContext } from './chat-types';
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
 * `contextRef` is the synchronous replacement for `locationContext`: callers
 * build it from the current pathname (`buildContextRef`, no fetch, no await)
 * and the server resolves + permission-checks it at request time.
 * `locationContext` stays accepted for at least one release so an old client
 * bundle that never sends a contextRef still gets its trusted client-computed
 * context honored; new callers should pass contextRef and leave
 * locationContext unset.
 */
export interface GlobalChatRequestBodyParams {
  conversationId: string | null;
  isReadOnly: boolean;
  webSearchEnabled: boolean;
  imageGenEnabled: boolean;
  showPageTree: boolean;
  locationContext?: LocationContext | null;
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
  locationContext: LocationContext | undefined;
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
    locationContext: params.locationContext || undefined,
    contextRef: params.contextRef,
    selectedProvider: params.selectedProvider,
    selectedModel: params.selectedModel,
    mcpTools: params.mcpTools && params.mcpTools.length > 0 ? params.mcpTools : undefined,
  };
}
