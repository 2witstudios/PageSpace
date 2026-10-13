import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { badges } from '../message-model/fixtures';
import { renderMessagesGround } from './messages-ground.render';

const html = (value: Parameters<typeof renderMessagesGround>[0]) => renderToStaticMarkup(<>{renderMessagesGround(value)}</>);

describe('renderMessagesGround()', () => {
  test('the unread totals', () => {
    const markup = html({ badges: badges({ channels: 6, dms: 2 }) });
    assert({
      given: 'six unread in channels and two unread direct messages',
      should: 'show both counts under their labels, and no "Threads you follow" count since no route serves it',
      actual: {
        channels: markup.includes('Unread in channels') && markup.includes('>6<'),
        dms: markup.includes('Unread direct messages') && markup.includes('>2<'),
        follow: markup.includes('Threads you follow'),
      },
      expected: { channels: true, dms: true, follow: false },
    });
  });

  test('while the totals load', () => {
    assert({
      given: 'badges that have not loaded yet',
      should: 'draw nothing rather than zeros',
      actual: html({ badges: undefined }),
      expected: '',
    });
  });
});
