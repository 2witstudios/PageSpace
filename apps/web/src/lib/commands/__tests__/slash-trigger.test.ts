import { describe, it, expect } from 'vitest';
import {
  findSlashTrigger,
  isTypingInsertion,
  insertionCovers,
  evaluateSlashTrigger,
  buildCommandInsertion,
  INITIAL_SLASH_MEMORY,
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
  memory: INITIAL_SLASH_MEMORY,
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

  it('given any whitespace in the query, should NOT find a trigger (trigger names cannot contain spaces; also prevents stacking with the @ mention picker)', () => {
    expect(findSlashTrigger('/foo bar', 8)).toBeNull();
    expect(findSlashTrigger('/foo ', 5)).toBeNull();
    expect(findSlashTrigger('/ @a', 4)).toBeNull();
    expect(findSlashTrigger('/a\nb', 4)).toBeNull();
  });

  it('given the / sits inside a tracked token range, should NOT find a trigger', () => {
    expect(findSlashTrigger('/foo-rest', 9, [{ start: 0, end: 4 }])).toBeNull();
  });

  it('given an already-serialized token after the /, should NOT find a trigger', () => {
    expect(findSlashTrigger('/[foo](c1:command)', 18)).toBeNull();
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

describe('evaluateSlashTrigger — opening', () => {
  it('given an empty input and a typed /, should open with empty query and remember the typed trigger', () => {
    const result = evaluateSlashTrigger(baseInput());
    expect(result).toEqual({
      action: 'open',
      triggerIndex: 0,
      query: '',
      memory: { dismissedTriggerIndex: -1, typedTriggerIndex: 0 },
    });
  });

  it('given whitespace-only prefix and a typed /, should open', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: '  ', value: '  /', cursorPos: 3 })
    );
    expect(result).toMatchObject({ action: 'open', triggerIndex: 2 });
  });

  it('given non-whitespace before the cursor slash, should not open', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: 'hello ', value: 'hello /', cursorPos: 7 })
    );
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

  it('given an IME composition in progress, should NOT open', () => {
    const result = evaluateSlashTrigger(baseInput({ isComposing: true }));
    expect(result.action).toBe('none');
  });

  it('given a paste resulting in a leading /, should NOT open (text stays literal)', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: '', value: '/foo', cursorPos: 4, inputType: 'insertFromPaste' })
    );
    expect(result.action).toBe('none');
    expect(result.memory.typedTriggerIndex).toBe(-1);
  });

  it('given typing after a pasted /foo, should still NOT open (the / never arrived by typing)', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: '/foo', value: '/foob', cursorPos: 5, inputType: 'insertText' })
    );
    expect(result.action).toBe('none');
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
});

describe('evaluateSlashTrigger — reopen after non-Escape close (mirrors mention reopen)', () => {
  // The picker closed via click-outside; the / at index 0 was originally typed.
  const closedAfterTyping = { dismissedTriggerIndex: -1, typedTriggerIndex: 0 };

  it('given continued typing after the same typed /, should reopen', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: '/', value: '/d', cursorPos: 2, memory: closedAfterTyping })
    );
    expect(result).toMatchObject({ action: 'open', triggerIndex: 0, query: 'd' });
  });

  it('given a non-typing change after the close, should NOT reopen', () => {
    const result = evaluateSlashTrigger(
      baseInput({
        prevValue: '/',
        value: '/d',
        cursorPos: 2,
        inputType: 'insertFromPaste',
        memory: closedAfterTyping,
      })
    );
    expect(result.action).toBe('none');
  });

  it('given a paste over a typed / that byte-preserves the slash, should keep the typed status (the edit diff shows the slash survived)', () => {
    // '/' was typed (typedTriggerIndex=0), picker closed; user selects all and
    // pastes '/deploy'. The edit diff shares the leading '/' so the typed
    // slash survives byte-wise; typing afterwards reopens (mention-parity).
    const afterPaste = evaluateSlashTrigger(
      baseInput({
        prevValue: '/',
        value: '/deploy',
        cursorPos: 7,
        inputType: 'insertFromPaste',
        memory: closedAfterTyping,
      })
    );
    expect(afterPaste.action).toBe('none'); // the paste itself never opens
    expect(afterPaste.memory.typedTriggerIndex).toBe(0);
  });

  it('given a non-typing edit whose region covers the slash itself, should forget the typed status', () => {
    // ' /' typed at index 1 (typedTriggerIndex=1); an autofill/replacement
    // rewrites from index 0 producing '/x' — the new slash arrived non-typed.
    const result = evaluateSlashTrigger(
      baseInput({
        prevValue: ' /',
        value: '/x',
        cursorPos: 2,
        inputType: 'insertReplacementText',
        memory: { dismissedTriggerIndex: -1, typedTriggerIndex: 1 },
      })
    );
    expect(result.action).toBe('none');
    expect(result.memory.typedTriggerIndex).toBe(-1);
  });
});

describe('evaluateSlashTrigger — dismissal memory (Escape)', () => {
  const dismissedAt0 = { dismissedTriggerIndex: 0, typedTriggerIndex: 0 };

  it('given a dismissed trigger position, should NOT reopen while typing after the same /', () => {
    const result = evaluateSlashTrigger(
      baseInput({ prevValue: '/r', value: '/re', cursorPos: 3, memory: dismissedAt0 })
    );
    expect(result.action).toBe('none');
    expect(result.memory.dismissedTriggerIndex).toBe(0);
  });

  it('given the / deleted and retyped, should reset all memory and open again', () => {
    const afterDelete = evaluateSlashTrigger(
      baseInput({
        prevValue: '/re',
        value: '',
        cursorPos: 0,
        inputType: 'deleteContentBackward',
        memory: dismissedAt0,
      })
    );
    expect(afterDelete.memory).toEqual(INITIAL_SLASH_MEMORY);

    const afterRetype = evaluateSlashTrigger(baseInput({ memory: afterDelete.memory }));
    expect(afterRetype.action).toBe('open');
  });
});

describe('evaluateSlashTrigger — open-state updates and closing', () => {
  it('given the picker is open and the user keeps typing, should update the query', () => {
    const result = evaluateSlashTrigger(
      baseInput({
        prevValue: '/re',
        value: '/rel',
        cursorPos: 4,
        isOpen: true,
        memory: { dismissedTriggerIndex: -1, typedTriggerIndex: 0 },
      })
    );
    expect(result).toMatchObject({ action: 'update', triggerIndex: 0, query: 'rel' });
  });

  it('given the user deletes back past the /, should close and reset memory', () => {
    const result = evaluateSlashTrigger(
      baseInput({
        prevValue: '/',
        value: '',
        cursorPos: 0,
        inputType: 'deleteContentBackward',
        isOpen: true,
        memory: { dismissedTriggerIndex: 0, typedTriggerIndex: 0 },
      })
    );
    expect(result).toEqual({ action: 'close', memory: INITIAL_SLASH_MEMORY });
  });

  it('given a space typed while open (completed trigger word), should close', () => {
    const result = evaluateSlashTrigger(
      baseInput({
        prevValue: '/rel',
        value: '/rel ',
        cursorPos: 5,
        isOpen: true,
        memory: { dismissedTriggerIndex: -1, typedTriggerIndex: 0 },
      })
    );
    expect(result.action).toBe('close');
  });

  it('given the trigger index shifts while open (leading whitespace deleted), should re-anchor the typed-trigger memory', () => {
    // ' /re' (typed trigger at 1, open) → leading space deleted → '/re' at 0.
    const result = evaluateSlashTrigger(
      baseInput({
        prevValue: ' /re',
        value: '/re',
        cursorPos: 3,
        inputType: 'deleteContentBackward',
        isOpen: true,
        memory: { dismissedTriggerIndex: -1, typedTriggerIndex: 1 },
      })
    );
    expect(result).toMatchObject({ action: 'update', triggerIndex: 0 });
    expect(result.memory.typedTriggerIndex).toBe(0);
  });
});

describe('evaluateSlashTrigger — one command per message', () => {
  it('given the message already contains a command chip, should never open', () => {
    const result = evaluateSlashTrigger(baseInput({ hasCommandToken: true }));
    expect(result.action).toBe('none');
  });

  it('given the message contains a command chip while open, should close', () => {
    const result = evaluateSlashTrigger(baseInput({ hasCommandToken: true, isOpen: true }));
    expect(result.action).toBe('close');
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
