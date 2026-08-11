/**
 * Personalization utilities for AI system prompt injection.
 *
 * The profile content lives as pages in the user's Home drive (see
 * `@pagespace/lib/memory/memory-pages`). This module reads those pages and
 * enforces the injection budget, since a page — unlike the old settings
 * textarea — has no server-side length cap of its own.
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { userPersonalization } from '@pagespace/db/schema/personalization';
import { readMemoryPages } from '@pagespace/lib/memory/memory-pages';
import {
  MAX_FIELD_LENGTH,
  MAX_TOTAL_INJECTION_LENGTH,
  type MemoryField,
} from '@/lib/memory/budgets';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isValidTimezone, normalizeTimezone } from './timestamp-utils';
import type { PersonalizationInfo } from './system-prompt';

// Budgets live in one place; see budgets.ts for why all three consumers must agree.
const TRUNCATION_MARKER = '\n[truncated]';

const FIELD_ORDER: readonly MemoryField[] = ['rules', 'writingStyle', 'bio'];

/**
 * Truncate on a line boundary where possible.
 *
 * Cutting mid-line can leave a negated instruction reading as its opposite
 * ("Never use em dashes" → "Never use em"), so prefer dropping the partial
 * trailing line entirely.
 */
function truncateField(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;

  const budget = maxLength - TRUNCATION_MARKER.length;
  const clipped = content.slice(0, Math.max(0, budget));
  const lastBreak = clipped.lastIndexOf('\n');
  const body = lastBreak > budget * 0.5 ? clipped.slice(0, lastBreak) : clipped;

  return body.trimEnd() + TRUNCATION_MARKER;
}

/**
 * Fetch user personalization for prompt injection.
 *
 * Returns null when personalization is disabled, unconfigured, or empty.
 * Errors are swallowed — personalization is optional and must never take a
 * conversation down with it.
 */
export async function getUserPersonalization(
  userId: string
): Promise<PersonalizationInfo | null> {
  try {
    const personalization = await db.query.userPersonalization.findFirst({
      where: eq(userPersonalization.userId, userId),
      columns: {
        enabled: true,
        bio: true,
        writingStyle: true,
        rules: true,
        bioPageId: true,
        writingStylePageId: true,
        rulesPageId: true,
      },
    });

    if (!personalization || !personalization.enabled) {
      return null;
    }

    const pageContent = await readMemoryPages(userId);

    /**
     * The legacy column is a fallback for users the backfill has not reached —
     * NOT a shadow copy that outlives the page.
     *
     * Keyed on whether a pointer EXISTS, not on whether content came back.
     * `readMemoryPages` omits a page that has been trashed or deleted, so
     * falling back on missing content would resurrect the pre-deletion text
     * and keep injecting it into every prompt after the user deleted the page
     * to stop exactly that. A present pointer therefore means "the page is the
     * source of truth", and an empty result from it means empty.
     */
    const legacyFor = (field: MemoryField, pointer: string | null): string => {
      if (pointer) return pageContent[field] ?? '';
      return pageContent[field] ?? personalization[field] ?? '';
    };

    const raw: Record<MemoryField, string> = {
      bio: legacyFor('bio', personalization.bioPageId),
      writingStyle: legacyFor('writingStyle', personalization.writingStylePageId),
      rules: legacyFor('rules', personalization.rulesPageId),
    };

    // Per-field budget.
    const trimmed: Record<MemoryField, string> = {
      bio: truncateField(raw.bio.trim(), MAX_FIELD_LENGTH.bio),
      writingStyle: truncateField(raw.writingStyle.trim(), MAX_FIELD_LENGTH.writingStyle),
      rules: truncateField(raw.rules.trim(), MAX_FIELD_LENGTH.rules),
    };

    const fieldTruncated =
      trimmed.bio.length < raw.bio.trim().length ||
      trimmed.writingStyle.length < raw.writingStyle.trim().length ||
      trimmed.rules.length < raw.rules.trim().length;

    // Total budget. Spend it in priority order — rules and writing style change
    // AI behaviour directly, bio is context — rather than scaling every field
    // down proportionally, which would corrupt all three at once.
    let remaining = MAX_TOTAL_INJECTION_LENGTH;
    const budgeted: Partial<Record<MemoryField, string>> = {};
    let overBudget = false;

    for (const field of FIELD_ORDER) {
      const value = trimmed[field];
      if (!value) continue;

      if (value.length <= remaining) {
        budgeted[field] = value;
        remaining -= value.length;
        continue;
      }

      overBudget = true;
      if (remaining > TRUNCATION_MARKER.length * 4) {
        budgeted[field] = truncateField(value, remaining);
      }
      remaining = 0;
    }

    // Warn when EITHER budget cut content. A field trimmed to its own limit
    // that then fits the total would otherwise truncate silently, which is the
    // case most likely to surprise a user who wrote a long page by hand.
    if (overBudget || fieldTruncated) {
      loggers.api.warn('Personalization truncated to fit the injection budget', {
        userId,
        fieldBudgetTruncated: fieldTruncated,
        totalBudgetTruncated: overBudget,
        totalLimit: MAX_TOTAL_INJECTION_LENGTH,
      });
    }

    if (!budgeted.bio && !budgeted.writingStyle && !budgeted.rules) {
      return null;
    }

    return {
      bio: budgeted.bio,
      writingStyle: budgeted.writingStyle,
      rules: budgeted.rules,
      enabled: true,
    };
  } catch (error) {
    loggers.api.error('Failed to fetch user personalization', { userId, error });
    return null;
  }
}

/**
 * Fetch user's IANA timezone from the database.
 * Returns undefined if not set or on error.
 */
export async function getUserTimezone(
  userId: string
): Promise<string | undefined> {
  try {
    const [user] = await db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId));
    return user?.timezone ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the timezone a route handler should interpret a request in:
 * an explicit value from the caller, else the caller's stored profile
 * timezone, else UTC.
 *
 * The AI tool path gets this for free — chat routes load the profile timezone
 * into `ToolExecutionContext.timezone` and the tools read it. Direct REST
 * callers (the SDK, integrations, the web UI) have no such context, so a route
 * that defaults straight to `'UTC'` silently offsets every wall-clock time
 * those callers send and stamps `'UTC'` on the stored record. This is the
 * route-handler equivalent of that context lookup.
 *
 * An explicit value that isn't a valid IANA zone falls through to the profile
 * rather than being stored as-is.
 */
export async function resolveRequestTimezone(
  explicitTimezone: unknown,
  userId: string,
): Promise<string> {
  if (typeof explicitTimezone === 'string') {
    const trimmed = explicitTimezone.trim();
    if (trimmed && isValidTimezone(trimmed)) return trimmed;
  }
  return normalizeTimezone(await getUserTimezone(userId));
}
