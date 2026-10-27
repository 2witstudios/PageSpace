import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import {
  buildPreview,
  evaluateEligibility,
  evaluateCreateNoOp,
  type EligibilityContext,
} from '../preview-eligibility';

function ctx(overrides: Partial<EligibilityContext> = {}): EligibilityContext {
  return {
    action: 'rollback',
    rollingBackRollback: false,
    effectiveOperation: 'update',
    isRollbackable: true,
    hasTargetValues: true,
    hasContentSnapshot: false,
    allowMissingTarget: false,
    ...overrides,
  };
}

describe('buildPreview', () => {
  it('fills defaults and applies overrides', () => {
    assert({
      given: 'a base plus a canExecute override',
      should: 'produce a full preview with defaults and the override applied',
      actual: buildPreview(
        { action: 'rollback', targetValues: { a: 1 }, changes: [], affectedResources: [] },
        { canExecute: true, reason: 'ok' }
      ),
      expected: {
        action: 'rollback',
        canExecute: true,
        reason: 'ok',
        warnings: [],
        hasConflict: false,
        conflictFields: [],
        requiresForce: false,
        isNoOp: false,
        currentValues: null,
        targetValues: { a: 1 },
        changes: [],
        affectedResources: [],
      },
    });
  });
});

describe('evaluateEligibility', () => {
  it('rejects a rollback-of-rollback with no source operation', () => {
    assert({
      given: 'a null effective operation while rolling back a rollback',
      should: 'reject with the rollback-specific reason',
      actual: evaluateEligibility(ctx({ effectiveOperation: null, rollingBackRollback: true })),
      expected: { kind: 'reject', reason: 'Rollback source operation not available' },
    });
  });

  it('rejects a regular activity with no effective operation', () => {
    assert({
      given: 'a null effective operation for a regular activity',
      should: 'reject with the generic reason',
      actual: evaluateEligibility(ctx({ effectiveOperation: null, rollingBackRollback: false })),
      expected: { kind: 'reject', reason: 'Operation not available' },
    });
  });

  it('rejects a non-rollbackable operation', () => {
    assert({
      given: 'an operation that is not rollbackable',
      should: 'reject naming the action and operation',
      actual: evaluateEligibility(ctx({ effectiveOperation: 'login', isRollbackable: false })),
      expected: { kind: 'reject', reason: "Cannot rollback 'login' operations" },
    });
  });

  it('rejects a missing-target rollback-of-rollback with the reapply reason', () => {
    assert({
      given: 'a rollback-of-rollback with no target, snapshot, or allowance',
      should: 'reject with the reapply reason',
      actual: evaluateEligibility(ctx({
        rollingBackRollback: true,
        hasTargetValues: false,
        hasContentSnapshot: false,
        allowMissingTarget: false,
      })),
      expected: { kind: 'reject', reason: 'No rollback state available to reapply' },
    });
  });

  it('rejects a missing-target regular rollback with the no-values reason', () => {
    assert({
      given: 'a regular rollback with no target, snapshot, or allowance',
      should: 'reject with the no-values reason',
      actual: evaluateEligibility(ctx({
        rollingBackRollback: false,
        hasTargetValues: false,
        hasContentSnapshot: false,
        allowMissingTarget: false,
      })),
      expected: { kind: 'reject', reason: 'No values to restore' },
    });
  });

  it('proceeds for a create even with no target values', () => {
    assert({
      given: 'a create operation with no target values',
      should: 'proceed (create needs no previous state)',
      actual: evaluateEligibility(ctx({
        effectiveOperation: 'create',
        hasTargetValues: false,
        hasContentSnapshot: false,
        allowMissingTarget: false,
      })),
      expected: { kind: 'proceed' },
    });
  });

  it('proceeds when target values are present', () => {
    assert({
      given: 'an update with target values',
      should: 'proceed',
      actual: evaluateEligibility(ctx({ hasTargetValues: true })),
      expected: { kind: 'proceed' },
    });
  });

  it('proceeds when only a content snapshot is present', () => {
    assert({
      given: 'no target values but a content snapshot',
      should: 'proceed',
      actual: evaluateEligibility(ctx({ hasTargetValues: false, hasContentSnapshot: true })),
      expected: { kind: 'proceed' },
    });
  });

  it('proceeds when the operation allows a missing target', () => {
    assert({
      given: 'no target or snapshot but the operation allows a missing target',
      should: 'proceed',
      actual: evaluateEligibility(ctx({
        hasTargetValues: false,
        hasContentSnapshot: false,
        allowMissingTarget: true,
      })),
      expected: { kind: 'proceed' },
    });
  });
});

describe('evaluateCreateNoOp', () => {
  const base = {
    shouldBeTrashed: true,
    hasUndoGroup: false,
    allowUndoGroupSkip: false,
    trashedReason: 'Page is already in trash',
    restoredReason: 'Page is already restored',
  };

  it('is not a no-op when current state differs from target', () => {
    assert({
      given: 'the create is not already in its desired state',
      should: 'return not-noop',
      actual: evaluateCreateNoOp({ ...base, isCreateNoOp: false }),
      expected: { kind: 'not-noop' },
    });
  });

  it('is silently skippable inside an undo group when allowed', () => {
    assert({
      given: 'a create no-op inside an undo group where skipping is allowed (page)',
      should: 'return skippable',
      actual: evaluateCreateNoOp({ ...base, isCreateNoOp: true, hasUndoGroup: true, allowUndoGroupSkip: true }),
      expected: { kind: 'skippable' },
    });
  });

  it('errors on a create no-op outside an undo group (already trashed)', () => {
    assert({
      given: 'a create no-op outside an undo group where it is already trashed',
      should: 'error with the trashed reason',
      actual: evaluateCreateNoOp({ ...base, isCreateNoOp: true, shouldBeTrashed: true, hasUndoGroup: false, allowUndoGroupSkip: true }),
      expected: { kind: 'error', reason: 'Page is already in trash' },
    });
  });

  it('errors on a create no-op outside an undo group (already restored)', () => {
    assert({
      given: 'a create no-op outside an undo group where it is already restored',
      should: 'error with the restored reason',
      actual: evaluateCreateNoOp({ ...base, isCreateNoOp: true, shouldBeTrashed: false, hasUndoGroup: false, allowUndoGroupSkip: true }),
      expected: { kind: 'error', reason: 'Page is already restored' },
    });
  });

  it('errors on a create no-op inside an undo group when skipping is disallowed (drive)', () => {
    assert({
      given: 'a create no-op inside an undo group but skipping is disallowed (drive)',
      should: 'error rather than silently skip',
      actual: evaluateCreateNoOp({ ...base, isCreateNoOp: true, shouldBeTrashed: true, hasUndoGroup: true, allowUndoGroupSkip: false }),
      expected: { kind: 'error', reason: 'Page is already in trash' },
    });
  });
});
