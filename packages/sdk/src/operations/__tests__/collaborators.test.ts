import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { listCollaborators } from '../collaborators.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Shape verified against apps/web/src/app/api/connections/route.ts GET ({connections: validConnections}). */
const connectionFixture = {
  id: 'c1abc',
  status: 'ACCEPTED',
  requestedAt: '2026-01-01T00:00:00.000Z',
  acceptedAt: '2026-01-02T00:00:00.000Z',
  requestMessage: null,
  user1Id: 'u1abc',
  user2Id: 'u2abc',
  requestedBy: 'u1abc',
  user: {
    id: 'u2abc',
    name: 'Grace',
    email: 'grace@example.com',
    image: null,
    username: 'grace',
    displayName: 'Grace Hopper',
    bio: null,
    avatarUrl: null,
  },
  isRequester: true,
};

describe('collaborators.list — request shape', () => {
  it('builds a bare GET to /api/connections with no status filter', () => {
    const request = buildRequest(listCollaborators, {}, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/connections');
    expect(request.body).toBeUndefined();
  });

  it('serializes status as a query param', () => {
    const request = buildRequest(listCollaborators, { status: 'PENDING' }, config);
    expect(request.url).toBe('https://pagespace.ai/api/connections?status=PENDING');
  });

  it('rejects a status outside the enum before any network call', () => {
    const result = listCollaborators.inputSchema.safeParse({ status: 'FRIENDS' });
    expect(result.success).toBe(false);
  });
});

describe('collaborators.list — response contract', () => {
  it('parses {connections} (route truth §2.15 list_collaborators)', () => {
    const result = parseResponse(listCollaborators, 200, new Headers(), JSON.stringify({ connections: [connectionFixture] }));
    expect(result).toEqual({ connections: [connectionFixture] });
  });

  it('parses an empty connections array', () => {
    const result = parseResponse(listCollaborators, 200, new Headers(), JSON.stringify({ connections: [] }));
    expect(result).toEqual({ connections: [] });
  });

  it('rejects a response drifting to a bare array (the old handler assumption)', () => {
    const result = parseResponse(listCollaborators, 200, new Headers(), JSON.stringify([connectionFixture]));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });
});

describe('collaborators.list — metadata', () => {
  it('is named and described for MCP/CLI derivation', () => {
    expect(listCollaborators.name).toBe('collaborators.list');
    expect(listCollaborators.description.length).toBeGreaterThan(0);
  });
});
