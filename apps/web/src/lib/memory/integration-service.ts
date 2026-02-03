/**
 * Memory Integration Service
 *
 * Evaluates raw insights from the discovery service against the user's
 * current personalization profile. Decides whether to append, skip, or
 * reorganize content.
 */

import { generateText } from 'ai';
import { db, userPersonalization, eq } from '@pagespace/db';
import { createAIProvider, isProviderError } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/server';
import type { DiscoveryResult } from './discovery-service';

export interface UserPersonalizationData {
  bio: string;
  writingStyle: string;
  rules: string;
  enabled: boolean;
}

export interface FieldDecision {
  action: 'append' | 'skip';
  content?: string;
  reason?: string;
}

export interface IntegrationDecision {
  bio: FieldDecision;
  writingStyle: FieldDecision;
  rules: FieldDecision;
}

// Signal strength threshold
const MIN_INSIGHTS_FOR_UPDATE = 2;

const EVALUATOR_SYSTEM_PROMPT = `You are evaluating discovered insights about a user to decide if they should be added to their personalization profile.

Your job is to:
1. Compare new insights against what's already in the profile
2. Filter out redundant or already-captured information
3. Identify genuinely new, significant insights worth recording
4. Categorize approved insights into the correct field

FIELDS:
- bio: Background, expertise, role, beliefs, worldview, mental models
- writingStyle: Communication preferences, tone, formatting, interaction style
- rules: Explicit instructions, preferences about AI behavior, do's and don'ts

QUALITY GATES:
- Only approve insights that add meaningful new understanding
- Skip if the insight is already captured (even if worded differently)
- Skip if the insight is too vague or generic to be useful
- Skip if the insight contradicts existing profile content

For each field, decide:
- "append" - Add new content to the end of this field
- "skip" - No changes needed for this field

Return a JSON object with this structure:
{
  "bio": { "action": "append" | "skip", "content": "text to append", "reason": "why" },
  "writingStyle": { "action": "append" | "skip", "content": "text to append", "reason": "why" },
  "rules": { "action": "append" | "skip", "content": "text to append", "reason": "why" }
}

When appending, format the content naturally as prose or bullet points.`;

/**
 * Fetch current personalization for a user
 */
export async function getCurrentPersonalization(
  userId: string
): Promise<UserPersonalizationData | null> {
  const record = await db.query.userPersonalization.findFirst({
    where: eq(userPersonalization.userId, userId),
  });

  if (!record) {
    return null;
  }

  return {
    bio: record.bio ?? '',
    writingStyle: record.writingStyle ?? '',
    rules: record.rules ?? '',
    enabled: record.enabled,
  };
}

/**
 * Update personalization fields for a user
 */
export async function updatePersonalization(
  userId: string,
  updates: Partial<Pick<UserPersonalizationData, 'bio' | 'writingStyle' | 'rules'>>
): Promise<void> {
  const updateData: {
    bio?: string;
    writingStyle?: string;
    rules?: string;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (updates.bio !== undefined) updateData.bio = updates.bio;
  if (updates.writingStyle !== undefined) updateData.writingStyle = updates.writingStyle;
  if (updates.rules !== undefined) updateData.rules = updates.rules;

  await db
    .insert(userPersonalization)
    .values({
      userId,
      bio: updates.bio ?? '',
      writingStyle: updates.writingStyle ?? '',
      rules: updates.rules ?? '',
      enabled: true,
    })
    .onConflictDoUpdate({
      target: userPersonalization.userId,
      set: updateData,
    });
}

/**
 * Evaluate insights and integrate into personalization profile
 */
export async function evaluateAndIntegrate(
  userId: string,
  insights: DiscoveryResult,
  currentPersonalization: UserPersonalizationData | null
): Promise<IntegrationDecision> {
  const current = currentPersonalization ?? {
    bio: '',
    writingStyle: '',
    rules: '',
    enabled: true,
  };

  const totalInsights =
    insights.worldview.length +
    insights.projects.length +
    insights.communication.length +
    insights.preferences.length;

  if (totalInsights < MIN_INSIGHTS_FOR_UPDATE) {
    loggers.api.debug('Memory integration: insufficient insights', {
      userId,
      totalInsights,
      threshold: MIN_INSIGHTS_FOR_UPDATE,
    });
    return {
      bio: { action: 'skip', reason: 'Insufficient insights' },
      writingStyle: { action: 'skip', reason: 'Insufficient insights' },
      rules: { action: 'skip', reason: 'Insufficient insights' },
    };
  }

  const insightsText = `
WORLDVIEW & EXPERTISE INSIGHTS:
${insights.worldview.length > 0 ? insights.worldview.map((i) => `- ${i}`).join('\n') : '(none discovered)'}

PROJECTS & CURRENT WORK INSIGHTS:
${insights.projects.length > 0 ? insights.projects.map((i) => `- ${i}`).join('\n') : '(none discovered)'}

COMMUNICATION STYLE INSIGHTS:
${insights.communication.length > 0 ? insights.communication.map((i) => `- ${i}`).join('\n') : '(none discovered)'}

PREFERENCES & RULES INSIGHTS:
${insights.preferences.length > 0 ? insights.preferences.map((i) => `- ${i}`).join('\n') : '(none discovered)'}
`;

  const currentProfileText = `
CURRENT BIO:
${current.bio || '(empty)'}

CURRENT WRITING STYLE:
${current.writingStyle || '(empty)'}

CURRENT RULES:
${current.rules || '(empty)'}
`;

  const providerResult = await createAIProvider(userId, {
    selectedProvider: 'pagespace',
    selectedModel: 'pro',
  });

  if (isProviderError(providerResult)) {
    loggers.api.error('Memory integration: provider error', {
      error: providerResult.error,
    });
    return {
      bio: { action: 'skip', reason: 'Provider error' },
      writingStyle: { action: 'skip', reason: 'Provider error' },
      rules: { action: 'skip', reason: 'Provider error' },
    };
  }

  try {
    const result = await generateText({
      model: providerResult.model,
      system: EVALUATOR_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Evaluate these discovered insights against the current profile and decide what to integrate.

${currentProfileText}

DISCOVERED INSIGHTS:
${insightsText}

Remember: Only approve genuinely new, significant insights. Return JSON with decisions for each field.`,
        },
      ],
      temperature: 0.2,
      maxRetries: 2,
    });

    const text = result.text.trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : text;

    try {
      const decision = JSON.parse(jsonStr) as IntegrationDecision;

      if (
        typeof decision.bio?.action !== 'string' ||
        typeof decision.writingStyle?.action !== 'string' ||
        typeof decision.rules?.action !== 'string'
      ) {
        throw new Error('Invalid decision structure');
      }

      loggers.api.info('Memory integration decision', {
        userId,
        bioAction: decision.bio.action,
        writingStyleAction: decision.writingStyle.action,
        rulesAction: decision.rules.action,
      });

      return decision;
    } catch (parseError) {
      loggers.api.warn('Memory integration: failed to parse decision', {
        userId,
        response: text.substring(0, 500),
      });
      return {
        bio: { action: 'skip', reason: 'Parse error' },
        writingStyle: { action: 'skip', reason: 'Parse error' },
        rules: { action: 'skip', reason: 'Parse error' },
      };
    }
  } catch (error) {
    loggers.api.error('Memory integration: generation error', { userId, error });
    return {
      bio: { action: 'skip', reason: 'Generation error' },
      writingStyle: { action: 'skip', reason: 'Generation error' },
      rules: { action: 'skip', reason: 'Generation error' },
    };
  }
}

/**
 * Apply integration decisions to update personalization
 */
export async function applyIntegrationDecisions(
  userId: string,
  decisions: IntegrationDecision,
  currentPersonalization: UserPersonalizationData | null
): Promise<{ updated: boolean; fields: string[] }> {
  const current = currentPersonalization ?? {
    bio: '',
    writingStyle: '',
    rules: '',
    enabled: true,
  };

  const updates: Partial<Pick<UserPersonalizationData, 'bio' | 'writingStyle' | 'rules'>> = {};
  const updatedFields: string[] = [];

  if (decisions.bio.action === 'append' && decisions.bio.content) {
    const newContent = decisions.bio.content.trim();
    if (newContent) {
      updates.bio = current.bio
        ? `${current.bio}\n\n${newContent}`
        : newContent;
      updatedFields.push('bio');
    }
  }

  if (decisions.writingStyle.action === 'append' && decisions.writingStyle.content) {
    const newContent = decisions.writingStyle.content.trim();
    if (newContent) {
      updates.writingStyle = current.writingStyle
        ? `${current.writingStyle}\n\n${newContent}`
        : newContent;
      updatedFields.push('writingStyle');
    }
  }

  if (decisions.rules.action === 'append' && decisions.rules.content) {
    const newContent = decisions.rules.content.trim();
    if (newContent) {
      updates.rules = current.rules
        ? `${current.rules}\n\n${newContent}`
        : newContent;
      updatedFields.push('rules');
    }
  }

  if (updatedFields.length > 0) {
    await updatePersonalization(userId, updates);
    loggers.api.info('Memory integration: personalization updated', {
      userId,
      fields: updatedFields,
    });
  }

  return {
    updated: updatedFields.length > 0,
    fields: updatedFields,
  };
}
