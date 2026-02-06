import type { UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

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

export async function createAgentConversation(agentId: string): Promise<string> {
  const response = await fetchWithAuth(`/api/ai/page-agents/${agentId}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(`Failed to create conversation for agent ${agentId}`);
  }
  const data = (await response.json()) as AgentConversationCreateResponse;
  const conversationId = data.conversationId || data.id;
  if (!conversationId) {
    throw new Error('Conversation id missing in response');
  }
  return conversationId;
}
