/**
 * Tests for the LocationContext <-> PageContext adapters.
 *
 * `pageContextToLocationContext` exists so /api/ai/chat can normalize BOTH of its
 * location sources (a server-resolved contextRef, and the legacy client-supplied
 * pageContext) to one shape. The model prompt and the tool context are then built
 * from that single object, which is what keeps them from disagreeing about which
 * workspace is in view.
 */

import { describe, it, expect } from 'vitest';
import {
  pageContextToLocationContext,
  locationContextToPageContext,
  type PageContext,
} from '../buildPageContext';

const PAGE: PageContext = {
  pageId: 'page-1',
  pageTitle: 'Spec',
  pageType: 'DOCUMENT',
  pagePath: '/engineering/Docs/Spec',
  parentPath: '/engineering/Docs',
  breadcrumbs: ['Engineering', 'Docs', 'Spec'],
  driveId: 'drive-1',
  driveName: 'Engineering',
  driveSlug: 'engineering',
};

describe('pageContextToLocationContext', () => {
  it('lifts a flat page context into the nested location shape', () => {
    expect(pageContextToLocationContext(PAGE)).toEqual({
      currentPage: { id: 'page-1', title: 'Spec', type: 'DOCUMENT', path: '/engineering/Docs/Spec' },
      currentDrive: { id: 'drive-1', name: 'Engineering', slug: 'engineering' },
      breadcrumbs: ['Engineering', 'Docs', 'Spec'],
    });
  });

  it('returns null for an absent page context', () => {
    expect(pageContextToLocationContext(undefined)).toBeNull();
    expect(pageContextToLocationContext(null)).toBeNull();
  });

  // The legacy client shape carries an optional driveId; an orphaned page must
  // not synthesize a drive with an empty id, which would then be handed to
  // driveId-defaulting as if it were a real workspace.
  it('yields a null currentDrive when the page carries no drive', () => {
    const result = pageContextToLocationContext({ ...PAGE, driveId: undefined });
    expect(result?.currentDrive).toBeNull();
    expect(result?.currentPage?.id).toBe('page-1');
  });

  it('round-trips through locationContextToPageContext without losing location', () => {
    const round = locationContextToPageContext(pageContextToLocationContext(PAGE));
    expect(round).toMatchObject({
      pageId: PAGE.pageId,
      pageTitle: PAGE.pageTitle,
      pagePath: PAGE.pagePath,
      parentPath: PAGE.parentPath,
      driveId: PAGE.driveId,
      driveName: PAGE.driveName,
      driveSlug: PAGE.driveSlug,
      breadcrumbs: PAGE.breadcrumbs,
    });
  });

  // The asymmetry that made the normalization necessary in the first place:
  // a drive-level location survives as LocationContext but cannot be expressed
  // as a PageContext at all.
  it('cannot be expressed as a PageContext when there is no page (the reason the seam exists)', () => {
    const driveOnly = { currentPage: null, currentDrive: { id: 'drive-1', name: 'Engineering', slug: 'engineering' }, breadcrumbs: ['Engineering'] };
    expect(locationContextToPageContext(driveOnly)).toBeUndefined();
  });
});
