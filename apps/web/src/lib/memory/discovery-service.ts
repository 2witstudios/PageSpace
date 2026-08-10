/**
 * Memory Discovery Service
 *
 * Runs focused LLM passes to discover insights about a user from their
 * recent conversations and activity. This is "blind" discovery — the LLM
 * does NOT see the user's current personalization profile.
 *
 * Claims carry evidence and occurrence counts for corroboration.
 */

import { generateObject } from 'ai';
import { db } from '@pagespace/db/db';
import { and, desc, eq, gte, inArray, isNotNull, ne } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { driveMembers } from '@pagespace/db/schema/members';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { BACKGROUND_HEAVY_PROVIDER, BACKGROUND_HEAVY_MODEL } from '@/lib/ai/core/ai-providers-config';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { z } from 'zod';

export type MemoryField = 'bio' | 'writingStyle' | 'rules';

export interface DiscoveredClaim {
  field: MemoryField;
  claim: string;
  evidence: string;
  /**
   * How many messages in THIS window support the claim.
   *
   * Not used for corroboration — that counts distinct evidence days across
   * runs (see `evidenceAt`), and a count confined to one window cannot
   * distinguish one emphatic day from a standing preference. It is kept
   * because asking the model to count forces it to look for repetition rather
   * than latch onto a single striking sentence, and it is worth having in the
   * logs when tuning the prompts.
   */
  occurrencesInWindow: number;
  /**
   * When the newest message supporting this claim was written.
   *
   * This, NOT the time the cron happened to run, is what corroboration counts.
   * Discovery re-reads the same rolling 7-day window every night, so a single
   * unchanged message is rediscovered on consecutive runs; counting cron days
   * would promote a one-off after two or three nights and defeat the whole
   * point of the staging table.
   *
   * Derived server-side from `evidenceMessageIndex` — the model cites which
   * message it quoted, and we look up that message's real timestamp. The model
   * never supplies a date.
   */
  evidenceAt: Date;
}

export interface DiscoveryResult {
  claims: DiscoveredClaim[];
}

interface ConversationMessage {
  role: string;
  content: string;
  createdAt: Date;
}

// Zod schema for structured output — eliminates silent parse failures.
//
// `field` is optional: `runDiscoveryPasses` assigns it from the pass the claim
// came from, which is the authority. Requiring it here would make a response
// that omits it fail schema validation and drop the whole pass to zero claims.
const claimSchema = z.object({
  field: z.enum(['bio', 'writingStyle', 'rules']).optional(),
  claim: z.string().min(1),
  evidence: z.string().min(1),
  occurrencesInWindow: z.number().int().min(1),
  /**
   * Index (from the numbered transcript) of the newest message supporting the
   * claim. An index rather than a date so the model cannot invent a timestamp;
   * anything out of range falls back to the oldest message in the window,
   * which is the conservative choice — it cannot fabricate recency.
   */
  evidenceMessageIndex: z.number().int().min(0),
});

const discoverySchema = z.object({
  claims: z.array(claimSchema),
});

// Discovery pass prompt — shared structure, field-specific logic
const DISCOVERY_PROMPT_BASE = `Analyze these conversations to discover insights about this person that would change how an AI behaves.

ACTIONABILITY GATE (check first, everything fails this):
Only capture something if knowing it would genuinely change AI behaviour in a conversation.
If it is merely true about the person but doesn't affect what the AI should do, SKIP IT.

EXPLICIT EXCLUSIONS (never record these, even if they seem actionable):
- Personal history, family relationships, living situation
- Religious or political beliefs
- Hobbies, games, sports teams, entertainment preferences
- Named third parties (real names of anyone other than the user)
- Employer or product marketing claims
- Self-reported metrics (lines of code, rankings, follower counts, scores)
- Current tasks, projects, or work-in-progress status

Each message in the transcript below is numbered like [12 user], in chronological order: [0] is the OLDEST message and the highest number is the MOST RECENT. Use those numbers.

Return a JSON object with a "claims" array. Each claim has:
- claim: the insight itself — IMPERATIVE for writingStyle/rules (e.g. "Never use emojis", not "user prefers no emojis")
- evidence: a verbatim quote from the user's messages that supports this claim
- occurrencesInWindow: how many distinct messages in these conversations support this claim
- evidenceMessageIndex: the NUMBER of the most recent message supporting this claim, exactly as shown in brackets

Example output format:
{
  "claims": [
    {
      "claim": "Prefer concise responses without preamble or sign-off",
      "evidence": "be concise, skip the preamble",
      "occurrencesInWindow": 3,
      "evidenceMessageIndex": 12
    }
  ]
}`;

const WORLDVIEW_SPECIFIC = `
Focus on: expertise, domain knowledge, thinking style, professional background.
Examples of good bio claims:
- "Software engineer specializing in React and TypeScript"
- "Prefers test-driven development"
- "Background in finance, now working on B2B SaaS"
`;

const COMMUNICATION_SPECIFIC = `
Focus on: how the AI should WRITE — both directions.
- TO the user: tone, verbosity, formatting, interaction patterns
- AS the user: voice, banned constructions, sentence shape, characteristic phrasing for ghostwriting

EVERY claim must be IMPERATIVE, second-person, starting with a verb. Never describe how the user talks.
Examples of good writingStyle claims:
- "Be concise and direct. Do not use preamble or sign-off."
- "When drafting text as the user, avoid em dashes. Use sentence fragments and single-word closings like 'Exactly.'"
- "Use bullet points for lists. Provide code examples for technical concepts."
- "When ghostwriting, enthymematic style: leave conclusions unstated so the reader fills the gap"
`;

const RULES_SPECIFIC = `
Focus on: universal AI behavior preferences that apply in ANY workspace.
- NOT project-specific technology choices
- NOT scope or priority decisions for a specific release
- NOT one-off decisions explained by their context

Examples of good rules claims:
- "Always suggest TypeScript solutions over JavaScript"
- "Include error handling when writing code"
- "Never use emojis in code comments or documentation"
`;

/**
 * Gather recent messages from all conversation sources for a user.
 *
 * Wider window than before: 60 messages × 1500 chars each (vs 100 × 500).
 */
async function gatherRecentConversations(
  userId: string,
  lookbackDays: number = 7
): Promise<ConversationMessage[]> {
  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);

  const allMessages: ConversationMessage[] = [];

  // Global/DM conversations. eq(type, 'global') is REQUIRED — see D6 comment
  // in agent-epic "Agent-Session Single Source of Truth".
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
        eq(conversations.type, 'global'),
        eq(conversations.userId, userId),
        eq(messages.isActive, true),
        // Skip streaming placeholder rows
        ne(messages.status, 'streaming'),
        gte(messages.createdAt, lookbackDate)
      )
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(60); // was 150, reduced to 60 for tighter window

  allMessages.push(
    ...globalMessages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }))
  );

  // Page agent conversations via drive membership.
  const userDrives = await db
    .select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .where(and(eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt)));
  const driveIds = userDrives.map((d) => d.driveId);

  if (driveIds.length > 0) {
    const pageMessages = await db
      .select({
        content: messages.content,
        role: messages.role,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .innerJoin(pages, eq(pages.id, conversations.contextId))
      .where(
        and(
          eq(conversations.type, 'page'),
          eq(messages.userId, userId),
          eq(messages.isActive, true),
          inArray(pages.driveId, driveIds),
          gte(messages.createdAt, lookbackDate)
        )
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(60);

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
 * Gather recent activity patterns.
 */
async function gatherRecentActivity(
  userId: string,
  lookbackDays: number = 7
): Promise<string[]> {
  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);

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
    .limit(30); // was 50, reduced

  return activities.map(
    (a) =>
      `${a.operation} ${a.resourceType}${a.resourceTitle ? `: "${a.resourceTitle}"` : ''}`
  );
}

/**
 * Run a single focused discovery pass using generateObject.
 */
async function runDiscoveryPass(
  userId: string,
  passName: string,
  /** The field this pass is responsible for — the authority on every claim it returns. */
  field: MemoryField,
  systemPrompt: string,
  conversationContext: string,
  /** Same order as the numbered transcript, so a cited index resolves to a real timestamp. */
  messageDates: Date[]
): Promise<DiscoveredClaim[]> {
  const providerResult = await createAIProvider(userId, {
    selectedProvider: BACKGROUND_HEAVY_PROVIDER,
    selectedModel: BACKGROUND_HEAVY_MODEL,
  });

  if (isProviderError(providerResult)) {
    loggers.api.warn(`Memory discovery ${passName} pass failed: provider error`, {
      error: providerResult.error,
    });
    return [];
  }

  try {
    const result = await generateObject({
      model: providerResult.model,
      schema: discoverySchema,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Here are recent conversations from this user:\n\n${conversationContext}\n\nBased on these conversations, what insights can you extract? Remember the actionability gate — only record things that would change how an AI behaves.`,
        },
      ],
      temperature: 0.3,
      maxRetries: 2,
    });

    AIMonitoring.trackUsage({
      userId,
      provider: providerResult.provider,
      model: providerResult.modelName,
      source: 'memory',
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      totalTokens: result.usage
        ? (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0)
        : undefined,
      success: true,
      metadata: { feature: 'memory_discovery', pass: passName },
    });

    // Resolve each cited index to the real message timestamp. An out-of-range
    // index falls back to the OLDEST message in the window: a model that cites
    // nothing usable must not be able to make a claim look fresher than its
    // evidence, which would let it clear the corroboration bar early.
    // Transcript is chronological, so index 0 is the oldest message in the
    // window. An unusable index falls back to it: a claim must never be able
    // to look FRESHER than the evidence actually supports, since that is what
    // would let it clear the corroboration bar early.
    const oldest = messageDates[0] ?? new Date();

    // The model's own `field` tag is discarded in favour of `field`, the field
    // this pass is responsible for. The model can omit or mislabel it, and a
    // claim filed into the wrong page is worse than one not filed at all.
    return result.object.claims.map(({ field: _modelTag, ...claim }) => ({
      ...claim,
      field,
      evidenceAt: messageDates[claim.evidenceMessageIndex] ?? oldest,
    }));
  } catch (error) {
    loggers.api.warn(`Memory discovery ${passName} pass failed`, { error });
    return [];
  }
}

/**
 * Run all discovery passes for a user.
 *
 * Returns a unified set of claims across all three fields.
 */
export async function runDiscoveryPasses(userId: string): Promise<DiscoveryResult> {
  const [recentMessages, recentActivity] = await Promise.all([
    gatherRecentConversations(userId),
    gatherRecentActivity(userId),
  ]);

  if (recentMessages.length < 3) {
    loggers.api.debug('Memory discovery: insufficient conversation data', {
      userId,
      messageCount: recentMessages.length,
    });
    return { claims: [] };
  }

  // Format conversation context: 60 messages × 1500 chars (was 100 × 500).
  //
  // `recentMessages` is newest-first (that is how the 60 most recent are
  // selected), but the transcript is then REVERSED to chronological order
  // before numbering. Numbering a newest-first list would make index 0 the
  // newest message while a model reading a conversation naturally assumes
  // ascending time — so "cite the most recent message" would return a high
  // index, and `evidenceAt` would resolve to the OLDEST message instead.
  //
  // That failure is invisible: the index is in range, so the out-of-range
  // fallback never fires, and today's evidence is silently stamped a week old.
  // It also inverts the corroboration rule, since both
  // `shouldIncrementOccurrences` and `promotionCutoff` key on `evidenceAt`.
  const windowed = recentMessages.slice(0, 60).reverse();
  const messageDates = windowed.map((m) => m.createdAt);
  const conversationContext = windowed
    .map((m, i) => `[${i} ${m.role}]: ${m.content.substring(0, 1500)}`)
    .join('\n\n');

  const activityContext =
    recentActivity.length > 0
      ? `\n\nRecent workspace activity:\n${recentActivity.slice(0, 20).join('\n')}`
      : '';

  const fullContext = conversationContext + activityContext;

  // Run three focused passes in parallel. Each pass owns its field and stamps
  // it onto every claim it returns, so the model's own tag never decides which
  // page a claim lands in.
  const [bioClaims, communicationClaims, rulesClaims] = await Promise.all([
    runDiscoveryPass(
      userId,
      'worldview',
      'bio',
      DISCOVERY_PROMPT_BASE + '\n\n' + WORLDVIEW_SPECIFIC,
      fullContext,
      messageDates
    ),
    runDiscoveryPass(
      userId,
      'communication',
      'writingStyle',
      DISCOVERY_PROMPT_BASE + '\n\n' + COMMUNICATION_SPECIFIC,
      fullContext,
      messageDates
    ),
    runDiscoveryPass(
      userId,
      'preferences',
      'rules',
      DISCOVERY_PROMPT_BASE + '\n\n' + RULES_SPECIFIC,
      fullContext,
      messageDates
    ),
  ]);

  const allClaims = [...bioClaims, ...communicationClaims, ...rulesClaims];

  loggers.api.info('Memory discovery passes complete', {
    userId,
    claimCounts: {
      bio: bioClaims.length,
      writingStyle: communicationClaims.length,
      rules: rulesClaims.length,
    },
  });

  return { claims: allClaims };
}
