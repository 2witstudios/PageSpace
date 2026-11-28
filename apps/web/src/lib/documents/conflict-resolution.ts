/**
 * Pure decision core for save conflicts (HTTP 409 on PATCH /api/pages/[pageId]).
 *
 * The rule this module exists to enforce: a 409 NEVER replaces the user's
 * buffer. The server's copy is parked alongside the local one until the user
 * picks a side. Everything here is pure — no zustand, no sonner, no fetch —
 * so the effectful shell (useDocument) stays a thin translation layer.
 */

/** The server's copy, parked while the user decides what to do with it. */
export interface DocumentConflict {
  remoteContent: string;
  remoteContentRevision: number;
  remoteContentMode?: 'html' | 'markdown';
  detectedAt: number;
}

/** Body of the 409 response (`route.ts` returns error and the revisions). */
export interface ConflictResponseBody {
  error?: string;
  currentContentRevision?: number;
  expectedContentRevision?: number;
}

/** The refetched server page, or null when the refetch itself failed. */
export interface RemotePageSnapshot {
  content?: string | null;
  contentRevision?: number;
  contentMode?: 'html' | 'markdown';
}

/**
 * The result of reading a content field that may be absent OR explicitly empty.
 *
 * These two are NOT the same and conflating them is destructive in both
 * directions: an absent REMOTE content coerced to '' lets "Use theirs" wipe the
 * user's text, and an absent LOCAL content coerced to '' lets "Keep mine" save
 * an empty document over someone else's work. `?? ''` cannot express the
 * difference, so it is banned at these boundaries — use `readContent`.
 */
export type ContentRead = { present: true; content: string } | { present: false };

/** `null` means an empty document. `undefined` means we do not have it. */
export function readContent(content: string | null | undefined): ContentRead {
  if (content === undefined) return { present: false };
  return { present: true, content: content ?? '' };
}

export type ConflictDecision =
  | { kind: 'conflict'; conflict: DocumentConflict }
  | { kind: 'error'; message: string };

export interface ConflictDecisionInput {
  conflictBody: ConflictResponseBody | null;
  remotePage: RemotePageSnapshot | null;
  detectedAt: number;
}

/**
 * Turn a 409 (plus whatever the follow-up refetch produced) into either a
 * parked conflict or a plain error.
 *
 * A conflict is only offerable when we have BOTH the server's content (to show
 * under "Use theirs") and its revision (so "Keep mine" can re-save against a
 * revision that cannot 409 again). Missing either, we report an error and leave
 * the local buffer dirty — the user's text is never the thing we drop.
 */
export function decideConflictOutcome(input: ConflictDecisionInput): ConflictDecision {
  const { conflictBody, remotePage, detectedAt } = input;

  if (!remotePage) {
    return {
      kind: 'error',
      message:
        'Document was modified elsewhere and the current version could not be loaded. Your changes are still here — try saving again.',
    };
  }

  const remote = readContent(remotePage.content);
  if (!remote.present) {
    return {
      kind: 'error',
      message:
        'Document was modified elsewhere and the current version could not be read. Your changes are still here — try saving again.',
    };
  }

  const remoteContentRevision = remotePage.contentRevision ?? conflictBody?.currentContentRevision;

  if (remoteContentRevision === undefined) {
    return {
      kind: 'error',
      message:
        'Document was modified elsewhere and its version number is unknown. Your changes are still here — try saving again.',
    };
  }

  return {
    kind: 'conflict',
    conflict: {
      remoteContent: remote.content,
      remoteContentRevision,
      ...(remotePage.contentMode !== undefined ? { remoteContentMode: remotePage.contentMode } : {}),
      detectedAt,
    },
  };
}

export type ConflictResolutionChoice = 'keep-mine' | 'use-theirs';

export type ConflictResolutionPlan =
  | { action: 'save-local'; contentToSave: string; expectedContentRevision: number }
  | { action: 'adopt-remote'; contentToAdopt: string; contentRevision: number; contentMode?: 'html' | 'markdown' };

export interface ConflictResolutionInput {
  localContent: string;
  conflict: DocumentConflict;
}

/**
 * What each resolution choice means, as data.
 *
 * `keep-mine` re-saves the local content with `expectedContentRevision` set to the
 * revision we just observed, so the retry compare-and-swaps against the version
 * that caused the conflict instead of the stale one.
 *
 * `keep-mine` IS destructive to the other person's text from the user's point of
 * view, and the UI must say so. Every `applyPageMutation` does write a
 * `page_versions` row, so their revision is durably stored — but that is an
 * operator-level fact, not a recovery path: `history/route.ts` is GET-only,
 * there is no restore endpoint, no UI reads page history, and the rows expire
 * after 30 days. Do not turn this into a reassurance to the user that their
 * colleague's version can be recovered. Instead the banner shows the parked
 * remote content inline so the choice is informed. (Multiplayer Documents epic,
 * Phase A — task `jc5su9gmeohiyo3ulzu7o143`.)
 */
export function planConflictResolution(
  choice: ConflictResolutionChoice,
  input: ConflictResolutionInput
): ConflictResolutionPlan {
  if (choice === 'keep-mine') {
    return {
      action: 'save-local',
      contentToSave: input.localContent,
      expectedContentRevision: input.conflict.remoteContentRevision,
    };
  }

  return {
    action: 'adopt-remote',
    contentToAdopt: input.conflict.remoteContent,
    contentRevision: input.conflict.remoteContentRevision,
    ...(input.conflict.remoteContentMode !== undefined ? { contentMode: input.conflict.remoteContentMode } : {}),
  };
}

/**
 * Whether the autosave loop may fire a PATCH.
 *
 * While a conflict is parked, the local revision is known-stale: another PATCH
 * would 409 again, re-park, and (because typing keeps rescheduling the debounce)
 * loop forever. Saves resume once the user resolves.
 */
export function canScheduleSave(input: { hasPendingConflict: boolean }): boolean {
  return !input.hasPendingConflict;
}
