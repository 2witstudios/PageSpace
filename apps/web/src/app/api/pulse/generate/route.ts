import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  createAIProvider,
  isProviderError,
  buildTimestampSystemPrompt,
  getUserTimeOfDay,
  getStartOfTodayInTimezone,
  isValidTimezone,
  normalizeTimezone,
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
} from '@pagespace/db';
import { fetchCalendarContext } from '../calendar-context';
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
import { AIMonitoring } from '@pagespace/lib/ai-monitoring';

import { PULSE_SYSTEM_PROMPT } from '../pulse-prompt';

const AUTH_OPTIONS = { allow: ['session'] as const };

export async function POST(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    // Parse request body for timezone
    let clientTimezone: string | undefined;
    try {
      const body = await req.json();
      const requestedTimezone = typeof body?.timezone === 'string' ? body.timezone.trim() : undefined;
      if (requestedTimezone && isValidTimezone(requestedTimezone)) {
        clientTimezone = requestedTimezone;
      }
    } catch {
      // No body or invalid JSON is fine - timezone is optional
    }

    // Get user info for personalization
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const userName = user?.name || user?.email?.split('@')[0] || 'there';

    // Determine timezone: use client-provided, then stored preference, then UTC
    const userTimezone = clientTimezone || normalizeTimezone(user?.timezone);

    // If client provided a timezone and it differs from stored, update user profile
    if (clientTimezone && clientTimezone !== user?.timezone) {
      await db.update(users).set({ timezone: clientTimezone }).where(eq(users.id, userId));
    }

    // Time windows - use user's timezone for "today" calculations
    const now = new Date();
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
    // 1. WORKSPACE CONTEXT
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

    // Get team members
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
    // Get activity logs WITH contentRef for diff generation
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
          ne(activityLogs.userId, userId), // Only others' activity
          gte(activityLogs.timestamp, fortyEightHoursAgo)
        )
      )
      .orderBy(desc(activityLogs.timestamp))
      .limit(100) : [];

    // ========================================
    // 3. GENERATE ACTUAL CONTENT DIFFS
    // ========================================
    // Filter to page content changes that we can diff
    const pageActivities = rawActivity.filter(
      a => a.pageId &&
           a.driveId &&
           a.resourceType === 'page' &&
           (a.operation === 'update' || a.operation === 'create') &&
           (a.contentRef || a.contentSnapshot)
    );

    // Convert to ActivityForDiff format
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

    // Generate diffs within budget (generous budget for Pulse)
    const diffBudget = calculateDiffBudget(30000); // ~7.5k tokens for diffs
    const contentDiffs = generateDiffsWithinBudget(diffRequests, diffBudget);

    // ========================================
    // 4. AGGREGATE ACTIVITY SUMMARY
    // ========================================
    // Group by person+page for summary
    const activityByPersonPage: Record<string, {
      person: string;
      pageId: string;
      pageTitle: string;
      driveName: string;
      editCount: number;
      lastEdit: Date;
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
        };
      }
      activityByPersonPage[key].editCount++;
      if (a.timestamp > activityByPersonPage[key].lastEdit) {
        activityByPersonPage[key].lastEdit = a.timestamp;
      }
    });

    const aggregatedActivity = Object.values(activityByPersonPage)
      .sort((a, b) => b.editCount - a.editCount)
      .slice(0, 10);

    // ========================================
    // 5. DIRECT MESSAGES - Full content
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
    // 6. PAGE CHAT DISCUSSIONS
    // ========================================
    const recentPageChats = driveIds.length > 0 ? await db
      .select({
        pageId: chatMessages.pageId,
        pageTitle: pages.title,
        senderName: users.name,
        senderEmail: users.email,
        content: chatMessages.content,
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
      .select({ title: taskItems.title, priority: taskItems.priority })
      .from(taskItems)
      .where(
        and(
          or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
          ne(taskItems.status, 'completed'),
          lt(taskItems.dueDate, startOfToday)
        )
      )
      .orderBy(desc(taskItems.priority))
      .limit(5);

    const todayTasks = await db
      .select({ title: taskItems.title, priority: taskItems.priority })
      .from(taskItems)
      .where(
        and(
          or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
          ne(taskItems.status, 'completed'),
          gte(taskItems.dueDate, startOfToday),
          lt(taskItems.dueDate, endOfToday)
        )
      )
      .limit(5);

    // ========================================
    // 10. CALENDAR EVENTS
    // ========================================
    const endOfTomorrow = new Date(endOfToday.getTime() + 24 * 60 * 60 * 1000);

    const calendarContext = await fetchCalendarContext({
      userId, driveIds, now, endOfToday, endOfTomorrow,
    });
    const { happeningNow, upcomingToday } = calendarContext;
    const tomorrowEvents = calendarContext.tomorrow;
    const pendingRsvps = calendarContext.pendingInvites;
    const allCalendarEvents = calendarContext.allEvents;

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
      activitySummary: aggregatedActivity.map(a => ({
        person: a.person,
        page: a.pageTitle,
        drive: a.driveName,
        editCount: a.editCount,
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
      })),

      sharedWithYou: recentShares.map(s => ({
        page: s.pageTitle || 'a page',
        by: s.sharedByName || 'Someone',
      })),

      tasks: {
        overdue: overdueTasks.map(t => ({ title: t.title, priority: t.priority })),
        dueToday: todayTasks.map(t => ({ title: t.title, priority: t.priority })),
      },

      calendar: {
        happeningNow: happeningNow.map(e => ({
          title: e.title,
          location: e.location || undefined,
          endAt: e.endAt.toISOString(),
        })),
        upcomingToday: upcomingToday.map(e => ({
          title: e.title,
          location: e.location || undefined,
          startAt: e.startAt.toISOString(),
          endAt: e.endAt.toISOString(),
          allDay: e.allDay,
        })),
        tomorrow: tomorrowEvents.map(e => ({
          title: e.title,
          location: e.location || undefined,
          startAt: e.startAt.toISOString(),
          allDay: e.allDay,
        })),
        pendingInvites: pendingRsvps.map(r => ({
          title: r.eventTitle,
          startAt: r.startAt.toISOString(),
        })),
      },

      // Previous pulses for deduplication - DO NOT repeat this information
      previousPulses: recentPulses.map(p => ({
        message: p.summary,
        sentAt: p.generatedAt.toISOString(),
      })),
    };

    // Determine greeting based on time of day in user's timezone
    const { timeOfDay } = getUserTimeOfDay(userTimezone);

    // Build prompt for AI
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
      loggers.api.error('Failed to create AI provider for pulse', { error: providerResult.error });
      return NextResponse.json({ error: providerResult.error }, { status: providerResult.status });
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

    // Track AI usage
    const usage = result.usage;
    AIMonitoring.trackUsage({
      userId,
      provider: providerResult.provider,
      model: providerResult.modelName,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage ? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) : undefined,
      success: true,
    });

    // Extract greeting
    let greeting: string | null = null;
    const greetingMatch = summary.match(/^([^.!?]+[!])\s*/);
    if (greetingMatch) {
      greeting = greetingMatch[1];
    }

    // Save to database
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const expiresAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);

    const [savedSummary] = await db.insert(pulseSummaries).values({
      userId,
      summary,
      greeting,
      type: 'on_demand',
      contextData: {
        workspace: contextData.workspace,
        workingOn: contextData.activitySummary.slice(0, 5).map(a => ({
          person: a.person,
          page: a.page,
          driveName: a.drive,
          action: 'update',
        })),
        tasks: {
          dueToday: contextData.tasks.dueToday.length,
          dueThisWeek: 0,
          overdue: contextData.tasks.overdue.length,
          completedThisWeek: 0,
          recentlyCompleted: [],
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
        calendar: {
          happeningNow: happeningNow.length,
          upcomingToday: upcomingToday.length,
          tomorrow: tomorrowEvents.length,
          pendingInvites: pendingRsvps.length,
          events: allCalendarEvents.slice(0, 5).map(e => ({
            title: e.title,
            startAt: e.startAt.toISOString(),
          })),
        },
      },
      aiProvider: providerResult.provider,
      aiModel: providerResult.modelName,
      periodStart: sixHoursAgo,
      periodEnd: now,
      generatedAt: now,
      expiresAt,
    }).returning();

    loggers.api.info('Generated pulse summary', {
      userId,
      summaryId: savedSummary.id,
      summaryLength: summary.length,
      diffCount: contentDiffs.length,
      contextSize: JSON.stringify(contextData).length,
    });

    return NextResponse.json({
      id: savedSummary.id,
      summary,
      greeting,
      generatedAt: savedSummary.generatedAt,
      expiresAt: savedSummary.expiresAt,
      contextData: savedSummary.contextData,
    });

  } catch (error) {
    loggers.api.error('Error generating pulse summary:', error as Error);
    return NextResponse.json({ error: 'Failed to generate pulse summary' }, { status: 500 });
  }
}
