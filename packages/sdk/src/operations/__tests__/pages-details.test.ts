import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { getPageDetails } from '../pages.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Shape verified against apps/web/src/app/api/pages/[pageId]/route.ts GET → pageService.getPage (PageWithDetails). */
const pageFixture = {
  id: 'p1abc',
  title: 'Design Doc',
  type: 'DOCUMENT',
  content: '<p>Hello</p>',
  contentMode: 'html',
  parentId: null,
  driveId: 'd1abc',
  position: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  revision: 3,
  stateHash: 'abc123',
  isTrashed: false,
  trashedAt: null,
  aiProvider: null,
  aiModel: null,
  systemPrompt: null,
  enabledTools: null,
  isPaginated: false,
  children: [],
  messages: [
    {
      id: 'm1abc',
      content: 'Looks good',
      createdAt: '2026-01-02T00:00:00.000Z',
      user: { id: 'u1abc', name: 'Ada', email: 'ada@example.com', image: null },
    },
  ],
};

describe('pages.details — request shape', () => {
  it('interpolates :pageId into the path and sends no body', () => {
    const request = buildRequest(getPageDetails, { pageId: 'p1abc' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/pages/p1abc');
    expect(request.body).toBeUndefined();
  });

  it('URL-encodes the pageId', () => {
    const request = buildRequest(getPageDetails, { pageId: 'a/b' }, config);
    expect(request.url).toBe('https://pagespace.ai/api/pages/a%2Fb');
  });
});

describe('pages.details — response contract', () => {
  it('parses PageWithDetails (route truth, §2.3 get_page_details)', () => {
    const result = parseResponse(getPageDetails, 200, new Headers(), JSON.stringify(pageFixture));
    expect(result).toEqual(pageFixture);
  });

  it('parses a page with children (PageData rows, no nested children/messages)', () => {
    const child = { ...pageFixture, id: 'c1abc' } as Record<string, unknown>;
    delete child.children;
    delete child.messages;
    const result = parseResponse(getPageDetails, 200, new Headers(), JSON.stringify({ ...pageFixture, children: [child] }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
  });

  it('rejects a response missing a required field', () => {
    const malformed = { ...pageFixture } as Record<string, unknown>;
    delete malformed.driveId;
    const result = parseResponse(getPageDetails, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 404 as NotFoundError, never a schema mismatch', () => {
    const result = parseResponse(getPageDetails, 404, new Headers(), JSON.stringify({ error: 'Page not found' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('pages.details — metadata', () => {
  it('declares the drive-scope requirement per ADR 0002', () => {
    expect(getPageDetails.requiredScope).toBe('drive');
  });
});
