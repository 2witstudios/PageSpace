/**
 * `copy_content` — move bytes the agent ALREADY has, without re-emitting them.
 *
 * Every other write verb takes its content as a model-emitted string, so moving
 * a file the agent just built in the sandbox into a page costs a full
 * re-transcription of every byte: expensive, and lossy in the way models are
 * lossy — paraphrased prose, dropped blank lines, reflowed whitespace.
 *
 * This tool names a SOURCE and a DESTINATION and moves the bytes server-side.
 * It is deliberately thin: every arm delegates to the function that already
 * owns that operation (`replaceLines`/`insertLines` for line edits,
 * `applyPageMutation` for the write, `readSandboxFileForCopy`/`writeSandboxFile`
 * for the sandbox). The value is in what it does NOT do — no transcription, no
 * conversion, no truncation.
 *
 * Sources are RE-READ at execute time rather than addressed by a prior tool
 * result. That matches how this codebase already handles stale context:
 * `tool-result-eliding.ts` drops old outputs and tells the model to call the
 * tool again. Anything ephemeral (a command's stdout) the agent redirects to a
 * file first, which is a thing it can already do.
 *
 * Everything is injected so the whole surface is unit-testable with no DB, no
 * network and no sandbox.
 */
import { tool } from 'ai';
import { z } from 'zod';
import {
  LineRangeError,
  canonicalizeForLineEditing,
  projectLines,
  replaceLines,
  insertLines,
  type LineEditResult,
} from '@/lib/editor/line-edit';
import { insertAtAnchor } from '@/lib/editor/text-edit';
import { isRawTextPage, describeContentModeMismatch } from '../core/page-serializer';
import { looksLikeHtmlDocument } from '@/lib/editor/line-breaks';
import { isSheetType } from '@pagespace/lib/sheets/sheet';
import { PageType } from '@pagespace/lib/utils/enums';
import { toModelOutputForCopyContent } from './copy-content-model-output';
import { resolveOrThrowPageId } from './page-context-defaults';
import type { ToolExecutionContext } from '../core/types';

/** Mirrors MAX_WRITE_BYTES; asserted equal to the runner's cap by its test. */
export const MAX_COPY_BYTES = 1024 * 1024;

/** Longest path this tool will accept, matching the sandbox tools. */
export const MAX_COPY_PATH_LENGTH = 1024;

/** The page shape this tool needs. A subset of the repository row. */
export interface CopyPageRecord {
  id: string;
  title: string;
  type: string;
  contentMode: string | null;
  content: string | null;
  driveId: string;
  revision?: number | null;
}

export interface CopyContentDeps {
  /** Page reads/writes — all injected, so the factory imports no DB. */
  findPage: (pageId: string) => Promise<CopyPageRecord | null>;
  canViewPage: (context: ToolExecutionContext, pageId: string) => Promise<boolean>;
  canEditPage: (context: ToolExecutionContext, pageId: string) => Promise<boolean>;
  writePageContent: (args: {
    page: CopyPageRecord;
    newContent: string;
    context: ToolExecutionContext;
    metadata: Record<string, unknown>;
  }) => Promise<void>;

  /** Sandbox file IO. `readFile` MUST be the verbatim copy read, not readFile's. */
  readSandboxFile: (args: {
    path: string;
    context: ToolExecutionContext;
  }) => Promise<{ success: true; content: string; bytes: number } | { success: false; error: string }>;
  writeSandboxFile: (args: {
    path: string;
    content: string;
    context: ToolExecutionContext;
  }) => Promise<{ success: true; bytesWritten: number } | { success: false; error: string }>;

  /**
   * The per-agent sandbox switch, checked AT CALL TIME.
   *
   * `filterToolsForSandboxEnablement` strips sandbox tools by NAME, and
   * `pages.sandboxEnabled` is read once when the tool set is assembled. This
   * tool is registered as a workspace tool (its page→page arm touches no
   * sandbox and must work on every deployment), so it survives that filter —
   * which would make it a way around the switch for an agent whose sandbox
   * access is off. Adding it to SANDBOX_TOOL_NAMES is not an option: that would
   * strip the page→page arm from every agent, since the switch defaults off.
   * So the check moves here, and applies to the file arms only.
   */
  isSandboxEnabledForContext: (context: ToolExecutionContext) => Promise<boolean>;
}

const SIDE_KIND = z.enum(['page', 'file']);

export const copyFromSchema = z
  .object({
    kind: SIDE_KIND.describe('"page" to copy from a workspace page, "file" from a sandbox file.'),
    pageId: z
      .string()
      .optional()
      .describe('kind=page: the source page. Omit to use the page currently in view.'),
    path: z.string().min(1).max(MAX_COPY_PATH_LENGTH).optional().describe('kind=file: the sandbox path.'),
    lineStart: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'kind=page: first line to copy, 1-based. These are the SAME line numbers read_page showed you.'
      ),
    lineEnd: z.number().int().min(1).optional().describe('kind=page: last line to copy, inclusive.'),
  })
  .strict();

export const copyToSchema = z
  .object({
    kind: SIDE_KIND.describe('"page" to write into a workspace page, "file" into a sandbox file.'),
    pageId: z
      .string()
      .optional()
      .describe('kind=page: the destination page. Omit to use the page currently in view.'),
    path: z.string().min(1).max(MAX_COPY_PATH_LENGTH).optional().describe('kind=file: the sandbox path. Overwrites.'),
    mode: z
      .enum(['replace', 'replaceLines', 'insertAfter', 'append'])
      .optional()
      .describe(
        'kind=page: replace = whole page; replaceLines = the startLine..endLine range; insertAfter = after the anchor line; append = at the end.'
      ),
    startLine: z.number().int().min(1).optional().describe('mode=replaceLines: first line to replace.'),
    endLine: z.number().int().min(1).optional().describe('mode=replaceLines: last line, inclusive.'),
    anchor: z
      .string()
      .min(1)
      .optional()
      .describe('mode=insertAfter: text identifying the line to insert next to.'),
    position: z
      .enum(['before', 'after'])
      .optional()
      .describe('mode=insertAfter: which side of the anchor line. Defaults to after.'),
    expectedTotalLines: z
      .number()
      .int()
      // A page always projects to at least one line, so 0 could only ever be a
      // guaranteed staleness failure.
      .min(1)
      .optional()
      .describe(
        'mode=replaceLines: the line count you last read. The edit is refused if the page has changed since.'
      ),
  })
  .strict();

export const copyContentInputSchema = z
  .object({ from: copyFromSchema, to: copyToSchema })
  .strict()
  .superRefine((value, ctx) => {
    const require = (cond: boolean, path: (string | number)[], message: string) => {
      if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };

    if (value.from.kind === 'file') {
      require(!!value.from.path, ['from', 'path'], 'from.path is required when from.kind is "file".');
      require(
        value.from.lineStart === undefined && value.from.lineEnd === undefined,
        ['from', 'lineStart'],
        'Line ranges apply to pages, not files. Copy the whole file, or narrow it in the sandbox first.'
      );
    }
    if (
      value.from.lineStart !== undefined &&
      value.from.lineEnd !== undefined &&
      value.from.lineEnd < value.from.lineStart
    ) {
      require(false, ['from', 'lineEnd'], 'from.lineEnd must be >= from.lineStart.');
    }

    if (value.to.kind === 'file') {
      require(!!value.to.path, ['to', 'path'], 'to.path is required when to.kind is "file".');
      // Every page-only field, not just `mode`. Accepting a field and then
      // ignoring it is the thing this rule exists to prevent, so it has to
      // cover all of them or it only pretends to.
      for (const field of ['mode', 'startLine', 'endLine', 'anchor', 'expectedTotalLines'] as const) {
        require(
          value.to[field] === undefined,
          ['to', field],
          `to.${field} applies to page destinations only; a file destination is always a whole-file write.`
        );
      }
    } else {
      require(!!value.to.mode, ['to', 'mode'], 'to.mode is required when to.kind is "page".');
      if (value.to.mode === 'replaceLines') {
        require(value.to.startLine !== undefined, ['to', 'startLine'], 'mode "replaceLines" needs startLine.');
      }
      if (value.to.mode === 'replaceLines' &&
          value.to.startLine !== undefined &&
          value.to.endLine !== undefined &&
          value.to.endLine < value.to.startLine) {
        require(false, ['to', 'endLine'], 'to.endLine must be >= to.startLine.');
      }
      if (value.to.mode === 'insertAfter') {
        require(!!value.to.anchor, ['to', 'anchor'], 'mode "insertAfter" needs anchor.');
      }
      // Accepting a staleness guard and then ignoring it is worse than not
      // offering one — most of all on `replace`, which overwrites the whole
      // page. Only replaceLines threads it through, so only replaceLines takes
      // it.
      if (value.to.mode !== 'replaceLines' && value.to.expectedTotalLines !== undefined) {
        require(
          false,
          ['to', 'expectedTotalLines'],
          'expectedTotalLines only applies to mode "replaceLines"; it would be ignored here.'
        );
      }
    }
  });

type CopyFrom = z.infer<typeof copyFromSchema>;
type CopyTo = z.infer<typeof copyToSchema>;

interface ResolvedSource {
  bytes: string;
  /** How the source is described back to the caller and in activity metadata. */
  label: string;
  /**
   * What the copied bytes are. A sandbox file is always raw text; a page is
   * classified by `contentShapeOf`.
   */
  shape: ContentShape;
}

type Refusal = { success: false; error: string; message: string; [key: string]: unknown };

const refuse = (error: string, message: string, extra: Record<string, unknown> = {}): Refusal => ({
  success: false,
  error,
  message,
  ...extra,
});

/**
 * What the bytes of a page ARE: raw text, HTML, or not yet determinable.
 *
 * ONE classifier, used for the source and the destination alike. Round 2 gave
 * the two sides different rules — the destination sniffed its stored content
 * while the source went on `contentMode` alone — and the asymmetry broke the
 * two most ordinary copies there are: an HTML page into a freshly created
 * (empty) page, and a page into a sibling of the very shape the sniffing was
 * added for. Whatever the rule is, both sides have to be asked the same
 * question.
 *
 * `unknown` is the load-bearing case. An empty page has no content to conflict
 * with, so it is compatible with anything; treating "no evidence" as "HTML"
 * is what refused the create_page -> copy_content flow.
 *
 * The content vote is DOCUMENT-only, matching `describeContentModeMismatch`
 * exactly. Everything predates contentMode defaulting to markdown, so a large
 * population of html-mode DOCUMENTs actually hold markdown or JSON (#2463) and
 * their real format is only knowable by looking. Other html-typed pages are not
 * in that population: a CANVAS genuinely is an HTML document, and
 * `looksLikeHtmlDocument` would not recognize one anyway — it keys on block
 * tags and knows nothing of `<!DOCTYPE>`, `<html>` or `<body>`.
 */
type ContentShape = 'raw' | 'html' | 'unknown';

function contentShapeOf(page: CopyPageRecord): ContentShape {
  // markdown-mode documents and CODE pages: raw by declaration.
  if (isRawTextPage(page)) return 'raw';
  // A FILE page holds extracted PLAINTEXT while the row keeps the schema
  // default contentMode 'html'. `describeContentModeMismatch` says the same.
  if (page.type === PageType.FILE) return 'raw';
  // Not a DOCUMENT, not raw-by-declaration: an html-typed page that means it.
  if (page.type !== PageType.DOCUMENT) return 'html';

  const content = page.content ?? '';
  if (content.trim() === '') return 'unknown';
  return looksLikeHtmlDocument(content) ? 'html' : 'raw';
}

/** Two shapes conflict only when both are known and they differ. */
function shapesConflict(source: ContentShape, destination: ContentShape): boolean {
  return source !== 'unknown' && destination !== 'unknown' && source !== destination;
}

/**
 * Page types whose `content` holds structured records rather than editable
 * text. Copying bytes into (or out of) one of these is never meaningful.
 */
const STRUCTURED_PAGE_TYPES: ReadonlySet<string> = new Set<string>([
  PageType.CHANNEL,
  PageType.TASK_LIST,
  PageType.FOLDER,
  PageType.AI_CHAT,
]);

/** Page types whose content is not line-addressable text. */
function rejectNonTextPage(page: CopyPageRecord, side: 'source' | 'destination'): Refusal | null {
  if (isSheetType(page.type as PageType)) {
    return refuse(
      'Sheets are not line-addressable',
      side === 'source'
        ? `"${page.title}" is a sheet. Its content is rows, not lines, so it cannot be copied byte-for-byte. Use read_sheet to read it.`
        : `"${page.title}" is a sheet. Use edit_sheet_cells to write cells; a byte-for-byte copy has no meaning for rows.`,
      { pageId: page.id, type: page.type }
    );
  }
  // FOLDER and AI_CHAT are seeded with structured JSON by create_page
  // (`{"children":[]}` / `{"messages":[]}`), so writing text over them destroys
  // the page rather than editing it — and reading one dumps that raw JSON into
  // the destination. CANVAS is deliberately absent: it genuinely is an HTML
  // page.
  if (STRUCTURED_PAGE_TYPES.has(page.type)) {
    return refuse(
      'Not a text page',
      `"${page.title}" is a ${page.type}, whose content is structured records rather than text. There is nothing to copy byte-for-byte.`,
      { pageId: page.id, type: page.type }
    );
  }
  return null;
}

export function createCopyContentTools(deps: CopyContentDeps) {
  const readContext = (options: unknown): ToolExecutionContext | undefined =>
    (options as { experimental_context?: ToolExecutionContext })?.experimental_context;

  async function resolveSource(
    from: CopyFrom,
    context: ToolExecutionContext
  ): Promise<ResolvedSource | Refusal> {
    if (from.kind === 'file') {
      if (!(await deps.isSandboxEnabledForContext(context))) {
        return refuse(
          'Sandbox access is off for this agent',
          "This agent cannot reach sandbox files. Enable sandbox access in the agent's settings, or copy from a page instead."
        );
      }
      const read = await deps.readSandboxFile({ path: from.path as string, context });
      if (!read.success) return refuse('Could not read the source file', read.error);
      return { bytes: read.content, label: `file:${from.path}`, shape: 'raw' };
    }

    const pageId = resolveOrThrowPageId(from.pageId, context);
    const page = await deps.findPage(pageId);
    if (!page) return refuse('Source page not found', `No page with ID "${pageId}".`);
    if (!(await deps.canViewPage(context, page.id))) {
      return refuse('Insufficient permissions', `You do not have access to read "${page.title}".`);
    }
    const rejected = rejectNonTextPage(page, 'source');
    if (rejected) return rejected;

    // The SAME projection read_page shows, so a range copied from a fresh read
    // addresses the same lines the agent saw.
    const sourceShape = contentShapeOf(page);
    // 'unknown' means an empty page — nothing to line-break either way.
    const serialized = canonicalizeForLineEditing(page.content, sourceShape !== 'html');
    const allLines = serialized.split('\n');
    const totalLines = allLines.length;

    if (from.lineStart === undefined && from.lineEnd === undefined) {
      return { bytes: serialized, label: `page:${page.id}`, shape: sourceShape };
    }

    const start = from.lineStart ?? 1;
    if (start > totalLines) {
      return refuse(
        'Line range is past the end of the source',
        `"${page.title}" has ${totalLines} line${totalLines === 1 ? '' : 's'}, so line ${start} does not exist.`,
        { totalLines }
      );
    }
    const end = from.lineEnd !== undefined ? Math.min(from.lineEnd, totalLines) : totalLines;
    return {
      bytes: allLines.slice(start - 1, end).join('\n'),
      label: `page:${page.id} lines ${start}-${end}`,
      shape: sourceShape,
    };
  }

  async function writeToPage(
    to: CopyTo,
    source: ResolvedSource,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    const pageId = resolveOrThrowPageId(to.pageId, context);
    const page = await deps.findPage(pageId);
    if (!page) return refuse('Destination page not found', `No page with ID "${pageId}".`);
    // Permission FIRST: every refusal below names the page's title or type, so
    // running them ahead of the check would tell a caller without edit access
    // what the page is.
    if (!(await deps.canEditPage(context, page.id))) {
      return refuse('Insufficient permissions', 'You do not have edit access to this page.');
    }
    if (page.type === PageType.FILE) {
      return refuse(
        'Cannot write to FILE pages',
        'This is an uploaded file; its content is managed by the system. Create a document page instead.',
        { pageId: page.id }
      );
    }
    const rejected = rejectNonTextPage(page, 'destination');
    if (rejected) return rejected;
    // Byte-for-byte means byte-for-byte: this tool converts nothing. Raw text
    // written into an html-mode document renders as literal characters, which
    // is exactly the "literal garbage, not formatting" the writing-documents
    // skill tells agents to avoid — so refuse rather than produce it.
    const destShape = contentShapeOf(page);
    // The line projection follows the page's DECLARED mode, unchanged — only the
    // compatibility gate consults the sniffed shape.
    const destIsRawText = isRawTextPage(page);
    if (shapesConflict(source.shape, destShape)) {
      return refuse(
        'Content mode mismatch',
        `The source is ${source.shape === 'raw' ? 'raw text (markdown, code, or a file)' : 'HTML'} but "${page.title}" holds ` +
          `${destShape === 'raw' ? 'raw text' : 'HTML'}. copy_content never converts between them — ` +
          `writing one into the other produces literal characters, not formatting. ` +
          `Create a page with the matching mode (create_page defaults to markdown) and copy into that.`,
        {
          pageId: page.id,
          sourceShape: source.shape,
          destinationShape: destShape,
          destinationContentMode: page.contentMode ?? 'html',
        }
      );
    }

    const lineCount = projectLines(page.content, destIsRawText).length;
    let edit: LineEditResult;
    let anchorLine: number | null = null;
    try {
      switch (to.mode) {
        case 'replace':
          edit = replaceLines({
            content: page.content,
            startLine: 1,
            endLine: lineCount,
            replacement: source.bytes,
            isRawText: destIsRawText,
          });
          break;
        case 'replaceLines':
          edit = replaceLines({
            content: page.content,
            startLine: to.startLine as number,
            endLine: to.endLine ?? (to.startLine as number),
            replacement: source.bytes,
            isRawText: destIsRawText,
            expectedTotalLines: to.expectedTotalLines,
          });
          break;
        case 'append': {
          // insertLines clamps to one past the last line, so "the end" needs no
          // separate primitive — but a trailing newline projects as a final
          // EMPTY line, and inserting after that empty line yields a blank line
          // between the old content and the copy ('a\n' -> 'a\n\n<copy>').
          // Empty content is the same trap: it projects as one empty line, so
          // a copy into an empty page would start with a blank line. Insert
          // BEFORE that trailing empty line instead, which keeps the document's
          // terminal newline exactly where it was.
          const destLines = projectLines(page.content, destIsRawText);
          const endsWithBlank = destLines[destLines.length - 1] === '';
          edit = insertLines({
            content: page.content,
            startLine: endsWithBlank ? destLines.length : destLines.length + 1,
            insertion: source.bytes,
            isRawText: destIsRawText,
          });
          break;
        }
        case 'insertAfter': {
          // insertAtAnchor, NOT a hand-rolled findIndex + insertLines. On an
          // html page it snaps to the block boundary, so the copy lands outside
          // the anchor's element instead of nested inside it — hand-rolling the
          // index produced `<p>Alpha<p>COPY</p></p>`, invalid markup that Tiptap
          // restructures on the next save, moving every line number underneath
          // the agent. insert_content has always used this; so does this now.
          const anchored = insertAtAnchor({
            content: page.content,
            anchor: to.anchor as string,
            insertion: source.bytes,
            position: to.position ?? 'after',
            isRawText: destIsRawText,
          });
          if (!anchored.inserted) {
            // Mirrors insert_content: a missing anchor is a no-op the agent can
            // act on, not a failure — and nothing is written.
            return {
              success: true,
              inserted: false,
              pageId: page.id,
              title: page.title,
              message: `No line containing "${to.anchor}" was found in "${page.title}". Nothing was copied.`,
            };
          }
          edit = {
            oldContent: anchored.oldContent,
            newContent: anchored.newContent,
            newLineCount: anchored.newLineCount,
            previousLineCount: anchored.oldContent.split('\n').length,
            linesReplaced: 0,
            changeType: 'insertion',
          };
          anchorLine = anchored.anchorLine;
          break;
        }
        default:
          return refuse('Unsupported mode', `Unknown destination mode "${String(to.mode)}".`);
      }
    } catch (error) {
      if (error instanceof LineRangeError) {
        return refuse(
          error.kind === 'stale' ? 'Page changed since it was read' : 'Line number out of range',
          error.message,
          {
            totalLines: lineCount,
            suggestion: 'Read the page again and re-address the copy against the line numbers it returns.',
            pageId: page.id,
          }
        );
      }
      throw error;
    }

    await deps.writePageContent({
      page,
      newContent: edit.newContent,
      context,
      metadata: {
        copiedFrom: source.label,
        changeType: edit.changeType,
        // An insertion replaces nothing, so its size is the lines it ADDED.
        linesChanged:
          edit.changeType === 'insertion'
            ? edit.newLineCount - edit.previousLineCount
            : edit.linesReplaced,
      },
    });

    // An insertion replaces nothing, so `linesReplaced` is 0 by construction —
    // reporting only that for a 400-line append reads as "nothing happened".
    // Insertion ONLY: on a replace this delta goes negative, and a field named
    // `linesAdded` reading -4 is a number an agent will misread. The replace
    // modes already describe themselves with linesReplaced + newLineCount.
    const isInsertion = edit.changeType === 'insertion';
    // Surfaced on SUCCESS, not only on the mismatch refusal: replace_lines and
    // insert_content both attach it to the result, and a page whose stored
    // content disagrees with its declared mode is exactly what an agent needs
    // told after a write, not just when one is refused.
    // From the content just STORED, not the pre-write row: a warning that
    // describes the document as it used to be is worse than none.
    const contentModeWarning = describeContentModeMismatch({ ...page, content: edit.newContent });

    return {
      success: true,
      pageId: page.id,
      title: page.title,
      type: page.type,
      contentMode: page.contentMode || 'html',
      mode: to.mode,
      ...(anchorLine !== null ? { anchorLine } : {}),
      sourceLabel: source.label,
      bytesCopied: Buffer.byteLength(source.bytes, 'utf8'),
      // From the edit result, never recomputed — five copies of this
      // arithmetic disagreeing is what #2463 was.
      linesReplaced: edit.linesReplaced,
      ...(isInsertion ? { linesAdded: edit.newLineCount - edit.previousLineCount } : {}),
      newLineCount: edit.newLineCount,
      previousLineCount: edit.previousLineCount,
      ...(contentModeWarning ? { contentModeWarning } : {}),
      // Stripped before the model sees them (copy-content-model-output.ts);
      // kept here because RichDiffRenderer draws from them.
      oldContent: edit.oldContent,
      newContent: edit.newContent,
      message: `Copied ${source.label} into "${page.title}" without re-transcribing it.`,
    };
  }

  async function writeToFile(
    to: CopyTo,
    source: ResolvedSource,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    if (!(await deps.isSandboxEnabledForContext(context))) {
      return refuse(
        'Sandbox access is off for this agent',
        "This agent cannot write sandbox files. Enable sandbox access in the agent's settings, or copy into a page instead."
      );
    }
    const written = await deps.writeSandboxFile({
      path: to.path as string,
      content: source.bytes,
      context,
    });
    if (!written.success) return refuse('Could not write the destination file', written.error);
    return {
      success: true,
      path: to.path,
      sourceLabel: source.label,
      bytesCopied: written.bytesWritten,
      message: `Copied ${source.label} to ${to.path} without re-transcribing it.`,
    };
  }

  return {
    copy_content: tool({
      description:
        'Copy content you already have from one place to another WITHOUT retyping it: page->page, page->file, file->page, file->file. ' +
        'The bytes move server-side, so this costs no output tokens and is byte-exact. ' +
        'Use it instead of pasting content into replace_lines, insert_content or writeFile. ' +
        'It never converts between formats. To copy into a new page, call create_page first (it takes no content), then copy into it.',
      inputSchema: copyContentInputSchema,
      toModelOutput: ({ output }) => toModelOutputForCopyContent(output),
      execute: async ({ from, to }, options) => {
        const context = readContext(options);
        if (!context?.userId) throw new Error('User authentication required');

        // Resolve BOTH page ids before doing any work. resolveOrThrowPageId
        // throws when neither an explicit id nor a page-in-view is available,
        // and resolving the destination lazily meant that throw landed AFTER
        // the source had been read — provisioning a sandbox, spending machine
        // time and writing an audit row for a copy that could never land.
        try {
          if (from.kind === 'page') resolveOrThrowPageId(from.pageId, context);
          if (to.kind === 'page') resolveOrThrowPageId(to.pageId, context);
        } catch (error) {
          return refuse(
            'No page specified',
            error instanceof Error ? error.message : String(error)
          );
        }

        // Source first, destination second, write last. Nothing is written
        // until BOTH sides have been authorized.
        const source = await resolveSource(from, context);
        if ('success' in source) return source;

        const bytes = Buffer.byteLength(source.bytes, 'utf8');
        // A zero-byte source is the limit case of the truncation this tool
        // refuses to do: `replace` would empty the destination and report
        // success, with only `bytesCopied: 0` to say so. It nearly always means
        // the source is not what the agent thinks — an unextracted upload
        // (image, scanned PDF, extraction still pending) or an empty file — so
        // it is refused rather than executed.
        // Whitespace-only counts as empty: an unextracted upload commonly yields
        // a lone newline or a run of spaces rather than a truly empty string,
        // and copying that over a page is the same silent wipe.
        //
        // Unless the caller NARROWED the source explicitly — asking for lines
        // 2-2 of a document is a deliberate selection, and a blank separator
        // line is a legitimate thing to copy.
        const deliberatelyNarrowed = from.kind === 'page' && (from.lineStart !== undefined || from.lineEnd !== undefined);
        if (source.bytes.trim() === '' && !deliberatelyNarrowed) {
          return refuse(
            'Source is empty',
            `${source.label} has no content, so there is nothing to copy. Copying it would empty the destination rather than fill it. ` +
              `If the source is an uploaded file, its text may not have been extracted yet. ` +
              `To copy blank lines on purpose, name them with from.lineStart/from.lineEnd.`,
            { sourceBytes: bytes }
          );
        }
        if (bytes > MAX_COPY_BYTES) {
          return refuse(
            'Source is too large to copy',
            `${source.label} is ${bytes} bytes, over the ${MAX_COPY_BYTES}-byte limit. ` +
              `Narrow it with from.lineStart/from.lineEnd. It is NOT copied partially — a half-copied ` +
              `document looks complete, so this refuses instead.`,
            { sourceBytes: bytes, limit: MAX_COPY_BYTES }
          );
        }

        return to.kind === 'page'
          ? writeToPage(to, source, context)
          : writeToFile(to, source, context);
      },
    }),
  };
}
