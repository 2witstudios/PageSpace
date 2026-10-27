import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { getActivity } from '../activity.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Bare `activity_logs` row (`packages/db/src/schema/monitoring.ts`) + `user` relation, route-serialized. */
const activityLogFixture = {
  id: 'a1abc',
  timestamp: '2026-07-03T12:00:00.000Z',
  userId: 'u1abc',
  actorEmail: 'ada@example.com',
  actorDisplayName: 'Ada Lovelace',
  isAiGenerated: false,
  aiProvider: null,
  aiModel: null,
  aiConversationId: null,
  operation: 'update',
  resourceType: 'page',
  resourceId: 'p1abc',
  resourceTitle: 'Q3 Plan',
  driveId: 'd1abc',
  pageId: 'p1abc',
  contentSnapshot: null,
  contentFormat: null,
  contentRef: null,
  contentSize: null,
  rollbackFromActivityId: null,
  rollbackSourceOperation: null,
  rollbackSourceTimestamp: null,
  rollbackSourceTitle: null,
  updatedFields: ['title'],
  previousValues: { title: 'Q2 Plan' },
  newValues: { title: 'Q3 Plan' },
  metadata: null,
  streamId: null,
  streamSeq: null,
  changeGroupId: null,
  changeGroupType: null,
  stateHashBefore: null,
  stateHashAfter: null,
  dataCategory: 'content',
  legalBasis: 'contract',
  retentionPolicy: 'account_lifetime',
  recipients: null,
  isArchived: false,
  chainSeq: 42,
  previousLogHash: 'hash0',
  logHash: 'hash1',
  chainSeed: null,
  user: { id: 'u1abc', name: 'Ada Lovelace', email: 'ada@example.com', image: null },
};

describe('activity.get — request shape (D1: GET, not the old tool\'s POST)', () => {
  it('builds a GET to /api/activities with no params (context defaults server-side)', () => {
    const request = buildRequest(getActivity, {}, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/activities');
    expect(request.body).toBeUndefined();
  });

  it('sends context/driveId/pageId/operation/resourceType/limit/offset as query params', () => {
    const request = buildRequest(
      getActivity,
      { context: 'drive', driveId: 'd1abc', operation: 'update', resourceType: 'page', limit: 25, offset: 10 },
      config,
    );
    expect(request.method).toBe('GET');
    const url = new URL(request.url);
    expect(url.pathname).toBe('/api/activities');
    expect(url.searchParams.get('context')).toBe('drive');
    expect(url.searchParams.get('driveId')).toBe('d1abc');
    expect(url.searchParams.get('operation')).toBe('update');
    expect(url.searchParams.get('resourceType')).toBe('page');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('offset')).toBe('10');
  });

  it('sends startDate/endDate as ISO strings, not Date objects (query params are strings)', () => {
    const request = buildRequest(
      getActivity,
      { startDate: '2026-07-01T00:00:00.000Z', endDate: '2026-07-03T00:00:00.000Z' },
      config,
    );
    const url = new URL(request.url);
    expect(url.searchParams.get('startDate')).toBe('2026-07-01T00:00:00.000Z');
    expect(url.searchParams.get('endDate')).toBe('2026-07-03T00:00:00.000Z');
  });

  it('rejects an invalid context (route enum: user | drive | page)', () => {
    const result = getActivity.inputSchema.safeParse({ context: 'bogus' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed startDate', () => {
    const result = getActivity.inputSchema.safeParse({ startDate: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('rejects limit above the route clamp of 100', () => {
    const result = getActivity.inputSchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects a negative offset', () => {
    const result = getActivity.inputSchema.safeParse({ offset: -1 });
    expect(result.success).toBe(false);
  });

  it('has no `types` filter (D1: dropped — operation/resourceType are the route\'s real equivalents)', () => {
    const shape = getActivity.inputSchema as unknown as { shape?: Record<string, unknown> };
    expect(shape.shape).not.toHaveProperty('types');
  });
});

describe('activity.get — response contract', () => {
  it('parses {activities, pagination} (route truth: activities/route.ts GET, not a bare array)', () => {
    const body = {
      activities: [activityLogFixture],
      pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
    };
    const result = parseResponse(getActivity, 200, new Headers(), JSON.stringify(body));
    expect(result).toEqual(body);
  });

  it('parses an empty activity feed', () => {
    const body = { activities: [], pagination: { total: 0, limit: 50, offset: 0, hasMore: false } };
    const result = parseResponse(getActivity, 200, new Headers(), JSON.stringify(body));
    expect(result).toEqual(body);
  });

  it('parses an AI-generated activity entry', () => {
    const aiEntry = {
      ...activityLogFixture,
      isAiGenerated: true,
      aiProvider: 'anthropic',
      aiModel: 'claude-sonnet-5',
      aiConversationId: 'c1abc',
    };
    const body = { activities: [aiEntry], pagination: { total: 1, limit: 50, offset: 0, hasMore: false } };
    const result = parseResponse(getActivity, 200, new Headers(), JSON.stringify(body));
    expect(result).toEqual(body);
  });

  it('parses a null user (userId set-null on account deletion, audit trail preserved)', () => {
    const orphaned = { ...activityLogFixture, userId: null, user: null };
    const body = { activities: [orphaned], pagination: { total: 1, limit: 50, offset: 0, hasMore: false } };
    const result = parseResponse(getActivity, 200, new Headers(), JSON.stringify(body));
    expect(result).toEqual(body);
  });

  it('parses hasMore: true with a partial page', () => {
    const body = { activities: [activityLogFixture], pagination: { total: 5, limit: 1, offset: 0, hasMore: true } };
    const result = parseResponse(getActivity, 200, new Headers(), JSON.stringify(body));
    expect(result).toEqual(body);
  });

  it('rejects a response that drifts from the activity row contract', () => {
    const malformed = { activities: [{ ...activityLogFixture, isArchived: 'nope' }], pagination: { total: 1, limit: 50, offset: 0, hasMore: false } };
    const result = parseResponse(getActivity, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('rejects an unrecognized resourceType (route enum drift)', () => {
    const malformed = { activities: [{ ...activityLogFixture, resourceType: 'bogus' }], pagination: { total: 1, limit: 50, offset: 0, hasMore: false } };
    const result = parseResponse(getActivity, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 400 (missing driveId for drive context) as a typed error, not schema drift', () => {
    const result = parseResponse(getActivity, 400, new Headers(), JSON.stringify({ error: 'driveId is required for drive context' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 403 (no access to the requested drive) as PermissionDeniedError', () => {
    const result = parseResponse(
      getActivity,
      403,
      new Headers(),
      JSON.stringify({ error: 'Unauthorized - you do not have access to this drive' }),
    );
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('activity.get — metadata', () => {
  it('does not declare a fixed requiredScope (context is caller-selected: user/drive/page, no single driveId path param)', () => {
    expect(getActivity.requiredScope).toBeUndefined();
  });

  it('uses GET, which isIdempotentMethod allows the transport to auto-retry safely', () => {
    expect(getActivity.method).toBe('GET');
  });
});
