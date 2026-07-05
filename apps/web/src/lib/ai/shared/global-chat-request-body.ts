import type { LocationContext } from './chat-types';

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
 */
export interface GlobalChatRequestBodyParams {
  conversationId: string | null;
  isReadOnly: boolean;
  webSearchEnabled: boolean;
  showPageTree: boolean;
  locationContext?: LocationContext | null;
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
  showPageTree: boolean;
  locationContext: LocationContext | undefined;
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
    showPageTree: params.showPageTree,
    locationContext: params.locationContext || undefined,
    selectedProvider: params.selectedProvider,
    selectedModel: params.selectedModel,
    mcpTools: params.mcpTools && params.mcpTools.length > 0 ? params.mcpTools : undefined,
  };
}
