import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import { getConflictFields, isNoOpChange, classifyUndoGroupConflict } from '../conflict';

describe('getConflictFields', () => {
  it('returns no conflicts when expected values are null', () => {
    assert({
      given: 'null expected values',
      should: 'return an empty array',
      actual: getConflictFields(null, { a: 1 }),
      expected: [],
    });
  });

  it('returns no conflicts when current values are null', () => {
    assert({
      given: 'null current values',
      should: 'return an empty array',
      actual: getConflictFields({ a: 1 }, null),
      expected: [],
    });
  });

  it('flags fields whose current value differs from expected', () => {
    assert({
      given: 'a field that changed since the recorded activity',
      should: 'return that field name',
      actual: getConflictFields({ title: 'old', position: 1 }, { title: 'new', position: 1 }),
      expected: ['title'],
    });
  });

  it('flags nothing when every expected field matches current', () => {
    assert({
      given: 'current values matching every expected field',
      should: 'return an empty array',
      actual: getConflictFields({ title: 'x', position: 1 }, { title: 'x', position: 1, extra: 9 }),
      expected: [],
    });
  });
});

describe('isNoOpChange', () => {
  it('is not a no-op when target values are null', () => {
    assert({
      given: 'null target values',
      should: 'return false',
      actual: isNoOpChange(null, { a: 1 }),
      expected: false,
    });
  });

  it('is not a no-op when current values are null', () => {
    assert({
      given: 'null current values',
      should: 'return false',
      actual: isNoOpChange({ a: 1 }, null),
      expected: false,
    });
  });

  it('is not a no-op when target values are empty', () => {
    assert({
      given: 'an empty target-values object',
      should: 'return false',
      actual: isNoOpChange({}, { a: 1 }),
      expected: false,
    });
  });

  it('is a no-op when every target field already matches current', () => {
    assert({
      given: 'target values all matching current',
      should: 'return true',
      actual: isNoOpChange({ title: 'x' }, { title: 'x', other: 1 }),
      expected: true,
    });
  });

  it('is not a no-op when a target field differs from current', () => {
    assert({
      given: 'a target field that differs from current',
      should: 'return false',
      actual: isNoOpChange({ title: 'x' }, { title: 'y' }),
      expected: false,
    });
  });
});

describe('classifyUndoGroupConflict', () => {
  it('returns the empty array unchanged when there are no conflicts', () => {
    assert({
      given: 'no detected conflict fields',
      should: 'return the empty list without classifying',
      actual: classifyUndoGroupConflict({
        conflictFields: [],
        hasUndoGroupContext: true,
        hasExternalModification: false,
      }),
      expected: [],
    });
  });

  it('keeps conflicts when there is no undo-group context', () => {
    assert({
      given: 'conflicts detected outside any undo group',
      should: 'keep the conflicts (real conflict)',
      actual: classifyUndoGroupConflict({
        conflictFields: ['title'],
        hasUndoGroupContext: false,
        hasExternalModification: false,
      }),
      expected: ['title'],
    });
  });

  it('keeps conflicts when an external modification exists', () => {
    assert({
      given: 'an undo group but a later modification from outside it',
      should: 'keep the conflicts',
      actual: classifyUndoGroupConflict({
        conflictFields: ['title'],
        hasUndoGroupContext: true,
        hasExternalModification: true,
      }),
      expected: ['title'],
    });
  });

  it('clears conflicts when the only later modifications were internal to the undo group', () => {
    assert({
      given: 'an undo group whose members made the only later modifications',
      should: 'clear the conflicts (internal changes are not conflicts)',
      actual: classifyUndoGroupConflict({
        conflictFields: ['title'],
        hasUndoGroupContext: true,
        hasExternalModification: false,
      }),
      expected: [],
    });
  });
});
