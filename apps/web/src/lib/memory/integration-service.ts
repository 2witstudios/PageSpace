/**
 * Memory Integration Service
 *
 * Evaluates promoted candidates against the user's current personalization pages
 * and applies updates via whole-field rewrite (not append).
 *
 * Includes two deterministic guards to prevent destructive rewrites:
 * 1. 40% deletion guard — rejects any rewrite that deletes more than 40% of existing content
 * 2. Per-field budget guard — rejects rewrites exceeding the size limit
 */

import { and, eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages, drives } from '@pagespace/db/schema/core';
import { userPersonalization, personalizationCandidates } from '@pagespace/db/schema/personalization';
import { generateText } from 'ai';
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { BACKGROUND_HEAVY_PROVIDER, BACKGROUND_HEAVY_MODEL } from '@/lib/ai/core/ai-providers-config';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { readMemoryPages } from '@pagespace/lib/memory/memory-pages';
import {
  applyPageMutation,
  PageRevisionMismatchError,
} from '@/services/api/page-mutation-service';

export type MemoryField = 'bio' | 'writingStyle' | 'rules';

// Injection budgets — enforced at read time in personalization-utils
const MAX_FIELD_LENGTHS: Record<MemoryField, number> = {
  bio: 3000,
  writingStyle: 2500,
  rules: 2500,
};

/**
 * Fetch the current personalization page content for a user.
 *
 * Thin alias over the shared reader so the cron and the prompt-injection path
 * cannot drift apart in what "the user's current profile" means.
 */
export async function getCurrentPersonalizationPages(
  userId: string
): Promise<Partial<Record<MemoryField, string>>> {
  return readMemoryPages(userId);
}

/** Column on `user_personalization` holding each field's page pointer. */
const POINTER_COLUMN = {
  bio: userPersonalization.bioPageId,
  writingStyle: userPersonalization.writingStylePageId,
  rules: userPersonalization.rulesPageId,
} as const;

/**
 * Overwrite a single memory page with new content.
 *
 * Routed through `applyPageMutation` rather than writing `pages.content`
 * directly, for three reasons:
 *
 *  - **A user can be editing the page while the cron runs.** Passing
 *    `expectedRevision` makes the write fail rather than silently discard an
 *    edit made between our read and our write. Losing what someone typed into
 *    their own memory page is worse than skipping a nightly update, so a
 *    mismatch is treated as "not written" and the candidates stay pending.
 *  - It keeps `revision`/`stateHash` coherent, which every other writer and
 *    the realtime layer depend on.
 *  - It records page-version and activity entries, so a background rewrite of
 *    the user's own page is visible in history rather than appearing from
 *    nowhere.
 *
 * A missing pointer, or a pointer to a trashed page, is a no-op: the user
 * deleted that page and the cron does not resurrect it.
 */
export async function updatePersonalizationPage(
  userId: string,
  field: MemoryField,
  newContent: string
): Promise<{ written: boolean; reason?: string }> {
  const [personalization] = await db
    .select({ pageId: POINTER_COLUMN[field] })
    .from(userPersonalization)
    .where(eq(userPersonalization.userId, userId))
    .limit(1);

  const pageId = personalization?.pageId;
  if (!pageId) {
    loggers.api.warn('Memory integration: no page pointer for field', {
      userId,
      field,
    });
    return { written: false, reason: 'no page pointer (backfill has not run for this user)' };
  }

  // Read the revision we are writing against, and confirm the page is still
  // live AND still inside this user's own Home drive.
  //
  // The drive join is defence in depth rather than a fix for a reachable bug:
  // the pointer is only ever set server-side by `provisionMemoryPages`. But
  // this function will happily write whatever page id that column names, and
  // `readMemoryPages` already scopes its reads by drive — leaving the WRITE
  // unscoped is the kind of asymmetry that turns a future bug (a bad backfill,
  // a page moved between drives) into writing one person's profile into
  // someone else's page.
  const [page] = await db
    .select({ revision: pages.revision, isTrashed: pages.isTrashed })
    .from(pages)
    .innerJoin(drives, eq(drives.id, pages.driveId))
    .where(
      and(
        eq(pages.id, pageId),
        eq(drives.ownerId, userId),
        eq(drives.kind, 'HOME'),
      )
    )
    .limit(1);

  if (!page || page.isTrashed) {
    loggers.api.warn('Memory integration: page pointer is stale, trashed, or out of scope', {
      userId,
      field,
      pageId,
    });
    return { written: false, reason: 'page is trashed or no longer exists' };
  }

  try {
    await applyPageMutation({
      pageId,
      operation: 'update',
      updates: { content: newContent },
      updatedFields: ['content'],
      expectedRevision: page.revision,
      context: {
        userId,
        isAiGenerated: true,
        changeGroupType: 'automation',
        metadata: { source: 'memory-cron', memoryField: field },
      },
    });
  } catch (error) {
    if (error instanceof PageRevisionMismatchError) {
      // The user edited the page while this run was deciding. Their edit wins;
      // the candidates stay pending and the next run re-evaluates against what
      // they actually wrote.
      loggers.api.info('Memory integration: page changed mid-run, deferring to the user edit', {
        userId,
        field,
        pageId,
      });
      return { written: false, reason: 'page was edited during this run' };
    }
    throw error;
  }

  // Retire the legacy column for this field now that a page holds the content.
  //
  // The column is a one-way fallback for users the backfill has not reached,
  // NOT a shadow copy that outlives the page. Leaving it populated is a latent
  // privacy leak with a real trigger: `purgeExpiredTrashedPages` hard-deletes a
  // trashed page 30 days on, `ON DELETE SET NULL` clears the pointer, and the
  // pointer-absent branch in `getUserPersonalization` then reads the column
  // again — resurrecting, weeks later, exactly the content the user deleted the
  // page to be rid of.
  await db
    .update(userPersonalization)
    .set({ [field]: null, updatedAt: new Date() })
    .where(eq(userPersonalization.userId, userId));

  return { written: true };
}

/**
 * The outcome of one evaluation run.
 *
 * `ok: false` means the evaluator never reached a decision — provider error,
 * generation failure, or an unparseable response. That is deliberately NOT the
 * same shape as "decided to change nothing": a transient model outage must
 * leave candidates pending for the next run rather than permanently retiring
 * every ready claim the user has accumulated.
 */
export type EvaluationOutcome =
  | {
      ok: true;
      /** Full replacement content, per field the evaluator chose to rewrite. */
      updates: Partial<Record<MemoryField, string>>;
      /** IDs of the candidates the evaluator actually used. */
      usedCandidateIds: string[];
    }
  | { ok: false; reason: string };

/**
 * Evaluate promoted candidates and decide how to integrate.
 *
 * Returns the FULL new content for each field that changes, instructed to
 * preserve every line it is not explicitly superseding, plus the specific
 * candidate IDs it drew on so the caller can settle them individually.
 */
export async function evaluateAndIntegrate(
  userId: string,
  candidates: typeof personalizationCandidates.$inferSelect[],
  currentPages: Partial<Record<MemoryField, string>>
): Promise<EvaluationOutcome> {
  if (candidates.length === 0) {
    return { ok: true, updates: {}, usedCandidateIds: [] };
  }

  const current = {
    bio: currentPages.bio ?? '',
    writingStyle: currentPages.writingStyle ?? '',
    rules: currentPages.rules ?? '',
  };

  // Group candidates by field.
  //
  // `field` is a free-form text column, so the guard checks membership in an
  // explicit set rather than using `in`, which also matches inherited keys:
  // a row whose field read `toString` would pass `in`, resolve `byField[field]`
  // to a function, and throw on `.push` — aborting the whole evaluation run.
  const byField: Record<MemoryField, typeof candidates> = {
    bio: [],
    writingStyle: [],
    rules: [],
  };
  const KNOWN_FIELDS = new Set<string>(['bio', 'writingStyle', 'rules']);

  for (const candidate of candidates) {
    if (!KNOWN_FIELDS.has(candidate.field)) {
      loggers.api.warn('Memory integration: candidate has an unrecognised field', {
        userId,
        candidateId: candidate.id,
        field: candidate.field,
      });
      continue;
    }
    byField[candidate.field as MemoryField].push(candidate);
  }

  const EVALUATOR_SYSTEM_PROMPT = `You are deciding how to update a user's personalization profile based on newly-learned information.

The profile exists to make every AI conversation feel personal — like the AI already knows who this person is. These are living documents stored as pages in the user's workspace, so they must remain accurate and concise.

QUALITY GATES (apply in order — fail any gate = do NOT use this candidate):
0. ACTIONABILITY: Would knowing this change how the AI behaves? If no, skip.
1. PORTABILITY: Would this still apply if the person was working on a completely different project? If no, skip.
2. PERSONHOOD: Does this describe the person, or just a decision they made in a specific context? Skip project-specific decisions.
3. NOVELTY: Is this already captured in the current profile (even if worded differently)? If yes, skip.
4. CONSISTENCY: Does this contradict something already in the profile? If yes, skip — never append conflicting statements.
5. ATTRIBUTION: Is this a verifiable fact about the user, or a self-reported claim? Self-claims about credentials, metrics, or rankings must be marked as "claimed" not proven. Never record numeric self-claims as facts.

For each field, output the FULL NEW CONTENT — the complete page, not just the new text. Your job is to:
- PRESERVE every existing line that is still accurate
- SUPPLEMENT lines with related new insights (group related points together)
- REMOVE lines that are superseded by newer, more accurate information
- REORGANIZE into a coherent structure (prose or bullets, whichever fits)

Each candidate insight below is numbered like [3]. Report which ones you actually used.

Return JSON with this structure:
{
  "bio": "full new bio content or null if unchanged",
  "writingStyle": "full new writing style content or null if unchanged",
  "rules": "full new rules content or null if unchanged",
  "usedInsights": [3, 7]
}

"usedInsights" must list the number of every insight whose content you incorporated. Omit the numbers you decided to skip — they are recorded as declined.

Remember: You are writing the COMPLETE page, not just additions. Preserve what matters, remove what doesn't.`;

  const providerResult = await createAIProvider(userId, {
    selectedProvider: BACKGROUND_HEAVY_PROVIDER,
    selectedModel: BACKGROUND_HEAVY_MODEL,
  });

  if (isProviderError(providerResult)) {
    loggers.api.error('Memory integration: provider error', {
      error: providerResult.error,
    });
    return { ok: false, reason: 'provider error' };
  }

  // Number every candidate so the evaluator can cite which it used. Indices are
  // stable for this call only; they never leave this function.
  const numbered = candidates.map((c, i) => ({ index: i, candidate: c }));
  const byIndex = new Map(numbered.map((n) => [n.index, n.candidate.id]));

  try {
    // Build candidates text
    const candidatesByField = (Object.keys(byField) as MemoryField[])
      .filter((field) => byField[field].length > 0)
      .map((field) => {
        const items = numbered
          .filter((n) => n.candidate.field === field)
          .map(({ index, candidate: c }) =>
            // Fixed UTC formatting: toLocaleDateString() varies with host
            // locale and timezone, which makes prompts non-reproducible and
            // can name a different calendar day than the UTC-day rule the
            // candidate service enforces.
            `[${index}] ${c.claim} (seen on ${c.occurrences} separate days, first: ${new Date(c.firstSeenAt).toISOString().slice(0, 10)})`
          )
          .join('\n');
        return `NEW ${field.toUpperCase()} INSIGHTS:\n${items}`;
      })
      .join('\n\n');

    const currentProfileText = `
CURRENT BIO:
${current.bio || '(empty)'}

CURRENT WRITING STYLE:
${current.writingStyle || '(empty)'}

CURRENT RULES:
${current.rules || '(empty)'}
`;

    const result = await generateText({
      model: providerResult.model,
      system: EVALUATOR_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Evaluate these newly-learned insights against the current profile and produce updated page content where appropriate.

${currentProfileText}

${candidatesByField}

Return JSON with the full new content for each field that should change. Use null for unchanged fields.`,
        },
      ],
      temperature: 0.2,
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
      metadata: { feature: 'memory_integration' },
    });

    const text = result.text.trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : text;

    try {
      const parsed = JSON.parse(jsonStr);
      const updates: Partial<Record<MemoryField, string>> = {};

      for (const field of ['bio', 'writingStyle', 'rules'] as const) {
        if (parsed[field] && typeof parsed[field] === 'string') {
          updates[field] = parsed[field];
        }
      }

      // Map the cited indices back to candidate IDs. Anything the evaluator
      // did not cite is treated as declined by the caller.
      const usedCandidateIds: string[] = Array.isArray(parsed.usedInsights)
        ? [
            ...new Set(
              (parsed.usedInsights as unknown[])
                .filter((i): i is number => Number.isInteger(i))
                .map((i) => byIndex.get(i))
                .filter((id): id is string => id !== undefined)
            ),
          ]
        : [];

      return { ok: true, updates, usedCandidateIds };
    } catch {
      loggers.api.warn('Memory integration: failed to parse decision', {
        userId,
        response: text.substring(0, 500),
      });
      return { ok: false, reason: 'unparseable evaluator response' };
    }
  } catch (error) {
    loggers.api.error('Memory integration: generation error', { userId, error });
    return { ok: false, reason: 'generation error' };
  }
}

/**
 * Apply integration decisions with guards.
 *
 * 1. 40% deletion guard: reject if more than 40% of existing content deleted
 * 2. Per-field budget guard: reject if exceeds max length
 */
export async function applyIntegrationDecisions(
  userId: string,
  updates: Partial<Record<MemoryField, string>>,
  currentPages: Partial<Record<MemoryField, string>>
): Promise<{
  updated: boolean;
  fields: MemoryField[];
  /** Fields a guard refused to write, with why. Structured so callers can act on the field. */
  rejected: { field: MemoryField; reason: string }[];
}> {
  const updatedFields: MemoryField[] = [];
  const rejected: { field: MemoryField; reason: string }[] = [];

  for (const [field, newContent] of Object.entries(updates) as [MemoryField, string][]) {
    const verdict = screenRewrite(field, currentPages[field] ?? '', newContent);

    if (!verdict.ok) {
      rejected.push({ field, reason: verdict.reason });
      loggers.api.warn('Memory integration: rewrite rejected', {
        userId,
        field,
        reason: verdict.reason,
        currentLength: (currentPages[field] ?? '').length,
        newLength: newContent.length,
      });
      continue;
    }

    // A field counts as updated only when a row actually changed. Reporting a
    // write that never landed would make the caller retire the candidates
    // behind it, losing claims for every user whose backfill has not run or
    // who has trashed the page.
    //
    // A thrown write is contained rather than propagated: one field failing
    // must not discard the settlement information for the fields that already
    // succeeded, which the caller needs to decide what to retire.
    let result: { written: boolean; reason?: string };
    try {
      result = await updatePersonalizationPage(userId, field, newContent);
    } catch (error) {
      loggers.api.error('Memory integration: page write threw', { userId, field, error });
      result = { written: false, reason: 'write failed' };
    }

    if (result.written) {
      updatedFields.push(field);
    } else {
      rejected.push({ field, reason: result.reason ?? 'write did not affect any row' });
    }
  }

  return {
    updated: updatedFields.length > 0,
    fields: updatedFields,
    rejected,
  };
}

/** Fraction of a page the evaluator may drop in a single run. */
const MAX_DELETION_RATIO = 0.4;

export type RewriteVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether a proposed whole-page rewrite may be written.
 *
 * Whole-page rewrite is what lets memory correct and forget rather than only
 * accumulate — but it also means one bad generation can wipe a page the user
 * hand-wrote. These two guards bound that blast radius deterministically,
 * without asking a model to police itself.
 *
 * The shrink check is deliberately a LENGTH heuristic, not a diff: it catches
 * the failure that actually happens (the model returns a summary, or a fragment,
 * instead of the full page) and does not pretend to catch a same-length rewrite
 * that replaces meaning. Compaction is the sanctioned way to shrink a page, and
 * it writes through `updatePersonalizationPage` directly rather than here.
 */
export function screenRewrite(
  field: MemoryField,
  current: string,
  next: string
): RewriteVerdict {
  if (current.length > 0 && next.length < current.length * (1 - MAX_DELETION_RATIO)) {
    return {
      ok: false,
      reason: `would delete >${Math.round(MAX_DELETION_RATIO * 100)}% of existing content`,
    };
  }

  const maxLength = MAX_FIELD_LENGTHS[field];
  if (next.length > maxLength) {
    return { ok: false, reason: `exceeds ${maxLength} char limit` };
  }

  return { ok: true };
}
