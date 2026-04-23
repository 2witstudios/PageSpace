import { tool } from 'ai';
import { z } from 'zod';
import { canUserEditPage, canUserViewPage } from '@pagespace/lib/permissions';
import {
  loggers,
  getActorInfo,
  logMessageActivity,
} from '@pagespace/lib/server';
import { db, channelMessages, channelReadStatus, pages, driveMembers, eq, and } from '@pagespace/db';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { broadcastInboxEvent } from '@/lib/websocket/socket-utils';
import { type ToolExecutionContext } from '../core';
import { maskIdentifier } from '@/lib/logging/mask';

const channelLogger = loggers.ai.child({ module: 'channel-tools' });

/**
 * Resolve sender identity for AI-generated channel messages.
 *
 * Global assistant: uses the user's display name + 'global_assistant' type
 * Page agent: uses "agent title (user display name)" + 'agent' type
 */
const resolveSenderIdentity = async (
  context: ToolExecutionContext
): Promise<{ senderType: 'global_assistant' | 'agent'; senderName: string; agentPageId?: string }> => {
  const { chatSource } = context;
  const actorInfo = await getActorInfo(context.userId);
  const actorDisplayName = actorInfo.actorDisplayName ?? 'User';

  if (chatSource?.type === 'page' && chatSource.agentTitle) {
    return {
      senderType: 'agent',
      senderName: `${chatSource.agentTitle} (${actorDisplayName})`,
      agentPageId: chatSource.agentPageId,
    };
  }

  // Global assistant or unknown — use the user's display name
  return {
    senderType: 'global_assistant',
    senderName: actorDisplayName,
  };
};

export const channelTools = {
  /**
   * Send a message to a channel as the AI
   */
  send_channel_message: tool({
    description:
      'Send a message to a channel (team discussion space). The message will appear in the channel with an AI sender badge. Use this to post updates, announcements, or responses visible to all channel members.',
    inputSchema: z.object({
      channelId: z.string().describe('The unique ID of the channel page to send a message to'),
      content: z.string().describe('The message content to send (supports markdown formatting)'),
    }),
    execute: async ({ channelId, content }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      if (!content || content.trim().length === 0) {
        throw new Error('Message content cannot be empty');
      }

      try {
        // Verify the channel exists and load drive relations for broadcast
        const channel = await db.query.pages.findFirst({
          where: and(eq(pages.id, channelId), eq(pages.isTrashed, false)),
          columns: { id: true, title: true, type: true, driveId: true },
          with: {
            drive: { columns: { ownerId: true } },
          },
        });
        if (!channel) {
          throw new Error(`Channel with ID "${channelId}" not found`);
        }

        // Verify this is a CHANNEL type page
        if (channel.type !== 'CHANNEL') {
          return {
            success: false,
            error: 'Page is not a channel',
            message: `This page is a ${channel.type}. Use send_channel_message only on CHANNEL pages.`,
            suggestion: 'Use list_pages to find channels (type: CHANNEL) in the drive.',
          };
        }

        // Check edit permissions
        const canEdit = await canUserEditPage(userId, channel.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to send messages in this channel');
        }

        // Determine sender identity
        const senderIdentity = await resolveSenderIdentity(context as ToolExecutionContext);
        const treatAsSelfAuthored = senderIdentity.senderType === 'global_assistant';

        // Insert the message
        const [createdMessage] = await db
          .insert(channelMessages)
          .values({
            pageId: channelId,
            userId,
            content: content.trim(),
            aiMeta: {
              senderType: senderIdentity.senderType,
              senderName: senderIdentity.senderName,
              ...(senderIdentity.agentPageId && { agentPageId: senderIdentity.agentPageId }),
            },
          })
          .returning();

        // Only mark sender read for self-authored global assistant messages.
        // Agent messages should behave like third-party messages for unread/inbox semantics.
        if (treatAsSelfAuthored) {
          await db
            .insert(channelReadStatus)
            .values({ userId, channelId, lastReadAt: new Date() })
            .onConflictDoUpdate({
              target: [channelReadStatus.userId, channelReadStatus.channelId],
              set: { lastReadAt: new Date() },
            });
        }

        // Log activity for audit trail (fire-and-forget)
        const toolContext = context as ToolExecutionContext;
        getActorInfo(userId)
          .then(actorInfo => {
            logMessageActivity(userId, 'create', {
              id: createdMessage.id,
              pageId: channelId,
              driveId: channel.driveId,
              conversationType: 'channel',
            }, actorInfo, {
              newContent: content.trim(),
              isAiGenerated: true,
              aiProvider: toolContext.aiProvider ?? 'unknown',
              aiModel: toolContext.aiModel ?? 'unknown',
              aiConversationId: toolContext.conversationId,
              metadata: {
                senderType: senderIdentity.senderType,
                senderName: senderIdentity.senderName,
                agentPageId: senderIdentity.agentPageId,
              },
            });
          })
          .catch(() => {
            channelLogger.warn('Failed to get actor info for activity logging');
          });

        // Fetch the complete message with user info for broadcasting
        const newMessage = await db.query.channelMessages.findFirst({
          where: eq(channelMessages.id, createdMessage.id),
          with: {
            user: {
              columns: { id: true, name: true, image: true },
            },
            file: {
              columns: { id: true, mimeType: true, sizeBytes: true },
            },
            reactions: {
              with: {
                user: {
                  columns: { id: true, name: true },
                },
              },
            },
          },
        });

        // Broadcast to real-time channel
        if (process.env.INTERNAL_REALTIME_URL && newMessage) {
          try {
            const requestBody = JSON.stringify({
              channelId,
              event: 'new_message',
              payload: newMessage,
            });

            await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
              method: 'POST',
              headers: createSignedBroadcastHeaders(requestBody),
              body: requestBody,
            });
          } catch (error) {
            channelLogger.error('Failed to broadcast AI message to socket server', error instanceof Error ? error : undefined);
          }
        }

        // Broadcast inbox updates to channel members
        try {
          if (channel.driveId) {
            const members = await db.query.driveMembers.findMany({
              where: eq(driveMembers.driveId, channel.driveId),
              columns: { userId: true },
            });

            const driveOwnerId = channel.drive?.ownerId;
            const memberUserIds = new Set(members.map(m => m.userId));
            if (driveOwnerId && !memberUserIds.has(driveOwnerId)) {
              members.push({ userId: driveOwnerId });
            }

            const messagePreview = content.length > 100
              ? content.substring(0, 100) + '...'
              : content;

            const memberPermissions = await Promise.all(
              members
                .filter(m => !treatAsSelfAuthored || m.userId !== userId)
                .map(async member => ({
                  userId: member.userId,
                  canView: await canUserViewPage(member.userId, channelId),
                }))
            );

            const broadcastPromises = memberPermissions
              .filter(m => m.canView)
              .map(member =>
                broadcastInboxEvent(member.userId, {
                  operation: 'channel_updated',
                  type: 'channel',
                  id: channelId,
                  driveId: channel.driveId,
                  lastMessageAt: newMessage?.createdAt?.toISOString() || new Date().toISOString(),
                  lastMessagePreview: messagePreview,
                  lastMessageSender: senderIdentity.senderName,
                })
              );

            await Promise.all(broadcastPromises);
          }
        } catch (error) {
          channelLogger.error('Failed to broadcast inbox update for AI message', error instanceof Error ? error : undefined);
        }

        return {
          success: true,
          messageId: createdMessage.id,
          channelId,
          channelTitle: channel.title,
          senderName: senderIdentity.senderName,
          senderType: senderIdentity.senderType,
          messagePreview: content.trim(),
          message: `Successfully sent message to channel "${channel.title}"`,
          summary: `Posted to #${channel.title} as ${senderIdentity.senderName} (${senderIdentity.senderType === 'global_assistant' ? 'global assistant' : 'agent'})`,
        };
      } catch (error) {
        channelLogger.error('Failed to send channel message', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          channelId: maskIdentifier(channelId),
        });
        throw new Error(`Failed to send channel message: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};
