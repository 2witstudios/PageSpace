// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { focusComposerAtEnd } from './focus-composer';

afterEach(() => { document.body.innerHTML = ''; });

describe('focusComposerAtEnd', () => {
  it('focuses the composer with the caret after the restored draft', () => {
    const host = document.createElement('div');
    host.innerHTML = '<textarea>Half a thought</textarea>';
    document.body.append(host);
    const field = host.querySelector('textarea') as HTMLTextAreaElement;
    field.setSelectionRange(0, 0);
    focusComposerAtEnd(host);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([14, 14]);
  });

  it('leaves an empty composer focused at 0 and does nothing without a host or field', () => {
    const host = document.createElement('div');
    host.innerHTML = '<textarea></textarea>';
    document.body.append(host);
    focusComposerAtEnd(host);
    expect(document.activeElement).toBe(host.querySelector('textarea'));
    expect(() => focusComposerAtEnd(null)).not.toThrow();
    expect(() => focusComposerAtEnd(document.createElement('div'))).not.toThrow();
  });
});
