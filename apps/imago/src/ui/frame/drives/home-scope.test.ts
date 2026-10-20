import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '../stage/stage';
import { isDashboard } from './home-scope';

const at = (path: string) => isDashboard(stageFor(path), 'home1');

describe('isDashboard()', () => {
  test('Home’s aggregate sections', () => {
    assert({
      given: 'the Home drive’s chat, Messages, Tasks, Calendar, Console and Activity',
      should: 'read across every drive',
      actual: ['/home1', '/home1/messages', '/home1/tasks', '/home1/calendar', '/home1/agents', '/home1/activity'].map(at),
      expected: [true, true, true, true, true, true],
    });
  });

  test('Home’s own sections', () => {
    assert({
      given: 'the Home drive’s Files, Members, Trash, Workflows and settings',
      should: 'stay Home’s own',
      actual: ['/home1/files', '/home1/members', '/home1/trash', '/home1/workflows', '/home1/settings'].map(at),
      expected: [false, false, false, false, false],
    });
  });

  test('another drive', () => {
    assert({
      given: 'the chat and Tasks of a drive that is not Home',
      should: 'stay scoped to that drive',
      actual: ['/d1', '/d1/tasks'].map(at),
      expected: [false, false],
    });
  });

  test('no Home drive', () => {
    assert({
      given: 'a viewer with no Home drive yet',
      should: 'never be the dashboard',
      actual: isDashboard(stageFor('/home1'), null),
      expected: false,
    });
  });
});
