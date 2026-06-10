import { describe, it, expect } from 'vitest';
import {
  findSlashTrigger,
  isTypingInsertion,
  insertionCovers,
  evaluateSlashTrigger,
  buildCommandInsertion,
  SlashEvaluationInput,
} from '../slash-trigger';

const baseInput = (overrides: Partial<SlashEvaluationInput> = {}): SlashEvaluationInput => ({
  prevValue: '',
  value: '/',
  cursorPos: 1,
  inputType: 'insertText',
  isComposing: false,
  hasCommandToken: false,
  tokenRanges: [],
  isOpen: false,
  dismissedTriggerIndex: -1,
  ...overrides,
});

describe('findSlashTrigger', () => {
  it('given an empty input then a typed /, should find trigger at 0 with empty query', () => {
    expect(findSlashTrigger('/', 1)).toEqual({ triggerIndex: 0, query: '' });
  });

  it('given only whitespace before the /, should find the trigger (position-0-or-only-whitespace rule)', () => {
    expect(findSlashTrigger('  /', 3)).toEqual({ triggerIndex: 2, query: '' });
    expect(findSlashTrigger('\n/', 2)).toEqual({ triggerIndex: 1, query: '' });
  });

  it('given non-whitespace before the /, should NOT find a trigger (slash is literal)', () => {
    expect(findSlashTrigger('hello /', 7)).toBeNull();
  });

  it('given text typed after the /, should expose it as the query', () => {
    expect(findSlashTrigger('/rel', 4)).toEqual({ triggerIndex: 0, query: 'rel' });
  });

  it('given the cursor mid-query, should use only text before the cursor', () => {
    expect(findSlashTrigger('/rel', 2)).toEqual({ triggerIndex: 0, query: 'r' });
  });

  it('given the cursor before the /, should NOT find a trigger', () => {
    expect(findSlashTrigger('/rel', 0)).toBeNull();
  });

  it('given a completed word plus space after the / (mirrors mention close), should NOT find a trigger', () => {
    expect(findSlashTrigger('/foo bar', 8)).toBeNull();
  });

  it('given the / sits inside a tracked token range, should NOT find a trigger', () => {
    expect(findSlashTrigger('/foo rest', 9, [{ start: 0, end: 4 }])).toBeNull();
  });

  it('given a value not starting with /, should NOT find a trigger', () => {
    expect(findSlashTrigger('abc', 3)).toBeNull();
    expect(findSlashTrigger('', 0)).toBeNull();
  });
});

describe('isTypingInsertion', () => {
  it('treats keystrokes and committed IME composition as typing', () => {
    expect(isTypingInsertion('insertText')).toBe(true);
    expect(isTypingInsertion('insertCompositionText')).toBe(true);
  });

  it('treats paste, drop, autofill, deletions, and unknown sources as non-typing', () => {
    expect(isTypingInsertion('insertFromPaste')).toBe(false);
    expect(isTypingInsertion('insertFromDrop')).toBe(false);
    expect(isTypingInsertion('insertReplacementText')).toBe(false);
    expect(isTypingInsertion('deleteContentBackward')).toBe(false);
    expect(isTypingInsertion(null)).toBe(false);
  });
});

describe('insertionCovers', () => {
  it('given a single typed / at 0, should cover index 0', () => {
    expect(insertionCovers('', '/', 0)).toBe(true);
  });

  it('given a typed char appended after a literal /foo, should NOT cover index 0', () => {
    expect(insertionCovers('/foo', '/foob', 0)).toBe(false);
  });

  it('given a multi-char committed composition containing the /, should cover it', () => {
    expect(insertionCovers('', '/rel', 0)).toBe(true);
  });

  it('given a deletion that brings / to position 0, should NOT cover it', () => {
    expect(insertionCovers('a /x', '/x', 0)).toBe(false);
  });
});

describe('evaluateSlashTrigger', () => {
  it('given an empty input and a typed /, should open with empty query', () => {
    const result = evaluateSlashTrigger(baseInput());
    expect(result).toEqual({
      action: 'open',
      triggerIndex: 0,
      query: '',
      dismissedTriggerIndex: -1,
    });
  });

  it('given whitespace-only prefix and a typed /, should open', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: '  ', value: '  /', cursorPos: 3 })
    );
    expect(result.action).toBe('open');
  });

  it('given non-whitespace before the cursor slash, should not open', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: 'hello ', value: 'hello /', cursorPos: 7 })
    );
    expect(result.action).toBe('none');
  });

  it('given the message already contains a command chip, should never open', () => {
    const result = evaluateSlashTrigger(
      baseInput({ hasCommandToken: true })
    );
    expect(result.action).toBe('none');
  });

  it('given the message contains a command chip while open, should close', () => {
    const result = evaluateSlashTrigger(
      baseInput({ hasCommandToken: true, isOpen: true })
    );
    expect(result.action).toBe('close');
  });

  it('given the picker is open and the user keeps typing, should update the query', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: '/re', value: '/rel', cursorPos: 4, isOpen: true })
    );
    expect(result).toMatchObject({ action: 'update', triggerIndex: 0, query: 'rel' });
  });

  it('given the user deletes back past the /, should close and reset dismissal', () => {
    const result = evaluateSlashTrigger(
      baseInput({
        prevValue: '/',
        value: '',
        cursorPos: 0,
        inputType: 'deleteContentBackward',
        isOpen: true,
        dismissedTriggerIndex: 0,
      })
    );
    expect(result).toEqual({ action: 'close', dismissedTriggerIndex: -1 });
  });

  it('given a dismissed trigger position, should NOT reopen while typing after the same /', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: '/r', value: '/re', cursorPos: 3, dismissedTriggerIndex: 0 })
    );
    expect(result.action).toBe('none');
    expect(result.dismissedTriggerIndex).toBe(0);
  });

  it('given the / deleted and retyped, should reset dismissal and open again', () => {
    // Step 1: deletion clears the trigger and resets dismissal
    const afterDelete = evaluateSlashTrigger(
      baseInput({
        prevValue: '/re',
        value: '',
        cursorPos: 0,
        inputType: 'deleteContentBackward',
        dismissedTriggerIndex: 0,
      })
    );
    expect(afterDelete.dismissedTriggerIndex).toBe(-1);

    // Step 2: retyping the / opens
    const afterRetype = evaluateSlashTrigger(
      baseInput({ dismissedTriggerIndex: afterDelete.dismissedTriggerIndex })
    );
    expect(afterRetype.action).toBe('open');
  });

  it('given an IME composition in progress, should NOT open', () => {
    const result = evaluateSlashTrigger(baseInput({ isComposing: true }));
    expect(result.action).toBe('none');
  });

  it('given a committed composition that begins with / at position 0, should open once', () => {
    const result = evaluateSlashTrigger(
      baseInput({
        prevValue: '',
        value: '/rel',
        cursorPos: 4,
        inputType: 'insertCompositionText',
      })
    );
    expect(result).toMatchObject({ action: 'open', triggerIndex: 0, query: 'rel' });
  });

  it('given a / typed mid-message then preceding text deleted, should NOT retroactively open', () => {
    const result = evaluateSlashTrigger(
      baseInput({
        prevValue: 'a /x',
        value: '/x',
        cursorPos: 2,
        inputType: 'deleteContentBackward',
      })
    );
    expect(result.action).toBe('none');
  });

  it('given a paste resulting in a leading /, should NOT open (text stays literal)', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: '', value: '/foo', cursorPos: 4, inputType: 'insertFromPaste' })
    );
    expect(result.action).toBe('none');
  });

  it('given a typed insertion that does not cover the slash, should NOT open (pasted /foo then typing)', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: '/foo', value: '/foob', cursorPos: 5, inputType: 'insertText' })
    );
    expect(result.action).toBe('none');
  });
});

describe('buildCommandInsertion', () => {
  it('given selection at the trigger, should insert /trigger plus trailing space and place caret after it', () => {
    const result = buildCommandInsertion('/rel', 0, 4, 'release-checklist');
    expect(result.newValue).toBe('/release-checklist ');
    expect(result.token).toEqual({ start: 0, end: 18 });
    expect(result.newCursorPos).toBe(19);
  });

  it('given whitespace before the trigger, should preserve it', () => {
    const result = buildCommandInsertion('  /f', 2, 4, 'foo');
    expect(result.newValue).toBe('  /foo ');
    expect(result.token).toEqual({ start: 2, end: 6 });
    expect(result.newCursorPos).toBe(7);
  });

  it('given text after the cursor, should keep it after the inserted chip', () => {
    const result = buildCommandInsertion('/f tail', 0, 2, 'foo');
    expect(result.newValue).toBe('/foo  tail');
    expect(result.token).toEqual({ start: 0, end: 4 });
    expect(result.newCursorPos).toBe(5);
  });
});
