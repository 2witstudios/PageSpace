import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import {
  assertDriveNameConfirmed,
  createDrive,
  listDrives,
  renameDrive,
  restoreDrive,
  setHomePage,
  trashDrive,
  updateDriveContext,
} from '../drives.js';

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

/** Shape verified against apps/web/src/app/api/drives/[driveId]/route.ts PATCH → drives.$inferSelect (raw row, not DriveWithAccess). */
const driveRowFixture = {
  id: 'd1abc',
  name: 'Engineering',
  slug: 'engineering',
  ownerId: 'u1abc',
  kind: 'STANDARD',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  drivePrompt: null,
  publishSubdomain: null,
  homePageId: null,
  publishDefaultOgImageUrl: null,
};

describe('drives.create — request shape', () => {
  it('builds a POST to /api/drives with name in the body', () => {
    const request = buildRequest(createDrive, { name: 'New Drive' }, config);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/drives');
    expect(request.body).toBe(JSON.stringify({ name: 'New Drive' }));
  });

  it('rejects an empty name before any network call', () => {
    const result = createDrive.inputSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });
});

describe('drives.create — response contract', () => {
  it('parses a 201 DriveWithAccess row (route truth, §2.1 create_drive)', () => {
    const result = parseResponse(createDrive, 201, new Headers(), JSON.stringify(driveFixture));
    expect(result).toEqual(driveFixture);
  });

  it('classifies a 400 (reserved name) as a typed ValidationError', () => {
    const result = parseResponse(createDrive, 400, new Headers(), JSON.stringify({ error: 'Cannot create a drive with that name.' }));
    expect((result as { code: string }).code).toBe('VALIDATION_ERROR');
  });
});

describe('drives.rename — request shape', () => {
  it('interpolates :driveId and sends only name in the body', () => {
    const request = buildRequest(renameDrive, { driveId: 'd1abc', name: 'Renamed' }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc');
    expect(request.body).toBe(JSON.stringify({ name: 'Renamed' }));
  });
});

describe('drives.rename — response contract', () => {
  it('parses the raw updated drive row (route truth — not DriveWithAccess)', () => {
    const result = parseResponse(renameDrive, 200, new Headers(), JSON.stringify(driveRowFixture));
    expect(result).toEqual(driveRowFixture);
  });

  it('rejects a response drifting back to the DriveWithAccess shape', () => {
    const result = parseResponse(renameDrive, 200, new Headers(), JSON.stringify(driveFixture));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 403 (home drive / not owner-admin) as PermissionDeniedError', () => {
    const result = parseResponse(renameDrive, 403, new Headers(), JSON.stringify({ error: 'Only drive owners and admins can update drive settings' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('drives.rename — metadata', () => {
  it('declares drive:admin as the minimum required scope', () => {
    expect(renameDrive.requiredScope).toBe('drive:admin');
  });
});

describe('drives.updateContext — request shape', () => {
  it('interpolates :driveId and sends only drivePrompt in the body', () => {
    const request = buildRequest(updateDriveContext, { driveId: 'd1abc', drivePrompt: 'Be concise.' }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc');
    expect(request.body).toBe(JSON.stringify({ drivePrompt: 'Be concise.' }));
  });

  it('rejects a drivePrompt over 10000 chars (route limit)', () => {
    const result = updateDriveContext.inputSchema.safeParse({ driveId: 'd1abc', drivePrompt: 'x'.repeat(10001) });
    expect(result.success).toBe(false);
  });
});

describe('drives.updateContext — response contract', () => {
  it('parses the raw updated drive row', () => {
    const result = parseResponse(updateDriveContext, 200, new Headers(), JSON.stringify({ ...driveRowFixture, drivePrompt: 'Be concise.' }));
    expect(result).toEqual({ ...driveRowFixture, drivePrompt: 'Be concise.' });
  });
});

describe('drives.updateContext — metadata', () => {
  it('documents the token-cost caveat in its description', () => {
    expect(updateDriveContext.description.toLowerCase()).toContain('token');
  });
});

describe('drives.setHomePage — request shape', () => {
  it('interpolates :driveId and sends only homePageId in the body', () => {
    const request = buildRequest(setHomePage, { driveId: 'd1abc', homePageId: 'p1xyz' }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc');
    expect(request.body).toBe(JSON.stringify({ homePageId: 'p1xyz' }));
  });

  it('sends an explicit null to clear the home page', () => {
    const request = buildRequest(setHomePage, { driveId: 'd1abc', homePageId: null }, config);
    expect(request.body).toBe(JSON.stringify({ homePageId: null }));
  });

  it('rejects an empty-string homePageId before any network call (route treats "" as invalid, only a real ID or null)', () => {
    const result = setHomePage.inputSchema.safeParse({ driveId: 'd1abc', homePageId: '' });
    expect(result.success).toBe(false);
  });
});

describe('drives.setHomePage — response contract', () => {
  it('parses the raw updated drive row', () => {
    const result = parseResponse(setHomePage, 200, new Headers(), JSON.stringify({ ...driveRowFixture, homePageId: 'p1xyz' }));
    expect(result).toEqual({ ...driveRowFixture, homePageId: 'p1xyz' });
  });

  it('classifies a 400 (invalid home page) as a typed ValidationError', () => {
    const result = parseResponse(setHomePage, 400, new Headers(), JSON.stringify({ error: 'Home page must be a non-trashed page in this drive' }));
    expect((result as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('classifies a 403 (not owner/admin) as PermissionDeniedError', () => {
    const result = parseResponse(setHomePage, 403, new Headers(), JSON.stringify({ error: 'Only drive owners and admins can update drive settings' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('drives.setHomePage — metadata', () => {
  it('declares drive:admin as the minimum required scope', () => {
    expect(setHomePage.requiredScope).toBe('drive:admin');
  });
});

describe('drives.trash — request shape', () => {
  it('builds a DELETE to /api/drives/:driveId', () => {
    const request = buildRequest(trashDrive, { driveId: 'd1abc', confirmDriveName: 'Engineering' }, config);
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc');
  });
});

describe('drives.trash — response contract', () => {
  it('parses {success:true}', () => {
    const result = parseResponse(trashDrive, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });

  it('classifies a 403 (home drive) as PermissionDeniedError', () => {
    const result = parseResponse(trashDrive, 403, new Headers(), JSON.stringify({ error: 'Home drives cannot be trashed' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('drives.trash — metadata (non-idempotent, no auto-retry)', () => {
  it('uses DELETE, which isIdempotentMethod classifies as non-idempotent', () => {
    expect(trashDrive.method).toBe('DELETE');
  });
});

describe('assertDriveNameConfirmed — D11 client-side guardrail', () => {
  it('succeeds when the confirmation matches the actual drive name', () => {
    const result = assertDriveNameConfirmed('Engineering', 'Engineering');
    expect(result.ok).toBe(true);
  });

  it('fails closed when the confirmation does not match', () => {
    const result = assertDriveNameConfirmed('Engineering', 'engineering');
    expect(result).toEqual({ ok: false, error: { actualName: 'Engineering', confirmName: 'engineering' } });
  });

  it('is case-sensitive and whitespace-sensitive (no fuzzy matching)', () => {
    const result = assertDriveNameConfirmed('Engineering', 'Engineering ');
    expect(result.ok).toBe(false);
  });
});

describe('drives.restore — request shape', () => {
  it('builds a POST to /api/drives/:driveId/restore with no body', () => {
    const request = buildRequest(restoreDrive, { driveId: 'd1abc' }, config);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/restore');
    expect(request.body).toBeUndefined();
  });
});

describe('drives.restore — response contract', () => {
  it('parses {success:true}', () => {
    const result = parseResponse(restoreDrive, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });

  it('classifies a 400 (not in trash) as a typed ValidationError', () => {
    const result = parseResponse(restoreDrive, 400, new Headers(), JSON.stringify({ error: 'Drive is not in trash' }));
    expect((result as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('classifies a 404 (not found / not owner) as NotFoundError', () => {
    const result = parseResponse(restoreDrive, 404, new Headers(), JSON.stringify({ error: 'Drive not found or access denied' }));
    expect((result as { code: string }).code).toBe('NOT_FOUND');
  });
});
