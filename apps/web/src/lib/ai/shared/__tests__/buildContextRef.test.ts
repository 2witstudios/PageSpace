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
});
