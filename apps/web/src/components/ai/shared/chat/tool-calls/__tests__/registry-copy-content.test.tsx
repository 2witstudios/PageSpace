import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import { toolRenderers } from '../registry';
import { RichDiffRenderer } from '../RichDiffRenderer';

const render = (parsedOutput: Record<string, unknown>) =>
  toolRenderers['copy_content']({
    toolName: 'copy_content',
    parsedInput: null,
    parsedOutput,
    output: parsedOutput,
  } as Parameters<(typeof toolRenderers)['copy_content']>[0]);

describe('copy_content renderer', () => {
  it('given a completed page copy, should render the diff', () => {
    const result = render({
      success: true,
      title: 'Doc',
      oldContent: 'old',
      newContent: 'new',
    });
    expect(isValidElement(result) && result.type).toBe(RichDiffRenderer);
  });

  it('given inserted:false, should NOT render a diff', () => {
    // A missing insertAfter anchor rides on a success:true envelope and writes
    // nothing, so rendering it as a completed update would report a copy that
    // never happened.
    const result = render({
      success: true,
      inserted: false,
      title: 'Doc',
      message: 'No line containing "NOPE" was found.',
    });
    expect(isValidElement(result) && result.type).not.toBe(RichDiffRenderer);
  });

  it('given inserted:false, should report the copy as unsuccessful', () => {
    const result = render({ success: true, inserted: false, title: 'Doc' });
    expect(isValidElement(result) && (result.props as { success?: boolean }).success).toBe(false);
  });

  it('given inserted:false alongside diff fields, should still not render a diff', () => {
    // Defensive: the envelope must decide, not the presence of content keys.
    const result = render({
      success: true,
      inserted: false,
      oldContent: 'old',
      newContent: 'new',
    });
    expect(isValidElement(result) && result.type).not.toBe(RichDiffRenderer);
  });

  it('given a file destination (no diff fields), should render the action summary as successful', () => {
    const result = render({ success: true, path: 'export.md', message: 'Copied.' });
    expect(isValidElement(result) && result.type).not.toBe(RichDiffRenderer);
    expect(isValidElement(result) && (result.props as { success?: boolean }).success).toBe(true);
  });

  it('given a refusal, should report it as unsuccessful', () => {
    const result = render({ success: false, error: 'Content mode mismatch' });
    expect(isValidElement(result) && (result.props as { success?: boolean }).success).toBe(false);
  });
});
