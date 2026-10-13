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
});
