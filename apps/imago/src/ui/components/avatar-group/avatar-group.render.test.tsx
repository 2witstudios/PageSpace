import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  avatarGroupClass,
  avatarGroupFaceClass,
  avatarGroupRestClass,
} from './avatar-group-class';
import { renderAvatarGroup } from './avatar-group.render';
import { renderAvatar } from '../avatar/avatar.render';

const face = (html: string) => `<span class="${avatarGroupFaceClass}">${html}</span>`;

describe('renderAvatarGroup()', () => {
  test('24px ringed faces and a count for the rest', () => {
    const names = ['Jono Woodall', 'research-worker', 'Noah Hines', 'Val Suarez'];
    assert({
      given: 'four people, one an agent, labelled as assignees',
      should:
        'name them all, draw the first three as overlapping stacked faces with the agent marked, and count one more',
      actual: renderToString(
        renderAvatarGroup({
          names,
          agents: ['research-worker'],
          label: 'Assigned to',
        }),
      ),
      expected: [
        `<span class="${avatarGroupClass}" role="img" aria-label="Assigned to Jono Woodall, research-worker, Noah Hines, Val Suarez">`,
        face(renderToString(renderAvatar({ name: 'Jono Woodall', size: 'stack' }))),
        face(renderToString(renderAvatar({ name: 'research-worker', size: 'stack', agent: true }))),
        face(renderToString(renderAvatar({ name: 'Noah Hines', size: 'stack' }))),
        `<span class="${avatarGroupRestClass}">+1</span>`,
        '</span>',
      ].join(''),
    });
  });

  test('everyone shown', () => {
    assert({
      given: 'two people, no label and no agents',
      should: 'name them by themselves and add no count',
      actual: renderToString(renderAvatarGroup({ names: ['Ann Lee', 'Bo Yu'] })),
      expected: [
        `<span class="${avatarGroupClass}" role="img" aria-label="Ann Lee, Bo Yu">`,
        face(renderToString(renderAvatar({ name: 'Ann Lee', size: 'stack' }))),
        face(renderToString(renderAvatar({ name: 'Bo Yu', size: 'stack' }))),
        '</span>',
      ].join(''),
    });
  });

  test('a chosen number shown', () => {
    const html = renderToString(
      renderAvatarGroup({ names: ['A', 'B', 'C'], shown: 1 }),
    );
    assert({
      given: 'three people with one face shown',
      should: 'draw one face and count two more',
      actual: [
        html.split(`class="${avatarGroupFaceClass}"`).length - 1,
        html.includes('>+2</span>'),
      ],
      expected: [1, true],
    });
  });

  test('the same name twice', () => {
    const html = renderToString(renderAvatarGroup({ names: ['Al', 'Al'] }));
    assert({
      given: 'two people with the same name',
      should: 'draw both faces',
      actual: html.split(`class="${avatarGroupFaceClass}"`).length - 1,
      expected: 2,
    });
  });

  test('nobody', () => {
    assert({
      given: 'no names',
      should: 'render nothing',
      actual: renderToString(renderAvatarGroup({ names: [] })),
      expected: '',
    });
  });
});
