// The agent chat routes apps/web already has, read through imago's API client
// (the session cookie on every request, apps/web's errors as ApiError).
//
// Imago reads chat through the page-agent routes only, the Imago agents being
// ordinary AI_CHAT pages in the viewer's Home drive; it never calls
// /api/ai/global/* (DEC-3). Access is decided there: these lists are whatever
// the server answers. Messages pass through untouched so their `parts` reach
// the renderer as the server built them.

import type { ApiClient } from '@/api/client';
import { ApiError, INVALID_RESPONSE } from '@/api/errors';
import type {
  AgentConversationsResponse,
  BuiltinAgentPointer,
  BuiltinAgentsResponse,
  ConversationMessagesResponse,
  ConversationsPage,
  MessagesPage,
} from '../chat-model/chat';

const segment = encodeURIComponent;

/** Conversations per page (the route's default; it allows up to 200). */
export const CONVERSATIONS_PAGE_SIZE = 50;

/** Messages per page (the route's default; it allows up to 200). */
export const MESSAGES_PAGE_SIZE = 50;

const agentConversations = (agentId: string) => `/api/ai/page-agents/${segment(agentId)}/conversations`;

export const chatPaths = {
  /** The viewer's built-in Imago agents, in registry order. */
  builtinAgents: '/api/user/builtin-agents',
  /** One page of the viewer's conversations with an agent page, most recent first. */
  conversations: (agentId: string, page: number) =>
    `${agentConversations(agentId)}?page=${page}&pageSize=${CONVERSATIONS_PAGE_SIZE}`,
  /** A conversation's newest messages, or those before `cursor` (a message id). */
  messages: (agentId: string, conversationId: string, cursor?: string) =>
    `${agentConversations(agentId)}/${segment(conversationId)}/messages?limit=${MESSAGES_PAGE_SIZE}` +
    (cursor === undefined ? '' : `&direction=before&cursor=${segment(cursor)}`),
  /** One agent turn, streamed back as the AI SDK UI message stream (the page-agent pipeline). */
  turn: '/api/ai/chat',
  /** Stops a turn server-side: streams are server-owned and outlive the reader. */
  abort: '/api/ai/abort',
};

const invalid = (message: string) => new ApiError({ status: 200, code: INVALID_RESPONSE, message });

const hasArray = (body: unknown, field: string): boolean =>
  typeof body === 'object' && body !== null && Array.isArray((body as Record<string, unknown>)[field]);

/** The viewer's Imago agent pointers from GET /api/user/builtin-agents. */
export const fetchBuiltinAgents = async (client: ApiClient): Promise<readonly BuiltinAgentPointer[]> => {
  const body = await client.apiFetch<BuiltinAgentsResponse>(chatPaths.builtinAgents);
  if (!hasArray(body, 'agents')) throw invalid('Built-in agents response carried no agents');
  return body.agents;
};

/** One page (from 0) of the viewer's conversations with an agent page. */
export const fetchConversationsPage = async (
  client: ApiClient,
  agentId: string,
  page: number,
): Promise<ConversationsPage> => {
  const body = await client.apiFetch<AgentConversationsResponse>(chatPaths.conversations(agentId, page));
  if (!hasArray(body, 'conversations')) throw invalid('Conversations response carried no conversations');
  return { conversations: body.conversations, hasMore: body.pagination?.hasMore === true };
};

/** A conversation's newest page of messages, or the page before `cursor`. */
export const fetchConversationMessages = async (
  client: ApiClient,
  agentId: string,
  conversationId: string,
  cursor?: string,
): Promise<MessagesPage> => {
  const body = await client.apiFetch<ConversationMessagesResponse>(
    chatPaths.messages(agentId, conversationId, cursor),
  );
  if (!hasArray(body, 'messages')) throw invalid('Messages response carried no messages');
  const { hasMore, nextCursor } = body.pagination ?? { hasMore: false, nextCursor: null };
  return {
    messages: body.messages,
    olderCursor: hasMore ? nextCursor : null,
    rev: typeof body.rev === 'number' ? body.rev : null,
  };
};
