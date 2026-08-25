import { describe, it, expect } from 'vitest';
import { toModelOutputForCopyContent } from '../copy-content-model-output';
import { createCopyContentTools, type CopyContentDeps } from '../copy-content-tools';

describe('toModelOutputForCopyContent', () => {
  it('should strip the copied bytes but keep the counts', () => {
    const out = toModelOutputForCopyContent({
      success: true,
      pageId: 'p1',
      bytesCopied: 42,
      oldContent: 'OLD-BYTES',
      newContent: 'NEW-BYTES',
    }) as { value: Record<string, unknown> };

    expect(out.value.oldContent).toBeUndefined();
    expect(out.value.newContent).toBeUndefined();
    expect(out.value.bytesCopied).toBe(42);
    expect(out.value.pageId).toBe('p1');
  });

  it('should pass a refusal through unchanged', () => {
    const refusal = { success: false, error: 'Source is empty', message: 'nothing to copy' };
    const out = toModelOutputForCopyContent(refusal) as { value: Record<string, unknown> };
    expect(out.value).toEqual(refusal);
  });

  it('should tolerate a non-object output', () => {
    expect(() => toModelOutputForCopyContent(null)).not.toThrow();
    expect(() => toModelOutputForCopyContent('text')).not.toThrow();
  });
});

describe('copy_content — toModelOutput is actually WIRED to the tool', () => {
  // The suite used to call the helper directly, which pins the helper and not
  // the tool: deleting `toModelOutput:` from the tool definition left every
  // test green while turning the tool into a pessimization — it would have sent
  // up to ~2 MB of copied bytes back as input tokens, which is the one thing it
  // exists to avoid.
  const deps = {
    findPage: async () => ({
      id: 'p1', title: 'Doc', type: 'DOCUMENT', contentMode: 'markdown',
      content: 'OLD', driveId: 'd1', revision: 1,
    }),
    canViewPage: async () => true,
    canEditPage: async () => true,
    writePageContent: async () => {},
    readSandboxFile: async () => ({ success: true as const, content: 'X', bytes: 1 }),
    writeSandboxFile: async () => ({ success: true as const, bytesWritten: 1 }),
    isSandboxEnabledForContext: async () => true,
  } as unknown as CopyContentDeps;

  it('the registered tool must carry a toModelOutput that strips content', async () => {
    const tool = createCopyContentTools(deps).copy_content as {
      execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
      toModelOutput?: (arg: { output: unknown }) => { value: Record<string, unknown> };
    };

    expect(tool.toModelOutput, 'copy_content must define toModelOutput').toBeTypeOf('function');

    const result = await tool.execute(
      { from: { kind: 'page', pageId: 'p1' }, to: { kind: 'page', pageId: 'p1', mode: 'append' } },
      { experimental_context: { userId: 'u1' } },
    );
    expect(result.success).toBe(true);
    expect(typeof result.oldContent).toBe('string');

    const modelFacing = JSON.stringify(tool.toModelOutput!({ output: result }));
    expect(modelFacing).not.toContain('oldContent');
    expect(modelFacing).not.toContain('newContent');
    expect(modelFacing).toContain('bytesCopied');
  });
});
