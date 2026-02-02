import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  createAIProvider,
  isProviderError,
  buildTimestampSystemPrompt,
} from '@/lib/ai/core';
import {
  db,
  taskItems,
  directMessages,
  dmConversations,
  pages,
  driveMembers,
  activityLogs,
  users,
  pulseSummaries,
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
} from '@pagespace/db';
import type { PulseSummaryContextData } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const };

// System prompt for generating pulse summaries
const PULSE_SYSTEM_PROMPT = `You are a helpful workspace assistant generating a brief, personalized activity summary for a user's dashboard.

Your task is to create a SHORT, conversational pulse summary (2-4 sentences max) that helps the user understand:
- What's happened since they last checked in
- What needs their attention
- Any notable activity from collaborators

Guidelines:
- Be concise and friendly, like a helpful colleague giving a quick update
- Prioritize actionable information (overdue tasks, unread messages)
- Mention specific page titles or task names when relevant
- Use natural language, not bullet points
- Include a brief greeting appropriate to the time of day if provided
- If there's not much activity, acknowledge that briefly

Do NOT:
- Use excessive exclamation marks or emojis
- Be overly enthusiastic or salesy
- List every single activity
- Include generic filler content
- Mention exact numbers unless they're significant`;

export async function POST(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    // Get user info for personalization
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const userName = user?.name || user?.email?.split('@')[0] || 'there';

    // Gather context data
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

    // Week boundaries (Sunday start)
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - dayOfWeek);

    // Get user's drives
    const userDrives = await db
      .select({ driveId: driveMembers.driveId })
      .from(driveMembers)
      .where(eq(driveMembers.userId, userId));
    const driveIds = userDrives.map(d => d.driveId);

    // Task data
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

    // Recently completed tasks (last 24h)
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

      // Get recent unread message senders
      if (unreadCount > 0) {
        const unreadMessages = await db
          .select({
            senderId: directMessages.senderId,
            senderName: users.name,
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
          .limit(5);

        const uniqueSenders = new Set<string>();
        unreadMessages.forEach(m => {
          if (m.senderName) uniqueSenders.add(m.senderName);
        });
        recentSenders.push(...Array.from(uniqueSenders).slice(0, 3));
      }
    }

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

      // Recent page updates (by others)
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

    // Recent activity by collaborators
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
      },
      messages: {
        unreadCount,
        recentSenders,
      },
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

    // Determine greeting based on time of day
    const hour = now.getHours();
    let timeOfDay = 'day';
    if (hour < 12) timeOfDay = 'morning';
    else if (hour < 17) timeOfDay = 'afternoon';
    else timeOfDay = 'evening';

    // Build prompt for AI
    const userPrompt = `Generate a brief pulse summary for ${userName}.

Time: ${timeOfDay}

Context data:
${JSON.stringify(contextData, null, 2)}

Create a 2-4 sentence summary that highlights the most important information. Start with a brief, appropriate greeting.`;

    // Get AI provider (use standard model)
    const providerResult = await createAIProvider(userId, {
      selectedProvider: 'pagespace',
      selectedModel: 'standard',
    });

    if (isProviderError(providerResult)) {
      loggers.api.error('Failed to create AI provider for pulse', { error: providerResult.error });
      return NextResponse.json({ error: providerResult.error }, { status: providerResult.status });
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

    // Extract greeting if present (first sentence ending with !)
    let greeting: string | null = null;
    const greetingMatch = summary.match(/^([^.!?]+[!])\s*/);
    if (greetingMatch) {
      greeting = greetingMatch[1];
    }

    // Save to database
    const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000); // Expires in 2 hours
    const [savedSummary] = await db.insert(pulseSummaries).values({
      userId,
      summary,
      greeting,
      type: 'on_demand',
      contextData,
      aiProvider: providerResult.provider,
      aiModel: providerResult.modelName,
      periodStart: twoHoursAgo,
      periodEnd: now,
      generatedAt: now,
      expiresAt,
    }).returning();

    loggers.api.info('Generated pulse summary', {
      userId,
      summaryId: savedSummary.id,
      summaryLength: summary.length,
    });

    return NextResponse.json({
      id: savedSummary.id,
      summary,
      greeting,
      generatedAt: savedSummary.generatedAt,
      expiresAt: savedSummary.expiresAt,
      contextData,
    });

  } catch (error) {
    loggers.api.error('Error generating pulse summary:', error as Error);
    return NextResponse.json({ error: 'Failed to generate pulse summary' }, { status: 500 });
  }
}
