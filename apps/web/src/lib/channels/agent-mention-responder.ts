import { db } from '@pagespace/db/db'
import { and, desc, eq, inArray } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { channelMessages } from '@pagespace/db/schema/chat';
import { canActorEditPage, canActorConsultAgent } from '@/lib/ai/tools/actor-permissions'
import { loggers } from '@pagespace/lib/logging/logger-config';
import { channelMessageRepository } from '@pagespace/lib/services/channel-message-repository';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import {
  broadcastInboxEvent,
  broadcastThreadReplyCountUpdated,
} from '@/lib/websocket/socket-utils';
import { notifyMentionedUsers } from '@/lib/channels/notify-mentioned-users';
import { processMentionsInMessage } from '@/lib/ai/core/mention-processor';
import {
  buildCommandPromptSection,
  commandExecutionDataFromPlan,
  isSoloBuiltinCommandIgnoringMentions,
  type CommandExecutionData,
} from '@/lib/ai/core/command-processor';
import { planCommandExecutions } from '@/lib/ai/core/command-resolver';
import { loadHelpAnswerText } from '@/lib/commands/help-answer';
import { acquireUserCreditHold } from '@/lib/ai/core/user-credit-hold';
import { MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { buildThreadPreview } from '@pagespace/lib/services/preview';
import { decryptField } from '@pagespace/lib/encryption/field-crypto';
import type { ToolExecutionContext } from '@/lib/ai/core/types';
import { hasVisionCapability } from '@/lib/ai/core/model-capabilities';
import { DEFAULT_MODEL } from '@/lib/ai/core/ai-providers-config';
import { files, type AttachmentMeta } from '@pagespace/db/schema/storage';
import type { ChannelMessageAiMeta } from '@pagespace/db/schema/chat';
import { canUserAccessFile } from '@pagespace/lib/permissions/file-access';
import { generatePresignedUrl, getPresignedUrlTtl, toContentHash } from '@/lib/presigned-url';
import { isAllowedImageType } from '@/lib/validation/image-validation';
import {
  buildRecentImageFileParts,
  MAX_RECENT_IMAGE_ATTACHMENTS,
  MAX_RECENT_IMAGE_ATTACHMENT_SIZE_BYTES,
  type ImageFilePart,
  type RecentImageFileCandidate,
} from '@/lib/channels/build-recent-image-file-parts';

const channelMentionLogger = loggers.ai.child({ module: 'channel-agent-mentions' });

const CONTEXT_MESSAGE_LIMIT = 12;
const MESSAGE_SNIPPET_LIMIT = 320;
const TRANSCRIPT_CHAR_LIMIT = 5000;

export interface MentionedAgent {
  id: string;
  title: string;
  enabledTools: string[] | null;
  /** Whether this agent's configured model (falling back to DEFAULT_MODEL) supports vision. */
  hasVision: boolean;
}

export interface RecentChannelMessage {
  content: string;
  createdAt: Date;
  user: { name: string | null } | null;
  aiMeta: ChannelMessageAiMeta | null;
  fileId: string | null;
  attachmentMeta: AttachmentMeta | null;
  /** Present since messages gained real attachment rows; ordered by position. */
  attachments?: Array<{
    fileId: string | null;
    attachmentMeta: AttachmentMeta | null;
    position: number;
  }>;
}

export interface TriggerMentionedAgentResponsesParams {
  userId: string;
  channelId: string;
  channelTitle: string;
  channelType?: string;
  sourceMessageId: string;
  content: string;
  /**
   * When the originating message is itself a thread reply, the agent's reply
   * MUST land in the same thread, not at the top level. The route forwards
   * the thread root id here; absent (or empty) means the original was top-level
   * and the agent should reply at the top level (existing behavior).
   */
  parentId?: string;
  driveId?: string | null;
  driveName?: string | null;
  driveSlug?: string | null;
}

interface AskAgentResult {
  success?: boolean;
  response?: string;
  error?: string;
}

// Recognizes the AskAgentResult contract — a non-null object that has at least
// one of the three declared keys. Each key's value is checked against its
// declared primitive type ONLY when the value is not `undefined`; an explicit
// `undefined` value (with the key present) is treated the same as the key
// being absent, matching the optional `?` semantics of the interface. The
// downstream `!success || !response` gate handles the shape-valid-but-empty
// case (e.g. `{ success: true }` with no response); this predicate's job is
// solely to reject foreign shapes the cast would have accepted blindly.
export function isAskAgentResult(value: unknown): value is AskAgentResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.success !== undefined && typeof candidate.success !== 'boolean') {
    return false;
  }
  if (candidate.response !== undefined && typeof candidate.response !== 'string') {
    return false;
  }
  if (candidate.error !== undefined && typeof candidate.error !== 'string') {
    return false;
  }
  return 'success' in candidate || 'response' in candidate || 'error' in candidate;
}

function convertMentionsToDisplayText(content: string): string {
  return content.replace(
    /@\[([^\]]{1,500})\]\(([^:)]{1,200}):([^)]{1,200})\)/g,
    (_match, label: string) => `@${label}`
  );
}

function toSingleLine(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

function buildChannelTranscript(
  messages: Array<{
    content: string;
    createdAt: Date;
    user: { name: string | null } | null;
    aiMeta: { senderName: string } | null;
  }>
): string {
  if (messages.length === 0) {
    return 'No prior channel messages.';
  }

  const lines = messages.map((message) => {
    const senderName = message.aiMeta?.senderName || message.user?.name || 'Unknown';
    const timestamp = message.createdAt.toISOString();
    const displayContent = toSingleLine(
      convertMentionsToDisplayText(message.content || ''),
      MESSAGE_SNIPPET_LIMIT
    );
    return `- [${timestamp}] ${senderName}: ${displayContent}`;
  });

  const transcript = lines.join('\n');
  if (transcript.length <= TRANSCRIPT_CHAR_LIMIT) {
    return transcript;
  }

  return `${transcript.slice(0, TRANSCRIPT_CHAR_LIMIT)}\n...`;
}

function buildLocationContext(params: TriggerMentionedAgentResponsesParams): ToolExecutionContext['locationContext'] {
  return {
    currentPage: {
      id: params.channelId,
      title: params.channelTitle,
      type: params.channelType || 'CHANNEL',
      path: `/channel/${params.channelId}`,
    },
    currentDrive: params.driveId
      ? {
          id: params.driveId,
          name: params.driveName || 'Unknown Drive',
          slug: params.driveSlug || params.driveId,
        }
      : undefined,
  };
}

export async function resolveMentionedAgents(content: string): Promise<MentionedAgent[]> {
  const processed = processMentionsInMessage(content);
  if (processed.mentions.length === 0) {
    return [];
  }

  const mentionOrder: string[] = [];
  const seen = new Set<string>();
  for (const mention of processed.mentions) {
    if (!seen.has(mention.id)) {
      seen.add(mention.id);
      mentionOrder.push(mention.id);
    }
  }

  if (mentionOrder.length === 0) {
    return [];
  }

  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const pagesById = await db.query.pages.findMany({
    where: and(
      inArray(pages.id, mentionOrder),
      eq(pages.type, 'AI_CHAT'),
      eq(pages.isTrashed, false)
    ),
    columns: {
      id: true,
      title: true,
      enabledTools: true,
      aiProvider: true,
      aiModel: true,
    },
  });

  if (pagesById.length === 0) {
    return [];
  }

  const pageLookup = new Map(pagesById.map((page) => [page.id, page]));
  const orderedAgents: MentionedAgent[] = [];

  for (const pageId of mentionOrder) {
    const page = pageLookup.get(pageId);
    if (!page) {
      continue;
    }
    orderedAgents.push({
      id: page.id,
      title: page.title || 'Agent',
      enabledTools: Array.isArray(page.enabledTools) ? page.enabledTools : null,
      hasVision: hasVisionCapability(page.aiModel || DEFAULT_MODEL),
    });
  }

  return orderedAgents;
}

export async function fetchRecentChannelMessages(channelId: string): Promise<RecentChannelMessage[]> {
  return db.query.channelMessages.findMany({
    where: and(eq(channelMessages.pageId, channelId), eq(channelMessages.isActive, true)),
    columns: {
      content: true,
      createdAt: true,
      aiMeta: true,
      fileId: true,
      attachmentMeta: true,
    },
    with: {
      user: {
        columns: {
          name: true,
        },
      },
      attachments: {
        columns: { fileId: true, attachmentMeta: true, position: true },
      },
    },
    orderBy: [desc(channelMessages.createdAt)],
    limit: CONTEXT_MESSAGE_LIMIT,
  });
}

/**
 * Resolve recent channel image attachments into presigned, access-checked
 * file parts for ask_agent. Skips the S3/DB round-trips entirely when no
 * eligible agent can view images (nothing would ever consume the result).
 *
 * Everything security-relevant — storage key, mime type, size, and the drive
 * used for the access check — comes from the `files` row, never from the
 * message's `attachmentMeta` (client-supplied at message-POST time, so a
 * crafted message could otherwise pair an accessible fileId with a forged
 * contentHash and mint a presigned URL for an arbitrary object).
 * `attachmentMeta` is used only for the display filename.
 */
async function resolveImageAttachmentsForContext(
  userId: string,
  contextMessages: RecentChannelMessage[]
): Promise<ImageFilePart[]> {
  // Dedup by fileId, keeping each file's MOST RECENT mention: re-sharing the
  // same screenshot across several of the last 12 messages must not both
  // (a) redo the access-check/presign per repeat, and (b) crowd out distinct
  // older images from the eventual 5-slot cap with copies of one image.
  // Map.delete+set (rather than a plain overwrite) moves the re-seen key to
  // the end of iteration order, so final ordering reflects last-seen position.
  //
  // `contextMessages` arrives OLDEST-FIRST: `fetchRecentChannelMessages` orders
  // newest-first (it takes the newest CONTEXT_MESSAGE_LIMIT rows) and the sole
  // caller reverses it before passing it here, because the transcript reads in
  // reading order. Everything below depends on that: `buildRecentImageFileParts`
  // keeps the LAST `maxCount` candidates, so oldest-first is what makes the cap
  // keep the newest images and the dedupe keep each file's latest mention. Do
  // not "fix" this by reversing again — that inverts both.
  const latestByFileId = new Map<string, RecentChannelMessage & { fileId: string }>();
  for (const message of contextMessages) {
    // Read every attachment on the message, not just the first. A message can
    // now carry a whole batch of photos, and an agent mentioned on one should
    // see all of them. Falls back to the legacy column for rows written before
    // messages had attachment rows.
    //
    // Capped per message at the same number of slots the final selection has,
    // taking the first few in the sender's own order. One message cannot then
    // contribute more than the whole budget, and which few it contributes
    // reads the way the batch reads. The final selection keeps the LAST
    // candidates, so the newest messages win the cap — a ten-photo message
    // posted just now can fill all five slots, and an older one cannot evict
    // what came after it.
    const messageAttachments =
      message.attachments && message.attachments.length > 0
        ? [...message.attachments]
            .sort((a, b) => a.position - b.position)
            .slice(0, MAX_RECENT_IMAGE_ATTACHMENTS)
            .map((attachment) => ({
              fileId: attachment.fileId,
              attachmentMeta: attachment.attachmentMeta,
            }))
        : [{ fileId: message.fileId, attachmentMeta: message.attachmentMeta }];

    for (const attachment of messageAttachments) {
      if (!attachment.fileId) continue;
      latestByFileId.delete(attachment.fileId);
      latestByFileId.set(attachment.fileId, {
        ...message,
        fileId: attachment.fileId,
        attachmentMeta: attachment.attachmentMeta,
      });
    }
  }

  if (latestByFileId.size === 0) {
    return [];
  }

  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const fileRows = await db.query.files.findMany({
    where: inArray(files.id, [...latestByFileId.keys()]),
    columns: { id: true, driveId: true, sizeBytes: true, mimeType: true, storagePath: true },
  });
  const filesById = new Map(fileRows.map((file) => [file.id, file]));

  const candidates: RecentImageFileCandidate[] = await Promise.all(
    [...latestByFileId.values()].map(async (message) => {
      const file = filesById.get(message.fileId);
      const filename = message.attachmentMeta?.originalName || 'attachment';

      // Missing row, a non-image mime type, an oversized file, or a stub row
      // with no blob ever persisted (storagePath null — see reap-orphaned-files)
      // can never become a valid file part, so skip the per-file
      // access-check/signing work up front rather than signing a dead URL.
      if (
        !file ||
        !file.storagePath ||
        !file.mimeType ||
        !isAllowedImageType(file.mimeType) ||
        file.sizeBytes > MAX_RECENT_IMAGE_ATTACHMENT_SIZE_BYTES
      ) {
        return {
          fileId: message.fileId,
          url: '',
          mimeType: file?.mimeType ?? null,
          filename,
          sizeBytes: file?.sizeBytes ?? 0,
          accessible: false,
        };
      }

      const accessible = await canUserAccessFile(userId, file.id, file.driveId);
      const url = accessible
        ? await generatePresignedUrl(
            toContentHash(file.storagePath),
            'original',
            getPresignedUrlTtl(file.mimeType),
            undefined,
            file.mimeType
          )
        : '';

      return {
        fileId: file.id,
        url,
        mimeType: file.mimeType,
        filename,
        sizeBytes: file.sizeBytes,
        accessible,
      };
    })
  );

  return buildRecentImageFileParts(candidates);
}

/**
 * Whether the agent's saved tool allowlist lets it talk in channels.
 *
 * Same semantics as `filterToolsForAgentAllowlist` (tool-filtering.ts):
 * `null` is an unconfigured agent with NO restriction — the default every
 * creation path writes — so a member agent replies to mentions out of the
 * box; `[]` blocks every tool, and an explicit list must name
 * `send_channel_message`. Treating null as "not enabled" here meant a
 * freshly created agent could never answer a mention.
 */
function canAgentSendChannelMessages(enabledTools: string[] | null): boolean {
  if (enabledTools === null) return true;
  return enabledTools.includes('send_channel_message');
}

/**
 * The execution context the mentioner's consult runs under — a plain user
 * context (no agent chatSource: the human asks, the agent answers), located
 * in the channel's drive. It is passed to BOTH the preliminary
 * canActorConsultAgent gate and executeAskAgent, whose own gate is the same
 * function, so the two can never disagree about a guest agent.
 */
function buildMentionerContext(
  params: TriggerMentionedAgentResponsesParams,
  conversationId: string,
  locationContext: ToolExecutionContext['locationContext'],
): ToolExecutionContext {
  return {
    userId: params.userId,
    conversationId,
    locationContext,
    requestOrigin: 'user',
    agentCallDepth: 0,
  } as ToolExecutionContext;
}

/**
 * The execution context the agent's own reply is authorized under — the same
 * shape the top-level send passes to `send_channel_message`, so asking
 * `canActorEditPage` with it up front answers exactly the question that tool
 * would otherwise answer after the model call has already been paid for.
 * The thread branch inserts through the repository directly and had no gate
 * at all; both branches now share this one.
 */
function buildAgentActorContext(
  params: TriggerMentionedAgentResponsesParams,
  agent: MentionedAgent,
  conversationId: string,
  locationContext: ToolExecutionContext['locationContext'],
  commandExecution?: CommandExecutionData[],
): ToolExecutionContext {
  return {
    userId: params.userId,
    conversationId,
    locationContext,
    requestOrigin: 'agent',
    chatSource: {
      type: 'page',
      agentPageId: agent.id,
      agentTitle: agent.title,
    },
    ...(commandExecution && { commandExecution }),
  } as ToolExecutionContext;
}

function mentionConversationIdFor(channelId: string, agentId: string): string {
  return `channel:${channelId}:agent:${agentId}`;
}

/**
 * Post an agent's reply into a thread.
 *
 * Mirrors the thread-reply path in the channel POST route: insert via the
 * transactional helper, broadcast `new_message` to the channel room (so the
 * panel renders it), bump the parent footer via `thread_reply_count_updated`,
 * and fan out `thread_updated` to followers (excluding the userId, which is
 * the human who triggered the agent — they do not need a self-bump).
 *
 * Failures are logged and swallowed so a stalled realtime sidecar does not
 * abort the originating user-facing request.
 */
async function postAgentThreadReply(input: {
  userId: string;
  channelId: string;
  content: string;
  parentId: string;
  agent: MentionedAgent;
  commandExecution?: CommandExecutionData[];
  driveId?: string | null;
}): Promise<void> {
  const result = await channelMessageRepository.insertChannelThreadReply({
    parentId: input.parentId,
    pageId: input.channelId,
    userId: input.userId,
    content: input.content,
    attachments: [],
    aiMeta: {
      senderType: 'agent',
      senderName: input.agent.title,
      agentPageId: input.agent.id,
      ...(input.commandExecution && { commandExecution: input.commandExecution }),
    },
  });

  if (result.kind !== 'ok') {
    channelMentionLogger.warn('Agent thread reply rejected by repository', {
      channelId: input.channelId,
      parentId: input.parentId,
      kind: result.kind,
    });
    return;
  }

  const replyWithRelations = await channelMessageRepository.loadChannelMessageWithRelations(
    result.reply.id
  );

  if (process.env.INTERNAL_REALTIME_URL && replyWithRelations) {
    try {
      const requestBody = JSON.stringify({
        channelId: input.channelId,
        event: 'new_message',
        payload: replyWithRelations,
      });
      await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
        method: 'POST',
        headers: createSignedBroadcastHeaders(requestBody),
        body: requestBody,
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      channelMentionLogger.error(
        'Failed to broadcast agent thread reply',
        error instanceof Error ? error : undefined,
        { channelId: input.channelId, parentId: input.parentId }
      );
    }
  }

  await broadcastThreadReplyCountUpdated(input.channelId, {
    rootId: result.rootId,
    replyCount: result.replyCount,
    lastReplyAt: result.lastReplyAt.toISOString(),
  });

  try {
    const followers = await channelMessageRepository.listChannelThreadFollowers(result.rootId);
    const replyPreview = buildThreadPreview(input.content);
    await Promise.all(
      followers
        .filter((followerId: string) => followerId !== input.userId)
        .map((followerId: string) =>
          broadcastInboxEvent(followerId, {
            operation: 'thread_updated',
            type: 'channel',
            id: input.channelId,
            rootMessageId: result.rootId,
            lastReplyAt: result.lastReplyAt.toISOString(),
            lastReplyPreview: replyPreview,
            lastReplySender: { id: input.userId, name: input.agent.title },
          })
        )
    );
  } catch (error) {
    channelMentionLogger.error(
      'Failed to fan out thread_updated for agent thread reply',
      error instanceof Error ? error : undefined,
      { channelId: input.channelId, parentId: input.parentId }
    );
  }

  // Fire-and-forget mention notifications for the agent's reply content
  if (input.driveId) {
    void notifyMentionedUsers({
      content: input.content,
      pageId: input.channelId,
      driveId: input.driveId,
      triggeredByUserId: input.userId,
      mentionerNameOverride: input.agent.title,
    });
  }
}

export async function triggerMentionedAgentResponses(
  params: TriggerMentionedAgentResponsesParams
): Promise<void> {
  try {
    if (!params.content || !params.content.trim()) {
      return;
    }

    // executeAskAgent is the KEPT internal invoke-an-agent engine — the
    // ask_agent TOOL surface died with the session-family rebuild (spawn/send
    // with wait absorbed it), but a mention reply is exactly this inline,
    // ephemeral consult.
    const [{ executeAskAgent }, { channelTools }] = await Promise.all([
      import('@/lib/ai/tools/agent-communication-tools'),
      import('@/lib/ai/tools/channel-tools'),
    ]);

    const askAgentExecute = executeAskAgent;
    const sendChannelExecute = channelTools.send_channel_message.execute;

    if (!sendChannelExecute) {
      channelMentionLogger.warn('Agent mention responder tools are unavailable');
      return;
    }

    const mentionedAgents = await resolveMentionedAgents(params.content);
    if (mentionedAgents.length === 0) {
      return;
    }

    const locationContext = buildLocationContext(params);

    // Three gates, cheapest first, all before any model call: the agent's
    // allowlist lets it talk in channels; the mentioner may consult it (the
    // same rule executeAskAgent applies — view its page, or it is a member of
    // the channel's drive); and it can actually post in THIS channel as
    // itself (a plain MEMBER agent can, in a non-private channel — the same
    // rule as a member user).
    const eligibleAgentChecks = await Promise.all(
      mentionedAgents.map(async (agent) => {
        if (!canAgentSendChannelMessages(agent.enabledTools)) return { agent, eligible: false };
        const conversationId = mentionConversationIdFor(params.channelId, agent.id);
        const mentionerContext = buildMentionerContext(params, conversationId, locationContext);
        if (!(await canActorConsultAgent(mentionerContext, agent.id, params.driveId ?? null))) {
          return { agent, eligible: false };
        }
        const actorContext = buildAgentActorContext(params, agent, conversationId, locationContext);
        return { agent, eligible: await canActorEditPage(actorContext, params.channelId) };
      })
    );

    const eligibleAgents = eligibleAgentChecks
      .filter((entry) => entry.eligible)
      .map((entry) => entry.agent);

    if (eligibleAgents.length === 0) {
      return;
    }

    // A mention whose content is nothing but the /help chip (plus the
    // @mention(s) that got it here at all — reaching this function already
    // required at least one, see resolveMentionedAgents above, so the
    // strict isSoloBuiltinCommand could never be satisfied here) answers
    // directly from code for every eligible agent, below. Computed early
    // (pure, no I/O) so everything below that exists only to build an
    // askAgentExecute call — the channel transcript fetch/decrypt, image
    // attachment resolution, command resolution's dynamic section — can
    // skip entirely for this case; none of it is read on the solo-help path.
    const isSoloHelpMention = isSoloBuiltinCommandIgnoringMentions(params.content, 'help');

    let transcript = '';
    let question = '';
    let imageAttachments: ImageFilePart[] = [];
    if (!isSoloHelpMention) {
      const recentMessages = await fetchRecentChannelMessages(params.channelId);

      // Decrypt PII at the edge (GDPR #965) so the agent transcript shows plaintext
      // sender names (legacy plaintext passes through unchanged).
      const contextMessages = await Promise.all(
        [...recentMessages].reverse().map(async (m) => ({
          ...m,
          user: m.user ? { ...m.user, name: await decryptField(m.user.name) } : null,
        })),
      );
      transcript = buildChannelTranscript(contextMessages);
      question = toSingleLine(convertMentionsToDisplayText(params.content), MESSAGE_SNIPPET_LIMIT);

      // Only worth resolving presigned URLs/access checks when at least one
      // eligible agent can actually view images. Resolution failure (S3
      // misconfigured, transient DB error) must degrade to text-only, not
      // abort every mentioned agent's reply — this call sits ahead of the
      // per-agent try/catch below, so an uncaught throw here would propagate
      // to the function-level catch and silence the whole mention entirely.
      if (eligibleAgents.some((agent) => agent.hasVision)) {
        try {
          imageAttachments = await resolveImageAttachmentsForContext(params.userId, contextMessages);
        } catch (error) {
          channelMentionLogger.error(
            'Failed to resolve recent channel image attachments; continuing with text-only replies',
            error instanceof Error ? error : undefined,
            { channelId: params.channelId, sourceMessageId: params.sourceMessageId }
          );
        }
      }
    }

    // Universal Commands (UX spec §6): a chip is inert in a plain channel
    // message, but every command chip executes — with the SENDER's
    // permissions — when this message triggers an agent response.
    // Resolution degrades, never fails; a skipped command becomes a
    // one-line notice. Both the prompt injection and the persisted
    // execution-feedback pill carry every resolved command, in order.
    //
    // Skipped entirely for a solo /help mention: planCommandExecutions would
    // resolve /help's dynamic section (a DB read building the model-facing
    // command list) only for commandContext, which this path never sends to
    // a model — and the "used" pill it would also produce is exactly
    // {label:'help', status:'used'} either way, since a builtin has no entry
    // page for commandExecutionDataFromPlan to read.
    const commandPlans = isSoloHelpMention
      ? []
      : await planCommandExecutions(params.content, params.userId, {
          driveId: params.driveId ?? null,
        });
    const commandContext = buildCommandPromptSection(commandPlans);
    const commandExecution = isSoloHelpMention
      ? [{ label: 'help', status: 'used' as const }]
      : commandPlans.length > 0
        ? commandPlans.map(commandExecutionDataFromPlan)
        : undefined;

    // isSoloHelpMention computed above (before command resolution). The
    // answer itself is sender-scoped (the human's command list), not
    // agent-scoped, so it's identical regardless of which agent replies —
    // this skips askAgentExecute/generateText entirely for every one.
    for (const agent of eligibleAgents) {
      try {
        const mentionConversationId = mentionConversationIdFor(params.channelId, agent.id);

        let replyContent: string;
        if (isSoloHelpMention) {
          replyContent = await loadHelpAnswerText(params.userId, params.driveId ?? null);
        } else {
          // The agent's run bills the MENTIONER (executeAskAgent tracks usage as
          // params.userId), so it passes the credit gate before any model is
          // built — one hold per reply. A mention is a user action: the daily
          // exposure cap applies, and the in-flight cap bounds a message that
          // mentions many agents. A refusal skips this agent's reply.
          const hold = await acquireUserCreditHold(params.userId, { maxInFlight: MAX_CHAT_INFLIGHT });
          if (!hold.allowed) {
            channelMentionLogger.info('Mentioned agent reply skipped (credit gate denied)', {
              channelId: params.channelId,
              agentId: agent.id,
              reason: hold.reason,
            });
            continue;
          }
          let rawAskResult: unknown;
          try {
            rawAskResult = await askAgentExecute(
              {
                agentPath: `/${agent.title}`,
                agentId: agent.id,
                question,
                context: [
                  `You were mentioned in the channel "${params.channelTitle}".`,
                  'Respond directly to the latest request and use recent channel context when relevant.',
                  '',
                  'Recent channel transcript (oldest to newest):',
                  transcript,
                  ...(commandContext ? ['', commandContext] : []),
                ].join('\n'),
                conversationId: mentionConversationId,
                ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
              },
              {
                toolCallId: `channel-mention-ask-${params.sourceMessageId}-${agent.id}`,
                messages: [],
                experimental_context: buildMentionerContext(params, mentionConversationId, locationContext),
              }
            );
          } finally {
            hold.release();
          }

          if (!isAskAgentResult(rawAskResult)) {
            channelMentionLogger.error('Mentioned agent returned a malformed result; skipping', {
              channelId: params.channelId,
              agentId: agent.id,
              receivedType: typeof rawAskResult,
              receivedKeys:
                rawAskResult && typeof rawAskResult === 'object'
                  ? Object.keys(rawAskResult as Record<string, unknown>)
                  : null,
            });
            continue;
          }
          const askResult = rawAskResult;

          if (!askResult.success || !askResult.response || !askResult.response.trim()) {
            channelMentionLogger.warn('Mentioned agent returned no response', {
              channelId: params.channelId,
              agentId: agent.id,
              error: askResult.error,
            });
            continue;
          }

          replyContent = askResult.response.trim();
        }

        const trimmedParent = (params.parentId ?? '').trim();
        if (trimmedParent.length > 0) {
          // Thread-reply branch: route through the same transactional helper
          // users use, with `aiMeta` set so the reply renders as the agent's
          // identity and not the human user's. Auto-follow is handled inside
          // the repository (PR 3); we still need to fan out `thread_updated`
          // to the resulting follower set so other followers see the reply
          // in their inbox even though it was posted by the agent.
          await postAgentThreadReply({
            userId: params.userId,
            channelId: params.channelId,
            content: replyContent,
            parentId: trimmedParent,
            agent,
            commandExecution,
            driveId: params.driveId,
          });
        } else {
          await sendChannelExecute(
            {
              channelId: params.channelId,
              content: replyContent,
            },
            {
              toolCallId: `channel-mention-send-${params.sourceMessageId}-${agent.id}`,
              messages: [],
              experimental_context: buildAgentActorContext(
                params,
                agent,
                mentionConversationId,
                locationContext,
                commandExecution,
              ),
            }
          );
        }
      } catch (error) {
        channelMentionLogger.error(
          'Failed to generate or post mentioned agent response',
          error instanceof Error ? error : undefined,
          {
            channelId: params.channelId,
            sourceMessageId: params.sourceMessageId,
            agentId: agent.id,
          }
        );
      }
    }
  } catch (error) {
    channelMentionLogger.error(
      'Failed to process channel agent mentions',
      error instanceof Error ? error : undefined,
      {
        channelId: params.channelId,
        sourceMessageId: params.sourceMessageId,
      }
    );
  }
}
