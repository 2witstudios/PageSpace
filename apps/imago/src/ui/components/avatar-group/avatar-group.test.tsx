import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { AvatarGroup } from './avatar-group';
import { renderAvatarGroup } from './avatar-group.render';

describe('AvatarGroup', () => {
  test('renders through renderAvatarGroup', () => {
    const props = { names: ['Ann Lee', 'Bo Yu'], agents: ['Bo Yu'], label: 'In this chat:' } as const;
    assert({
      given: 'the same props',
      should: 'render exactly what renderAvatarGroup renders',
      actual: renderToString(h(AvatarGroup, props)),
      expected: renderToString(renderAvatarGroup(props)),
    });
  });
});
