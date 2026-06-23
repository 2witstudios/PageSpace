import { describe, it, expect } from 'vitest';
import { applyEdit } from '../edit-file';

describe('applyEdit', () => {
  it('given a unique oldString, should replace it once and report one replacement', () => {
    const result = applyEdit({ content: 'a b c', oldString: 'b', newString: 'X' });
    expect(result).toEqual({ ok: true, content: 'a X c', replacements: 1 });
  });

  it('given an oldString that does not occur, should fail with edit_no_match', () => {
    const result = applyEdit({ content: 'a b c', oldString: 'zzz', newString: 'X' });
    expect(result).toEqual({ ok: false, reason: 'edit_no_match' });
  });

  it('given multiple occurrences without replaceAll, should fail with edit_not_unique', () => {
    const result = applyEdit({ content: 'x x x', oldString: 'x', newString: 'Y' });
    expect(result).toEqual({ ok: false, reason: 'edit_not_unique' });
  });

  it('given multiple occurrences with replaceAll, should replace all and report the count', () => {
    const result = applyEdit({ content: 'x x x', oldString: 'x', newString: 'Y', replaceAll: true });
    expect(result).toEqual({ ok: true, content: 'Y Y Y', replacements: 3 });
  });

  it('given an empty newString, should delete the matched text', () => {
    const result = applyEdit({ content: 'foo-bar', oldString: '-bar', newString: '' });
    expect(result).toEqual({ ok: true, content: 'foo', replacements: 1 });
  });

  it('given an oldString with regex-special characters, should match it literally', () => {
    const result = applyEdit({ content: 'value = a.b+c', oldString: 'a.b+c', newString: 'z' });
    expect(result).toEqual({ ok: true, content: 'value = z', replacements: 1 });
  });

  it('given replaceAll with a regex-special oldString, should replace every literal occurrence', () => {
    const result = applyEdit({ content: '$x $x', oldString: '$x', newString: 'q', replaceAll: true });
    expect(result).toEqual({ ok: true, content: 'q q', replacements: 2 });
  });

  it('given a multi-line unique oldString, should replace across lines', () => {
    const result = applyEdit({
      content: 'line1\nline2\nline3',
      oldString: 'line2\nline3',
      newString: 'merged',
    });
    expect(result).toEqual({ ok: true, content: 'line1\nmerged', replacements: 1 });
  });

  it('given inputs, should not mutate the original content string', () => {
    const content = 'a b c';
    applyEdit({ content, oldString: 'b', newString: 'X' });
    expect(content).toBe('a b c');
  });
});
