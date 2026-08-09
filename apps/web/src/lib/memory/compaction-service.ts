/**
 * Memory Compaction Service
 *
 * When a personalization field exceeds its budget, this service uses LLM to
 * reorganize and reduce the content while preserving key information.
 *
 * Compaction is now deletion-biased: "delete anything that does not change
 * AI behaviour; preserve only what does."
 */

import { generateText } from 'ai';
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { BACKGROUND_HEAVY_PROVIDER, BACKGROUND_HEAVY_MODEL } from '@/lib/ai/core/ai-providers-config';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { getCurrentPersonalizationPages, updatePersonalizationPage } from './integration-service';

export type MemoryField = 'bio' | 'writingStyle' | 'rules';

// Per-field budgets — trigger at 1.0×, compact to 0.7×
const FIELD_LENGTHS: Record<MemoryField, { max: number; compactTo: number }> = {
  bio: { max: 3000, compactTo: 2100 },
  writingStyle: { max: 2500, compactTo: 1750 },
  rules: { max: 2500, compactTo: 1750 },
};

const COMPACTION_PROMPTS: Record<MemoryField, string> = {
  bio: `You are compacting a user's bio and background information that has grown too long.

Your job is to DELETE anything that does not change how an AI behaves. Keep ONLY what affects AI responses.

REMOVE:
- Personal history, family details, living situation
- Religious or political beliefs
- Hobbies, games, sports, entertainment preferences
- Named third parties (other than the user)
- Self-reported metrics or rankings
- Current tasks or project status

PRESERVE:
- Professional expertise and domain knowledge
- Technical background and specialization
- Thinking patterns and decision-making frameworks
- Work style preferences that affect AI collaboration

Organize the remaining content clearly. Output only the compacted bio, no commentary.`,

  writingStyle: `You are compacting a user's writing style preferences that have grown too long.

Your job is to DELETE anything that does not change how an AI writes or responds. Keep ONLY actionable instructions.

REMOVE:
- Descriptive statements about how the user talks (e.g. "user uses typos")
- Redundant or conflicting instructions
- Project-specific preferences

PRESERVE:
- Imperative instructions for how AI should respond TO the user
- Imperative instructions for how AI should draft text AS the user
- Voice, banned constructions, sentence shape, characteristic phrasing
- Formatting and interaction preferences

Organize by direction (TO vs AS) if both exist. Output only the compacted content, no commentary.`,

  rules: `You are compacting a user's AI behavior rules that have grown too long.

Your job is to DELETE anything that does not change how an AI behaves. Keep ONLY universal rules.

REMOVE:
- Project-specific technology choices
- Scope or priority decisions for a specific release
- One-off decisions tied to a specific context
- Redundant or conflicting rules

PRESERVE:
- Universal preferences that apply in ANY workspace
- Persistent do's and don'ts about AI output
- Always/never instructions that the user wants followed

Organize clearly. Output only the compacted rules, no commentary.`,
};

/**
 * Check if a field needs compaction.
 */
export function needsCompaction(
  content: string,
  field: MemoryField
): boolean {
  const { max } = FIELD_LENGTHS[field];
  return content.length > max;
}

/**
 * Compact a single personalization field.
 */
export async function compactField(
  userId: string,
  field: MemoryField,
  content: string
): Promise<string> {
  const { compactTo } = FIELD_LENGTHS[field];

  const providerResult = await createAIProvider(userId, {
    selectedProvider: BACKGROUND_HEAVY_PROVIDER,
    selectedModel: BACKGROUND_HEAVY_MODEL,
  });

  if (isProviderError(providerResult)) {
    loggers.api.error('Memory compaction: provider error', {
      userId,
      field,
      error: providerResult.error,
    });
    return content;
  }

  try {
    const systemPrompt = COMPACTION_PROMPTS[field];

    const result = await generateText({
      model: providerResult.model,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Here is the ${field} content that needs to be compacted to under ${compactTo} characters:

---
${content}
---

Compact this by deleting anything that does not change AI behaviour. Output only the compacted content.`,
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
      metadata: { feature: 'memory_compaction', field },
    });

    const compactedContent = result.text.trim();

    if (compactedContent.length === 0) {
      loggers.api.warn('Memory compaction: empty result, keeping original', {
        userId,
        field,
      });
      return content;
    }

    if (compactedContent.length >= content.length) {
      loggers.api.debug('Memory compaction: no size reduction, keeping original', {
        userId,
        field,
        originalLength: content.length,
        compactedLength: compactedContent.length,
      });
      return content;
    }

    loggers.api.info('Memory compaction: field compacted', {
      userId,
      field,
      originalLength: content.length,
      compactedLength: compactedContent.length,
      reduction: `${Math.round((1 - compactedContent.length / content.length) * 100)}%`,
    });

    return compactedContent;
  } catch (error) {
    loggers.api.error('Memory compaction: generation error', {
      userId,
      field,
      error,
    });
    return content;
  }
}

/**
 * Check and compact all personalization fields for a user if needed.
 */
export async function checkAndCompactIfNeeded(
  userId: string
): Promise<{ compacted: boolean; fields: MemoryField[] }> {
  const current = await getCurrentPersonalizationPages(userId);

  const fieldsToCompact: MemoryField[] = [];

  for (const [field, content] of Object.entries(current) as [MemoryField, string][]) {
    if (content && needsCompaction(content, field)) {
      fieldsToCompact.push(field);
    }
  }

  if (fieldsToCompact.length === 0) {
    return { compacted: false, fields: [] };
  }

  loggers.api.info('Memory compaction: fields need compaction', {
    userId,
    fields: fieldsToCompact,
  });

  const compactedFields: MemoryField[] = [];

  for (const field of fieldsToCompact) {
    const originalContent = current[field] ?? '';
    const compactedContent = await compactField(userId, field, originalContent);

    if (compactedContent !== originalContent) {
      await updatePersonalizationPage(userId, field, compactedContent);
      compactedFields.push(field);
    }
  }

  return {
    compacted: compactedFields.length > 0,
    fields: compactedFields,
  };
}
