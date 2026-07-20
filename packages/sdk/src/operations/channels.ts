/**
 * Channel messaging operations (Phase 3 task 9, part 1/2 — old handler
 * `conversation.js` channel ops): `channels.sendMessage`, `channels.deleteMessage`.
 * Old MCP tools: `send_channel_message`, `delete_channel_message`. The
 * activity-feed operation from the same old handler file belongs to
 * `activity.ts` (Phase 3 task 9, part 2/2).
 *
 * Route-verified against `apps/web/src/app/api/channels/[pageId]/messages/route.ts`
 * POST and `apps/web/src/app/api/channels/[pageId]/messages/[messageId]/route.ts`
 * DELETE (docs/sdk/operations-inventory.md D12: the old tool's "session-only,
 * may 401" warning is stale — the route accepts mcp tokens too).
 *
 * Channel messages are NOT AI SDK `UIMessage`s: `channel_messages.content`
 * (`packages/db/src/schema/chat.ts`) is a flat text column, not a `parts`
 * array, unlike `conversations.ts`'s AI-agent messages. `packages/lib/src/types.ts`'s
 * canonical `parts` structure genuinely does not apply to this route's
 * response — using it here would be a locally-invented shape masquerading as
 * project law. The output schema below is the wire-format mirror of
 * `loadChannelMessageWithRelations` (`channel-message-repository.ts`) plus
 * `attachQuotedMessages` (`quote-enrichment.ts`) — the actual DB row and its
 * `user`/`file`/`reactions`/`mirroredFrom`/`quotedMessage` relations.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const attachmentMetaSchema = z.object({
  originalName: z.string(),
  size: z.number(),
  mimeType: z.string(),
  contentHash: z.string(),
});

const channelCommandExecutionSchema = z.object({
  label: z.string(),
  status: z.enum(['used', 'skipped']),
  reason: z.enum(['page_trashed', 'no_access', 'not_found', 'disabled']).optional(),
  entryPageTitle: z.string().optional(),
});

/**
 * Universal Commands execution feedback: one entry per resolved command in
 * the triggering message. Rows persisted before multi-command support
 * shipped still carry this as a single object (`ChannelMessageAiMeta`'s
 * `commandExecution` field is a jsonb payload with no data migration), so
 * this accepts either shape and normalizes to an array — mirroring
 * `normalizeCommandExecutionList` in the web app (`execution-indicator-model.ts`).
 */
const channelCommandExecutionListSchema = z
  .union([channelCommandExecutionSchema, z.array(channelCommandExecutionSchema)])
  .optional()
  .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]));

/** Set when a channel message was posted by an AI tool or an incoming channel webhook (`channel-message-repository.ts` `ChannelMessageAiMeta`). */
const channelMessageAiMetaSchema = z.object({
  senderType: z.enum(['global_assistant', 'agent', 'webhook']),
  senderName: z.string(),
  agentPageId: z.string().optional(),
  commandExecution: channelCommandExecutionListSchema,
});

const channelMessageUserSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});

const channelMessageFileSchema = z.object({
  id: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number(),
});

const channelMessageReactionSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  userId: z.string(),
  emoji: z.string(),
  createdAt: z.string(),
  user: z.object({ id: z.string(), name: z.string().nullable() }),
});

const mirroredFromSchema = z.object({
  parentId: z.string().nullable(),
});

/** Denormalized quote snapshot (`quote-enrichment.ts` `QuotedMessageSnapshot`). */
const quotedMessageSnapshotSchema = z.object({
  id: z.string(),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  authorImage: z.string().nullable(),
  contentSnippet: z.string(),
  createdAt: z.string(),
  isActive: z.boolean(),
});

/**
 * `loadChannelMessageWithRelations` row shape. `quotedMessage` is declared
 * `.optional()` (not just `.nullable()`) because only the top-level POST
 * branch runs `attachQuotedMessages` (`messages/route.ts`); the thread-reply
 * branch returns `replyWithRelations` as-is and never adds the key.
 */
const channelMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.string(),
  pageId: z.string(),
  userId: z.string(),
  fileId: z.string().nullable(),
  attachmentMeta: attachmentMetaSchema.nullable(),
  isActive: z.boolean(),
  editedAt: z.string().nullable(),
  aiMeta: channelMessageAiMetaSchema.nullable(),
  parentId: z.string().nullable(),
  replyCount: z.number(),
  lastReplyAt: z.string().nullable(),
  mirroredFromId: z.string().nullable(),
  quotedMessageId: z.string().nullable(),
  user: channelMessageUserSchema,
  file: channelMessageFileSchema.nullable(),
  reactions: z.array(channelMessageReactionSchema),
  mirroredFrom: mirroredFromSchema.nullable(),
  quotedMessage: quotedMessageSnapshotSchema.nullable().optional(),
});

// ---------------------------------------------------------------------------
// channels.sendMessage — POST /api/channels/:pageId/messages
// ---------------------------------------------------------------------------

export const sendChannelMessage = defineOperation({
  name: 'channels.sendMessage',
  method: 'POST',
  path: '/api/channels/:pageId/messages',
  inputSchema: z.strictObject({
    pageId: z.string(),
    // Route coerces a non-string body to '' (`typeof content === 'string' ? content : ''`)
    // and never enforces a minimum length — attachment-only messages send an empty string.
    content: z.string(),
    fileId: z.string().optional(),
    attachmentMeta: attachmentMetaSchema.optional(),
    parentId: z.string().optional(),
    alsoSendToParent: z.boolean().optional(),
    quotedMessageId: z.string().optional(),
  }),
  outputSchema: channelMessageSchema,
  requiredScope: 'drive',
  description:
    'Send a message to a CHANNEL page, or reply in a thread when `parentId` is set (`alsoSendToParent` mirrors the reply to the top level too). `quotedMessageId` inline-quotes a top-level message and cannot be combined with `parentId` (route: 400 if both are set). Non-idempotent: POST is never auto-retried by the facade (isIdempotentMethod only retries GET) — a retried send double-posts.',
});

// ---------------------------------------------------------------------------
// channels.deleteMessage — DELETE /api/channels/:pageId/messages/:messageId
// ---------------------------------------------------------------------------

export const deleteChannelMessage = defineOperation({
  name: 'channels.deleteMessage',
  method: 'DELETE',
  path: '/api/channels/:pageId/messages/:messageId',
  inputSchema: z.strictObject({ pageId: z.string(), messageId: z.string() }),
  outputSchema: z.object({ success: z.literal(true) }),
  requiredScope: 'drive',
  destructive: true,
  description:
    'Soft-delete a channel message. Only the message author may delete their own message (route: 403 otherwise); softDeleteChannelMessage is gated on isActive=true, so a concurrent or repeated delete of an already-deleted message 404s rather than re-succeeding. Irreversible from the caller\'s perspective — the CLI requires --yes.',
});
