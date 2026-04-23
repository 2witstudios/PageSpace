import {
  and,
  channelMessages,
  db,
  desc,
  eq,
  inArray,
  pages,
} from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions'
import { loggers } from '@pagespace/lib/logging/logger-config';
import { processMentionsInMessage } from '@/lib/ai/core/mention-processor';
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
  driveId?: string | null;
  driveName?: string | null;
  driveSlug?: string | null;
}

interface AskAgentResult {
  success?: boolean;
  response?: string;
  error?: string;
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
        const askResult = (await askAgentExecute(
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
        )) as AskAgentResult;

        if (!askResult.success || !askResult.response || !askResult.response.trim()) {
          channelMentionLogger.warn('Mentioned agent returned no response', {
            channelId: params.channelId,
            agentId: agent.id,
            error: askResult.error,
          });
          continue;
        }

        await sendChannelExecute(
          {
            channelId: params.channelId,
            content: askResult.response.trim(),
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
