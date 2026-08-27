import { describe, it, expect } from 'vitest';
import { toModelOutputForPageWrite } from '../page-write-model-output';
import { pageWriteTools } from '../page-write-tools';

describe('toModelOutputForPageWrite', () => {
  it('should strip oldContent/newContent but keep counts and identity', () => {
    const out = toModelOutputForPageWrite({
      success: true,
      pageId: 'p1',
      title: 'Doc',
      linesReplaced: 3,
      newLineCount: 40,
      oldContent: 'OLD-BYTES'.repeat(1000),
      newContent: 'NEW-BYTES'.repeat(1000),
    }) as { value: Record<string, unknown> };

    expect(out.value.oldContent).toBeUndefined();
    expect(out.value.newContent).toBeUndefined();
    expect(out.value.linesReplaced).toBe(3);
    expect(out.value.newLineCount).toBe(40);
    expect(out.value.pageId).toBe('p1');
  });

  it('should pass a refusal through unchanged (no content keys to strip)', () => {
    const refusal = { success: false, error: 'Line number out of range', totalLines: 12 };
    const out = toModelOutputForPageWrite(refusal) as { value: Record<string, unknown> };
    expect(out.value).toEqual(refusal);
  });

  it('should tolerate a non-object output', () => {
    expect(() => toModelOutputForPageWrite(null)).not.toThrow();
    expect(() => toModelOutputForPageWrite('text')).not.toThrow();
  });
});

describe('replace_lines / insert_content — toModelOutput is wired to the tool', () => {
  // Deleting the `toModelOutput:` line from the tool definition would leave
  // the helper's own unit tests green while the tool went back to echoing the
  // whole before/after document to the model on every edit.
  it('replace_lines carries a toModelOutput that strips content', () => {
    const tool = pageWriteTools.replace_lines as unknown as {
      toModelOutput?: (arg: { output: unknown }) => { value: Record<string, unknown> };
    };
    expect(tool.toModelOutput, 'replace_lines must define toModelOutput').toBeTypeOf('function');

    const modelFacing = JSON.stringify(
      tool.toModelOutput!({ output: { success: true, oldContent: 'X', newContent: 'Y', newLineCount: 5 } }),
    );
    expect(modelFacing).not.toContain('oldContent');
    expect(modelFacing).not.toContain('newContent');
    expect(modelFacing).toContain('newLineCount');
  });

  it('insert_content carries a toModelOutput that strips content', () => {
    const tool = pageWriteTools.insert_content as unknown as {
      toModelOutput?: (arg: { output: unknown }) => { value: Record<string, unknown> };
    };
    expect(tool.toModelOutput, 'insert_content must define toModelOutput').toBeTypeOf('function');

    const modelFacing = JSON.stringify(
      tool.toModelOutput!({ output: { success: true, oldContent: 'X', newContent: 'Y', anchorLine: 3 } }),
    );
    expect(modelFacing).not.toContain('oldContent');
    expect(modelFacing).not.toContain('newContent');
    expect(modelFacing).toContain('anchorLine');
  });
});
