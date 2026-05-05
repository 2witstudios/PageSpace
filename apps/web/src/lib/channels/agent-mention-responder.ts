import { db } from '@pagespace/db/db'
import { and, desc, eq, inArray } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { channelMessages } from '@pagespace/db/schema/chat';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions'
import { loggers } from '@pagespace/lib/logging/logger-config';
import { channelMessageRepository } from '@pagespace/lib/services/channel-message-repository';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import {
  broadcastInboxEvent,
  broadcastThreadReplyCountUpdated,
} from '@/lib/websocket/socket-utils';
import { processMentionsInMessage } from '@/lib/ai/core/mention-processor';
import { buildThreadPreview } from '@/lib/channels/build-thread-preview';
import type { ToolExecutionContext } from '@/lib/ai/core';

const channelMentionLogger = loggers.ai.child({ module: 'channel-agent-mentions' });

const CONTEXT_MESSAGE_LIMIT = 12;
const MESSAGE_SNIPPET_LIMIT = 320;
const TRANSCRIPT_CHAR_LIMIT = 5000;

interface MentionedAgent {
  id: string;
  title: string;
  enabledTools: string[] | null;
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

export function isAskAgentResult(value: unknown): value is AskAgentResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  // Each declared field is optional, so undefined is allowed; any other
  // non-matching type rejects the shape.
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

async function resolveMentionedAgents(content: string): Promise<MentionedAgent[]> {
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
    });
  }

  return orderedAgents;
}

function canAgentSendChannelMessages(enabledTools: string[] | null): boolean {
  return Array.isArray(enabledTools) && enabledTools.includes('send_channel_message');
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
}): Promise<void> {
  const result = await channelMessageRepository.insertChannelThreadReply({
    parentId: input.parentId,
    pageId: input.channelId,
    userId: input.userId,
    content: input.content,
    fileId: null,
    attachmentMeta: null,
    aiMeta: {
      senderType: 'agent',
      senderName: input.agent.title,
      agentPageId: input.agent.id,
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
}

export async function triggerMentionedAgentResponses(
  params: TriggerMentionedAgentResponsesParams
): Promise<void> {
  try {
    if (!params.content || !params.content.trim()) {
      return;
    }

    const [{ agentCommunicationTools }, { channelTools }] = await Promise.all([
      import('@/lib/ai/tools/agent-communication-tools'),
      import('@/lib/ai/tools/channel-tools'),
    ]);

    const askAgentExecute = agentCommunicationTools.ask_agent.execute;
    const sendChannelExecute = channelTools.send_channel_message.execute;

    if (!askAgentExecute || !sendChannelExecute) {
      channelMentionLogger.warn('Agent mention responder tools are unavailable');
      return;
    }

    const mentionedAgents = await resolveMentionedAgents(params.content);
    if (mentionedAgents.length === 0) {
      return;
    }

    const eligibleAgentChecks = await Promise.all(
      mentionedAgents.map(async (agent) => ({
        agent,
        canView: await canUserViewPage(params.userId, agent.id),
        canSend: canAgentSendChannelMessages(agent.enabledTools),
      }))
    );

    const eligibleAgents = eligibleAgentChecks
      .filter((entry) => entry.canView && entry.canSend)
      .map((entry) => entry.agent);

    if (eligibleAgents.length === 0) {
      return;
    }

    const recentMessages = await db.query.channelMessages.findMany({
      where: and(
        eq(channelMessages.pageId, params.channelId),
        eq(channelMessages.isActive, true)
      ),
      columns: {
        content: true,
        createdAt: true,
        aiMeta: true,
      },
      with: {
        user: {
          columns: {
            name: true,
          },
        },
      },
      orderBy: [desc(channelMessages.createdAt)],
      limit: CONTEXT_MESSAGE_LIMIT,
    });

    const contextMessages = [...recentMessages].reverse();
    const transcript = buildChannelTranscript(contextMessages);
    const question = toSingleLine(
      convertMentionsToDisplayText(params.content),
      MESSAGE_SNIPPET_LIMIT
    );
    const locationContext = buildLocationContext(params);

    for (const agent of eligibleAgents) {
      try {
        const mentionConversationId = `channel:${params.channelId}:agent:${agent.id}`;
        const rawAskResult: unknown = await askAgentExecute(
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
            ].join('\n'),
            conversationId: mentionConversationId,
          },
          {
            toolCallId: `channel-mention-ask-${params.sourceMessageId}-${agent.id}`,
            messages: [],
            experimental_context: {
              userId: params.userId,
              conversationId: mentionConversationId,
              locationContext,
              requestOrigin: 'user',
              agentCallDepth: 0,
            } as ToolExecutionContext,
          }
        );

        if (!isAskAgentResult(rawAskResult)) {
          channelMentionLogger.warn('Mentioned agent returned a malformed result; skipping', {
            channelId: params.channelId,
            agentId: agent.id,
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

        const replyContent = askResult.response.trim();
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
              experimental_context: {
                userId: params.userId,
                conversationId: mentionConversationId,
                locationContext,
                requestOrigin: 'agent',
                chatSource: {
                  type: 'page',
                  agentPageId: agent.id,
                  agentTitle: agent.title,
                },
              } as ToolExecutionContext,
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
