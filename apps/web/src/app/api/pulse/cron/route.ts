import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import {
  createAIProvider,
  isProviderError,
  buildTimestampSystemPrompt,
  getUserTimeOfDay,
  getStartOfTodayInTimezone,
  normalizeTimezone,
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
import {
  groupActivitiesForDiff,
  resolveStackedVersionContent,
  generateDiffsWithinBudget,
  calculateDiffBudget,
  type ActivityForDiff,
  type ActivityDiffGroup,
  type DiffRequest,
  type StackedDiff,
} from '@pagespace/lib/content';
import { readPageContent, loggers } from '@pagespace/lib/server';
import { validateCronRequest } from '@/lib/auth/cron-auth';

// System prompt for generating pulse summaries
const PULSE_SYSTEM_PROMPT = `You're a thoughtful workspace companion - like a colleague who sits nearby and notices things. You have deep awareness of what's happening in the user's workspace, but you're NOT a status reporter.

YOUR PERSONALITY:
- Warm, observant, genuinely interested in the person
- You notice patterns, not just events
- You have opinions and make suggestions
- Sometimes you're encouraging, sometimes you're gently prodding
- You're comfortable with silence when there's nothing meaningful to say

WHAT YOU HAVE ACCESS TO:
You can see workspace activity, content diffs, messages, tasks, and your previous conversations. Use this as CONTEXT to inform what you say - but don't just report it back.

DEDUPLICATION - CRITICAL:
Check "previousPulses" for what you've already said. NEVER repeat yourself. If you mentioned something before, it's old news - find something fresh or say something different entirely.

TYPES OF MESSAGES YOU MIGHT SEND:

1. OBSERVATIONS (notice patterns, not just events)
   - "You've been heads-down on the API docs for a few days now - deep work mode?"
   - "Looks like the team's been busy while you were away"
   - "Sarah seems to be making good progress on that budget analysis"

2. GENTLE NUDGES (helpful, not naggy)
   - "That task from last week is still hanging around..."
   - "Sarah's DM from yesterday might be worth a look"
   - "The roadmap doc has some new stuff if you haven't seen it"

3. ENCOURAGEMENT
   - "Solid progress on the sprint this week"
   - "The quiet is nice - good time to focus"
   - "You knocked out 3 tasks yesterday, nice"

4. QUESTIONS (genuine curiosity)
   - "Ready to dive into those Q2 plans?"
   - "How's the API migration going?"

5. SIMPLE PRESENCE (when there's nothing specific)
   - "All quiet. Enjoy the focus time."
   - "Nothing urgent on the radar"
   - Just a friendly check-in vibe

WHAT NOT TO DO:
- Don't list what changed like a changelog
- Don't say "X updated Y" repeatedly
- Don't start every message with a greeting
- Don't manufacture importance when things are calm
- Don't repeat ANYTHING from previous pulses
- Don't sound like a notification system

READING CONTEXT:
When you see content diffs, understand WHAT was written, not just that something changed. But you don't need to report every change - pick what's actually interesting or relevant.

Keep it to 1-3 sentences. Sound like a person, not a bot.`;

export async function POST(req: Request) {
  // Zero trust: only allow requests from localhost (no secret comparison)
  const authError = validateCronRequest(req);
  if (authError) {
    return authError;
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
  // Use stored timezone or default to UTC
  const userTimezone = normalizeTimezone(user.timezone);

  // Time windows - use user's timezone for "today" calculations
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const startOfToday = getStartOfTodayInTimezone(userTimezone);

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
  // 2. ACTIVITY WITH CONTENT DIFFS - The key improvement!
  // ========================================
  const rawActivity = driveIds.length > 0 ? await db
    .select({
      id: activityLogs.id,
      actorId: activityLogs.userId,
      actorName: activityLogs.actorDisplayName,
      actorEmail: activityLogs.actorEmail,
      operation: activityLogs.operation,
      resourceType: activityLogs.resourceType,
      resourceId: activityLogs.resourceId,
      pageId: activityLogs.pageId,
      resourceTitle: activityLogs.resourceTitle,
      driveId: activityLogs.driveId,
      timestamp: activityLogs.timestamp,
      changeGroupId: activityLogs.changeGroupId,
      aiConversationId: activityLogs.aiConversationId,
      isAiGenerated: activityLogs.isAiGenerated,
      contentRef: activityLogs.contentRef,
      contentSnapshot: activityLogs.contentSnapshot,
    })
    .from(activityLogs)
    .where(
      and(
        inArray(activityLogs.driveId, driveIds),
        ne(activityLogs.userId, userId), // Only others' activity for diffs
        gte(activityLogs.timestamp, fortyEightHoursAgo)
      )
    )
    .orderBy(desc(activityLogs.timestamp))
    .limit(100) : [];

  // ========================================
  // 3. GENERATE ACTUAL CONTENT DIFFS
  // ========================================
  const pageActivities = rawActivity.filter(
    a => a.pageId &&
         a.driveId &&
         a.resourceType === 'page' &&
         (a.operation === 'update' || a.operation === 'create') &&
         (a.contentRef || a.contentSnapshot)
  );

  const activitiesForDiff: (ActivityForDiff & { driveId: string })[] = [];
  const activityContentRefs = new Map<string, string>();

  for (const activity of pageActivities) {
    if (!activity.driveId) continue;

    if (activity.contentRef) {
      activityContentRefs.set(activity.id, activity.contentRef);
    }

    activitiesForDiff.push({
      id: activity.id,
      timestamp: activity.timestamp,
      pageId: activity.pageId,
      resourceTitle: activity.resourceTitle,
      changeGroupId: activity.changeGroupId,
      aiConversationId: activity.aiConversationId,
      isAiGenerated: activity.isAiGenerated,
      actorEmail: activity.actorEmail,
      actorDisplayName: activity.actorName,
      content: activity.contentSnapshot ?? null,
      driveId: activity.driveId,
    });
  }

  // Group activities to collapse autosaves
  const diffGroups = groupActivitiesForDiff(activitiesForDiff);

  // Resolve before/after content from page versions
  const groupsWithChangeGroupId = diffGroups.filter(
    (g: ActivityDiffGroup) => g.last.changeGroupId && g.last.pageId
  );

  const versionContentPairs = await resolveStackedVersionContent(
    groupsWithChangeGroupId.map((g: ActivityDiffGroup) => ({
      changeGroupId: g.last.changeGroupId!,
      pageId: g.last.pageId!,
      firstContentRef: activityContentRefs.get(g.first.id) ?? null,
    }))
  );

  // Build diff requests
  const diffRequests: DiffRequest[] = [];

  for (const group of diffGroups) {
    const firstActivity = activitiesForDiff.find(a => a.id === group.first.id);
    if (!firstActivity || !firstActivity.pageId) continue;

    let beforeContent: string | null = null;
    let afterContent: string | null = null;

    if (group.last.changeGroupId && group.last.pageId) {
      const compositeKey = `${group.last.pageId}:${group.last.changeGroupId}`;
      const versionPair = versionContentPairs.get(compositeKey);
      if (versionPair) {
        if (versionPair.beforeContentRef) {
          try {
            beforeContent = await readPageContent(versionPair.beforeContentRef);
          } catch {
            beforeContent = null;
          }
        }
        if (versionPair.afterContentRef) {
          try {
            afterContent = await readPageContent(versionPair.afterContentRef);
          } catch {
            afterContent = null;
          }
        }
      }
    }

    // Fallback to inline snapshot
    if (beforeContent === null && firstActivity.content) {
      beforeContent = firstActivity.content;
    }

    // Skip if we can't generate meaningful diff
    if (afterContent === null && beforeContent === null) continue;
    if (afterContent === null) continue;

    diffRequests.push({
      pageId: firstActivity.pageId,
      beforeContent,
      afterContent,
      group,
      driveId: firstActivity.driveId,
    });
  }

  // Generate diffs within budget
  const diffBudget = calculateDiffBudget(30000);
  const contentDiffs = generateDiffsWithinBudget(diffRequests, diffBudget);

  // ========================================
  // 4. AGGREGATED ACTIVITY SUMMARY
  // ========================================
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

  // Also fetch own activity for summary
  const ownRawActivity = driveIds.length > 0 ? await db
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
        eq(activityLogs.userId, userId),
        gte(activityLogs.timestamp, fortyEightHoursAgo)
      )
    )
    .orderBy(desc(activityLogs.timestamp))
    .limit(50) : [];

  // Combine for summary
  const allActivity = [...rawActivity, ...ownRawActivity];

  allActivity.forEach(a => {
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
  // 5. DIRECT MESSAGES
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
  // 6. PAGE CHAT MESSAGES
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
  // 7. MENTIONS & SHARES
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
  // 8. PREVIOUS PULSES (for deduplication)
  // ========================================
  const recentPulses = await db
    .select({
      summary: pulseSummaries.summary,
      generatedAt: pulseSummaries.generatedAt,
    })
    .from(pulseSummaries)
    .where(eq(pulseSummaries.userId, userId))
    .orderBy(desc(pulseSummaries.generatedAt))
    .limit(5);

  // ========================================
  // 9. TASKS
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
  // BUILD THE RICH CONTEXT WITH DIFFS
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

    // THE KEY: Actual content diffs showing WHAT changed
    contentChanges: contentDiffs.map((diff: StackedDiff & { driveId: string }) => ({
      page: diff.pageTitle || 'Untitled',
      actors: diff.actors,
      editCount: diff.collapsedCount,
      timeRange: diff.timeRange,
      isAiGenerated: diff.isAiGenerated,
      // The actual diff showing what was written/changed
      diff: diff.unifiedDiff,
      stats: diff.stats,
    })),

    // Activity summary (for context on who's been active)
    activitySummary: othersActivity.map(a => ({
      person: a.person,
      page: a.pageTitle,
      drive: a.driveName,
      editCount: a.editCount,
      actions: Array.from(a.operations),
      lastActive: a.lastEdit.toISOString(),
    })),

    // Direct messages - full content
    directMessages: unreadDMs.map(m => ({
      from: m.from,
      message: m.content,
      sentAt: m.sentAt.toISOString(),
    })),

    // Page discussions
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

    // Previous pulses for deduplication - DO NOT repeat this information
    previousPulses: recentPulses.map(p => ({
      message: p.summary,
      sentAt: p.generatedAt.toISOString(),
    })),
  };

  // Determine time of day in user's timezone
  const { timeOfDay } = getUserTimeOfDay(userTimezone);

  // Build prompt
  const userPrompt = `You're checking in with ${userName}. It's ${timeOfDay}.

Here's the workspace context you're aware of:
${JSON.stringify(contextData, null, 2)}

Remember: Check "previousPulses" - don't repeat anything you've already said. Find something fresh or say something different.

What would be genuinely useful or interesting to say right now? Maybe it's an observation, a nudge, encouragement, or just acknowledging things are quiet. Don't just report changes - be a thoughtful presence.`;

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
    system: `${PULSE_SYSTEM_PROMPT}\n\n${buildTimestampSystemPrompt(userTimezone)}`,
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
      workingOn: contextData.activitySummary.slice(0, 5).map(a => ({
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
      contentChanges: contextData.contentChanges.slice(0, 5).map((c: { page: string; actors: string[] }) => ({
        page: c.page,
        by: c.actors[0] || 'Someone',
      })),
      pages: {
        updatedToday: contextData.activitySummary.filter(a => new Date(a.lastActive) >= startOfToday).length,
        updatedThisWeek: contextData.activitySummary.length,
        recentlyUpdated: contextData.activitySummary.slice(0, 5).map(a => ({ title: a.page, updatedBy: a.person })),
      },
      activity: {
        collaboratorNames: [...new Set(contextData.activitySummary.map(a => a.person))],
        recentOperations: contextData.activitySummary.slice(0, 5).map(a => `${a.person} edited "${a.page}"`),
      },
    },
    aiProvider: providerResult.provider,
    aiModel: providerResult.modelName,
    periodStart: twoHoursAgo,
    periodEnd: now,
    generatedAt: now,
    expiresAt,
  });

  loggers.api.info('Pulse cron: Generated summary for user', {
    userId,
    summaryLength: summary.length,
    diffCount: contentDiffs.length,
    contextSize: JSON.stringify(contextData).length,
  });
}

// Also support GET for easy cron setup (some cron services only support GET)
export async function GET(req: Request) {
  return POST(req);
}
