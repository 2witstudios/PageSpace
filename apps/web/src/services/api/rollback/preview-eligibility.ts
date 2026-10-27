/**
 * Preview eligibility and construction.
 *
 * Pure decisions extracted from previewActivityAction: whether an activity is
 * eligible to be rolled back/redone at all (before any current-state DB read),
 * how a create no-op resolves (silently skippable inside an undo group vs a
 * user-facing error outside one — ai-undo-service depends on this split), and a
 * factory that fills the preview defaults. The DB reads stay in the shell.
 */
import type { ActivityAction, ActivityActionPreview, ActivityChangeSummary } from '@/types/activity-actions';
import type { ActivityOperation } from '@pagespace/lib/monitoring/activity-logger';

/** The immutable parts of a preview shared by every branch. */
export interface PreviewBase {
  action: ActivityAction;
  targetValues: Record<string, unknown> | null;
  changes: ActivityChangeSummary[];
  affectedResources: { type: string; id: string; title: string }[];
}

/** Build a full preview from the shared base plus per-branch overrides. */
export function buildPreview(
  base: PreviewBase,
  overrides: Partial<ActivityActionPreview>
): ActivityActionPreview {
  return {
    action: base.action,
    canExecute: false,
    reason: undefined,
    warnings: [],
    hasConflict: false,
    conflictFields: [],
    requiresForce: false,
    isNoOp: false,
    currentValues: null,
    targetValues: base.targetValues,
    changes: base.changes,
    affectedResources: base.affectedResources,
    ...overrides,
  };
}

export interface EligibilityContext {
  action: ActivityAction;
  rollingBackRollback: boolean;
  effectiveOperation: ActivityOperation | null;
  isRollbackable: boolean;
  hasTargetValues: boolean;
  hasContentSnapshot: boolean;
  allowMissingTarget: boolean;
}

export type EligibilityResult =
  | { kind: 'proceed' }
  | { kind: 'reject'; reason: string };

/**
 * Decide whether an activity may proceed past the pre-fetch gate. Assumes the
 * activity exists (the shell guards null separately for type-narrowing). A
 * create needs no previous state, so it skips the missing-target check.
 */
export function evaluateEligibility(ctx: EligibilityContext): EligibilityResult {
  if (!ctx.effectiveOperation) {
    return {
      kind: 'reject',
      reason: ctx.rollingBackRollback
        ? 'Rollback source operation not available'
        : 'Operation not available',
    };
  }

  if (!ctx.isRollbackable) {
    return { kind: 'reject', reason: `Cannot ${ctx.action} '${ctx.effectiveOperation}' operations` };
  }

  if (
    ctx.effectiveOperation !== 'create' &&
    !ctx.hasTargetValues &&
    !ctx.hasContentSnapshot &&
    !ctx.allowMissingTarget
  ) {
    return {
      kind: 'reject',
      reason: ctx.rollingBackRollback
        ? 'No rollback state available to reapply'
        : 'No values to restore',
    };
  }

  return { kind: 'proceed' };
}

export type CreateNoOpResult =
  | { kind: 'not-noop' }
  | { kind: 'skippable' }
  | { kind: 'error'; reason: string };

/**
 * Resolve a create rollback that is already in its desired state. Inside an undo
 * group where skipping is allowed (page) it is silently skippable; otherwise it
 * is a user-facing error naming whether the resource is already trashed or
 * already restored.
 */
export function evaluateCreateNoOp(params: {
  isCreateNoOp: boolean;
  shouldBeTrashed: boolean;
  hasUndoGroup: boolean;
  allowUndoGroupSkip: boolean;
  trashedReason: string;
  restoredReason: string;
}): CreateNoOpResult {
  if (!params.isCreateNoOp) {
    return { kind: 'not-noop' };
  }
  if (params.hasUndoGroup && params.allowUndoGroupSkip) {
    return { kind: 'skippable' };
  }
  return {
    kind: 'error',
    reason: params.shouldBeTrashed ? params.trashedReason : params.restoredReason,
  };
}
