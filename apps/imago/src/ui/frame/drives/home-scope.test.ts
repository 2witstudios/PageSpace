import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '../stage/stage';
import { isDashboard } from './home-scope';

const at = (path: string) => isDashboard(stageFor(path), 'home1');

describe('isDashboard()', () => {
  test('Home’s aggregate sections', () => {
    assert({
      given: 'the Home drive’s chat, Messages, Calendar, Console and Activity',
      should: 'read across every drive',
      actual: ['/home1', '/home1/messages', '/home1/calendar', '/home1/agents', '/home1/activity'].map(at),
      expected: [true, true, true, true, true],
    });
  });

  test('Home’s own sections', () => {
    assert({
      given: 'the Home drive’s Files, Tasks (never switched), Members, Trash, Workflows and settings',
      should: 'stay Home’s own',
      actual: ['/home1/files', '/home1/tasks', '/home1/members', '/home1/trash', '/home1/workflows', '/home1/settings'].map(at),
      expected: [false, false, false, false, false, false],
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

describe('isDashboard() with switched sections', () => {
  test('a section switched to All drives', () => {
    assert({
      given: 'Tasks and Calendar switched to All drives, on a drive that is not Home',
      should: 'claim no drive for them, while the drive’s chat and Files stay its own',
      actual: ['/d1/tasks', '/d1/calendar', '/d1', '/d1/files'].map((path) =>
        isDashboard(stageFor(path), 'home1', { tasks: 'all', calendar: 'all', files: 'all' }),
      ),
      expected: [true, true, false, false],
    });
  });

  test('Home switched to itself', () => {
    assert({
      given: 'Home’s Messages switched to this drive',
      should: 'scope Messages to Home, while Home’s chat still reads every drive',
      actual: ['/home1/messages', '/home1'].map((path) => isDashboard(stageFor(path), 'home1', { messages: 'drive' })),
      expected: [false, true],
    });
  });
});

describe('isDashboard() without a drive', () => {
  test('a driveless route', () => {
    assert({
      given: 'the user-level DM index, even with every section switched to All drives',
      should: 'never claim the dashboard, since no drive is in the URL',
      actual: isDashboard(stageFor('/dm'), 'home1', { messages: 'all', tasks: 'all' }),
      expected: false,
    });
  });
});
