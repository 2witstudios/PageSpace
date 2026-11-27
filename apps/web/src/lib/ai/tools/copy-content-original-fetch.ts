/**
 * A FILE page's original, fetched under the process-wide copy byte budget —
 * the production body of `copy_content`'s `fetchFileOriginal` dep.
 *
 * The page's recorded size is reserved BEFORE any byte arrives (the most one
 * copy can hold when the row has none), and the fetch is capped at exactly that
 * reservation, so a row that understates the file can never bring more into
 * memory than the budget accounted for. The reservation is handed back to the
 * caller on success, to free once the bytes are written onward, and given back
 * here on any failure or throw.
 */
import { holdUntilHandedOff, type ByteBudget } from './copy-byte-budget';
import type { CopyPageRecord } from './copy-content-tools';

export interface OriginalFetchEffects {
  budget: ByteBudget;
  fetchOriginal: (args: {
    pageId: string;
    filePath: string;
    maxBytes: number;
    deadlineAt: number;
  }) => Promise<{ success: true; bytes: Uint8Array } | { success: false; error: string; reason?: string }>;
  /** Largest file one copy moves (`MAX_BINARY_COPY_BYTES`). */
  maxCopyBytes: number;
  /** The agent-facing refusal when the budget has no room (`DENIAL_MESSAGES.copy_budget_exhausted`). */
  budgetExhaustedMessage: string;
}

export async function fetchOriginalUnderBudget(
  { page, deadlineAt }: { page: CopyPageRecord; deadlineAt: number },
  effects: OriginalFetchEffects,
): Promise<
  | { success: true; bytes: Uint8Array; release: () => void }
  | { success: false; error: string; reason?: string }
> {
  const filePath = page.filePath;
  if (!filePath) return { success: false, error: 'This upload has no stored file.' };
  // Refused before any byte moves when the row already says it is too big.
  if (typeof page.fileSize === 'number' && page.fileSize > effects.maxCopyBytes) {
    return {
      success: false,
      error: `"${page.title}" is ${page.fileSize} bytes, over the ${effects.maxCopyBytes}-byte limit for copying a file into the sandbox.`,
    };
  }
  const recordedSize = typeof page.fileSize === 'number' && page.fileSize > 0 ? page.fileSize : null;
  const reserveBytes = recordedSize ?? effects.maxCopyBytes;
  const { result, release } = await holdUntilHandedOff(effects.budget, async (reserve) => {
    if (!(await reserve(reserveBytes))) {
      return { success: false as const, error: effects.budgetExhaustedMessage, reason: 'copy_budget_exhausted' };
    }
    return effects.fetchOriginal({ pageId: page.id, filePath, maxBytes: reserveBytes, deadlineAt });
  });
  if (result.success) return { success: true, bytes: result.bytes, release };
  // The fetch was cut off at the ROW'S size, not at a limit: the row understates
  // the file. Say that, and name the limit that actually applies — reporting the
  // recorded size as "the limit" would send the agent after a limit that is not one.
  if (result.reason === 'over_limit' && recordedSize !== null) {
    return {
      success: false,
      reason: 'over_limit',
      error:
        `"${page.title}" is larger than its recorded size of ${recordedSize} bytes, so it was not copied ` +
        `(nothing was copied partially). One copy into the sandbox can move at most ${effects.maxCopyBytes} bytes; ` +
        `if the file is under that, its record is out of date — re-upload it, or ask for it to be reprocessed.`,
    };
  }
  return result;
}
