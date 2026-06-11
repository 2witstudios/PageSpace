import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      commands: { findMany: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}));
vi.mock('@pagespace/db/schema/commands', () => ({
  commands: { id: 'id', userId: 'userId', driveId: 'driveId', enabled: 'enabled' },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: vi.fn(),
  canUserViewPage: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(
    (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object)
  ),
}));

import { GET } from '../suggest/route';
import { db } from '@pagespace/db/db';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { authenticateRequestWithOptions } from '@/lib/auth';

const mockedAuth = vi.mocked(authenticateRequestWithOptions);
const mockedDb = vi.mocked(db, true);
const mockedIsMember = vi.mocked(isUserDriveMember);
const mockedCanViewPage = vi.mocked(canUserViewPage);

const USER_ID = 'user_1';

const webAuth = (): SessionAuthResult => ({
  userId: USER_ID,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_1',
  role: 'user',
  adminRoleVersion: 0,
});

const authError = (): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
});

const userCommand = (trigger: string, overrides: Record<string, unknown> = {}) => ({
  id: `user-${trigger}`,
  userId: USER_ID,
  driveId: null,
  trigger,
  description: `User command ${trigger}`,
  entryPageId: 'page_1',
  type: 'document',
  enabled: true,
  entryPage: { driveId: 'some_drive', isTrashed: false },
  ...overrides,
});

const driveCommand = (trigger: string, overrides: Record<string, unknown> = {}) => ({
  id: `drive-${trigger}`,
  userId: null,
  driveId: 'drive_1',
  trigger,
  description: `Drive command ${trigger}`,
  entryPageId: 'page_2',
  type: 'document',
  enabled: true,
  entryPage: { driveId: 'drive_1', isTrashed: false },
  ...overrides,
});

const suggestRequest = (query: Record<string, string> = {}) => {
  const url = new URL('http://localhost/api/commands/suggest');
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new Request(url);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockResolvedValue(webAuth());
  mockedIsMember.mockResolvedValue(true);
  mockedCanViewPage.mockResolvedValue(true);
  mockedDb.query.commands.findMany.mockResolvedValue([] as never);
});

describe('GET /api/commands/suggest', () => {
  it('returns 401 when authentication fails', async () => {
    mockedAuth.mockResolvedValue(authError() as never);
    const response = await GET(suggestRequest());
    expect(response.status).toBe(401);
  });

  it('always includes built-in commands', async () => {
    const response = await GET(suggestRequest());
    expect(response.status).toBe(200);
    const json = await response.json();
    const help = json.suggestions.find((s: { trigger: string }) => s.trigger === 'help');
    expect(help).toMatchObject({ trigger: 'help', scope: 'builtin' });
    expect(help.description).toBeTruthy();
  });

  it('returns 403 when the caller is not a member of the requested drive', async () => {
    mockedIsMember.mockResolvedValue(false);
    const response = await GET(suggestRequest({ driveId: 'drive_1' }));
    expect(response.status).toBe(403);
  });

  it('does not query drive commands when no driveId is given', async () => {
    mockedDb.query.commands.findMany.mockResolvedValue([userCommand('mine')] as never);
    const response = await GET(suggestRequest());
    const json = await response.json();
    expect(json.suggestions.map((s: { trigger: string }) => s.trigger).sort()).toEqual([
      'help',
      'mine',
    ]);
    // Only one findMany call: the personal commands
    expect(mockedDb.query.commands.findMany).toHaveBeenCalledTimes(1);
  });

  it('merges with builtin > user > drive precedence and marks shadowing', async () => {
    mockedDb.query.commands.findMany
      .mockResolvedValueOnce([userCommand('deploy')] as never) // personal
      .mockResolvedValueOnce([driveCommand('deploy'), driveCommand('team-faq')] as never); // drive

    const response = await GET(suggestRequest({ driveId: 'drive_1' }));
    const json = await response.json();

    const deploy = json.suggestions.find((s: { trigger: string }) => s.trigger === 'deploy');
    expect(deploy.scope).toBe('user');
    expect(deploy.shadows).toBe('drive');
    expect(deploy.id).toBe('user-deploy');

    const teamFaq = json.suggestions.find((s: { trigger: string }) => s.trigger === 'team-faq');
    expect(teamFaq.scope).toBe('drive');
    expect(teamFaq.shadows).toBeUndefined();
  });

  it('builtin shadows a user command with the same trigger; the shadowed row is included with shadowedBy', async () => {
    mockedDb.query.commands.findMany.mockResolvedValueOnce([userCommand('help')] as never);
    const response = await GET(suggestRequest());
    const json = await response.json();
    const help = json.suggestions.filter((s: { trigger: string }) => s.trigger === 'help');
    // Winner first, shadowed (losing) command after — the picker renders the
    // shadowed row dimmed with an indicator (UX spec §1.4/§1.6).
    expect(help).toHaveLength(2);
    expect(help[0].scope).toBe('builtin');
    expect(help[0].shadows).toBe('user');
    expect(help[0].shadowedBy).toBeUndefined();
    expect(help[1]).toMatchObject({ id: 'user-help', scope: 'user', shadowedBy: 'builtin' });
  });

  it('includes a drive command shadowed by a personal command, marked shadowedBy user', async () => {
    mockedDb.query.commands.findMany
      .mockResolvedValueOnce([userCommand('deploy')] as never) // personal
      .mockResolvedValueOnce([driveCommand('deploy')] as never); // drive

    const response = await GET(suggestRequest({ driveId: 'drive_1' }));
    const json = await response.json();
    const deploy = json.suggestions.filter((s: { trigger: string }) => s.trigger === 'deploy');
    expect(deploy).toHaveLength(2);
    expect(deploy[0]).toMatchObject({ id: 'user-deploy', scope: 'user', shadows: 'drive' });
    expect(deploy[1]).toMatchObject({ id: 'drive-deploy', scope: 'drive', shadowedBy: 'user' });
  });

  it('applies the q filter to shadowed rows as well', async () => {
    mockedDb.query.commands.findMany
      .mockResolvedValueOnce([userCommand('deploy'), userCommand('other')] as never)
      .mockResolvedValueOnce([driveCommand('deploy')] as never);

    const response = await GET(suggestRequest({ driveId: 'drive_1', q: 'dep' }));
    const json = await response.json();
    const triggers = json.suggestions.map((s: { trigger: string }) => s.trigger);
    expect(triggers).toEqual(['deploy', 'deploy']);
  });

  it('filters by q with prefix matches ranked before substring matches', async () => {
    mockedDb.query.commands.findMany.mockResolvedValueOnce([
      userCommand('design-review'),
      userCommand('redesign'),
      userCommand('unrelated'),
    ] as never);

    const response = await GET(suggestRequest({ q: 'des' }));
    const json = await response.json();
    const triggers = json.suggestions.map((s: { trigger: string }) => s.trigger);
    expect(triggers).toEqual(['design-review', 'redesign']);
  });

  it('returns entries shaped {id, trigger, description, scope, shadows?}', async () => {
    mockedDb.query.commands.findMany.mockResolvedValueOnce([userCommand('mine')] as never);
    const response = await GET(suggestRequest({ q: 'mine' }));
    const json = await response.json();
    expect(json.suggestions).toHaveLength(1);
    expect(json.suggestions[0]).toEqual({
      id: 'user-mine',
      trigger: 'mine',
      description: 'User command mine',
      scope: 'user',
    });
  });

  it('suppresses a drive command whose entry page has moved to another drive', async () => {
    mockedDb.query.commands.findMany
      .mockResolvedValueOnce([] as never) // personal
      .mockResolvedValueOnce([
        driveCommand('moved-away', { entryPage: { driveId: 'other_drive', isTrashed: false } }),
        driveCommand('still-here'),
      ] as never);

    const response = await GET(suggestRequest({ driveId: 'drive_1' }));
    const json = await response.json();
    const triggers = json.suggestions.map((s: { trigger: string }) => s.trigger);
    expect(triggers).not.toContain('moved-away');
    expect(triggers).toContain('still-here');
  });

  it('suppresses commands whose entry page is trashed', async () => {
    mockedDb.query.commands.findMany
      .mockResolvedValueOnce([
        userCommand('trashed-entry', { entryPage: { driveId: 'some_drive', isTrashed: true } }),
        userCommand('live-entry'),
      ] as never)
      .mockResolvedValueOnce([
        driveCommand('drive-trashed', { entryPage: { driveId: 'drive_1', isTrashed: true } }),
      ] as never);

    const response = await GET(suggestRequest({ driveId: 'drive_1' }));
    const json = await response.json();
    const triggers = json.suggestions.map((s: { trigger: string }) => s.trigger);
    expect(triggers).not.toContain('trashed-entry');
    expect(triggers).not.toContain('drive-trashed');
    expect(triggers).toContain('live-entry');
  });

  it('returns 400 for an invalid driveId', async () => {
    const response = await GET(suggestRequest({ driveId: '' }));
    // empty string driveId param is treated as absent; long garbage is rejected
    expect([200, 400]).toContain(response.status);
    const longResponse = await GET(suggestRequest({ driveId: 'x'.repeat(200) }));
    expect(longResponse.status).toBe(400);
  });
});
