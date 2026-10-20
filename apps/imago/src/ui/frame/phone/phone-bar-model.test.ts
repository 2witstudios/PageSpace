import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '../stage/stage';
import { phoneBarItems, phoneBarSection } from './phone-bar-model';

describe('phoneBarItems()', () => {
  test('Chat, Files, Messages and Tasks in the drive, with the section current', () => {
    const items = phoneBarItems(stageFor('/d1/files/p1'), 'd1', 0);
    assert({
      given: 'a page in Files',
      should: 'list the four sections with Files current',
      actual: items.map((entry) => [entry.label, entry.href, entry.current]),
      expected: [
        ['Home', '/d1', false],
        ['Files', '/d1/files', true],
        ['Messages', '/d1/messages', false],
        ['Tasks', '/d1/tasks', false],
      ],
    });
  });

  test('Messages carries its unread count in its name', () => {
    const named = phoneBarItems(stageFor('/d1'), 'd1', 8).map((entry) => entry.name);
    assert({ given: '8 unread messages', should: 'name Messages with the count', actual: named, expected: ['Home', 'Files', 'Messages, 8 unread', 'Tasks'] });
  });

  test('no drive: no links', () => {
    assert({
      given: 'no drive',
      should: 'leave every href null',
      actual: phoneBarItems(stageFor('/'), null, 0).map((entry) => entry.href),
      expected: [null, null, null, null],
    });
  });
});

describe('phoneBarSection()', () => {
  test('the account and settings belong to no bar section', () => {
    assert({
      given: 'Tasks, the account and drive settings',
      should: 'name tasks, then none',
      actual: [stageFor('/d1/tasks'), stageFor('/account'), stageFor('/d1/settings')].map(phoneBarSection),
      expected: ['tasks', null, null],
    });
  });
});
