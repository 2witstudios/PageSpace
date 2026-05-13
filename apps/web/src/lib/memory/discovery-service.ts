/**
 * Memory Discovery Service
 *
 * Runs focused LLM passes to discover insights about a user from their
 * recent conversations and activity. This is "blind" discovery - the LLM
 * does NOT see the user's current personalization profile.
 */

import { generateText } from 'ai';
import { db } from '@pagespace/db/db'
import { eq, and, gte, desc, inArray, isNotNull } from '@pagespace/db/operators'
import { chatMessages, pages } from '@pagespace/db/schema/core'
import { activityLogs } from '@pagespace/db/schema/monitoring'
import { driveMembers } from '@pagespace/db/schema/members'
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { createAIProvider, isProviderError } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/logging/logger-config';

export interface DiscoveryResult {
  worldview: string[];
  communication: string[];
  preferences: string[];
}

interface ConversationMessage {
  role: string;
  content: string;
  createdAt: Date;
}

// Discovery pass prompts
const WORLDVIEW_PROMPT = `Analyze these conversations to discover:
- What does this person believe or value?
- What frameworks or mental models do they use?
- What are they expert in?
- What's their background or role?

Only report clear patterns, not speculation. Return a JSON array of strings, each string being a distinct insight. If no clear patterns emerge, return an empty array.

Example output: ["Values test-driven development", "Expert in React and TypeScript", "Has background in finance"]`;

const COMMUNICATION_PROMPT = `Analyze these conversations to discover:
- How does this person like to communicate?
- Do they prefer brief or detailed responses?
- What tone do they use and expect?
- Any formatting preferences?

Look for patterns in how they interact. Return a JSON array of strings, each string being a distinct communication preference. If no clear patterns emerge, return an empty array.

Example output: ["Prefers concise responses", "Uses technical language comfortably"]`;

const PREFERENCES_PROMPT = `Analyze these conversations to identify persistent preferences for how this person wants AI to interact with them.

ONLY capture preferences that pass the portability test: "Would this still apply if the user was working on a completely different project in a different workspace?" If no, skip it.

DO capture:
- Response format and length preferences
- Tone and communication style they expect from AI
- Persistent do's and don'ts about AI output (e.g., "don't use emojis", "always show TypeScript types")

DO NOT capture:
- Technology or tool choices for a specific project
- Scope or prioritization decisions ("we're not doing X for this release")
- One-off decisions explained by their conversational context
- Project-specific constraints or workflow choices

Return a JSON array of strings. If no clearly portable preferences emerge, return an empty array.

Example output: ["Prefers responses without preamble or sign-off", "Always wants TypeScript types in code examples"]`;

/**
 * Gather recent messages from all conversation sources for a user
 */
async function gatherRecentConversations(
  userId: string,
  lookbackDays: number = 7
): Promise<ConversationMessage[]> {
  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);

  const allMessages: ConversationMessage[] = [];

  // 1. Global/DM conversations (from unified conversations table)
  const globalMessages = await db
    .select({
      content: messages.content,
      role: messages.role,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.userId, userId),
        eq(messages.isActive, true),
        gte(messages.createdAt, lookbackDate)
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(150);

  allMessages.push(
    ...globalMessages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }))
  );

  // 2. Page agent conversations (chatMessages)
  // acceptedAt IS NOT NULL filters pending invitations — a not-yet-accepted
  // member must not see prior conversations from the inviting drive.
  const userDrives = await db
    .select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .where(and(eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt)));
  const driveIds = userDrives.map((d) => d.driveId);

  if (driveIds.length > 0) {
    const pageMessages = await db
      .select({
        content: chatMessages.content,
        role: chatMessages.role,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .innerJoin(pages, eq(pages.id, chatMessages.pageId))
      .where(
        and(
          eq(chatMessages.userId, userId),
          eq(chatMessages.isActive, true),
          inArray(pages.driveId, driveIds),
          gte(chatMessages.createdAt, lookbackDate)
        )
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(100);

    allMessages.push(
      ...pageMessages.map((m) => ({
        role: m.role,
        content: m.content || '',
        createdAt: m.createdAt,
      }))
    );
  }

  allMessages.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return allMessages;
}

/**
 * Gather recent activity patterns
 */
async function gatherRecentActivity(
  userId: string,
  lookbackDays: number = 7
): Promise<string[]> {
  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);

  // Same gate as gatherRecentConversations — exclude pending invitations.
  const userDrives = await db
    .select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .where(and(eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt)));
  const driveIds = userDrives.map((d) => d.driveId);

  if (driveIds.length === 0) return [];

  const activities = await db
    .select({
      operation: activityLogs.operation,
      resourceType: activityLogs.resourceType,
      resourceTitle: activityLogs.resourceTitle,
    })
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.userId, userId),
        inArray(activityLogs.driveId, driveIds),
        gte(activityLogs.timestamp, lookbackDate)
      )
    )
    .orderBy(desc(activityLogs.timestamp))
    .limit(50);

  return activities.map(
    (a) =>
      `${a.operation} ${a.resourceType}${a.resourceTitle ? `: "${a.resourceTitle}"` : ''}`
  );
}

/**
 * Run a single focused discovery pass
 */
async function runDiscoveryPass(
  userId: string,
  passName: string,
  systemPrompt: string,
  conversationContext: string
): Promise<string[]> {
  const providerResult = await createAIProvider(userId, {
    selectedProvider: 'pagespace',
    selectedModel: 'pro',
  });

  if (isProviderError(providerResult)) {
    loggers.api.warn(`Memory discovery ${passName} pass failed: provider error`, {
      error: providerResult.error,
    });
    return [];
  }

  try {
    const result = await generateText({
      model: providerResult.model,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Here are recent conversations from this user:\n\n${conversationContext}\n\nBased on these conversations, what insights can you extract? Remember to return a JSON array of strings.`,
        },
      ],
      temperature: 0.3,
      maxRetries: 2,
    });

    // Parse JSON array from response
    const text = result.text.trim();
    // Handle both raw JSON and markdown code block responses
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : text;

    try {
      const insights = JSON.parse(jsonStr);
      if (Array.isArray(insights)) {
        return insights.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        );
      }
    } catch {
      loggers.api.debug(`Memory discovery ${passName} pass: non-JSON response, skipping`);
    }

    return [];
  } catch (error) {
    loggers.api.warn(`Memory discovery ${passName} pass failed`, { error });
    return [];
  }
}

/**
 * Run all discovery passes for a user
 */
export async function runDiscoveryPasses(userId: string): Promise<DiscoveryResult> {
  // Gather context
  const [recentMessages, recentActivity] = await Promise.all([
    gatherRecentConversations(userId),
    gatherRecentActivity(userId),
  ]);

  // Check if there's enough data to analyze
  if (recentMessages.length < 3) {
    loggers.api.debug('Memory discovery: insufficient conversation data', {
      userId,
      messageCount: recentMessages.length,
    });
    return {
      worldview: [],
      projects: [],
      communication: [],
      preferences: [],
    };
  }

  // Format conversation context for LLM
  const conversationContext = recentMessages
    .slice(0, 100)
    .map((m) => `[${m.role}]: ${m.content.substring(0, 500)}`)
    .join('\n\n');

  // Add activity context if available
  const activityContext =
    recentActivity.length > 0
      ? `\n\nRecent workspace activity:\n${recentActivity.slice(0, 20).join('\n')}`
      : '';

  const fullContext = conversationContext + activityContext;

  const [worldview, communication, preferences] = await Promise.all([
    runDiscoveryPass(userId, 'worldview', WORLDVIEW_PROMPT, fullContext),
    runDiscoveryPass(userId, 'communication', COMMUNICATION_PROMPT, fullContext),
    runDiscoveryPass(userId, 'preferences', PREFERENCES_PROMPT, fullContext),
  ]);

  loggers.api.info('Memory discovery passes complete', {
    userId,
    insightCounts: {
      worldview: worldview.length,
      communication: communication.length,
      preferences: preferences.length,
    },
  });

  return {
    worldview,
    communication,
    preferences,
  };
}
