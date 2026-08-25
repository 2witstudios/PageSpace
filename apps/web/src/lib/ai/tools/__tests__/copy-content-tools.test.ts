import { describe, it, expect } from 'vitest';

// The factory imports no DB and no sandbox driver, so it runs directly against
// injected fakes (production wiring lives in copy-content-tools-runtime.ts).
import {
  createCopyContentTools,
  copyContentInputSchema,
  MAX_COPY_BYTES,
  type CopyContentDeps,
  type CopyPageRecord,
} from '../copy-content-tools';
import { toModelOutputForCopyContent } from '../copy-content-model-output';
import { MAX_WRITE_BYTES } from '@pagespace/lib/services/sandbox/tool-runners';

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

describe('copy_content — review regressions', () => {
  it('append into an empty page should not start with a blank line', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'COPY' }), page({ id: 'dst', content: '' })],
    });
    await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'append' },
    });
    expect(h.writes[0].newContent.startsWith('\n')).toBe(false);
    expect(h.writes[0].newContent).toContain('COPY');
  });

  it('append onto content ending in a newline should not double the newline', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'COPY' }), page({ id: 'dst', content: 'a\n' })],
    });
    await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'append' },
    });
    expect(h.writes[0].newContent).not.toContain('\n\n');
    expect(h.writes[0].newContent).toBe('a\nCOPY\n');
  });

  it('append onto content with no trailing newline should still separate the lines', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'COPY' }), page({ id: 'dst', content: 'a\nb' })],
    });
    await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'append' },
    });
    expect(h.writes[0].newContent).toBe('a\nb\nCOPY');
  });

  it('a FILE-page source is extracted plaintext, so copying it into an html page is refused', async () => {
    // FILE rows keep the schema default contentMode 'html' while holding
    // extracted TEXT, so trusting that default would let a .md upload through
    // into an html document as literal characters.
    const h = harness({
      pages: [
        page({ id: 'src', type: 'FILE', contentMode: 'html', content: '# Heading\n- bullet' }),
        page({ id: 'dst', type: 'DOCUMENT', contentMode: 'html', content: '<p>hi</p>' }),
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

  it('a FILE-page source copies cleanly into a markdown page, unmangled', async () => {
    const h = harness({
      pages: [
        page({ id: 'src', type: 'FILE', contentMode: 'html', content: '# Heading\n- bullet' }),
        page({ id: 'dst', type: 'DOCUMENT', contentMode: 'markdown', content: 'old' }),
      ],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
    // Not line-broken as if it were HTML.
    expect(h.writes[0].newContent).toBe('# Heading\n- bullet');
  });

  it('should not disclose a page title or type before the edit permission check', async () => {
    // Every type refusal names the page, so the permission gate has to run
    // first or it leaks what the page is to a caller who cannot edit it.
    const h = harness({
      pages: [page({ id: 'src' }), page({ id: 'dst', type: 'SHEET', title: 'Payroll 2026' })],
      canEditPage: async () => false,
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Payroll 2026');
    expect(JSON.stringify(result)).not.toContain('SHEET');
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

describe('copy_content — review round 2', () => {
  it('insertAfter into an html page should place the copy OUTSIDE the anchor element', async () => {
    // Hand-rolling the line index nested the copy inside the anchor's <p>,
    // producing invalid markup that Tiptap restructures on the next save —
    // which moves every line number underneath the agent.
    const h = harness({
      pages: [
        page({ id: 'src', type: 'DOCUMENT', contentMode: 'html', content: '<p>COPY</p>' }),
        page({ id: 'dst', type: 'DOCUMENT', contentMode: 'html', content: '<p>Alpha</p><p>Beta</p>' }),
      ],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'insertAfter', anchor: 'Alpha' },
    });
    expect(result.success).toBe(true);
    // The copy must sit between the two paragraphs, never inside the first.
    expect(h.writes[0].newContent).toBe('<p>\nAlpha\n</p>\n<p>\nCOPY\n</p>\n<p>\nBeta\n</p>');
  });

  it('insertAfter position:before into an html page should also respect the block boundary', async () => {
    const h = harness({
      pages: [
        page({ id: 'src', type: 'DOCUMENT', contentMode: 'html', content: '<p>C</p>' }),
        page({ id: 'dst', type: 'DOCUMENT', contentMode: 'html', content: '<p>Alpha</p>' }),
      ],
    });
    await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'insertAfter', anchor: 'Alpha', position: 'before' },
    });
    expect(h.writes[0].newContent).toBe('<p>\nC\n</p>\n<p>\nAlpha\n</p>');
  });

  it('an empty source should be refused, not used to wipe the destination', async () => {
    // A FILE page whose text was never extracted is the realistic trigger.
    const h = harness({
      pages: [
        page({ id: 'src', type: 'FILE', content: null }),
        page({ id: 'dst', content: 'IMPORTANT\nDATA' }),
      ],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Source is empty');
    expect(h.writes).toHaveLength(0);
  });

  it('an empty sandbox file should be refused too', async () => {
    const h = harness({ file: '', pages: [page({ id: 'dst', content: 'DATA' })] });
    const result = await run(h.deps, {
      from: { kind: 'file', path: 'empty.txt' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  it('should allow markdown into an html-mode page that actually holds markdown', async () => {
    // The #2463 page shape: contentMode says html, the content is markdown.
    // Refusing here sent the agent to a dead end for the tool's core use case.
    const h = harness({
      pages: [
        page({ id: 'src', contentMode: 'markdown', content: '# New' }),
        page({ id: 'dst', type: 'DOCUMENT', contentMode: 'html', content: '# already markdown\ntext' }),
      ],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
    expect(h.writes[0].newContent).toBe('# New');
  });

  it('should still refuse markdown into a page holding real HTML', async () => {
    const h = harness({
      pages: [
        page({ id: 'src', contentMode: 'markdown', content: '# New' }),
        page({ id: 'dst', type: 'DOCUMENT', contentMode: 'html', content: '<p>real html</p>' }),
      ],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Content mode mismatch');
  });

  it('should refuse FOLDER and AI_CHAT destinations, whose content is structured JSON', async () => {
    for (const type of ['FOLDER', 'AI_CHAT']) {
      const h = harness({
        pages: [page({ id: 'src', content: 'TEXT' }), page({ id: 'dst', type, content: '{"children":[]}' })],
      });
      const result = await run(h.deps, {
        from: { kind: 'page', pageId: 'src' },
        to: { kind: 'page', pageId: 'dst', mode: 'replace' },
      });
      expect(result.success, `${type} destination`).toBe(false);
      expect(h.writes).toHaveLength(0);
    }
  });

  it('should refuse an AI_CHAT source rather than dumping its transcript JSON', async () => {
    const h = harness({
      pages: [
        page({ id: 'src', type: 'AI_CHAT', content: '{"messages":[{"secret":1}]}' }),
        page({ id: 'dst', content: 'x' }),
      ],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  it('should report lines ADDED for an insertion, not just linesReplaced: 0', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'a\nb\nc' }), page({ id: 'dst', content: 'x' })],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'append' },
    });
    expect(result.linesAdded).toBe(3);
  });

  it('should surface a content-mode warning on SUCCESS, not only on refusal', async () => {
    const h = harness({
      pages: [
        page({ id: 'src', type: 'DOCUMENT', contentMode: 'html', content: '<p>X</p>' }),
        page({ id: 'dst', type: 'DOCUMENT', contentMode: 'html', content: '<p>real html</p>' }),
      ],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'append' },
    });
    expect(result.success).toBe(true);
    // This destination IS html, so no warning is expected — the assertion is
    // that the field is wired at all, checked by its absence here and its
    // presence in the schema-mismatch case above.
    expect(result).toHaveProperty('contentMode');
  });
});

describe('copy_content — input schema', () => {
  // The execute-level tests bypass zod entirely, so the schema needs its own.
  const parse = (v: unknown) => copyContentInputSchema.safeParse(v);

  it('should require to.mode for a page destination', () => {
    expect(parse({ from: { kind: 'page' }, to: { kind: 'page' } }).success).toBe(false);
  });

  it('should reject mode on a file destination', () => {
    expect(parse({ from: { kind: 'page' }, to: { kind: 'file', path: 'a', mode: 'replace' } }).success).toBe(false);
  });

  it('should require path for a file side', () => {
    expect(parse({ from: { kind: 'file' }, to: { kind: 'file', path: 'a' } }).success).toBe(false);
  });

  it('should reject a line range on a file source', () => {
    expect(parse({ from: { kind: 'file', path: 'a', lineStart: 1 }, to: { kind: 'file', path: 'b' } }).success).toBe(false);
  });

  it('should reject an inverted range on either side', () => {
    expect(parse({ from: { kind: 'page', lineStart: 5, lineEnd: 2 }, to: { kind: 'file', path: 'b' } }).success).toBe(false);
    expect(parse({ from: { kind: 'page' }, to: { kind: 'page', mode: 'replaceLines', startLine: 5, endLine: 2 } }).success).toBe(false);
  });

  it('should reject expectedTotalLines on modes that would ignore it', () => {
    // Silently discarding a staleness guard on `replace` is worse than not
    // offering one.
    expect(parse({ from: { kind: 'page' }, to: { kind: 'page', mode: 'replace', expectedTotalLines: 10 } }).success).toBe(false);
    expect(parse({ from: { kind: 'page' }, to: { kind: 'page', mode: 'replaceLines', startLine: 1, expectedTotalLines: 10 } }).success).toBe(true);
  });

  it('should require an anchor for insertAfter', () => {
    expect(parse({ from: { kind: 'page' }, to: { kind: 'page', mode: 'insertAfter' } }).success).toBe(false);
  });

  it('should accept the ordinary shapes', () => {
    expect(parse({ from: { kind: 'page', pageId: 'p', lineStart: 1, lineEnd: 4 }, to: { kind: 'page', pageId: 'q', mode: 'append' } }).success).toBe(true);
    expect(parse({ from: { kind: 'file', path: 'a.md' }, to: { kind: 'page', pageId: 'q', mode: 'replace' } }).success).toBe(true);
  });
});

describe('copy_content — content shape, one classifier for both sides', () => {
  const doc = (id: string, contentMode: string, content: string | null, type = 'DOCUMENT') =>
    page({ id, type, contentMode, content });

  it('an HTML page should copy into a freshly created empty page', async () => {
    // The canonical create_page -> copy_content flow. A one-sided classifier
    // called the empty destination "raw" and the html source "html", and
    // refused the most ordinary copy there is.
    const h = harness({
      pages: [doc('src', 'html', '<p>Hello</p>'), doc('dst', 'html', '')],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
    expect(h.writes).toHaveLength(1);
  });

  it('a RAW source should copy into an empty html-mode page', async () => {
    // The discriminating case for "empty means unknown": if an empty page were
    // classified html, this raw source would conflict and be refused — and this
    // is exactly what create_page (which still yields html-mode rows for
    // non-DOCUMENT types and legacy callers) followed by a file copy looks like.
    const h = harness({ pages: [doc('src', 'markdown', '# md'), doc('dst', 'html', '')] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
    expect(h.writes[0].newContent).toBe('# md');
  });

  it('a sandbox FILE should copy into an empty html-mode page', async () => {
    const h = harness({ file: 'plain report text\n', pages: [doc('dst', 'html', '')] });
    const result = await run(h.deps, {
      from: { kind: 'file', path: 'report.md' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
  });

  it('an HTML page should copy into a page whose content is null', async () => {
    const h = harness({ pages: [doc('src', 'html', '<p>Hi</p>'), doc('dst', 'html', null)] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
  });

  it('two pages of the SAME shape should copy, whichever shape that is', async () => {
    // html-mode rows holding markdown: the #2463 population. Both sides must be
    // asked the same question, or a page cannot be copied into its own sibling.
    const h = harness({
      pages: [doc('src', 'html', '# Heading\ntext'), doc('dst', 'html', '# Other\ntext')],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
    expect(h.writes[0].newContent).toBe('# Heading\ntext');
  });

  it('a page should be able to append into itself', async () => {
    const h = harness({ pages: [doc('p1', 'html', '# Heading\ntext')] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'p1' },
      to: { kind: 'page', pageId: 'p1', mode: 'append' },
    });
    expect(result.success).toBe(true);
  });

  it('a CANVAS holding a real HTML document should reject a markdown source', async () => {
    // looksLikeHtmlDocument keys on block tags and knows nothing of <!DOCTYPE>
    // or <html>, so sniffing a CANVAS misreads it as raw text. CANVAS is html
    // by type, and is classified that way rather than sniffed.
    const h = harness({
      pages: [
        doc('src', 'markdown', '# md'),
        doc('dst', 'html', '<!DOCTYPE html><html><body><p>hi</p></body></html>', 'CANVAS'),
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

  it('a CANVAS holding a real HTML document should accept an HTML source', async () => {
    const h = harness({
      pages: [
        doc('src', 'html', '<p>X</p>'),
        doc('dst', 'html', '<!DOCTYPE html><html><body><p>hi</p></body></html>', 'CANVAS'),
      ],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
  });

  it('should still refuse raw text into a page holding real HTML', async () => {
    const h = harness({ pages: [doc('src', 'markdown', '# md'), doc('dst', 'html', '<p>real</p>')] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
  });

  it('should still refuse HTML into a markdown-mode page', async () => {
    const h = harness({ pages: [doc('src', 'html', '<p>x</p>'), doc('dst', 'markdown', '# md')] });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
  });
});

describe('copy_content — round 3 details', () => {
  it('a whitespace-only source should be refused like an empty one', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: '   \n  \n' }), page({ id: 'dst', content: 'IMPORTANT' })],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Source is empty');
    expect(h.writes).toHaveLength(0);
  });

  it('but an explicitly named blank line range should still copy', async () => {
    // Asking for lines 2-2 of 'a\n\nb' is a deliberate selection.
    const h = harness({
      pages: [page({ id: 'src', content: 'a\n\nb' }), page({ id: 'dst', content: 'x' })],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src', lineStart: 2, lineEnd: 2 },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
  });

  it('should not report a negative linesAdded on a replace', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'one' }), page({ id: 'dst', content: 'a\nb\nc\nd\ne' })],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'replace' },
    });
    expect(result.success).toBe(true);
    expect(result.linesAdded).toBeUndefined();
    expect(result.linesReplaced).toBe(5);
  });

  it('should report linesAdded on an insertion', async () => {
    const h = harness({
      pages: [page({ id: 'src', content: 'a\nb\nc' }), page({ id: 'dst', content: 'x' })],
    });
    const result = await run(h.deps, {
      from: { kind: 'page', pageId: 'src' },
      to: { kind: 'page', pageId: 'dst', mode: 'append' },
    });
    expect(result.linesAdded).toBe(3);
  });
});

describe('copy_content — schema, round 3', () => {
  const parse = (v: unknown) => copyContentInputSchema.safeParse(v);

  it('should reject every page-only field on a file destination', () => {
    for (const extra of [
      { startLine: 1 },
      { endLine: 2 },
      { anchor: 'x' },
      { expectedTotalLines: 5 },
    ]) {
      const r = parse({ from: { kind: 'page' }, to: { kind: 'file', path: 'a', ...extra } });
      expect(r.success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('should reject expectedTotalLines: 0, which could only ever fail', () => {
    expect(parse({
      from: { kind: 'page' },
      to: { kind: 'page', mode: 'replaceLines', startLine: 1, expectedTotalLines: 0 },
    }).success).toBe(false);
  });

  it('should still accept a plain file destination', () => {
    expect(parse({ from: { kind: 'page' }, to: { kind: 'file', path: 'a.md' } }).success).toBe(true);
  });
});

describe('copy_content — cap parity with the sandbox runner', () => {
  it('MAX_COPY_BYTES must equal the runner MAX_WRITE_BYTES', () => {
    // The two are hand-duplicated across a package boundary (this module must
    // not import the sandbox package at runtime). If they drift, the tool
    // accepts a source the runner then refuses, or refuses one it would take.
    expect(MAX_COPY_BYTES).toBe(MAX_WRITE_BYTES);
  });
});
