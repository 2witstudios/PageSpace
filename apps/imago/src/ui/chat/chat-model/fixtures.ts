// Route answers for the chat tests, shaped like apps/web's handlers.

import type {
  AgentConversation,
  AgentConversationsResponse,
  BuiltinAgentKey,
  BuiltinAgentPointer,
  BuiltinAgentsResponse,
  ChatMessage,
  ConversationMessagesResponse,
} from './chat';

const PROVISIONED: readonly BuiltinAgentPointer[] = [{ key: 'imago', pageId: 'p-imago', title: 'Imago' }];

/** GET /api/user/builtin-agents for a viewer with Imago provisioned, unless `pageIds` says otherwise. */
export const pointers = (pageIds: Partial<Record<BuiltinAgentKey, string | null>> = {}): BuiltinAgentsResponse => ({
  agents: PROVISIONED.map((agent) => (agent.key in pageIds ? { ...agent, pageId: pageIds[agent.key] ?? null } : agent)),
});

export const agentConversation = (id: string, overrides: Partial<AgentConversation> = {}): AgentConversation => ({
  id,
  title: `Chat ${id}`,
  preview: `Chat ${id}`,
  createdAt: '2026-10-05T09:00:00.000Z',
  updatedAt: '2026-10-05T10:00:00.000Z',
  messageCount: 2,
  isShared: false,
  isOwner: true,
  sessionId: null,
  lastMessage: { role: 'assistant', timestamp: '2026-10-05T10:00:00.000Z' },
  ...overrides,
});

export const conversationsPage = (
  conversations: AgentConversation[],
  { page = 0, pageSize = 50, totalCount = conversations.length }: { page?: number; pageSize?: number; totalCount?: number } = {},
): AgentConversationsResponse => ({
  conversations,
  pagination: {
    page,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
    hasMore: (page + 1) * pageSize < totalCount,
  },
});

/** A user message with one text part, as the route returns it. */
export const userMessage = (id: string, text: string): ChatMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
  createdAt: '2026-10-05T10:00:00.000Z',
  editedAt: null,
  messageType: 'standard',
  status: 'complete',
  userName: 'Ada',
  source: null,
});

/** An assistant turn that called a tool, with its text, step and tool parts in order. */
export const assistantWithTool = (id: string): ChatMessage => ({
  id,
  role: 'assistant',
  parts: [
    { type: 'step-start' },
    {
      type: 'tool-read_page',
      toolCallId: 'call-1',
      state: 'output-available',
      input: { pageId: 'p1' },
      output: { title: 'Roadmap' },
    },
    { type: 'text', text: 'The roadmap says ship in October.' },
  ],
  createdAt: '2026-10-05T10:00:01.000Z',
  editedAt: null,
  messageType: 'standard',
  status: 'complete',
  userName: null,
  source: null,
});

export const messagesPage = (
  messages: ChatMessage[],
  {
    conversationId = 'c1',
    nextCursor = null,
    rev = 7,
  }: { conversationId?: string; nextCursor?: string | null; rev?: number | null } = {},
): ConversationMessagesResponse => ({
  messages,
  conversationId,
  messageCount: messages.length,
  pagination: {
    hasMore: nextCursor !== null,
    nextCursor,
    prevCursor: messages.at(-1)?.id ?? null,
    limit: 50,
    direction: 'before',
  },
  rev,
});

/** GET /api/drives/[driveId]/agents: the drive's agents the viewer can view, in the route's full shape. */
export const driveAgentsBody = (
  agents: readonly { readonly id?: string; readonly title: string | null }[],
  { driveId = 'd1', driveName = 'Alpha' }: { driveId?: string; driveName?: string } = {},
) => ({
  success: true,
  driveId,
  driveName,
  driveSlug: driveName.toLowerCase(),
  agents: agents.map((agent, position) => ({
    ...agent,
    parentId: 'root',
    position,
    aiProvider: 'default',
    aiModel: 'default',
    hasWelcomeMessage: false,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    hasSystemPrompt: false,
  })),
  count: agents.length,
});
