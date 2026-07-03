import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { listDrives } from '../drives.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Shape verified against apps/web/src/app/api/drives/route.ts GET (drive-service.ts DriveWithAccess). */
const driveFixture = {
  id: 'd1abc',
  name: 'Engineering',
  slug: 'engineering',
  ownerId: 'u1abc',
  kind: 'STANDARD',
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  isOwned: true,
  role: 'OWNER',
  lastAccessedAt: null,
  homePageId: null,
};

describe('drives.list — request shape', () => {
  it('builds a bare GET to /api/drives with no path params', () => {
    const request = buildRequest(listDrives, {}, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/drives');
    expect(request.body).toBeUndefined();
  });

  it('serializes includeTrash/tokenScopable as query params', () => {
    const request = buildRequest(listDrives, { includeTrash: true, tokenScopable: false }, config);
    expect(request.url).toBe('https://pagespace.ai/api/drives?includeTrash=true&tokenScopable=false');
  });
});

describe('drives.list — response contract', () => {
  it('parses a bare array of DriveWithAccess rows (route truth, §2.1)', () => {
    const result = parseResponse(listDrives, 200, new Headers(), JSON.stringify([driveFixture]));
    expect(result).toEqual([driveFixture]);
  });

  it('parses an empty drive list', () => {
    const result = parseResponse(listDrives, 200, new Headers(), JSON.stringify([]));
    expect(result).toEqual([]);
  });

  it('rejects a response that drifts from the DriveWithAccess contract', () => {
    const malformed = [{ ...driveFixture, role: 'SUPERADMIN' }];
    const result = parseResponse(listDrives, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a non-2xx response as a typed error, never a schema mismatch', () => {
    const result = parseResponse(listDrives, 403, new Headers(), JSON.stringify({ error: 'This token does not have access to this drive' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('drives.list — metadata', () => {
  it('is named and described for MCP/CLI derivation', () => {
    expect(listDrives.name).toBe('drives.list');
    expect(listDrives.description.length).toBeGreaterThan(0);
  });
});
