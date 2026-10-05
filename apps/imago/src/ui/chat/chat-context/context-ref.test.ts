import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '../../frame/stage/stage';
import { basePathRelative } from '@/lib/auth/sign-in-url';
import { contextRefFor } from './context-ref';

/** The ref for a browser URL, read the way the shell reads it (usePathname is basePath-relative). */
const refAt = (url: string) => contextRefFor(stageFor(basePathRelative(url) ?? '/'));

describe('contextRefFor()', () => {
  test('a page in a drive', () => {
    assert({
      given: 'the imago URL /imago/[driveId]/files/[pageId]',
      should: 'name the page and its drive',
      actual: refAt('/imago/d1/files/p1'),
      expected: { routeType: 'page', pageId: 'p1', driveId: 'd1' },
    });
  });

  test('a task list', () => {
    assert({
      given: 'a task list open in the Tasks section',
      should: 'name the task list page and its drive',
      actual: refAt('/imago/d1/tasks/t1'),
      expected: { routeType: 'page', pageId: 't1', driveId: 'd1' },
    });
  });

  test('a channel', () => {
    assert({
      given: 'a channel open in the Messages section',
      should: 'name the channel page, as classic does',
      actual: refAt('/imago/d1/messages/ch1'),
      expected: { routeType: 'channel', pageId: 'ch1' },
    });
  });

  test('drive chat', () => {
    assert({
      given: 'the drive chat, a drive section list and drive settings',
      should: 'name the drive',
      actual: [refAt('/imago/d1'), refAt('/imago/d1/files'), refAt('/imago/d1/settings')],
      expected: [
        { routeType: 'drive', driveId: 'd1' },
        { routeType: 'drive', driveId: 'd1' },
        { routeType: 'drive', driveId: 'd1' },
      ],
    });
  });

  test('a direct message', () => {
    assert({
      given: 'a DM open at /imago/dm/[id]',
      should: 'name the DM conversation',
      actual: refAt('/imago/dm/dm1'),
      expected: { routeType: 'dm', dmConversationId: 'dm1' },
    });
  });

  test('no drive', () => {
    assert({
      given: 'the root, the account page and the DM list',
      should: 'claim no location',
      actual: [refAt('/imago'), refAt('/imago/account'), refAt('/imago/dm')],
      expected: [{ routeType: 'other' }, { routeType: 'other' }, { routeType: 'other' }],
    });
  });
});
