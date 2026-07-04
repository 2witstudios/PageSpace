import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError, ValidationError } from '../../errors.js';
import { deleteLines, editSheetCells, insertLines, readDocument, replaceLines } from '../documents.js';

const config = { baseUrl: 'https://pagespace.ai' };
const DOCS_URL = 'https://pagespace.ai/api/mcp/documents';

describe('pages.read (documents) — request shape', () => {
  it('defaults operation to "read" and sends a bare pageId body', () => {
    const parsed = readDocument.inputSchema.parse({ pageId: 'p1abc' });
    const request = buildRequest(readDocument, parsed, config);
    expect(request.method).toBe('POST');
    expect(request.url).toBe(DOCS_URL);
    expect(JSON.parse(request.body!)).toEqual({ operation: 'read', pageId: 'p1abc' });
  });

  it('serializes a startLine/endLine range', () => {
    const parsed = readDocument.inputSchema.parse({ pageId: 'p1abc', startLine: 2, endLine: 5 });
    const request = buildRequest(readDocument, parsed, config);
    expect(JSON.parse(request.body!)).toEqual({ operation: 'read', pageId: 'p1abc', startLine: 2, endLine: 5 });
  });

  it('rejects endLine < startLine', () => {
    const result = readDocument.inputSchema.safeParse({ pageId: 'p1abc', startLine: 5, endLine: 2 });
    expect(result.success).toBe(false);
  });

  it('rejects a zero or negative startLine', () => {
    const result = readDocument.inputSchema.safeParse({ pageId: 'p1abc', startLine: 0 });
    expect(result.success).toBe(false);
  });
});

describe('pages.read (documents) — response contract: generic text page', () => {
  const genericFixture = {
    pageId: 'p1abc',
    pageTitle: 'Design Doc',
    totalLines: 3,
    numberedLines: ['   1 | a', '   2 | b', '   3 | c'],
    content: 'a\nb\nc',
  };

  it('parses a plain DOCUMENT/CODE page with no pageType field', () => {
    const result = parseResponse(readDocument, 200, new Headers(), JSON.stringify(genericFixture));
    expect(result).toEqual(genericFixture);
  });

  it('parses a FILE page with fileMetadata attached', () => {
    const withFile = {
      ...genericFixture,
      fileMetadata: { mimeType: 'application/pdf', fileSize: 1024, originalFileName: 'doc.pdf', processingStatus: 'completed' },
    };
    const result = parseResponse(readDocument, 200, new Headers(), JSON.stringify(withFile));
    expect(result).toEqual(withFile);
  });

  it('parses an out-of-range read (empty content + rangeMessage)', () => {
    const outOfRange = { ...genericFixture, numberedLines: [], content: '', rangeStart: 10, rangeEnd: 10, rangeMessage: 'beyond document length' };
    const result = parseResponse(readDocument, 200, new Headers(), JSON.stringify(outOfRange));
    expect(result).toEqual(outOfRange);
  });
});

describe('pages.read (documents) — response contract: CHANNEL page', () => {
  it('parses a channel transcript', () => {
    const channelFixture = {
      pageId: 'c1abc',
      pageTitle: 'general',
      pageType: 'CHANNEL',
      totalLines: 2,
      numberedLines: ['   1 | [user] Ada (2026-01-01T00:00:00.000Z): hi', '   2 | [agent] Bot (2026-01-01T00:00:01.000Z): hello'],
      content: '[user] Ada (2026-01-01T00:00:00.000Z): hi\n[agent] Bot (2026-01-01T00:00:01.000Z): hello',
      messageCount: 2,
      totalMessages: 2,
    };
    const result = parseResponse(readDocument, 200, new Headers(), JSON.stringify(channelFixture));
    expect(result).toEqual(channelFixture);
  });

  it('never matches the generic branch (pageType present rules it out)', () => {
    const emptyChannel = {
      pageId: 'c1abc',
      pageTitle: 'general',
      pageType: 'CHANNEL',
      totalLines: 0,
      numberedLines: [] as string[],
      content: '',
      messageCount: 0,
      totalMessages: 0,
    };
    const result = parseResponse(readDocument, 200, new Headers(), JSON.stringify(emptyChannel));
    expect(result).toEqual(emptyChannel);
  });
});

describe('pages.read (documents) — response contract: FILE status page', () => {
  it('parses a still-processing FILE page', () => {
    const fixture = {
      pageId: 'f1abc',
      pageTitle: 'scan.pdf',
      pageType: 'FILE',
      status: 'processing',
      error: 'File is still being processed',
      suggestion: 'Please try again in a moment',
    };
    const result = parseResponse(readDocument, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('parses a visual FILE page (message + fileMetadata, no error)', () => {
    const fixture = {
      pageId: 'f2abc',
      pageTitle: 'photo.png',
      pageType: 'FILE',
      status: 'visual',
      message: 'This is a visual file (image/png). Vision-capable processing is required to interpret its content.',
      fileMetadata: { mimeType: 'image/png', fileSize: 2048, originalFileName: 'photo.png', processingStatus: 'visual' },
    };
    const result = parseResponse(readDocument, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });
});

describe('pages.read (documents) — response contract: TASK_LIST page', () => {
  const taskListFixture = {
    pageId: 'tl1abc',
    pageTitle: 'Sprint Board',
    pageType: 'TASK_LIST',
    taskListId: 'list1abc',
    parentTaskList: null,
    totalLines: 1,
    numberedLines: ['   1 | # Sprint Board'],
    content: '# Sprint Board',
    tasks: [
      {
        id: 'task1abc',
        title: 'Ship it',
        status: 'in_progress',
        priority: 'high',
        assigneeId: null,
        assigneeAgentId: null,
        dueDate: null,
        position: 1,
        completedAt: null,
        pageId: 'task1page',
        assignee: null,
        assigneeAgent: null,
        assignees: [],
        hasContent: true,
        subTaskCount: 2,
        subTaskCompletedCount: 1,
      },
    ],
    availableStatuses: [{ slug: 'pending', label: 'To Do', group: 'todo', position: 0 }],
    progress: { total: 1, percentage: 0, byGroup: { todo: 0, in_progress: 1, done: 0 }, bySlug: { in_progress: 1 } },
  };

  it('parses the full TASK_LIST extras (availableStatuses, progress, tasks)', () => {
    const result = parseResponse(readDocument, 200, new Headers(), JSON.stringify(taskListFixture));
    expect(result).toEqual(taskListFixture);
  });

  it('parses a nested task list with a parentTaskList reference', () => {
    const nested = { ...taskListFixture, parentTaskList: { pageId: 'parent1', title: 'Epic', taskListId: 'listparent' } };
    const result = parseResponse(readDocument, 200, new Headers(), JSON.stringify(nested));
    expect(result).toEqual(nested);
  });

  it('rejects a task missing a required field (zero-trust on the hot-path domain)', () => {
    const malformed = { ...taskListFixture, tasks: [{ ...taskListFixture.tasks[0] }] } as { tasks: Array<Record<string, unknown>> };
    delete malformed.tasks[0]!.subTaskCount;
    const result = parseResponse(readDocument, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });
});

describe('pages.replaceLines — request shape', () => {
  it('defaults operation to "replace"', () => {
    const parsed = replaceLines.inputSchema.parse({ pageId: 'p1abc', startLine: 2, content: 'new line' });
    const request = buildRequest(replaceLines, parsed, config);
    expect(JSON.parse(request.body!)).toEqual({ operation: 'replace', pageId: 'p1abc', startLine: 2, content: 'new line' });
  });

  it('rejects endLine < startLine', () => {
    const result = replaceLines.inputSchema.safeParse({ pageId: 'p1abc', startLine: 5, endLine: 2, content: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('pages.replaceLines — response contract', () => {
  it('parses the replace result', () => {
    const fixture = {
      pageId: 'p1abc',
      pageTitle: 'Doc',
      totalLines: 3,
      numberedLines: ['   1 | a', '   2 | new line', '   3 | c'],
      operation: 'replace',
      affectedLines: '2-2',
    };
    const result = parseResponse(replaceLines, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('classifies an out-of-range 400 as ValidationError', () => {
    const result = parseResponse(replaceLines, 400, new Headers(), JSON.stringify({ error: 'Line number out of range' }));
    expect(result).toBeInstanceOf(ValidationError);
  });

  it('classifies a revision-conflict 409 as HttpError (not a schema mismatch)', () => {
    const result = parseResponse(replaceLines, 409, new Headers(), JSON.stringify({ error: 'Revision mismatch', currentRevision: 4, expectedRevision: 3 }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
  });
});

describe('pages.insertLines — request/response', () => {
  it('defaults operation to "insert" and omits endLine entirely', () => {
    const parsed = insertLines.inputSchema.parse({ pageId: 'p1abc', startLine: 4, content: 'inserted' });
    const request = buildRequest(insertLines, parsed, config);
    expect(JSON.parse(request.body!)).toEqual({ operation: 'insert', pageId: 'p1abc', startLine: 4, content: 'inserted' });
  });

  it('parses the insert result', () => {
    const fixture = {
      pageId: 'p1abc',
      pageTitle: 'Doc',
      totalLines: 4,
      numberedLines: ['   1 | a', '   2 | b', '   3 | inserted', '   4 | c'],
      operation: 'insert',
      insertedAt: 3,
    };
    const result = parseResponse(insertLines, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });
});

describe('pages.deleteLines — request/response', () => {
  it('defaults operation to "delete"', () => {
    const parsed = deleteLines.inputSchema.parse({ pageId: 'p1abc', startLine: 2, endLine: 3 });
    const request = buildRequest(deleteLines, parsed, config);
    expect(JSON.parse(request.body!)).toEqual({ operation: 'delete', pageId: 'p1abc', startLine: 2, endLine: 3 });
  });

  it('rejects endLine < startLine', () => {
    const result = deleteLines.inputSchema.safeParse({ pageId: 'p1abc', startLine: 5, endLine: 1 });
    expect(result.success).toBe(false);
  });

  it('parses the delete result', () => {
    const fixture = {
      pageId: 'p1abc',
      pageTitle: 'Doc',
      totalLines: 1,
      numberedLines: ['   1 | a'],
      operation: 'delete',
      deletedLines: '2-3',
    };
    const result = parseResponse(deleteLines, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });
});

describe('pages.editCells — request shape', () => {
  it('defaults operation to "edit-cells" and sends the cells array', () => {
    const parsed = editSheetCells.inputSchema.parse({ pageId: 's1abc', cells: [{ address: 'A1', value: '=SUM(B1:B2)' }] });
    const request = buildRequest(editSheetCells, parsed, config);
    expect(JSON.parse(request.body!)).toEqual({ operation: 'edit-cells', pageId: 's1abc', cells: [{ address: 'A1', value: '=SUM(B1:B2)' }] });
  });

  it('rejects an invalid A1 address client-side (fail closed)', () => {
    const result = editSheetCells.inputSchema.safeParse({ pageId: 's1abc', cells: [{ address: 'hello', value: '1' }] });
    expect(result.success).toBe(false);
  });

  it('rejects an empty cells array', () => {
    const result = editSheetCells.inputSchema.safeParse({ pageId: 's1abc', cells: [] });
    expect(result.success).toBe(false);
  });
});

describe('pages.editCells — response contract', () => {
  it('parses the edit-cells result', () => {
    const fixture = {
      pageId: 's1abc',
      pageTitle: 'Budget',
      cellsUpdated: 1,
      operation: 'edit-cells',
      stats: { valuesSet: 0, formulasSet: 1, cellsCleared: 0, sheetDimensions: { rows: 10, columns: 5 } },
      updatedCells: [{ address: 'A1', type: 'formula' }],
    };
    const result = parseResponse(editSheetCells, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('classifies a non-sheet-page 400 as ValidationError', () => {
    const result = parseResponse(editSheetCells, 400, new Headers(), JSON.stringify({ error: 'Page is not a sheet', pageType: 'DOCUMENT' }));
    expect(result).toBeInstanceOf(ValidationError);
  });
});
