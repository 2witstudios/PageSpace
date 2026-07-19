import type { UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';

export interface AgentConversationSummary {
  id: string;
  title?: string | null;
  lastMessageAt?: string;
  createdAt?: string;
}

interface AgentConversationsResponse {
  conversations?: AgentConversationSummary[];
}

export interface PaginationInfo {
  hasMore: boolean;
  nextCursor: string | null;
  prevCursor: string | null;
  limit: number;
  direction: string;
}

interface AgentMessagesResponse {
  messages?: UIMessage[];
  pagination?: PaginationInfo;
}

interface AgentConversationCreateResponse {
  conversationId?: string;
  id?: string;
}

export interface FetchAgentMessagesOptions {
  limit?: number;
  cursor?: string;
  direction?: 'before' | 'after';
  /**
   * Include the in-flight streaming placeholder row (the route excludes it by
   * default). Cache loads pass this so a history rejoin can see a conversation
   * that is still generating — `selectRenderedMessages` renders the live
   * pending-stream entry in place of the placeholder row (E2 D task
   * co2as25wcpme4m4gxqu4zgcj: the badge lit but agent click-through showed a
   * stale placeholder because these loads never asked for it).
   */
  includeStreaming?: boolean;
}

export interface FetchAgentMessagesResult {
  messages: UIMessage[];
  pagination: PaginationInfo | null;
}

/**
 * Fetch agent conversation messages with optional pagination.
 * Default behavior (no options): fetches the most recent 50 messages.
 */
export async function fetchAgentConversationMessages(
  agentId: string,
  conversationId: string,
  options?: FetchAgentMessagesOptions
): Promise<FetchAgentMessagesResult> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.direction) params.set('direction', options.direction);
  if (options?.includeStreaming) params.set('includeStreaming', '1');

  const queryString = params.toString();
  const url = `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages${queryString ? `?${queryString}` : ''}`;

  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to load messages for agent ${agentId}, conversation ${conversationId}`);
  }
  const data = (await response.json()) as AgentMessagesResponse | UIMessage[];

  // Handle legacy response format (array of messages)
  if (Array.isArray(data)) {
    return {
      messages: data,
      pagination: null
    };
  }

  return {
    messages: data.messages || [],
    pagination: data.pagination || null
  };
}

export async function fetchMostRecentAgentConversation(
  agentId: string
): Promise<AgentConversationSummary | null> {
  const response = await fetchWithAuth(
    `/api/ai/page-agents/${agentId}/conversations?limit=1`
  );
  if (!response.ok) {
    throw new Error(`Failed to load conversations for agent ${agentId}`);
  }
  const data = (await response.json()) as AgentConversationsResponse;
  return data.conversations?.[0] ?? null;
}

/**
 * Persist a new agent conversation. Pass `conversationId` (client-generated
 * cuid2) so the caller's identity is known synchronously — this call becomes
 * a fire-and-forget, idempotent persist rather than the source of the id.
 */
export async function createAgentConversation(
  agentId: string,
  conversationId?: string
): Promise<string> {
  const response = await fetchWithAuth(`/api/ai/page-agents/${agentId}/conversations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Browser-Session-Id': getBrowserSessionId(),
    },
    body: JSON.stringify(conversationId ? { conversationId } : {}),
  });
  if (!response.ok) {
    throw new Error(`Failed to create conversation for agent ${agentId}`);
  }
  // Caller already knows the id it asked the server to persist — no need to
  // parse the body to learn it.
  if (conversationId) return conversationId;

  const data = (await response.json()) as AgentConversationCreateResponse;
  const resolvedId = data.conversationId || data.id;
  if (!resolvedId) {
    throw new Error('Conversation id missing in response');
  }
  return resolvedId;
}
