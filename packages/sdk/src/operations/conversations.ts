/**
 * Conversation operations (Phase 3 task 5, part 2/2 — old handler
 * `conversation.js`): `conversations.list`, `conversations.read`. Old MCP
 * tools: `list_conversations`, `read_conversation`. Channel-messaging and
 * activity-feed operations from the same old handler file belong to Phase 3
 * task 9 (channels & activity), not here.
 *
 * Route-verified against
 * `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/route.ts` GET
 * and `.../conversations/[conversationId]/messages/route.ts` GET
 * (docs/sdk/operations-inventory.md rows for `list_conversations`,
 * `read_conversation`).
 *
 * Message `parts` fidelity: the messages route returns
 * `convertDbMessageToUIMessage` output (`apps/web/src/lib/ai/core/message-utils.ts`)
 * — a Vercel AI SDK `UIMessage` per project law (canonical `parts` array;
 * `packages/lib/src/types.ts`'s `ChatMessageSummary` is a flat-`content`
 * *storage* projection used elsewhere and is deliberately NOT reused here,
 * since it has no `parts` field and would not be faithful to this route's
 * actual response). `messagePartSchema` below is the wire-format mirror of
 * that route's real part shapes (text, file, `tool-*`, `data-*`) — never a
 * locally-invented message shape.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

// ---------------------------------------------------------------------------
// Shared: message `parts` array fidelity
// ---------------------------------------------------------------------------

/**
 * One UIMessage part. `type` is `'text' | 'file' | 'step-start' | 'tool-{name}' | 'data-{kind}'`
 * (dynamic suffixes, hence `z.string()` rather than a literal enum) with the
 * fields each variant actually carries (message-utils.ts `reconstructFromStructuredContent`
 * and the plain-text fallback) all declared — no `z.any()` anywhere in this
 * trust boundary; `input`/`output`/`data` are `z.unknown()` because their
 * shape is genuinely tool/part-specific, same idiom as `tasks.ts`'s
 * `metadata: z.record(z.string(), z.unknown())`.
 */
const messagePartSchema = z.object({
  type: z.string().min(1),
  text: z.string().optional(),
  url: z.string().optional(),
  mediaType: z.string().optional(),
  filename: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  state: z.enum(['input-streaming', 'input-available', 'output-available', 'output-error']).optional(),
  errorText: z.string().optional(),
  id: z.string().optional(),
  data: z.unknown().optional(),
});

const conversationMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(messagePartSchema),
  createdAt: z.string(),
  editedAt: z.string().nullable().optional(),
  messageType: z.string().optional(),
  userName: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// conversations.list — GET /api/ai/page-agents/:agentId/conversations
// ---------------------------------------------------------------------------

const conversationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  preview: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number(),
  isShared: z.boolean(),
  isOwner: z.boolean(),
  lastMessage: z.object({
    role: z.string().nullable(),
    timestamp: z.string(),
  }),
});

const listConversationsOutputSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  pagination: z.object({
    page: z.number(),
    pageSize: z.number(),
    totalCount: z.number(),
    totalPages: z.number(),
    hasMore: z.boolean(),
  }),
});

export const listConversations = defineOperation({
  name: 'conversations.list',
  method: 'GET',
  path: '/api/ai/page-agents/:agentId/conversations',
  inputSchema: z.object({
    agentId: z.string(),
    // Route clamps page to 0-10000 (default 0) and pageSize to 1-200 (default 50).
    page: z.number().int().min(0).max(10000).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  }),
  outputSchema: listConversationsOutputSchema,
  requiredScope: 'drive',
  description:
    'List conversations for an AI agent (most recent first), scoped to the caller\'s own private conversations plus shared ones.',
});

// ---------------------------------------------------------------------------
// conversations.read — GET /api/ai/page-agents/:agentId/conversations/:conversationId/messages
// ---------------------------------------------------------------------------

const readConversationOutputSchema = z.object({
  messages: z.array(conversationMessageSchema),
  conversationId: z.string(),
  messageCount: z.number(),
  pagination: z.object({
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    prevCursor: z.string().nullable(),
    limit: z.number(),
    direction: z.enum(['before', 'after']),
  }),
});

export const readConversation = defineOperation({
  name: 'conversations.read',
  method: 'GET',
  path: '/api/ai/page-agents/:agentId/conversations/:conversationId/messages',
  inputSchema: z.object({
    agentId: z.string(),
    conversationId: z.string(),
    // Route clamps limit to 1-200 (default 50).
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
    direction: z.enum(['before', 'after']).optional(),
  }),
  outputSchema: readConversationOutputSchema,
  requiredScope: 'drive',
  description:
    'Read messages in a conversation as canonical UIMessage `parts` arrays, cursor-paginated (default: 50 most recent, oldest-first order). A private conversation is only readable by its owner unless shared.',
});
