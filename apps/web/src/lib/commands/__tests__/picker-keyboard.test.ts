import { describe, it, expect } from 'vitest';
import { resolvePickerKeyAction, PickerKeyContext } from '../picker-keyboard';

const ctx = (overrides: Partial<PickerKeyContext> = {}): PickerKeyContext => ({
  placement: 'bottom',
  selectedIndex: 0,
  itemCount: 3,
  enterSelects: true,
  ...overrides,
});

describe('resolvePickerKeyAction — placement bottom', () => {
  it('ArrowDown moves selection down, wrapping at the end', () => {
    expect(resolvePickerKeyAction('ArrowDown', ctx({ selectedIndex: 0 }))).toEqual({
      type: 'move',
      index: 1,
    });
    expect(resolvePickerKeyAction('ArrowDown', ctx({ selectedIndex: 2 }))).toEqual({
      type: 'move',
      index: 0,
    });
  });

  it('ArrowUp moves selection up, wrapping at the start', () => {
    expect(resolvePickerKeyAction('ArrowUp', ctx({ selectedIndex: 1 }))).toEqual({
      type: 'move',
      index: 0,
    });
    expect(resolvePickerKeyAction('ArrowUp', ctx({ selectedIndex: 0 }))).toEqual({
      type: 'move',
      index: 2,
    });
  });
});

describe('resolvePickerKeyAction — placement top (visual direction matches key direction)', () => {
  it('ArrowUp moves toward the visually-upper item (index + 1, mirroring useSuggestion)', () => {
    expect(
      resolvePickerKeyAction('ArrowUp', ctx({ placement: 'top', selectedIndex: 0 }))
    ).toEqual({ type: 'move', index: 1 });
    expect(
      resolvePickerKeyAction('ArrowUp', ctx({ placement: 'top', selectedIndex: 2 }))
    ).toEqual({ type: 'move', index: 0 });
  });

  it('ArrowDown inverts (index - 1, wrapping)', () => {
    expect(
      resolvePickerKeyAction('ArrowDown', ctx({ placement: 'top', selectedIndex: 1 }))
    ).toEqual({ type: 'move', index: 0 });
    expect(
      resolvePickerKeyAction('ArrowDown', ctx({ placement: 'top', selectedIndex: 0 }))
    ).toEqual({ type: 'move', index: 2 });
  });
});

describe('resolvePickerKeyAction — selection & dismissal', () => {
  it('Enter selects when a hardware keyboard is in use', () => {
    expect(resolvePickerKeyAction('Enter', ctx())).toEqual({ type: 'select' });
  });

  it('Enter does nothing on a mobile soft keyboard (newline instead; tap is the selection mechanism)', () => {
    expect(resolvePickerKeyAction('Enter', ctx({ enterSelects: false }))).toEqual({
      type: 'none',
    });
  });

  it('Tab selects (Slack/Discord tab-to-complete convention)', () => {
    expect(resolvePickerKeyAction('Tab', ctx())).toEqual({ type: 'select' });
  });

  it('Shift+Tab does nothing special', () => {
    expect(resolvePickerKeyAction('Tab', ctx(), { shiftKey: true })).toEqual({ type: 'none' });
  });

  it('Escape dismisses', () => {
    expect(resolvePickerKeyAction('Escape', ctx())).toEqual({ type: 'dismiss' });
  });

  it('other keys pass through to the input', () => {
    expect(resolvePickerKeyAction('a', ctx())).toEqual({ type: 'none' });
    expect(resolvePickerKeyAction('Backspace', ctx())).toEqual({ type: 'none' });
  });
});

describe('resolvePickerKeyAction — empty list', () => {
  it('Escape still dismisses with no items', () => {
    expect(resolvePickerKeyAction('Escape', ctx({ itemCount: 0 }))).toEqual({
      type: 'dismiss',
    });
  });

  it('arrows, Enter, and Tab do nothing with no items', () => {
    expect(resolvePickerKeyAction('ArrowDown', ctx({ itemCount: 0 }))).toEqual({ type: 'none' });
    expect(resolvePickerKeyAction('Enter', ctx({ itemCount: 0 }))).toEqual({ type: 'none' });
    expect(resolvePickerKeyAction('Tab', ctx({ itemCount: 0 }))).toEqual({ type: 'none' });
  });
});
