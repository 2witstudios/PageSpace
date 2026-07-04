import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { listPages, listTrash } from '../pages.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Shape verified against apps/web/src/app/api/drives/[driveId]/pages/route.ts GET (ls-mode branch, :263-272). */
const lsFixture = {
  mode: 'ls',
  driveName: 'Engineering',
  driveSlug: 'engineering',
  location: '/engineering',
  breadcrumb: [] as Array<{ id: string; title: string }>,
  pages: [
    { id: 'p1abc', title: 'Design Doc', type: 'DOCUMENT', hasChildren: false, isTaskLinked: false },
    { id: 'p2abc', title: 'Notes', type: 'FOLDER', hasChildren: true, isTaskLinked: false },
  ],
  count: 2,
  totalInDrive: 5,
};

describe('pages.list — request shape', () => {
  it('interpolates :driveId and always sends ls=true', () => {
    const parsed = listPages.inputSchema.parse({ driveId: 'd1abc' });
    const request = buildRequest(listPages, parsed, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/pages?ls=true');
  });

  it('serializes parentId and recursive as query params', () => {
    const parsed = listPages.inputSchema.parse({ driveId: 'd1abc', parentId: 'p1abc', recursive: true });
    const request = buildRequest(listPages, parsed, config);
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/pages?ls=true&parentId=p1abc&recursive=true');
  });
});

describe('pages.list — response contract', () => {
  it('parses the ls-mode listing (route truth, §2.2)', () => {
    const result = parseResponse(listPages, 200, new Headers(), JSON.stringify(lsFixture));
    expect(result).toEqual(lsFixture);
  });

  it('rejects a page entry with an unknown type', () => {
    const malformed = { ...lsFixture, pages: [{ ...lsFixture.pages[0], type: 'BOGUS' }] };
    const result = parseResponse(listPages, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies an unknown parentId 404 as NotFoundError', () => {
    const result = parseResponse(listPages, 404, new Headers(), JSON.stringify({ error: 'parentId not found or not accessible' }));
    expect((result as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('pages.list — metadata', () => {
  it('requires drive-level access', () => {
    expect(listPages.requiredScope).toBe('drive');
  });
});

/** Shape verified against apps/web/src/app/api/drives/[driveId]/trash/route.ts GET (buildTree over trashed pages). */
const trashedPageFixture = {
  id: 't1abc',
  title: 'Old Doc',
  type: 'DOCUMENT',
  content: null,
  contentMode: 'html',
  parentId: null,
  driveId: 'd1abc',
  position: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  revision: 1,
  stateHash: null,
  isTrashed: true,
  trashedAt: '2026-01-03T00:00:00.000Z',
  aiProvider: null,
  aiModel: null,
  systemPrompt: null,
  enabledTools: null,
  isPaginated: false,
  children: [] as unknown[],
};

describe('pages.listTrash — request shape', () => {
  it('interpolates :driveId and sends no body', () => {
    const request = buildRequest(listTrash, { driveId: 'd1abc' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/trash');
    expect(request.body).toBeUndefined();
  });
});

describe('pages.listTrash — response contract', () => {
  it('parses a flat array of trashed pages with no children', () => {
    const result = parseResponse(listTrash, 200, new Headers(), JSON.stringify([trashedPageFixture]));
    expect(result).toEqual([trashedPageFixture]);
  });

  it('parses nested trashed pages (recursive children)', () => {
    const nested = { ...trashedPageFixture, children: [{ ...trashedPageFixture, id: 't2abc', parentId: 't1abc' }] };
    const result = parseResponse(listTrash, 200, new Headers(), JSON.stringify([nested]));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a non-admin 403 as PermissionDeniedError', () => {
    const result = parseResponse(listTrash, 403, new Headers(), JSON.stringify({ error: 'Only drive owners and admins can view trash' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('pages.listTrash — metadata', () => {
  it('requires the drive-admin floor (owner/admin-only route)', () => {
    expect(listTrash.requiredScope).toBe('drive:admin');
  });
});
