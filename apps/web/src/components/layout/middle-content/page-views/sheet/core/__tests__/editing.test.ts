import { describe, it, expect } from 'vitest';
import { shouldRegisterSheetEditing } from '../editing';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('shouldRegisterSheetEditing', () => {
  it('registers while a cell is being edited', () => {
    assert({
      given: 'an active cell edit',
      should: 'register an editing session',
      actual: shouldRegisterSheetEditing({ isEditingCell: true, isFormulaFocused: false, isDirty: false }),
      expected: true,
    });
  });

  it('registers while the formula bar is focused', () => {
    assert({
      given: 'a focused formula bar',
      should: 'register an editing session',
      actual: shouldRegisterSheetEditing({ isEditingCell: false, isFormulaFocused: true, isDirty: false }),
      expected: true,
    });
  });

  it('registers while the document has unsaved changes', () => {
    assert({
      given: 'a dirty document',
      should: 'register an editing session',
      actual: shouldRegisterSheetEditing({ isEditingCell: false, isFormulaFocused: false, isDirty: true }),
      expected: true,
    });
  });

  it('does not register when idle and saved', () => {
    assert({
      given: 'no cell edit, unfocused formula bar, and a clean document',
      should: 'not register an editing session',
      actual: shouldRegisterSheetEditing({ isEditingCell: false, isFormulaFocused: false, isDirty: false }),
      expected: false,
    });
  });
});
