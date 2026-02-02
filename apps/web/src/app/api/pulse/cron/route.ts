import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import {
  createAIProvider,
  isProviderError,
  buildTimestampSystemPrompt,
} from '@/lib/ai/core';
import {
  db,
  sessions,
  users,
  taskItems,
  directMessages,
  dmConversations,
  pages,
  driveMembers,
  activityLogs,
  pulseSummaries,
  userMentions,
  notifications,
  pagePermissions,
  eq,
  and,
  or,
  lt,
  gte,
  ne,
  desc,
  sql,
  count,
  inArray,
  isNull,
} from '@pagespace/db';
import type { PulseSummaryContextData } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

// This endpoint should be protected by a cron secret in production
const CRON_SECRET = process.env.CRON_SECRET;

// System prompt for generating pulse summaries
const PULSE_SYSTEM_PROMPT = `You are a workspace assistant generating a brief, personalized activity summary.

Create a SHORT summary (2-4 sentences) telling the user what specifically needs attention.

RULES:
- ALWAYS name specific tasks, pages, or people - never just counts
- If there are overdue tasks, name them: "'Finalize budget' and 'Review proposal' are overdue"
- High-priority overdue tasks should be mentioned first
- For messages, summarize content: "Noah asked about the pricing update" not "Noah messaged you"
- For mentions: "Sarah mentioned you in Q1 Planning"
- For shares: "Noah shared 'Product Roadmap' with you"
- For content changes: Describe WHAT changed: "Sarah updated Product Pricing" with who made the change
- NEVER mention categories with zero items - omit them entirely
- NEVER say "no messages", "nothing new", or similar - just skip empty categories
- Be direct and specific, like a colleague giving a quick heads-up
- Include a brief time-appropriate greeting

PRIORITY ORDER (mention most important first):
1. Overdue high-priority tasks
2. Pages shared with you / mentions
3. Meaningful content changes by collaborators
4. Unread messages with context

Do NOT:
- Use excessive exclamation marks or emojis
- Be overly enthusiastic
- List every single activity
- Include generic filler content
- Mention counts without naming the items`;

export async function POST(req: Request) {
  // Require cron secret - fail-closed for security
  if (!CRON_SECRET) {
    return NextResponse.json(
      { error: 'Cron endpoint not configured' },
      { status: 503 }
    );
  }
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

    // Find active users (users with a session activity in the last 4 hours)
    // This targets users who are likely to see the summary soon
    const activeSessionUsers = await db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(
        and(
          eq(sessions.type, 'user'),
          isNull(sessions.revokedAt),
          gte(sessions.lastUsedAt, fourHoursAgo)
        )
      )
      .groupBy(sessions.userId);

    const activeUserIds = activeSessionUsers.map(s => s.userId);

    if (activeUserIds.length === 0) {
      loggers.api.info('Pulse cron: No active users found');
      return NextResponse.json({ message: 'No active users', generated: 0 });
    }

    // Check which users need a new summary (no summary in last 2 hours)
    const usersWithRecentSummaries = await db
      .select({ userId: pulseSummaries.userId })
      .from(pulseSummaries)
      .where(
        and(
          inArray(pulseSummaries.userId, activeUserIds),
          gte(pulseSummaries.generatedAt, twoHoursAgo)
        )
      )
      .groupBy(pulseSummaries.userId);

    const usersWithRecentSummaryIds = new Set(usersWithRecentSummaries.map(u => u.userId));
    const usersNeedingSummary = activeUserIds.filter(id => !usersWithRecentSummaryIds.has(id));

    if (usersNeedingSummary.length === 0) {
      loggers.api.info('Pulse cron: All active users have recent summaries');
      return NextResponse.json({ message: 'All users up to date', generated: 0 });
    }

    loggers.api.info(`Pulse cron: Generating summaries for ${usersNeedingSummary.length} users`);

    let generated = 0;
    const errors: string[] = [];

    // Generate summaries for each user (with rate limiting)
    for (const userId of usersNeedingSummary) {
      try {
        await generatePulseForUser(userId, now);
        generated++;

        // Add a small delay between users to avoid overwhelming the AI provider
        if (usersNeedingSummary.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        loggers.api.error(`Pulse cron: Failed for user ${userId}`, { error: errorMsg });
        errors.push(`${userId}: ${errorMsg}`);
      }
    }

    loggers.api.info(`Pulse cron: Complete. Generated ${generated}/${usersNeedingSummary.length} summaries`);

    return NextResponse.json({
      message: 'Pulse generation complete',
      generated,
      total: usersNeedingSummary.length,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (error) {
    loggers.api.error('Pulse cron error:', error as Error);
    return NextResponse.json({ error: 'Cron job failed' }, { status: 500 });
  }
}

async function generatePulseForUser(userId: string, now: Date): Promise<void> {
  // Get user info
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new Error('User not found');

  const userName = user.name || user.email?.split('@')[0] || 'there';
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

  // Week boundaries
  const dayOfWeek = now.getDay();
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - dayOfWeek);

  // Get user's drives
  const userDrives = await db
    .select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .where(eq(driveMembers.userId, userId));
  const driveIds = userDrives.map(d => d.driveId);

  // Gather task data
  const [tasksOverdue] = await db
    .select({ count: count() })
    .from(taskItems)
    .where(
      and(
        or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
        ne(taskItems.status, 'completed'),
        lt(taskItems.dueDate, startOfToday)
      )
    );

  // Get overdue task details with priority
  const overdueTasksList = await db
    .select({ title: taskItems.title, priority: taskItems.priority })
    .from(taskItems)
    .where(
      and(
        or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
        ne(taskItems.status, 'completed'),
        lt(taskItems.dueDate, startOfToday)
      )
    )
    .orderBy(desc(taskItems.priority), taskItems.dueDate)
    .limit(5);

  const [tasksDueToday] = await db
    .select({ count: count() })
    .from(taskItems)
    .where(
      and(
        or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
        ne(taskItems.status, 'completed'),
        gte(taskItems.dueDate, startOfToday),
        lt(taskItems.dueDate, endOfToday)
      )
    );

  const [tasksDueThisWeek] = await db
    .select({ count: count() })
    .from(taskItems)
    .where(
      and(
        or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
        ne(taskItems.status, 'completed'),
        gte(taskItems.dueDate, startOfToday),
        lt(taskItems.dueDate, new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000))
      )
    );

  const [tasksCompletedThisWeek] = await db
    .select({ count: count() })
    .from(taskItems)
    .where(
      and(
        or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
        eq(taskItems.status, 'completed'),
        gte(taskItems.completedAt, startOfWeek)
      )
    );

  // Recently completed tasks
  const recentlyCompletedTasks = await db
    .select({ title: taskItems.title })
    .from(taskItems)
    .where(
      and(
        or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
        eq(taskItems.status, 'completed'),
        gte(taskItems.completedAt, new Date(now.getTime() - 24 * 60 * 60 * 1000))
      )
    )
    .orderBy(desc(taskItems.completedAt))
    .limit(3);

  // Upcoming tasks
  const upcomingTasks = await db
    .select({ title: taskItems.title })
    .from(taskItems)
    .where(
      and(
        or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
        ne(taskItems.status, 'completed'),
        gte(taskItems.dueDate, startOfToday)
      )
    )
    .orderBy(taskItems.dueDate)
    .limit(3);

  // Unread messages
  const userConversations = await db
    .select({ id: dmConversations.id })
    .from(dmConversations)
    .where(
      or(
        eq(dmConversations.participant1Id, userId),
        eq(dmConversations.participant2Id, userId)
      )
    );

  let unreadCount = 0;
  const recentSenders: string[] = [];
  const recentMessages: { from: string; preview?: string }[] = [];

  if (userConversations.length > 0) {
    const conversationIds = userConversations.map(c => c.id);
    const [unreadResult] = await db
      .select({ count: count() })
      .from(directMessages)
      .where(
        and(
          inArray(directMessages.conversationId, conversationIds),
          ne(directMessages.senderId, userId),
          eq(directMessages.isRead, false)
        )
      );
    unreadCount = unreadResult?.count ?? 0;

    // Get recent unread messages with content preview
    if (unreadCount > 0) {
      const unreadMessagesList = await db
        .select({
          senderId: directMessages.senderId,
          senderName: users.name,
          content: directMessages.content,
        })
        .from(directMessages)
        .leftJoin(users, eq(users.id, directMessages.senderId))
        .where(
          and(
            inArray(directMessages.conversationId, conversationIds),
            ne(directMessages.senderId, userId),
            eq(directMessages.isRead, false)
          )
        )
        .orderBy(desc(directMessages.createdAt))
        .limit(3);

      const uniqueSenders = new Set<string>();
      unreadMessagesList.forEach(m => {
        if (m.senderName) uniqueSenders.add(m.senderName);
        recentMessages.push({
          from: m.senderName || 'Someone',
          preview: m.content?.substring(0, 100),
        });
      });
      recentSenders.push(...Array.from(uniqueSenders).slice(0, 3));
    }
  }

  // Get recent @mentions of the user
  const recentMentions = await db
    .select({
      mentionedByName: users.name,
      pageTitle: pages.title,
    })
    .from(userMentions)
    .leftJoin(users, eq(users.id, userMentions.mentionedByUserId))
    .leftJoin(pages, eq(pages.id, userMentions.sourcePageId))
    .where(
      and(
        eq(userMentions.targetUserId, userId),
        gte(userMentions.createdAt, twoHoursAgo)
      )
    )
    .orderBy(desc(userMentions.createdAt))
    .limit(3);

  // Get unread notifications
  const unreadNotifications = await db
    .select({
      type: notifications.type,
      triggeredByName: users.name,
      pageTitle: pages.title,
    })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.triggeredByUserId))
    .leftJoin(pages, eq(pages.id, notifications.pageId))
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.isRead, false)
      )
    )
    .orderBy(desc(notifications.createdAt))
    .limit(5);

  // Get pages recently shared with user
  const recentShares = await db
    .select({
      pageTitle: pages.title,
      sharedByName: users.name,
    })
    .from(pagePermissions)
    .leftJoin(pages, eq(pages.id, pagePermissions.pageId))
    .leftJoin(users, eq(users.id, pagePermissions.grantedBy))
    .where(
      and(
        eq(pagePermissions.userId, userId),
        gte(pagePermissions.grantedAt, twoHoursAgo)
      )
    )
    .orderBy(desc(pagePermissions.grantedAt))
    .limit(3);

  // Pages updated
  let pagesUpdatedToday = 0;
  let pagesUpdatedThisWeek = 0;
  const recentlyUpdatedPages: { title: string; updatedBy: string }[] = [];

  if (driveIds.length > 0) {
    const [todayResult] = await db
      .select({ count: count() })
      .from(pages)
      .where(
        and(
          inArray(pages.driveId, driveIds),
          eq(pages.isTrashed, false),
          gte(pages.updatedAt, startOfToday)
        )
      );
    pagesUpdatedToday = todayResult?.count ?? 0;

    const [weekResult] = await db
      .select({ count: count() })
      .from(pages)
      .where(
        and(
          inArray(pages.driveId, driveIds),
          eq(pages.isTrashed, false),
          gte(pages.updatedAt, startOfWeek)
        )
      );
    pagesUpdatedThisWeek = weekResult?.count ?? 0;

    // Recent page updates by others
    const recentUpdates = await db
      .select({
        pageTitle: pages.title,
        actorName: activityLogs.actorDisplayName,
      })
      .from(activityLogs)
      .leftJoin(pages, eq(pages.id, activityLogs.pageId))
      .where(
        and(
          inArray(activityLogs.driveId, driveIds),
          eq(activityLogs.operation, 'update'),
          eq(activityLogs.resourceType, 'page'),
          ne(activityLogs.userId, userId),
          gte(activityLogs.timestamp, twoHoursAgo)
        )
      )
      .orderBy(desc(activityLogs.timestamp))
      .limit(5);

    const seenPages = new Set<string>();
    recentUpdates.forEach(u => {
      if (u.pageTitle && !seenPages.has(u.pageTitle)) {
        seenPages.add(u.pageTitle);
        recentlyUpdatedPages.push({
          title: u.pageTitle,
          updatedBy: u.actorName || 'Someone',
        });
      }
    });
  }

  // Collaborator activity
  const collaboratorActivity = await db
    .select({
      actorName: activityLogs.actorDisplayName,
      operation: activityLogs.operation,
      resourceTitle: activityLogs.resourceTitle,
    })
    .from(activityLogs)
    .where(
      and(
        driveIds.length > 0 ? inArray(activityLogs.driveId, driveIds) : sql`false`,
        ne(activityLogs.userId, userId),
        gte(activityLogs.timestamp, twoHoursAgo)
      )
    )
    .orderBy(desc(activityLogs.timestamp))
    .limit(10);

  const collaboratorNames = new Set<string>();
  const recentOperations: string[] = [];
  collaboratorActivity.forEach(a => {
    if (a.actorName) collaboratorNames.add(a.actorName);
    if (a.resourceTitle && recentOperations.length < 3) {
      recentOperations.push(`${a.actorName || 'Someone'} ${a.operation}d "${a.resourceTitle}"`);
    }
  });

  // Build context data
  const contextData: PulseSummaryContextData = {
    tasks: {
      dueToday: tasksDueToday?.count ?? 0,
      dueThisWeek: tasksDueThisWeek?.count ?? 0,
      overdue: tasksOverdue?.count ?? 0,
      completedThisWeek: tasksCompletedThisWeek?.count ?? 0,
      recentlyCompleted: recentlyCompletedTasks.map(t => t.title).filter((t): t is string => !!t),
      upcoming: upcomingTasks.map(t => t.title).filter((t): t is string => !!t),
      overdueItems: overdueTasksList.map(t => ({
        title: t.title ?? '',
        priority: t.priority,
      })).filter(t => t.title),
    },
    messages: {
      unreadCount,
      recentSenders,
      recentMessages,
    },
    mentions: recentMentions.map(m => ({
      by: m.mentionedByName || 'Someone',
      inPage: m.pageTitle || 'a page',
    })),
    notifications: unreadNotifications.map(n => ({
      type: n.type,
      from: n.triggeredByName,
      page: n.pageTitle,
    })),
    sharedWithYou: recentShares.map(s => ({
      page: s.pageTitle || 'a page',
      by: s.sharedByName || 'Someone',
    })),
    contentChanges: recentlyUpdatedPages.slice(0, 3).map(p => ({
      page: p.title,
      by: p.updatedBy,
    })),
    pages: {
      updatedToday: pagesUpdatedToday,
      updatedThisWeek: pagesUpdatedThisWeek,
      recentlyUpdated: recentlyUpdatedPages.slice(0, 3),
    },
    activity: {
      collaboratorNames: Array.from(collaboratorNames).slice(0, 5),
      recentOperations: recentOperations.slice(0, 3),
    },
  };

  // Determine time of day
  const hour = now.getHours();
  let timeOfDay = 'day';
  if (hour < 12) timeOfDay = 'morning';
  else if (hour < 17) timeOfDay = 'afternoon';
  else timeOfDay = 'evening';

  // Build prompt
  const userPrompt = `Generate a brief pulse summary for ${userName}.

Time: ${timeOfDay}

Context data:
${JSON.stringify(contextData, null, 2)}

Create a 2-4 sentence summary that highlights the most important information. Start with a brief, appropriate greeting.`;

  // Get AI provider
  const providerResult = await createAIProvider(userId, {
    selectedProvider: 'pagespace',
    selectedModel: 'standard',
  });

  if (isProviderError(providerResult)) {
    throw new Error(providerResult.error);
  }

  // Generate summary
  const result = await generateText({
    model: providerResult.model,
    system: `${PULSE_SYSTEM_PROMPT}\n\n${buildTimestampSystemPrompt()}`,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.7,
    maxRetries: 3,
  });

  const summary = result.text.trim();

  // Extract greeting
  let greeting: string | null = null;
  const greetingMatch = summary.match(/^([^.!?]+[!])\s*/);
  if (greetingMatch) {
    greeting = greetingMatch[1];
  }

  // Save to database
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  await db.insert(pulseSummaries).values({
    userId,
    summary,
    greeting,
    type: 'scheduled',
    contextData,
    aiProvider: providerResult.provider,
    aiModel: providerResult.modelName,
    periodStart: twoHoursAgo,
    periodEnd: now,
    generatedAt: now,
    expiresAt,
  });

  loggers.api.info('Pulse cron: Generated summary for user', { userId });
}

// Also support GET for easy cron setup (some cron services only support GET)
export async function GET(req: Request) {
  return POST(req);
}
