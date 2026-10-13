import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '@/ui/frame/stage/stage';
import { groundFor } from './ground';

const DRIVE = 'abcdefghijklmnopqrstuvwx';
const PAGE = 'bcdefghijklmnopqrstuvwxy';

describe('groundFor()', () => {
  test('each section index and an open object', () => {
    assert({
      given: 'the Files index, the Messages index, /dm, a page and the drive chat',
      should: 'show the Files intro, the unread counts, the people you can message, then nothing',
      actual: [`/${DRIVE}/files`, `/${DRIVE}/messages`, '/dm', `/${DRIVE}/files/${PAGE}`, `/${DRIVE}`].map((path) => groundFor(stageFor(path))),
      expected: ['files', 'messages', 'dm', null, null],
    });
  });

  test('the Tasks index, and an open list or task', () => {
    assert({
      given: 'the Tasks index of a drive, a list open in it, and the Tasks index with no drive',
      should: 'show the Tasks ground on the index only, and nothing with an object open or no drive',
      actual: [`/${DRIVE}/tasks`, `/${DRIVE}/tasks/${PAGE}`, '/tasks'].map((path) => groundFor(stageFor(path))),
      expected: ['tasks', null, null],
    });
  });
});
