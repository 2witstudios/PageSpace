import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError, ValidationError } from '../../errors.js';
import { createPage, movePage, renamePage, restorePage, trashPage } from '../pages.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Shape verified against apps/web/src/app/api/pages/route.ts POST (bare page row, :111). */
const pageRowFixture = {
  id: 'p1abc',
  title: 'New Page',
  type: 'DOCUMENT',
  content: '',
  contentMode: 'html',
  parentId: null,
  driveId: 'd1abc',
  position: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  revision: 0,
  stateHash: null,
  isTrashed: false,
  trashedAt: null,
  aiProvider: null,
  aiModel: null,
  systemPrompt: null,
  enabledTools: null,
  isPaginated: false,
};

describe('pages.create — request shape', () => {
  it('sends a bare POST to /api/pages with the full body', () => {
    const request = buildRequest(createPage, { driveId: 'd1abc', title: 'New Page', type: 'DOCUMENT' }, config);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/pages');
    expect(JSON.parse(request.body!)).toEqual({ driveId: 'd1abc', title: 'New Page', type: 'DOCUMENT' });
  });

  it('accepts every route-creatable type, including FILE/CODE/TERMINAL (D9)', () => {
    for (const type of ['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'FILE', 'SHEET', 'TASK_LIST', 'CODE', 'TERMINAL']) {
      const result = createPage.inputSchema.safeParse({ driveId: 'd1abc', title: 'x', type });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an unknown page type', () => {
    const result = createPage.inputSchema.safeParse({ driveId: 'd1abc', title: 'x', type: 'BOGUS' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty title', () => {
    const result = createPage.inputSchema.safeParse({ driveId: 'd1abc', title: '', type: 'DOCUMENT' });
    expect(result.success).toBe(false);
  });
});

describe('pages.create — response contract', () => {
  it('parses the created page row (route truth, §2.4)', () => {
    const result = parseResponse(createPage, 201, new Headers(), JSON.stringify(pageRowFixture));
    expect(result).toEqual(pageRowFixture);
  });

  it('classifies a 400 (e.g. missing title) as ValidationError', () => {
    const result = parseResponse(createPage, 400, new Headers(), JSON.stringify({ error: 'Title is required' }));
    expect(result).toBeInstanceOf(ValidationError);
  });
});

describe('pages.rename — request shape', () => {
  it('interpolates :pageId and sends only { title }', () => {
    const request = buildRequest(renamePage, { pageId: 'p1abc', title: 'Renamed' }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/pages/p1abc');
    expect(JSON.parse(request.body!)).toEqual({ title: 'Renamed' });
  });
});

describe('pages.rename — response contract', () => {
  it('parses the updated page row', () => {
    const renamed = { ...pageRowFixture, title: 'Renamed' };
    const result = parseResponse(renamePage, 200, new Headers(), JSON.stringify(renamed));
    expect(result).toEqual(renamed);
  });
});

describe('pages.move — request shape', () => {
  it('builds a fixed-path PATCH with the renamed wire fields (position -> newPosition)', () => {
    const request = buildRequest(movePage, { pageId: 'p1abc', newParentId: null, newPosition: 2 }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/pages/reorder');
    expect(JSON.parse(request.body!)).toEqual({ pageId: 'p1abc', newParentId: null, newPosition: 2 });
  });

  it('requires newParentId to be explicitly provided (null for root)', () => {
    const result = movePage.inputSchema.safeParse({ pageId: 'p1abc', newPosition: 2 });
    expect(result.success).toBe(false);
  });
});

describe('pages.move — response contract', () => {
  it('parses the reorder success message', () => {
    const result = parseResponse(movePage, 200, new Headers(), JSON.stringify({ message: 'Page reordered successfully' }));
    expect(result).toEqual({ message: 'Page reordered successfully' });
  });
});

describe('pages.move — metadata', () => {
  it('requires the drive-admin floor (scoped tokens need OWNER/ADMIN)', () => {
    expect(movePage.requiredScope).toBe('drive:admin');
  });
});

describe('pages.trash — request shape', () => {
  it('always sends trash_children explicitly (D10 fail-closed)', () => {
    const request = buildRequest(trashPage, { pageId: 'p1abc', trash_children: false }, config);
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://pagespace.ai/api/pages/p1abc');
    expect(JSON.parse(request.body!)).toEqual({ trash_children: false });
  });

  it('rejects input missing trash_children — no implicit server-default reliance', () => {
    const result = trashPage.inputSchema.safeParse({ pageId: 'p1abc' });
    expect(result.success).toBe(false);
  });
});

describe('pages.trash — response contract', () => {
  it('parses the trash success message', () => {
    const result = parseResponse(trashPage, 200, new Headers(), JSON.stringify({ message: 'Page moved to trash successfully.' }));
    expect(result).toEqual({ message: 'Page moved to trash successfully.' });
  });

  it('classifies a 403 as PermissionDeniedError', () => {
    const result = parseResponse(trashPage, 403, new Headers(), JSON.stringify({ error: 'Forbidden' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('pages.restore — request shape', () => {
  it('interpolates :pageId and sends no body', () => {
    const request = buildRequest(restorePage, { pageId: 'p1abc' }, config);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/pages/p1abc/restore');
    expect(request.body).toBeUndefined();
  });
});

describe('pages.restore — response contract', () => {
  it('parses the restore success message', () => {
    const result = parseResponse(restorePage, 200, new Headers(), JSON.stringify({ message: 'Page restored successfully.' }));
    expect(result).toEqual({ message: 'Page restored successfully.' });
  });

  it('classifies a not-in-trash 400 as ValidationError', () => {
    const result = parseResponse(restorePage, 400, new Headers(), JSON.stringify({ error: 'Page is not in trash' }));
    expect(result).toBeInstanceOf(ValidationError);
  });

  it('rejects a malformed success body', () => {
    const result = parseResponse(restorePage, 200, new Headers(), JSON.stringify({ msg: 'wrong field' }));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });
});
