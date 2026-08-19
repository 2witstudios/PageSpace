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
  remoteRevision: number;
  detectedAt: number;
}

/** Body of the 409 response (`route.ts` returns error/currentRevision/expectedRevision). */
export interface ConflictResponseBody {
  error?: string;
  currentRevision?: number;
  expectedRevision?: number;
}

/** The refetched server page, or null when the refetch itself failed. */
export interface RemotePageSnapshot {
  content?: string | null;
  revision?: number;
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

  const remoteRevision = remotePage.revision ?? conflictBody?.currentRevision;

  if (remoteRevision === undefined) {
    return {
      kind: 'error',
      message:
        'Document was modified elsewhere and its version number is unknown. Your changes are still here — try saving again.',
    };
  }

  return {
    kind: 'conflict',
    conflict: {
      remoteContent: remotePage.content ?? '',
      remoteRevision,
      detectedAt,
    },
  };
}

export type ConflictResolutionChoice = 'keep-mine' | 'use-theirs';

export type ConflictResolutionPlan =
  | { action: 'save-local'; contentToSave: string; expectedRevision: number }
  | { action: 'adopt-remote'; contentToAdopt: string; revision: number };

export interface ConflictResolutionInput {
  localContent: string;
  conflict: DocumentConflict;
}

/**
 * What each resolution choice means, as data.
 *
 * `keep-mine` re-saves the local content with `expectedRevision` set to the
 * revision we just observed, so the retry compare-and-swaps against the version
 * that caused the conflict instead of the stale one. The other person's text is
 * not destroyed: every `applyPageMutation` writes a `page_versions` row, so
 * their revision is already in page history.
 */
export function planConflictResolution(
  choice: ConflictResolutionChoice,
  input: ConflictResolutionInput
): ConflictResolutionPlan {
  if (choice === 'keep-mine') {
    return {
      action: 'save-local',
      contentToSave: input.localContent,
      expectedRevision: input.conflict.remoteRevision,
    };
  }

  return {
    action: 'adopt-remote',
    contentToAdopt: input.conflict.remoteContent,
    revision: input.conflict.remoteRevision,
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
