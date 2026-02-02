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
  drives,
  driveMembers,
  activityLogs,
  users,
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
} from '@pagespace/db';
import type { PulseSummaryContextData } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const };

// System prompt for generating pulse summaries
const PULSE_SYSTEM_PROMPT = `You are a friendly workspace companion giving the user a natural, conversational update about their workspace.

Your job is to tell them something INTERESTING or USEFUL about what's happening - not give them a robotic status report.

TONE:
- Like a thoughtful colleague catching you up over coffee
- Natural and conversational, not a bullet-point readout
- If it's a quiet day, just say hi warmly - don't manufacture urgency
- If there's interesting activity, share what's actually happening

WHAT TO FOCUS ON (pick what's most interesting, not everything):
- What are people actually working on? "Noah's been making progress on the Product Roadmap"
- Interesting updates: "Sarah added some new ideas to the Q1 Planning doc"
- Meaningful messages: If someone asked a specific question, mention it
- Recent shares/mentions: "Alex shared the Budget proposal with you"
- If someone left you a message, summarize WHAT they said, not just that they messaged

WHAT TO AVOID:
- Robotic stat dumps: "You have 5 tasks, 26 pages updated" - USELESS
- Vague summaries: "activity has occurred in your workspace" - BORING
- Task-list mentality: Don't treat this as a to-do reminder
- Counts without context: Never say "X tasks" or "X pages" without specifics
- Filler when there's nothing: If it's quiet, a simple warm greeting is fine

EXAMPLES OF GOOD SUMMARIES:
- "Hey! Noah's been working on the Product Roadmap this morning - looks like he added the Q2 timeline. Sarah also dropped some comments on your Budget doc."
- "Good afternoon! Alex shared the Marketing Brief with you, and it looks pretty comprehensive. Also, Sarah was asking about the launch date in your DMs."
- "Morning! Things are quiet right now. The team was active yesterday on the Sprint Planning doc if you want to catch up."

EXAMPLES OF BAD SUMMARIES:
- "Good morning. You have 3 tasks due today and 12 pages were updated this week." (robotic, no context)
- "Evening, Jonathan. Activity has occurred in your drives." (vague, useless)
- "You've completed 5 tasks this week, though no specific details were provided." (never admit lack of context - just omit)

Keep it to 2-3 natural sentences. Start with a brief, time-appropriate greeting.`;

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

    // Get user's drives with full context
    const userDrives = await db
      .select({ driveId: driveMembers.driveId })
      .from(driveMembers)
      .where(eq(driveMembers.userId, userId));
    const driveIds = userDrives.map(d => d.driveId);

    // Get drive details for workspace context
    const driveDetails = driveIds.length > 0 ? await db
      .select({
        id: drives.id,
        name: drives.name,
        description: drives.drivePrompt, // Can contain project description
      })
      .from(drives)
      .where(and(
        inArray(drives.id, driveIds),
        eq(drives.isTrashed, false)
      )) : [];

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
            preview: m.content?.substring(0, 300), // Longer preview for context
          });
        });
        recentSenders.push(...Array.from(uniqueSenders).slice(0, 5));
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

    // Extended time window for "what you missed" context (24 hours)
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Recent activity by collaborators - get more detail about what's happening
    const collaboratorActivity = await db
      .select({
        actorName: activityLogs.actorDisplayName,
        operation: activityLogs.operation,
        resourceType: activityLogs.resourceType,
        resourceTitle: activityLogs.resourceTitle,
        driveId: activityLogs.driveId,
        timestamp: activityLogs.timestamp,
      })
      .from(activityLogs)
      .where(
        and(
          driveIds.length > 0 ? inArray(activityLogs.driveId, driveIds) : sql`false`,
          ne(activityLogs.userId, userId),
          gte(activityLogs.timestamp, twentyFourHoursAgo)
        )
      )
      .orderBy(desc(activityLogs.timestamp))
      .limit(20);

    // Build rich activity summaries - group by person and what they're working on
    const collaboratorNames = new Set<string>();
    const recentOperations: string[] = [];
    const workingOn: { person: string; page: string; driveName?: string; action: string }[] = [];

    collaboratorActivity.forEach(a => {
      if (a.actorName) collaboratorNames.add(a.actorName);
      if (a.resourceTitle && a.resourceType === 'page') {
        const driveName = driveDetails.find(d => d.id === a.driveId)?.name;
        workingOn.push({
          person: a.actorName || 'Someone',
          page: a.resourceTitle,
          driveName,
          action: a.operation,
        });
      }
      if (a.resourceTitle && recentOperations.length < 5) {
        recentOperations.push(`${a.actorName || 'Someone'} ${a.operation}d "${a.resourceTitle}"`);
      }
    });

    // Dedupe and limit workingOn to most relevant
    const uniqueWorkingOn = workingOn.reduce((acc, curr) => {
      const key = `${curr.person}-${curr.page}`;
      if (!acc.some(x => `${x.person}-${x.page}` === key)) {
        acc.push(curr);
      }
      return acc;
    }, [] as typeof workingOn).slice(0, 5);

    // Build context data with rich workspace context
    const contextData: PulseSummaryContextData = {
      // Workspace context - what projects/drives exist
      workspace: {
        drives: driveDetails.map(d => ({
          name: d.name,
          description: d.description?.substring(0, 200) || undefined,
        })),
      },
      // What people are actively working on (most valuable context)
      workingOn: uniqueWorkingOn,
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
      contentChanges: recentlyUpdatedPages.slice(0, 5).map(p => ({
        page: p.title,
        by: p.updatedBy,
      })),
      pages: {
        updatedToday: pagesUpdatedToday,
        updatedThisWeek: pagesUpdatedThisWeek,
        recentlyUpdated: recentlyUpdatedPages.slice(0, 5),
      },
      activity: {
        collaboratorNames: Array.from(collaboratorNames).slice(0, 8),
        recentOperations: recentOperations.slice(0, 5),
      },
    };

    // Determine greeting based on time of day
    const hour = now.getHours();
    let timeOfDay = 'day';
    if (hour < 12) timeOfDay = 'morning';
    else if (hour < 17) timeOfDay = 'afternoon';
    else timeOfDay = 'evening';

    // Build prompt for AI - focus on what's interesting, not a data dump
    const userPrompt = `Generate a friendly workspace update for ${userName}.

Time of day: ${timeOfDay}

Here's what's been happening in their workspace:
${JSON.stringify(contextData, null, 2)}

Write a natural 2-3 sentence update. Focus on what's INTERESTING - who's working on what, any messages that need attention, or things that might be helpful to know. If nothing much is happening, just give a warm greeting. Don't list everything - pick the 1-2 most relevant things.`;

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
