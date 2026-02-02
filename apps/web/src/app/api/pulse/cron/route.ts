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

// This endpoint should be protected by a cron secret in production
const CRON_SECRET = process.env.CRON_SECRET;

// System prompt for generating pulse summaries
const PULSE_SYSTEM_PROMPT = `You are a friendly workspace companion who deeply understands the user's workspace and can give them genuinely useful, contextual updates.

You have access to RICH context including ACTUAL CONTENT DIFFS showing exactly what changed. Use this to tell users WHAT was written/edited, not just that something changed.

YOUR JOB:
- Tell them WHAT changed, not just that changes happened
- Read the diffs and summarize the actual content: "Noah added a section about Q2 pricing with 3 new tiers"
- If someone messaged them, tell them what the message actually says
- Be specific: "Sarah updated the API docs to include OAuth2 examples" not "Sarah edited the API docs"

READING DIFFS:
- Lines starting with + are additions (new content)
- Lines starting with - are deletions (removed content)
- Focus on the MEANING of what was added/removed, not line counts
- Summarize the substance: "Added a troubleshooting section" not "added 15 lines"

TONE:
- Like a thoughtful colleague who read the changes and can summarize them
- Natural and conversational
- If it's quiet, just say hi - don't manufacture activity

EXAMPLES OF GREAT SUMMARIES:
- "Morning! Noah's been working on the Product Roadmap - he added a whole Q2 section covering the API migration timeline and new pricing tiers. Also, Sarah left you a DM asking if the launch date is still Feb 15th."
- "Hey! Alex updated the onboarding guide with step-by-step screenshots for the new dashboard. There's also a discussion going on the Sprint Planning page about the deployment schedule."
- "Afternoon! Things are pretty quiet. Sarah shared the Budget Analysis with you earlier - it has projections through Q3."

WHAT TO AVOID:
- "5 pages were updated" - useless without substance
- "Changes were made to the document" - vague nonsense
- Reporting diff statistics like "23 lines added" - focus on meaning instead
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
         a.resourceType === 'page' &&
         (a.operation === 'update' || a.operation === 'create') &&
         (a.contentRef || a.contentSnapshot)
  );

  const activitiesForDiff: (ActivityForDiff & { driveId: string })[] = [];
  const activityContentRefs = new Map<string, string>();

  for (const activity of pageActivities) {
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
      driveId: activity.driveId!,
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
  // 8. TASKS
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

Here's what's happening in their workspace, INCLUDING ACTUAL CONTENT DIFFS:

${JSON.stringify(contextData, null, 2)}

IMPORTANT: The "contentChanges" array contains actual diffs showing what was written/changed. Read these diffs and summarize WHAT the content says, not just that changes were made.

For example, if you see a diff like:
+ ## Q2 Timeline
+ - Sprint 1: API Migration
+ - Sprint 2: New Dashboard

Say something like "Noah added a Q2 timeline covering the API migration and new dashboard sprints"

Write a natural 2-4 sentence update that tells them something genuinely useful about what changed.`;

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
