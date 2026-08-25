import { describe, it, expect } from 'vitest';

// The factory imports no DB and no sandbox driver, so it runs directly against
// injected fakes (production wiring lives in copy-content-tools-runtime.ts).
import {
  createCopyContentTools,
  MAX_COPY_BYTES,
  type CopyContentDeps,
  type CopyPageRecord,
} from '../copy-content-tools';
import { toModelOutputForCopyContent } from '../copy-content-model-output';

const CONTEXT = { userId: 'u1', chatSource: { type: 'page', agentPageId: 'agent-1' } };

function page(over: Partial<CopyPageRecord> = {}): CopyPageRecord {
  return {
    id: 'p1',
    title: 'Doc',
    type: 'DOCUMENT',
    contentMode: 'markdown',
    content: 'alpha\nbravo\ncharlie\n',
    driveId: 'd1',
    revision: 1,
    ...over,
  };
}

interface Harness {
  deps: CopyContentDeps;
  writes: Array<{ pageId: string; newContent: string; metadata: Record<string, unknown> }>;
  fileWrites: Array<{ path: string; content: string }>;
}

function harness(over: Partial<CopyContentDeps> & { pages?: CopyPageRecord[]; file?: string } = {}): Harness {
  const writes: Harness['writes'] = [];
  const fileWrites: Harness['fileWrites'] = [];
  const pages = over.pages ?? [page()];

  const deps: CopyContentDeps = {
    findPage: async (id) => pages.find((p) => p.id === id) ?? null,
    canViewPage: async () => true,
    canEditPage: async () => true,
    writePageContent: async ({ page: p, newContent, metadata }) => {
      writes.push({ pageId: p.id, newContent, metadata });
    },
    readSandboxFile: async () => ({ success: true, content: over.file ?? 'FROM FILE\n', bytes: 10 }),
    writeSandboxFile: async ({ path, content }) => {
      fileWrites.push({ path, content });
      return { success: true, bytesWritten: Buffer.byteLength(content, 'utf8') };
    },
    isSandboxEnabledForContext: async () => true,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['pages', 'file'].includes(k))),
  } as CopyContentDeps;

  return { deps, writes, fileWrites };
}

function run(deps: CopyContentDeps, args: unknown, context: unknown = CONTEXT) {
  const tools = createCopyContentTools(deps);
  const fn = (tools.copy_content as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute;
  return fn(args, { experimental_context: context });
}

describe('copy_content — byte fidelity', () => {
  it('given a page->page whole replace, should store the source bytes exactly', async () => {
    // Awkward on purpose: angle brackets, backticks and CRLF are what a
    // re-transcribing model quietly reformats.
    const tricky = 'a <p> b\r\n`code`\n\nlast';
    const h = harness({ pages: [page({ id: 'src', content: tricky }), page({ id: 'dst', content: 'old\n' })] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });

    expect(result.success).toBe(true);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].newContent).toBe(tricky);
  });

  it('given a file->page copy, should write the file bytes verbatim', async () => {
    const h = harness({ file: 'line1\nline2\n', pages: [page({ id: 'dst', content: 'x\n' })] });
    const result = await run(h.deps, {
      from: { kind: 'file', path: 'out/report.md' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
    expect(h.writes[0].newContent).toBe('line1\nline2\n');
  });

  it('given a page->file copy, should hand the sandbox the exact bytes', async () => {
    const h = harness({ pages: [page({ id: 'src', content: 'alpha\nbravo\n' })] });
    await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'file', path: 'export.md' },
    });
    expect(h.fileWrites).toEqual([{ path: 'export.md', content: 'alpha\nbravo\n' }]);
  });

  it('given a source line range, should copy exactly those lines', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'l1\nl2\nl3\nl4\n' }), page({ id: 'dst', content: 'x\n' })],
    });
    await run(h.deps, {
      from: { kind: 'page', pageId: 'src', lineStart: 2, lineEnd: 3 },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(h.writes[0].newContent).toBe('l2\nl3');
  });
});

describe('copy_content — destination modes', () => {
  it('replaceLines: should change only the named range', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'NEW' }), page({ id: 'dst', content: 'a\nb\nc\n' })],
    });
    await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replaceLines', startLine: 2, endLine: 2 },
    });
    expect(h.writes[0].newContent).toBe('a\nNEW\nc\n');
  });

  it('append: should add at the end without a bespoke append primitive', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'TAIL' }), page({ id: 'dst', content: 'a\nb' })],
    });
    await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'append' },
    });
    expect(h.writes[0].newContent).toContain('TAIL');
    expect(h.writes[0].newContent.startsWith('a\nb')).toBe(true);
  });

  it('insertAfter: should place the copy next to the anchor line', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'MID' }), page({ id: 'dst', content: 'top\nANCHOR\nbottom' })],
    });
    await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'insertAfter', anchor: 'ANCHOR' },
    });
    expect(h.writes[0].newContent).toBe('top\nANCHOR\nMID\nbottom');
  });

  it('insertAfter with a missing anchor: should report inserted:false and write NOTHING', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'MID' }), page({ id: 'dst', content: 'top\nbottom' })],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'insertAfter', anchor: 'NOPE' },
    });
    expect(result).toMatchObject({ success: true, inserted: false });
    expect(h.writes).toHaveLength(0);
  });

  it('replaceLines: should honour expectedTotalLines and refuse a stale edit without writing', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'NEW' }), page({ id: 'dst', content: 'a\nb\nc\n' })],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replaceLines', startLine: 1, expectedTotalLines: 99 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Page changed since it was read');
    expect(h.writes).toHaveLength(0);
  });

  it('replaceLines: an out-of-range line should refuse with the real line count', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'NEW' }), page({ id: 'dst', content: 'a\nb\n' })],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replaceLines', startLine: 50 },
    });
    expect(result.success).toBe(false);
    expect(result.totalLines).toBe(3);
    expect(h.writes).toHaveLength(0);
  });
});

describe('copy_content — the token win', () => {
  it('should not hand the copied bytes back to the model', async () => {
    // If oldContent/newContent reach the model, the tool costs in input tokens
    // exactly what it saved in output tokens and is pointless.
    const h = harness({
      pages: [page({ id: 'src', content: 'SECRET-PAYLOAD' }), page({ id: 'dst', content: 'x\n' })],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });

    expect(result.oldContent).toBeTypeOf('string');
    const modelFacing = JSON.stringify(toModelOutputForCopyContent(result));
    expect(modelFacing).not.toContain('SECRET-PAYLOAD');
    expect(modelFacing).toContain('bytesCopied');
  });

  it('should still carry the diff fields on the persisted result for the renderer', async () => {
    const h = harness({ pages: [page({ id: 'src', content: 'NEW' }), page({ id: 'dst', content: 'OLD' })] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(typeof result.oldContent).toBe('string');
    expect(typeof result.newContent).toBe('string');
  });
});

describe('copy_content — authorization', () => {
  it('should refuse when the source cannot be read, without touching the destination', async () => {
    const h = harness({
      pages: [page({ id: 'src' }), page({ id: 'dst' })],
      canViewPage: async () => false,
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  it('should refuse when the destination cannot be edited, and write nothing', async () => {
    const h = harness({
      pages: [page({ id: 'src' }), page({ id: 'dst' })],
      canEditPage: async () => false,
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  it('given the per-agent sandbox switch off, should refuse the FILE arms', async () => {
    // copy_content is a workspace tool, so it survives
    // filterToolsForSandboxEnablement. Without this call-time check it would be
    // a way around that switch.
    const h = harness({ isSandboxEnabledForContext: async () => false });
    const result = await run(h.deps, {
      from: { kind: 'file', path: 'a.txt' },
      to: { kind: 'page', pageId: 'p1', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('sandbox');
    expect(h.writes).toHaveLength(0);
  });

  it('given the per-agent sandbox switch off, page->page should still work', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'S' }), page({ id: 'dst', content: 'D' })],
      isSandboxEnabledForContext: async () => false,
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
    expect(h.writes).toHaveLength(1);
  });

  it('given the sandbox switch off, a file DESTINATION should also refuse', async () => {
    const h = harness({ isSandboxEnabledForContext: async () => false });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'p1' },
      to: { kind: 'file', path: 'out.txt' },
    });
    expect(result.success).toBe(false);
    expect(h.fileWrites).toHaveLength(0);
  });
});

describe('copy_content — refusals that protect content', () => {
  it('given a raw source and an html destination, should refuse and not mutate', async () => {
    const h = harness({
      pages: [
        page({ id: 'src', contentMode: 'markdown', content: '# Heading' }),
        page({ id: 'dst', contentMode: 'html', content: '<p>hi</p>' }),
      ],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Content mode mismatch');
    expect(h.writes).toHaveLength(0);
  });

  it('given a raw source and a raw destination, should copy', async () => {
    const h = harness({
      pages: [
        page({ id: 'src', contentMode: 'markdown', content: '# Heading' }),
        page({ id: 'dst', contentMode: 'markdown', content: 'old' }),
      ],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
  });

  it('given an html source and a FILE destination, should allow it — an export has no content mode', async () => {
    const h = harness({ pages: [page({ id: 'src', contentMode: 'html', content: '<p>hi</p>' })] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'file', path: 'export.html' },
    });
    expect(result.success).toBe(true);
    expect(h.fileWrites).toHaveLength(1);
  });

  it('given a SHEET source, should refuse and point at read_sheet', async () => {
    const h = harness({ pages: [page({ id: 'src', type: 'SHEET' }), page({ id: 'dst' })] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('read_sheet');
  });

  it('given a SHEET destination, should refuse and point at edit_sheet_cells', async () => {
    const h = harness({ pages: [page({ id: 'src' }), page({ id: 'dst', type: 'SHEET' })] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('edit_sheet_cells');
    expect(h.writes).toHaveLength(0);
  });

  it('given a FILE-type destination page, should refuse', async () => {
    const h = harness({ pages: [page({ id: 'src' }), page({ id: 'dst', type: 'FILE' })] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  it('given a source over the byte cap, should refuse rather than copy part of it', async () => {
    // A half-copied document looks complete — there is no notice attached to a
    // page to say it was cut — so this must never truncate.
    const huge = 'x'.repeat(MAX_COPY_BYTES + 1);
    const h = harness({ pages: [page({ id: 'src', content: huge }), page({ id: 'dst' })] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Source is too large to copy');
    expect(h.writes).toHaveLength(0);
  });

  it('given a source line range past the end, should refuse with the real line count', async () => {
    const h = harness({ pages: [page({ id: 'src', content: 'a\nb\n' }), page({ id: 'dst' })] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src', lineStart: 90 },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(result.totalLines).toBe(3);
  });

  it('given an unreadable source file, should surface the runner error and write nothing', async () => {
    const h = harness({
      readSandboxFile: async () => ({ success: false, error: 'File not found.' }),
    });
    const result = await run(h.deps, {
      from: { kind: 'file', path: 'missing.txt' },
      to: { kind: 'page', pageId: 'p1', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('File not found');
    expect(h.writes).toHaveLength(0);
  });
});
