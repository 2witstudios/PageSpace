// Imago's chat model: the shapes apps/web's agent routes answer with.
//
// Read from the handlers, not invented: GET /api/user/builtin-agents
// (apps/web/src/app/api/user/builtin-agents/route.ts) and GET
// /api/ai/page-agents/[agentId]/conversations[/[conversationId]/messages]
// (apps/web/src/app/api/ai/page-agents/[agentId]/conversations/**). Dates
// arrive as JSON strings. Messages keep the AI SDK's `parts` exactly as the
// server built them (convertDbMessageToUIMessage), for the renderer.

import type { UIMessage } from 'ai';
import type { BuiltinAgentKey } from '@pagespace/lib/agents/builtin-agents';

export type { BuiltinAgentKey };

/** One of the viewer's Imago agents; `pageId` is null until it is provisioned. */
export type BuiltinAgentPointer = {
  readonly key: BuiltinAgentKey;
  readonly pageId: string | null;
  readonly title: string;
};

export type BuiltinAgentsResponse = {
  readonly agents: readonly BuiltinAgentPointer[];
};

/**
 * An agent page in a drive, as GET /api/drives/[driveId]/agents lists it
 * (apps/web/src/app/api/drives/[driveId]/agents/route.ts): only the agents
 * the server says the viewer can view. Only what the picker needs is kept.
 */
export type DriveAgent = {
  readonly id: string;
  readonly title: string;
};

/** The agent the chat talks to when it is not Imago itself. */
export type ChatAgent = {
  readonly id: string;
  readonly title: string;
};

/** One conversation with an agent page, as GET .../conversations lists it. */
export type AgentConversation = {
  readonly id: string;
  /** Generated from the first user message's preview. */
  readonly title: string;
  readonly preview: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly isShared: boolean;
  readonly isOwner: boolean;
  /** The agent workspace the thread was born into; null for a plain page chat. */
  readonly sessionId: string | null;
  readonly lastMessage: {
    readonly role: string | null;
    readonly timestamp: string;
  };
};

export type AgentConversationsResponse = {
  readonly conversations: readonly AgentConversation[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalCount: number;
    readonly totalPages: number;
    readonly hasMore: boolean;
  };
};

/** A persisted message's lifecycle (message-utils.ts MessageStatus). */
export type ChatMessageStatus = 'streaming' | 'complete' | 'interrupted';

/**
 * A stored message as the messages route returns it: an AI SDK UIMessage
 * (`parts` untouched) plus the fields convertDbMessageToUIMessage adds.
 */
export type ChatMessage = UIMessage & {
  readonly createdAt?: string;
  readonly editedAt?: string | null;
  readonly messageType?: string;
  readonly status?: ChatMessageStatus;
  readonly userName?: string | null;
  readonly source?: string | null;
};

export type ConversationMessagesResponse = {
  /** Oldest first within the page. */
  readonly messages: readonly ChatMessage[];
  readonly conversationId: string;
  readonly messageCount: number;
  readonly pagination: {
    readonly hasMore: boolean;
    /** The oldest message's id, to load older messages; null when there are none. */
    readonly nextCursor: string | null;
    readonly prevCursor: string | null;
    readonly limit: number;
    readonly direction: 'before' | 'after';
  };
  /** The conversation's rev watermark at read time; null for a legacy thread. */
  readonly rev: number | null;
};

/** One page of an agent's conversations. */
export type ConversationsPage = {
  readonly conversations: readonly AgentConversation[];
  readonly hasMore: boolean;
};

/** One page of a conversation's messages, newest page first. */
export type MessagesPage = {
  readonly messages: readonly ChatMessage[];
  /** Where older messages start; null when this page reaches the beginning. */
  readonly olderCursor: string | null;
  readonly rev: number | null;
};
