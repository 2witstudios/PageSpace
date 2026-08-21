import { describe, it, expect } from 'vitest';
import {
  taskWriteErrorMessage,
  isRevisionConflict,
} from '../task-write-errors';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const apiError = (status: number, body?: unknown) =>
  Object.assign(new Error('request failed'), { status, body });

describe('taskWriteErrorMessage', () => {
  it('surfaces the sub-task guard message from a 422', () => {
    assert({
      given: 'a 422 carrying the completion-guard payload',
      should: 'show the server message naming what is blocking',
      actual: taskWriteErrorMessage(
        apiError(422, {
          code: 'SUBTASKS_INCOMPLETE',
          error: 'Complete all sub-tasks first (2 of 3 remaining)',
          pending: 2,
          total: 3,
        }),
        'Failed to update status',
      ),
      expected: 'Complete all sub-tasks first (2 of 3 remaining)',
    });
  });

  it('surfaces the invalid-status message from a 400', () => {
    // The status-vocabulary drift tripwire: the server names the valid slugs,
    // and flattening that into "Failed to update status" hides the whole cause.
    assert({
      given: 'a 400 naming the statuses the list actually defines',
      should: 'show the server message verbatim',
      actual: taskWriteErrorMessage(
        apiError(400, { error: 'Invalid status "shipped". Valid statuses: pending, completed' }),
        'Failed to update status',
      ),
      expected: 'Invalid status "shipped". Valid statuses: pending, completed',
    });
  });

  it('surfaces a permission refusal', () => {
    assert({
      given: 'a 403 from a subtree the user cannot edit',
      should: 'show the server explanation',
      actual: taskWriteErrorMessage(
        apiError(403, { error: 'You need edit permission to update tasks' }),
        'Failed to update status',
      ),
      expected: 'You need edit permission to update tasks',
    });
  });

  it('falls back for a 500 with a body', () => {
    assert({
      given: 'a server error',
      should: 'use the caller fallback rather than leaking internals',
      actual: taskWriteErrorMessage(apiError(500, { error: 'boom' }), 'Failed to update status'),
      expected: 'Failed to update status',
    });
  });

  it('falls back for a 422 with no parsable body', () => {
    assert({
      given: 'a 422 whose body is not an object',
      should: 'use the caller fallback',
      actual: taskWriteErrorMessage(apiError(422, 'nope'), 'Failed to update status'),
      expected: 'Failed to update status',
    });
  });

  it('falls back for a network error with no status', () => {
    assert({
      given: 'a plain Error from a dropped connection',
      should: 'use the caller fallback',
      actual: taskWriteErrorMessage(new Error('network'), 'Failed to update status'),
      expected: 'Failed to update status',
    });
  });
});

describe('isRevisionConflict', () => {
  it('matches 409 and 428 only', () => {
    assert({
      given: 'statuses 409, 428, 422 and 400',
      should: 'flag only the two revision codes',
      actual: [409, 428, 422, 400].map((s) => isRevisionConflict(apiError(s))),
      expected: [true, true, false, false],
    });
  });
});
