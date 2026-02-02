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
  drives,
  driveMembers,
  activityLogs,
  pulseSummaries,
  userMentions,
  pagePermissions,
  chatMessages,
  eq,
  and,
  or,
  lt,
  gte,
  ne,
  desc,
  inArray,
  isNull,
} from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

// This endpoint should be protected by a cron secret in production
const CRON_SECRET = process.env.CRON_SECRET;

// System prompt for generating pulse summaries
const PULSE_SYSTEM_PROMPT = `You are a friendly workspace companion who deeply understands the user's workspace and can give them genuinely useful, contextual updates.

You have access to RICH context about what's happening - actual page content, full messages, aggregated activity patterns, and more. Use this to give MEANINGFUL updates, not robotic summaries.

YOUR JOB:
- Tell them something they'd actually want to know
- Be specific about WHAT people are working on (you can see page content!)
- If someone messaged them, tell them what the message actually says
- Notice interesting patterns: "Noah's been really focused on the roadmap today"
- Connect the dots: "Sarah's updates to the Budget doc might be related to what Alex was asking about"

TONE:
- Like a thoughtful colleague who's been paying attention
- Natural and conversational
- Warm but not fake-enthusiastic
- If it's quiet, just say hi - don't manufacture activity

EXAMPLES OF GREAT SUMMARIES:
- "Morning! Noah's been heads-down on the Product Roadmap - he's added a whole new Q2 section with timeline estimates. Also, Sarah left you a DM asking if you've reviewed the pricing changes yet."
- "Hey! Looks like the team's been active on Sprint Planning today. Alex added some notes about the API migration, and there's a thread going in the comments about the timeline."
- "Afternoon! Things are pretty quiet. Sarah shared the Budget Analysis with you earlier if you want to take a look."
- "Evening! Quick catch-up: Noah finished that Q4 Projections doc you were both discussing. The final revenue numbers look different from the draft."

WHAT TO AVOID:
- "You have X tasks and Y pages were updated" - useless without specifics
- "Activity occurred in your workspace" - vague nonsense
- Listing every single thing that happened - pick what matters
- Admitting you don't have information - just focus on what you DO know

Keep it to 2-4 natural sentences. Be genuinely helpful.`;

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

  // Time windows
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Get user's drives
  const userDrives = await db
    .select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .where(eq(driveMembers.userId, userId));
  const driveIds = userDrives.map(d => d.driveId);

  // ========================================
  // 1. WORKSPACE CONTEXT - Drives and team members
  // ========================================
  const driveDetails = driveIds.length > 0 ? await db
    .select({
      id: drives.id,
      name: drives.name,
      description: drives.drivePrompt,
    })
    .from(drives)
    .where(and(
      inArray(drives.id, driveIds),
      eq(drives.isTrashed, false)
    )) : [];

  // Get team members for each drive
  const teamMembers = driveIds.length > 0 ? await db
    .select({
      driveId: driveMembers.driveId,
      userName: users.name,
      userEmail: users.email,
    })
    .from(driveMembers)
    .leftJoin(users, eq(users.id, driveMembers.userId))
    .where(and(
      inArray(driveMembers.driveId, driveIds),
      ne(driveMembers.userId, userId)
    )) : [];

  const teamByDrive = teamMembers.reduce((acc, m) => {
    if (!acc[m.driveId]) acc[m.driveId] = [];
    acc[m.driveId].push(m.userName || m.userEmail?.split('@')[0] || 'Unknown');
    return acc;
  }, {} as Record<string, string[]>);

  // ========================================
  // 2. AGGREGATED ACTIVITY
  // ========================================
  const rawActivity = driveIds.length > 0 ? await db
    .select({
      actorId: activityLogs.userId,
      actorName: activityLogs.actorDisplayName,
      operation: activityLogs.operation,
      resourceType: activityLogs.resourceType,
      resourceId: activityLogs.resourceId,
      resourceTitle: activityLogs.resourceTitle,
      driveId: activityLogs.driveId,
      timestamp: activityLogs.timestamp,
    })
    .from(activityLogs)
    .where(
      and(
        inArray(activityLogs.driveId, driveIds),
        gte(activityLogs.timestamp, fortyEightHoursAgo)
      )
    )
    .orderBy(desc(activityLogs.timestamp))
    .limit(200) : [];

  const activityByPersonPage: Record<string, {
    person: string;
    pageId: string;
    pageTitle: string;
    driveName: string;
    editCount: number;
    lastEdit: Date;
    operations: Set<string>;
    isOwnActivity: boolean;
  }> = {};

  rawActivity.forEach(a => {
    if (a.resourceType !== 'page' || !a.resourceId) return;
    const key = `${a.actorId}-${a.resourceId}`;
    const driveName = driveDetails.find(d => d.id === a.driveId)?.name || 'Unknown';

    if (!activityByPersonPage[key]) {
      activityByPersonPage[key] = {
        person: a.actorName || 'Someone',
        pageId: a.resourceId,
        pageTitle: a.resourceTitle || 'Untitled',
        driveName,
        editCount: 0,
        lastEdit: a.timestamp,
        operations: new Set(),
        isOwnActivity: a.actorId === userId,
      };
    }
    activityByPersonPage[key].editCount++;
    activityByPersonPage[key].operations.add(a.operation);
    if (a.timestamp > activityByPersonPage[key].lastEdit) {
      activityByPersonPage[key].lastEdit = a.timestamp;
    }
  });

  const aggregatedActivity = Object.values(activityByPersonPage)
    .sort((a, b) => b.editCount - a.editCount)
    .slice(0, 15);

  const othersActivity = aggregatedActivity.filter(a => !a.isOwnActivity);
  const ownActivity = aggregatedActivity.filter(a => a.isOwnActivity);

  // ========================================
  // 3. PAGE CONTENT
  // ========================================
  const activePageIds = othersActivity.slice(0, 8).map(a => a.pageId);

  const pageContents = activePageIds.length > 0 ? await db
    .select({
      id: pages.id,
      title: pages.title,
      content: pages.content,
      type: pages.type,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(and(
      inArray(pages.id, activePageIds),
      eq(pages.isTrashed, false)
    )) : [];

  const pageSnippets = pageContents.map(p => ({
    id: p.id,
    title: p.title,
    type: p.type,
    contentPreview: p.content?.substring(0, 1500) || '',
    updatedAt: p.updatedAt,
  }));

  // ========================================
  // 4. DIRECT MESSAGES
  // ========================================
  const userConversations = await db
    .select({ id: dmConversations.id })
    .from(dmConversations)
    .where(
      or(
        eq(dmConversations.participant1Id, userId),
        eq(dmConversations.participant2Id, userId)
      )
    );

  let unreadDMs: { from: string; content: string; sentAt: Date }[] = [];

  if (userConversations.length > 0) {
    const conversationIds = userConversations.map(c => c.id);
    const unreadMessagesList = await db
      .select({
        senderName: users.name,
        senderEmail: users.email,
        content: directMessages.content,
        createdAt: directMessages.createdAt,
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
      .limit(10);

    unreadDMs = unreadMessagesList.map(m => ({
      from: m.senderName || m.senderEmail?.split('@')[0] || 'Someone',
      content: m.content || '',
      sentAt: m.createdAt,
    }));
  }

  // ========================================
  // 5. PAGE CHAT MESSAGES
  // ========================================
  const recentPageChats = driveIds.length > 0 ? await db
    .select({
      pageId: chatMessages.pageId,
      pageTitle: pages.title,
      senderName: users.name,
      senderEmail: users.email,
      content: chatMessages.content,
      role: chatMessages.role,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .leftJoin(pages, eq(pages.id, chatMessages.pageId))
    .leftJoin(users, eq(users.id, chatMessages.userId))
    .where(
      and(
        inArray(pages.driveId, driveIds),
        eq(chatMessages.role, 'user'),
        eq(chatMessages.isActive, true),
        gte(chatMessages.createdAt, twentyFourHoursAgo),
        ne(chatMessages.userId, userId)
      )
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(15) : [];

  const chatsByPage = recentPageChats.reduce((acc, chat) => {
    const key = chat.pageId;
    if (!acc[key]) {
      acc[key] = {
        pageTitle: chat.pageTitle || 'Untitled',
        messages: [],
      };
    }
    acc[key].messages.push({
      from: chat.senderName || chat.senderEmail?.split('@')[0] || 'Someone',
      content: chat.content?.substring(0, 500) || '',
      sentAt: chat.createdAt,
    });
    return acc;
  }, {} as Record<string, { pageTitle: string; messages: { from: string; content: string; sentAt: Date }[] }>);

  // ========================================
  // 6. MENTIONS & SHARES
  // ========================================
  const recentMentions = await db
    .select({
      mentionedByName: users.name,
      pageTitle: pages.title,
      createdAt: userMentions.createdAt,
    })
    .from(userMentions)
    .leftJoin(users, eq(users.id, userMentions.mentionedByUserId))
    .leftJoin(pages, eq(pages.id, userMentions.sourcePageId))
    .where(
      and(
        eq(userMentions.targetUserId, userId),
        gte(userMentions.createdAt, fortyEightHoursAgo)
      )
    )
    .orderBy(desc(userMentions.createdAt))
    .limit(5);

  const recentShares = await db
    .select({
      pageTitle: pages.title,
      pageContent: pages.content,
      sharedByName: users.name,
      grantedAt: pagePermissions.grantedAt,
    })
    .from(pagePermissions)
    .leftJoin(pages, eq(pages.id, pagePermissions.pageId))
    .leftJoin(users, eq(users.id, pagePermissions.grantedBy))
    .where(
      and(
        eq(pagePermissions.userId, userId),
        gte(pagePermissions.grantedAt, fortyEightHoursAgo)
      )
    )
    .orderBy(desc(pagePermissions.grantedAt))
    .limit(5);

  // ========================================
  // 7. TASKS
  // ========================================
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

  const overdueTasks = await db
    .select({
      title: taskItems.title,
      priority: taskItems.priority,
      dueDate: taskItems.dueDate,
    })
    .from(taskItems)
    .where(
      and(
        or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
        ne(taskItems.status, 'completed'),
        lt(taskItems.dueDate, startOfToday)
      )
    )
    .orderBy(desc(taskItems.priority), taskItems.dueDate)
    .limit(10);

  const todayTasks = await db
    .select({
      title: taskItems.title,
      priority: taskItems.priority,
    })
    .from(taskItems)
    .where(
      and(
        or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
        ne(taskItems.status, 'completed'),
        gte(taskItems.dueDate, startOfToday),
        lt(taskItems.dueDate, endOfToday)
      )
    )
    .orderBy(desc(taskItems.priority))
    .limit(10);

  const recentlyCompletedTasks = await db
    .select({ title: taskItems.title, completedAt: taskItems.completedAt })
    .from(taskItems)
    .where(
      and(
        or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
        eq(taskItems.status, 'completed'),
        gte(taskItems.completedAt, twentyFourHoursAgo)
      )
    )
    .orderBy(desc(taskItems.completedAt))
    .limit(5);

  // ========================================
  // BUILD THE RICH CONTEXT OBJECT
  // ========================================
  const contextData = {
    userName,
    workspace: {
      drives: driveDetails.map(d => ({
        name: d.name,
        description: d.description || undefined,
        teamMembers: teamByDrive[d.id] || [],
      })),
    },
    colleagueActivity: othersActivity.map(a => ({
      person: a.person,
      page: a.pageTitle,
      drive: a.driveName,
      editCount: a.editCount,
      actions: Array.from(a.operations),
      lastActive: a.lastEdit.toISOString(),
    })),
    activePageContent: pageSnippets.map(p => ({
      title: p.title,
      type: p.type,
      preview: p.contentPreview,
    })),
    directMessages: unreadDMs.map(m => ({
      from: m.from,
      message: m.content,
      sentAt: m.sentAt.toISOString(),
    })),
    pageDiscussions: Object.entries(chatsByPage).map(([_, data]) => ({
      page: data.pageTitle,
      messages: data.messages.map(m => ({
        from: m.from,
        message: m.content,
        sentAt: m.sentAt.toISOString(),
      })),
    })),
    mentions: recentMentions.map(m => ({
      by: m.mentionedByName || 'Someone',
      inPage: m.pageTitle || 'a page',
      when: m.createdAt.toISOString(),
    })),
    sharedWithYou: recentShares.map(s => ({
      page: s.pageTitle || 'a page',
      by: s.sharedByName || 'Someone',
      preview: s.pageContent?.substring(0, 500) || '',
      when: s.grantedAt?.toISOString(),
    })),
    tasks: {
      overdue: overdueTasks.map(t => ({
        title: t.title,
        priority: t.priority,
        dueDate: t.dueDate?.toISOString(),
      })),
      dueToday: todayTasks.map(t => ({
        title: t.title,
        priority: t.priority,
      })),
      recentlyCompleted: recentlyCompletedTasks.map(t => ({
        title: t.title,
        completedAt: t.completedAt?.toISOString(),
      })),
    },
    ownRecentActivity: ownActivity.slice(0, 5).map(a => ({
      page: a.pageTitle,
      editCount: a.editCount,
      lastActive: a.lastEdit.toISOString(),
    })),
  };

  // Determine time of day
  const hour = now.getHours();
  let timeOfDay = 'day';
  if (hour < 12) timeOfDay = 'morning';
  else if (hour < 17) timeOfDay = 'afternoon';
  else timeOfDay = 'evening';

  // Build prompt
  const userPrompt = `Generate a personalized workspace update for ${userName}.

Time: ${timeOfDay}
Current time: ${now.toISOString()}

Here's the full context of what's happening in their workspace:

${JSON.stringify(contextData, null, 2)}

Based on this rich context, write a natural 2-4 sentence update that tells them something genuinely useful. You can see actual page content, full message text, and aggregated activity patterns - use this to be specific and helpful.

Focus on what would be most relevant to them right now. If colleagues have been active, tell them WHAT those colleagues are working on (you can see the content!). If there are messages, summarize what they actually say. If it's quiet, just give a warm greeting.`;

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
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  await db.insert(pulseSummaries).values({
    userId,
    summary,
    greeting,
    type: 'scheduled',
    contextData: {
      workspace: contextData.workspace,
      workingOn: contextData.colleagueActivity.slice(0, 5).map(a => ({
        person: a.person,
        page: a.page,
        driveName: a.drive,
        action: a.actions[0] || 'update',
      })),
      tasks: {
        dueToday: contextData.tasks.dueToday.length,
        dueThisWeek: 0,
        overdue: contextData.tasks.overdue.length,
        completedThisWeek: contextData.tasks.recentlyCompleted.length,
        recentlyCompleted: contextData.tasks.recentlyCompleted.map(t => t.title).filter((t): t is string => !!t),
        upcoming: contextData.tasks.dueToday.map(t => t.title).filter((t): t is string => !!t),
        overdueItems: contextData.tasks.overdue.map(t => ({ title: t.title || '', priority: t.priority })),
      },
      messages: {
        unreadCount: unreadDMs.length,
        recentSenders: [...new Set(unreadDMs.map(m => m.from))],
        recentMessages: unreadDMs.slice(0, 5).map(m => ({ from: m.from, preview: m.content.substring(0, 300) })),
      },
      mentions: contextData.mentions.map(m => ({ by: m.by, inPage: m.inPage })),
      notifications: [],
      sharedWithYou: contextData.sharedWithYou.map(s => ({ page: s.page, by: s.by })),
      contentChanges: contextData.colleagueActivity.slice(0, 5).map(a => ({ page: a.page, by: a.person })),
      pages: {
        updatedToday: contextData.colleagueActivity.filter(a => new Date(a.lastActive) >= startOfToday).length,
        updatedThisWeek: contextData.colleagueActivity.length,
        recentlyUpdated: contextData.colleagueActivity.slice(0, 5).map(a => ({ title: a.page, updatedBy: a.person })),
      },
      activity: {
        collaboratorNames: [...new Set(contextData.colleagueActivity.map(a => a.person))],
        recentOperations: contextData.colleagueActivity.slice(0, 5).map(a => `${a.person} edited "${a.page}" (${a.editCount} times)`),
      },
    },
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
