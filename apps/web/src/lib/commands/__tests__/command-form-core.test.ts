import { describe, it, expect } from 'vitest';
import {
  normalizeTriggerInput,
  validateTriggerValue,
  validateDescriptionValue,
  validateEntryPageValue,
  computeFormErrors,
  isSaveBlocked,
  computePageSize,
  sizeAdvisory,
  shadowNotice,
  buildCreatePayload,
  buildUpdatePayload,
  toggleToast,
  saveToast,
  deleteToast,
  deleteDialogTitle,
  DELETE_DIALOG_BODY,
  EMPTY_STATE_SUBTEXT,
} from '../command-form-core';

describe('normalizeTriggerInput', () => {
  it('lowercases as the user types', () => {
    expect(normalizeTriggerInput('Design-Review')).toBe('design-review');
  });

  it('converts spaces to hyphens on input', () => {
    expect(normalizeTriggerInput('release checklist')).toBe('release-checklist');
  });

  it('leaves characters it cannot normalize untouched (E3 fires for them)', () => {
    expect(normalizeTriggerInput('foo!')).toBe('foo!');
  });
});

describe('validateTriggerValue', () => {
  const ctx = { scope: 'personal' as const, existingTriggers: [] as string[] };

  it('E1: empty trigger', () => {
    expect(validateTriggerValue('', ctx)).toEqual({
      code: 'E1',
      message: 'Trigger is required.',
    });
  });

  it('E2: trigger over 64 chars', () => {
    expect(validateTriggerValue('a'.repeat(65), ctx)).toEqual({
      code: 'E2',
      message: 'Trigger must be 64 characters or fewer.',
    });
  });

  it('E3: invalid characters after normalization', () => {
    expect(validateTriggerValue('foo!', ctx)).toEqual({
      code: 'E3',
      message: 'Trigger can only contain lowercase letters, numbers, and hyphens.',
    });
  });

  it('E3: uppercase letters that were not normalized', () => {
    expect(validateTriggerValue('Foo', ctx)?.code).toBe('E3');
  });

  it('E4: leading hyphen', () => {
    expect(validateTriggerValue('-foo', ctx)).toEqual({
      code: 'E4',
      message: "Trigger can't start or end with a hyphen.",
    });
  });

  it('E4: trailing hyphen', () => {
    expect(validateTriggerValue('foo-', ctx)?.code).toBe('E4');
  });

  it('E5: consecutive hyphens', () => {
    expect(validateTriggerValue('foo--bar', ctx)).toEqual({
      code: 'E5',
      message: "Trigger can't contain consecutive hyphens.",
    });
  });

  it('E6 personal copy: duplicate within personal scope', () => {
    expect(
      validateTriggerValue('foo', { scope: 'personal', existingTriggers: ['foo'] })
    ).toEqual({
      code: 'E6',
      message: 'You already have a command named /foo.',
    });
  });

  it('E6 drive copy: duplicate within drive scope', () => {
    expect(
      validateTriggerValue('foo', { scope: 'drive', existingTriggers: ['foo'] })
    ).toEqual({
      code: 'E6',
      message: 'This drive already has a command named /foo.',
    });
  });

  it('E7: reserved built-in trigger', () => {
    expect(validateTriggerValue('help', ctx)).toEqual({
      code: 'E7',
      message: '/help is reserved for a built-in command. Choose a different trigger.',
    });
  });

  it('accepts a valid trigger', () => {
    expect(validateTriggerValue('release-checklist-2', ctx)).toBeNull();
  });

  it('accepts a 64-char trigger', () => {
    expect(validateTriggerValue('a'.repeat(64), ctx)).toBeNull();
  });
});

describe('validateDescriptionValue', () => {
  it('E8: empty description', () => {
    expect(validateDescriptionValue('')).toEqual({
      code: 'E8',
      message: 'Description is required.',
    });
  });

  it('E8: whitespace-only description', () => {
    expect(validateDescriptionValue('   ')?.code).toBe('E8');
  });

  it('E9: description over 1,024 chars', () => {
    expect(validateDescriptionValue('d'.repeat(1025))).toEqual({
      code: 'E9',
      message: 'Description must be 1,024 characters or fewer.',
    });
  });

  it('accepts a 1,024-char description', () => {
    expect(validateDescriptionValue('d'.repeat(1024))).toBeNull();
  });
});

describe('validateEntryPageValue', () => {
  it('E10: no entry page selected', () => {
    expect(validateEntryPageValue(null)).toEqual({
      code: 'E10',
      message: 'Choose an entry page for this command.',
    });
    expect(validateEntryPageValue('')?.code).toBe('E10');
  });

  it('accepts a selected page', () => {
    expect(validateEntryPageValue('page_1')).toBeNull();
  });
});

describe('computeFormErrors / isSaveBlocked', () => {
  const ctx = { scope: 'personal' as const, existingTriggers: [] as string[] };

  it('aggregates errors per field', () => {
    const errors = computeFormErrors(
      { trigger: '', description: '', entryPageId: null },
      ctx
    );
    expect(errors.trigger?.code).toBe('E1');
    expect(errors.description?.code).toBe('E8');
    expect(errors.entryPage?.code).toBe('E10');
    expect(isSaveBlocked(errors)).toBe(true);
  });

  it('returns no errors for a valid form', () => {
    const errors = computeFormErrors(
      { trigger: 'foo', description: 'Does a thing. Use it when needed.', entryPageId: 'p1' },
      ctx
    );
    expect(errors.trigger).toBeUndefined();
    expect(errors.description).toBeUndefined();
    expect(errors.entryPage).toBeUndefined();
    expect(isSaveBlocked(errors)).toBe(false);
  });
});

describe('computePageSize / sizeAdvisory (W1)', () => {
  it('estimates tokens at ~4 chars per token and counts lines', () => {
    const content = 'abcd\nefgh';
    expect(computePageSize(content)).toEqual({ tokens: 2, lines: 2 });
  });

  it('returns null when under both thresholds', () => {
    expect(sizeAdvisory('short page')).toBeNull();
  });

  it('fires above the token threshold with exact copy', () => {
    const content = 'a'.repeat(24000); // 6,000 tokens, 1 line
    expect(sizeAdvisory(content)).toBe(
      'This page is large (about 6,000 tokens / 1 lines). Commands work best when the entry page stays under ~5,000 tokens / 500 lines — move details into child pages, which the AI reads on demand.'
    );
  });

  it('fires above the line threshold', () => {
    const content = Array.from({ length: 501 }, () => 'x').join('\n');
    expect(sizeAdvisory(content)).toContain('501 lines');
  });

  it('does not fire at exactly the thresholds', () => {
    const content = Array.from({ length: 500 }, () => 'x').join('\n');
    expect(sizeAdvisory(content)).toBeNull();
  });
});

describe('shadowNotice (W2)', () => {
  it('returns null with no colliding drives', () => {
    expect(shadowNotice('foo', [])).toBeNull();
  });

  it('renders the exact copy for one drive', () => {
    expect(shadowNotice('foo', ['Marketing'])).toBe(
      'This will shadow the drive command /foo in Marketing. Your personal command will run instead.'
    );
  });

  it('comma-separates multiple drive names', () => {
    expect(shadowNotice('foo', ['Marketing', 'Engineering'])).toBe(
      'This will shadow the drive command /foo in Marketing, Engineering. Your personal command will run instead.'
    );
  });
});

describe('payload builders', () => {
  const form = {
    trigger: 'foo',
    description: 'Does foo. Use when foo-ing.',
    entryPageId: 'p1',
    enabled: true,
  };

  it('buildCreatePayload omits driveId for personal commands', () => {
    expect(buildCreatePayload(form, null)).toEqual({
      trigger: 'foo',
      description: 'Does foo. Use when foo-ing.',
      entryPageId: 'p1',
      enabled: true,
    });
  });

  it('buildCreatePayload includes driveId for drive commands', () => {
    expect(buildCreatePayload(form, 'drive_1')).toMatchObject({ driveId: 'drive_1' });
  });

  it('buildUpdatePayload sends only changed fields', () => {
    const original = { ...form };
    expect(buildUpdatePayload(original, { ...form, description: 'New text.' })).toEqual({
      description: 'New text.',
    });
  });

  it('buildUpdatePayload returns an empty object when nothing changed', () => {
    expect(buildUpdatePayload(form, { ...form })).toEqual({});
  });

  it('buildUpdatePayload covers every editable field', () => {
    expect(
      buildUpdatePayload(form, {
        trigger: 'bar',
        description: 'x',
        entryPageId: 'p2',
        enabled: false,
      })
    ).toEqual({ trigger: 'bar', description: 'x', entryPageId: 'p2', enabled: false });
  });
});

describe('copy builders', () => {
  it('toggle toasts', () => {
    expect(toggleToast('foo', true)).toBe('Command /foo enabled');
    expect(toggleToast('foo', false)).toBe('Command /foo disabled');
  });

  it('save toasts', () => {
    expect(saveToast('foo', false)).toBe('Command /foo created');
    expect(saveToast('foo', true)).toBe('Command /foo updated');
  });

  it('delete toast and dialog copy', () => {
    expect(deleteToast('foo')).toBe('Command /foo deleted');
    expect(deleteDialogTitle('foo')).toBe('Delete /foo?');
    expect(DELETE_DIALOG_BODY.personal).toBe(
      'This removes the command for you. Pages are not deleted. Messages that already used this command keep their chip but show it as removed.'
    );
    expect(DELETE_DIALOG_BODY.drive).toBe(
      'This removes the command for everyone in this drive. Pages are not deleted. Messages that already used this command keep their chip but show it as removed.'
    );
  });

  it('empty-state subtext per scope', () => {
    expect(EMPTY_STATE_SUBTEXT.personal).toBe(
      "Commands let you inject a page's knowledge into any AI conversation by typing /its-name."
    );
    expect(EMPTY_STATE_SUBTEXT.drive).toBe(
      'Drive commands are available to everyone in this drive.'
    );
  });
});
