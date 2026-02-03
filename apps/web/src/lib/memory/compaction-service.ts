/**
 * Memory Compaction Service
 *
 * When a personalization field exceeds the size threshold, this service
 * uses LLM to reorganize and summarize the content while preserving
 * key insights.
 */

import { generateText } from 'ai';
import { createAIProvider, isProviderError } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/server';
import {
  updatePersonalization,
  getCurrentPersonalization,
} from './integration-service';

// Size thresholds
const DEFAULT_MAX_LENGTH = 20000;
const COMPACTION_TRIGGER_RATIO = 0.9;
const COMPACTION_TARGET_RATIO = 0.7;

type PersonalizationField = 'bio' | 'writingStyle' | 'rules';

const COMPACTION_PROMPTS: Record<PersonalizationField, string> = {
  bio: `You are reorganizing a user's bio/background information that has grown too long.

Your job is to:
1. Preserve all key facts about their background, expertise, and role
2. Consolidate redundant or overlapping information
3. Remove outdated or superseded information (keep most recent)
4. Maintain the essential character and voice
5. Organize into clear sections if appropriate

Output the reorganized bio as clean prose or bullet points. Do NOT add commentary or explanations - just output the compacted content.`,

  writingStyle: `You are reorganizing a user's writing style preferences that have grown too long.

Your job is to:
1. Preserve all distinct communication preferences
2. Merge similar or overlapping preferences
3. Remove redundant instructions
4. Keep the most specific/actionable guidance
5. Organize logically (tone, format, length, etc.)

Output the reorganized writing style as clean prose or bullet points. Do NOT add commentary - just output the compacted content.`,

  rules: `You are reorganizing a user's AI rules/instructions that have grown too long.

Your job is to:
1. Preserve all explicit do's and don'ts
2. Consolidate rules that say the same thing differently
3. Remove rules that contradict newer rules (keep most recent)
4. Organize by category if appropriate
5. Keep the most specific/actionable rules

Output the reorganized rules as clean prose or bullet points. Do NOT add commentary - just output the compacted content.`,
};

/**
 * Check if a field needs compaction
 */
export function needsCompaction(
  content: string,
  maxLength: number = DEFAULT_MAX_LENGTH
): boolean {
  const triggerLength = maxLength * COMPACTION_TRIGGER_RATIO;
  return content.length > triggerLength;
}

/**
 * Compact a single personalization field
 */
export async function compactField(
  userId: string,
  fieldName: PersonalizationField,
  content: string,
  maxLength: number = DEFAULT_MAX_LENGTH
): Promise<string> {
  const targetLength = Math.floor(maxLength * COMPACTION_TARGET_RATIO);

  const providerResult = await createAIProvider(userId, {
    selectedProvider: 'pagespace',
    selectedModel: 'pro',
  });

  if (isProviderError(providerResult)) {
    loggers.api.error('Memory compaction: provider error', {
      userId,
      fieldName,
      error: providerResult.error,
    });
    return content;
  }

  try {
    const systemPrompt = COMPACTION_PROMPTS[fieldName];

    const result = await generateText({
      model: providerResult.model,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Here is the ${fieldName} content that needs to be reorganized and compacted:

---
${content}
---

Reorganize this into a more concise version (target: under ${targetLength} characters) while preserving all key information. Output only the compacted content.`,
        },
      ],
      temperature: 0.3,
      maxRetries: 2,
    });

    const compactedContent = result.text.trim();

    if (compactedContent.length === 0) {
      loggers.api.warn('Memory compaction: empty result, keeping original', {
        userId,
        fieldName,
      });
      return content;
    }

    if (compactedContent.length >= content.length) {
      loggers.api.debug('Memory compaction: no size reduction, keeping original', {
        userId,
        fieldName,
        originalLength: content.length,
        compactedLength: compactedContent.length,
      });
      return content;
    }

    loggers.api.info('Memory compaction: field compacted', {
      userId,
      fieldName,
      originalLength: content.length,
      compactedLength: compactedContent.length,
      reduction: `${Math.round((1 - compactedContent.length / content.length) * 100)}%`,
    });

    return compactedContent;
  } catch (error) {
    loggers.api.error('Memory compaction: generation error', {
      userId,
      fieldName,
      error,
    });
    return content;
  }
}

/**
 * Check and compact all personalization fields for a user if needed
 */
export async function checkAndCompactIfNeeded(
  userId: string,
  maxLength: number = DEFAULT_MAX_LENGTH
): Promise<{ compacted: boolean; fields: string[] }> {
  const current = await getCurrentPersonalization(userId);

  if (!current) {
    return { compacted: false, fields: [] };
  }

  const fieldsToCompact: PersonalizationField[] = [];

  if (current.bio && needsCompaction(current.bio, maxLength)) {
    fieldsToCompact.push('bio');
  }
  if (current.writingStyle && needsCompaction(current.writingStyle, maxLength)) {
    fieldsToCompact.push('writingStyle');
  }
  if (current.rules && needsCompaction(current.rules, maxLength)) {
    fieldsToCompact.push('rules');
  }

  if (fieldsToCompact.length === 0) {
    return { compacted: false, fields: [] };
  }

  loggers.api.info('Memory compaction: fields need compaction', {
    userId,
    fields: fieldsToCompact,
  });

  const compactionResults = await Promise.all(
    fieldsToCompact.map(async (field) => {
      const originalContent = current[field];
      if (!originalContent) return { field, content: '' };
      const compactedContent = await compactField(userId, field, originalContent, maxLength);
      return { field, content: compactedContent };
    })
  );

  const updates: Partial<Pick<typeof current, 'bio' | 'writingStyle' | 'rules'>> = {};
  const compactedFields: string[] = [];

  for (const result of compactionResults) {
    if (result.content && result.content !== current[result.field]) {
      updates[result.field] = result.content;
      compactedFields.push(result.field);
    }
  }

  if (compactedFields.length > 0) {
    await updatePersonalization(userId, updates);
  }

  return {
    compacted: compactedFields.length > 0,
    fields: compactedFields,
  };
}
