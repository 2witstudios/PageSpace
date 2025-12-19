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

interface AgentMessagesResponse {
  messages?: UIMessage[];
}

interface AgentConversationCreateResponse {
  conversationId?: string;
  id?: string;
}

export async function fetchAgentConversationMessages(
  agentId: string,
  conversationId: string
): Promise<UIMessage[]> {
  const response = await fetchWithAuth(
    `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages`
  );
  if (!response.ok) {
    throw new Error('Failed to load conversation messages');
  }
  const data = (await response.json()) as AgentMessagesResponse | UIMessage[];
  if (Array.isArray(data)) {
    return data;
  }
  return data.messages || [];
}

export async function fetchMostRecentAgentConversation(
  agentId: string
): Promise<AgentConversationSummary | null> {
  const response = await fetchWithAuth(
    `/api/ai/page-agents/${agentId}/conversations?limit=1`
  );
  if (!response.ok) {
    throw new Error('Failed to load conversations');
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
    throw new Error('Failed to create conversation');
  }
  const data = (await response.json()) as AgentConversationCreateResponse;
  const conversationId = data.conversationId || data.id;
  if (!conversationId) {
    throw new Error('Conversation id missing in response');
  }
  return conversationId;
}
