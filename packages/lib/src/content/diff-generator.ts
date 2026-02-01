/**
 * Budget-Aware Diff Generator
 *
 * Generates diffs within a token budget, prioritizing by importance.
 * Design principles:
 * - Budget-first: Never exceeds declared limits
 * - Priority-ordered: Most significant changes first
 * - Efficient: Stops early when budget exhausted, doesn't waste compute
 * - Consistent: Same budget = same output size (approximately)
 *
 * This is a reusable primitive for any AI tool that returns variable-length diffs.
 */

import { generateStackedDiff, type StackedDiff, type ActivityDiffGroup } from './activity-diff-utils';

/**
 * Budget configuration for diff generation
 */
export interface DiffBudget {
  /** Total characters available for all diffs combined */
  total: number;
  /** Maximum characters per individual diff */
  perItem: number;
  /** Minimum characters to bother generating a diff (default: 200) */
  minUseful?: number;
}

/**
 * Request for generating a diff
 */
export interface DiffRequest {
  /** Page ID */
  pageId: string;
  /** Content before the change */
  beforeContent: string | null;
  /** Content after the change */
  afterContent: string | null;
  /** Activity diff group metadata */
  group: ActivityDiffGroup;
  /** Drive ID for grouping */
  driveId: string;
  /** Higher = more important, generated first (default: change magnitude) */
  priority?: number;
}

/**
 * Estimates the change magnitude for prioritization.
 * Larger changes are typically more significant and should be shown first.
 */
export function estimateChangeMagnitude(
  beforeContent: string | null,
  afterContent: string | null
): number {
  const beforeLen = beforeContent?.length ?? 0;
  const afterLen = afterContent?.length ?? 0;

  // For new content (null -> something), use full length
  if (beforeLen === 0 && afterLen > 0) {
    return afterLen;
  }

  // For deleted content (something -> null), use full length
  if (beforeLen > 0 && afterLen === 0) {
    return beforeLen;
  }

  // For modifications, use absolute difference + some base for changed content
  // This ensures even small edits on large documents get some priority
  const lengthDiff = Math.abs(afterLen - beforeLen);
  const avgLen = (beforeLen + afterLen) / 2;

  // Weighted: length change matters most, but even unchanged-length edits
  // on large documents should rank higher than tiny documents
  return lengthDiff + Math.sqrt(avgLen);
}

/**
 * Truncates diff content to fit within character limit.
 * Tries to keep complete hunks where possible.
 */
function truncateDiffContent(diffContent: string, maxChars: number): string {
  if (diffContent.length <= maxChars) {
    return diffContent;
  }

  // Try to truncate at a hunk boundary
  const lines = diffContent.split('\n');
  const result: string[] = [];
  let currentLength = 0;
  const reserveForMessage = 50;

  for (const line of lines) {
    const lineWithNewline = line + '\n';

    if (currentLength + lineWithNewline.length > maxChars - reserveForMessage) {
      result.push('... [diff truncated - too large] ...');
      break;
    }

    result.push(line);
    currentLength += lineWithNewline.length;
  }

  return result.join('\n');
}

/**
 * Generates diffs within a token budget.
 *
 * Returns diffs in priority order (highest priority first) until budget exhausted.
 * Each diff is truncated to fit within per-item budget if needed.
 *
 * @param requests - Diff requests with content and metadata
 * @param budget - Budget constraints
 * @returns Array of generated diffs within budget
 */
export function generateDiffsWithinBudget(
  requests: DiffRequest[],
  budget: DiffBudget
): (StackedDiff & { driveId: string })[] {
  if (requests.length === 0) {
    return [];
  }

  const minUseful = budget.minUseful ?? 200;
  const results: (StackedDiff & { driveId: string })[] = [];
  let usedBudget = 0;

  // Calculate priorities if not provided
  const requestsWithPriority = requests.map((req) => ({
    ...req,
    priority: req.priority ?? estimateChangeMagnitude(req.beforeContent, req.afterContent),
  }));

  // Sort by priority descending (most significant first)
  const sorted = [...requestsWithPriority].sort((a, b) => b.priority - a.priority);

  for (const request of sorted) {
    // Calculate remaining budget for this item
    const remainingTotal = budget.total - usedBudget;
    const remainingPerItem = Math.min(budget.perItem, remainingTotal);

    // Stop if we can't fit a useful diff
    if (remainingPerItem < minUseful) {
      break;
    }

    // Generate the diff
    const diff = generateStackedDiff(
      request.beforeContent,
      request.afterContent,
      request.group
    );

    if (!diff) {
      continue;
    }

    // Truncate if needed
    let unifiedDiff = diff.unifiedDiff;
    if (unifiedDiff.length > remainingPerItem) {
      unifiedDiff = truncateDiffContent(unifiedDiff, remainingPerItem);
    }

    // Add to results
    results.push({
      ...diff,
      unifiedDiff,
      driveId: request.driveId,
    });

    usedBudget += unifiedDiff.length;
  }

  return results;
}

/**
 * Async generator version for streaming use cases.
 *
 * Yields diffs one at a time in priority order, stopping when budget exhausted.
 * Useful for streaming responses where you want to start sending results
 * before all diffs are generated.
 *
 * @param requests - Diff requests with content and metadata
 * @param budget - Budget constraints
 * @yields Generated diffs one at a time
 */
export async function* streamDiffsWithinBudget(
  requests: DiffRequest[],
  budget: DiffBudget
): AsyncGenerator<StackedDiff & { driveId: string }, void, unknown> {
  if (requests.length === 0) {
    return;
  }

  const minUseful = budget.minUseful ?? 200;
  let usedBudget = 0;

  // Calculate priorities if not provided
  const requestsWithPriority = requests.map((req) => ({
    ...req,
    priority: req.priority ?? estimateChangeMagnitude(req.beforeContent, req.afterContent),
  }));

  // Sort by priority descending
  const sorted = [...requestsWithPriority].sort((a, b) => b.priority - a.priority);

  for (const request of sorted) {
    const remainingTotal = budget.total - usedBudget;
    const remainingPerItem = Math.min(budget.perItem, remainingTotal);

    if (remainingPerItem < minUseful) {
      return;
    }

    const diff = generateStackedDiff(
      request.beforeContent,
      request.afterContent,
      request.group
    );

    if (!diff) {
      continue;
    }

    let unifiedDiff = diff.unifiedDiff;
    if (unifiedDiff.length > remainingPerItem) {
      unifiedDiff = truncateDiffContent(unifiedDiff, remainingPerItem);
    }

    usedBudget += unifiedDiff.length;

    yield {
      ...diff,
      unifiedDiff,
      driveId: request.driveId,
    };
  }
}

/**
 * Calculates optimal budget allocation based on maxOutputChars.
 *
 * Allocates a portion of the total output budget to diffs,
 * leaving room for metadata, actors, and other response fields.
 *
 * @param maxOutputChars - Total output character limit
 * @returns Budget configuration
 */
export function calculateDiffBudget(maxOutputChars: number): DiffBudget {
  // Allocate ~40% of output budget to diffs
  // This leaves room for metadata, actors, drive info, etc.
  const totalDiffBudget = Math.floor(maxOutputChars * 0.4);

  // Per-item limit: 10% of total output (~25% of diff budget)
  // This ensures no single diff dominates the output
  const perItemBudget = Math.floor(maxOutputChars * 0.1);

  return {
    total: totalDiffBudget,
    perItem: perItemBudget,
    minUseful: 200,
  };
}
