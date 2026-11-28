import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { ChannelThread, DirectThread } from '../message-model/message';
import { channelsByDrive, parseCollapsed, serializeCollapsed, toggleGroup } from './message-groups';

const channel = (id: string, driveId: string): ChannelThread => ({
  kind: 'channel',
  id,
  driveId,
  name: id,
  lastMessageAt: null,
  lastMessagePreview: null,
  lastMessageSender: null,
  unreadCount: 0,
});

const dm: DirectThread = {
  kind: 'dm',
  id: 'm1',
  name: 'Grace',
  avatarUrl: null,
  otherUserId: null,
  lastMessageAt: null,
  lastMessagePreview: null,
  lastReadAt: null,
  unreadCount: 0,
};

describe('toggleGroup()', () => {
  test('folds and opens', () => {
    assert({
      given: 'an open group, then the same group folded',
      should: 'fold it, then open it again',
      actual: [toggleGroup(['direct'], 'drive:d1'), toggleGroup(['direct', 'drive:d1'], 'drive:d1')],
      expected: [['direct', 'drive:d1'], ['direct']],
    });
  });
});

describe('parseCollapsed()', () => {
  test('what storage held', () => {
    assert({
      given: 'nothing, a saved list, malformed JSON, a non-list and a list with a stray value',
      should: 'read only a list of keys, and nothing folded otherwise',
      actual: [null, serializeCollapsed(['direct']), '{', '{"a":1}', '["direct",3]'].map(parseCollapsed),
      expected: [[], ['direct'], [], [], ['direct']],
    });
  });
});

describe('channelsByDrive()', () => {
  test('groups in the drives’ order, keeping each drive’s order', () => {
    const names = new Map([
      ['d2', 'Beta'],
      ['d1', 'Alpha'],
      ['d3', 'Empty'],
    ]);
    assert({
      given: 'channels from two named drives and one the drive list has not named, mixed with a DM',
      should: 'group them by drive in the list’s order, unnamed last, skipping drives with no channels and the DM',
      actual: channelsByDrive([channel('a', 'd1'), dm, channel('x', 'd9'), channel('b', 'd2'), channel('c', 'd1')], names).map(
        (drive) => [drive.driveId, drive.name, drive.channels.map((thread) => thread.id)],
      ),
      expected: [
        ['d2', 'Beta', ['b']],
        ['d1', 'Alpha', ['a', 'c']],
        ['d9', 'Drive', ['x']],
      ],
    });
  });
});
