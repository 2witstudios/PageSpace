import { describe, it, expect } from 'vitest';
import { buildContextRef } from '../buildContextRef';
import type { DriveEntry } from '../resolveLocationContext';

const DRIVES: DriveEntry[] = [
  { id: 'drive-1', slug: 'engineering', name: 'Engineering' },
];

describe('buildContextRef', () => {
  it('given a page route, should return routeType page with pageId and a KNOWN driveId', () => {
    expect(buildContextRef('/dashboard/drive-1/page-1', DRIVES)).toEqual({
      routeType: 'page',
      pageId: 'page-1',
      driveId: 'drive-1',
    });
  });

  // The server, not the client, is the source of truth for what a pageId/driveId
  // actually resolves to — but a driveId the client doesn't even recognize as one
  // of the user's own drives is worth stripping before it goes on the wire at all
  // (defense in depth; the server denies unauthorized access to it regardless).
  it('given a page route whose driveId is NOT in the known drives list, should omit driveId', () => {
    expect(buildContextRef('/dashboard/unknown-drive/page-1', DRIVES)).toEqual({
      routeType: 'page',
      pageId: 'page-1',
      driveId: undefined,
    });
  });

  it('given a channel route, should return routeType channel with pageId and no driveId (channels are not drive-scoped)', () => {
    expect(buildContextRef('/dashboard/channels/channel-1', DRIVES)).toEqual({
      routeType: 'channel',
      pageId: 'channel-1',
    });
  });

  it('given a whole-drive route, should return routeType drive with the KNOWN driveId', () => {
    expect(buildContextRef('/dashboard/drive-1', DRIVES)).toEqual({
      routeType: 'drive',
      driveId: 'drive-1',
    });
  });

  it('given a whole-drive route for an unrecognized drive, should return routeType drive with no driveId', () => {
    expect(buildContextRef('/dashboard/unknown-drive', DRIVES)).toEqual({
      routeType: 'drive',
      driveId: undefined,
    });
  });

  it('given a DM route, should return routeType dm with dmConversationId', () => {
    expect(buildContextRef('/dashboard/dms/conv-1', DRIVES)).toEqual({
      routeType: 'dm',
      dmConversationId: 'conv-1',
    });
  });

  it('given a route with no page/drive/dm meaning (e.g. settings), should return routeType other', () => {
    expect(buildContextRef('/settings/account', DRIVES)).toEqual({
      routeType: 'other',
    });
  });

  it('given the bare dashboard route, should return routeType other', () => {
    expect(buildContextRef('/dashboard', DRIVES)).toEqual({
      routeType: 'other',
    });
  });

  // A user sitting on /dashboard/<id>/tasks is plainly inside a workspace. These
  // sub-routes used to fall through to routeType 'other', which resolved to a
  // null location server-side — so the assistant was told "operating from the
  // dashboard" and guessed a drive (usually Home) for anything it created.
  describe('drive sub-routes keep the workspace in context', () => {
    const SUB_ROUTES = [
      'tasks', 'activity', 'members', 'settings',
      'trash', 'calendar', 'channels', 'files', 'workflows',
    ];

    it.each(SUB_ROUTES)('given /dashboard/drive-1/%s, should return routeType drive with the driveId', (section) => {
      expect(buildContextRef(`/dashboard/drive-1/${section}`, DRIVES)).toEqual({
        routeType: 'drive',
        driveId: 'drive-1',
      });
    });

    it('given a members sub-route (invite), should still return routeType drive', () => {
      expect(buildContextRef('/dashboard/drive-1/members/invite', DRIVES)).toEqual({
        routeType: 'drive',
        driveId: 'drive-1',
      });
    });

    it('given a members sub-route (single user), should still return routeType drive', () => {
      expect(buildContextRef('/dashboard/drive-1/members/user-9', DRIVES)).toEqual({
        routeType: 'drive',
        driveId: 'drive-1',
      });
    });

    // The known-drives trim applies on sub-routes exactly as on the bare route.
    it('given a sub-route of an unrecognized drive, should return routeType drive with no driveId', () => {
      expect(buildContextRef('/dashboard/unknown-drive/settings', DRIVES)).toEqual({
        routeType: 'drive',
        driveId: undefined,
      });
    });
  });

  describe('routes that are NOT drive-scoped stay routeType other', () => {
    it.each([
      ['the global drive list', '/dashboard/drives'],
      ['global tasks', '/dashboard/tasks'],
      ['global calendar', '/dashboard/calendar'],
      ['global storage', '/dashboard/storage'],
      ['account settings', '/account'],
    ])('given %s, should return routeType other', (_label, path) => {
      expect(buildContextRef(path, DRIVES)).toEqual({ routeType: 'other' });
    });
  });
});
