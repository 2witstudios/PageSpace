// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { AssigneeAvatars, assigneeAvatars, initialsOf } from './TaskAssigneeAvatars';
import type { TaskAssigneeData } from './task-list-types';

afterEach(unmountAll);

const userRow = (id: string, name: string | null): TaskAssigneeData => ({
  id,
  taskId: 't',
  userId: `user-${id}`,
  agentPageId: null,
  user: { id: `user-${id}`, name, image: null },
});

const agentRow = (id: string, title: string | null): TaskAssigneeData => ({
  id,
  taskId: 't',
  userId: null,
  agentPageId: `agent-${id}`,
  agentPage: { id: `agent-${id}`, title, type: 'AI_CHAT' },
});

describe('assigneeAvatars', () => {
  test('lists people and agents from the assignee rows, in order', () => {
    assert({
      given: 'a task with a person and an agent assigned',
      should: 'return both, marked as user and agent',
      actual: assigneeAvatars({ assignees: [userRow('1', 'Dana Whitfield'), agentRow('2', 'Launch Agent')] }).map(
        ({ kind, name }) => ({ kind, name }),
      ),
      expected: [
        { kind: 'user', name: 'Dana Whitfield' },
        { kind: 'agent', name: 'Launch Agent' },
      ],
    });
  });

  test('falls back to the legacy single assignee when no row resolves', () => {
    assert({
      given: 'no assignee rows but a legacy assigned agent',
      should: 'return the legacy agent as the one avatar',
      actual: assigneeAvatars({
        assignees: [],
        assignee: null,
        assigneeAgent: { id: 'a1', title: 'Research Agent', type: 'AI_CHAT' },
      }).map(({ kind, name }) => ({ kind, name })),
      expected: [{ kind: 'agent', name: 'Research Agent' }],
    });
  });

  test('is empty for a task with nobody assigned', () => {
    assert({
      given: 'a task with no assignees at all',
      should: 'return no avatars',
      actual: assigneeAvatars({ assignees: [], assignee: null, assigneeAgent: null }),
      expected: [],
    });
  });
});

describe('initialsOf', () => {
  test('takes the first letters of the first two words', () => {
    assert({
      given: 'a full name with three words',
      should: 'use the first two initials, upper-cased',
      actual: initialsOf('dana whitfield jones'),
      expected: 'DW',
    });
  });

  test('falls back to a question mark for a blank name', () => {
    assert({
      given: 'a blank name',
      should: 'show a question mark',
      actual: initialsOf('   '),
      expected: '?',
    });
  });
});

describe('AssigneeAvatars', () => {
  test('draws people with initials and agents as named squares, capped at three', () => {
    const container = mount(
      createElement(AssigneeAvatars, {
        task: {
          assignees: [
            userRow('1', 'Dana Whitfield'),
            agentRow('2', 'Launch Agent'),
            userRow('3', 'Sam Okafor'),
            userRow('4', 'Priya Raman'),
          ],
        },
      }),
    );
    const shown = [...container.querySelectorAll('[title]')].map((node) => node.getAttribute('title'));
    const agentSquares = container.querySelectorAll('.rounded-md').length;
    assert({
      given: 'four assignees on a card',
      should: 'show the first three, with the agent drawn as a square',
      actual: { shown, agentSquares },
      expected: { shown: ['Dana Whitfield', 'Launch Agent', 'Sam Okafor'], agentSquares: 1 },
    });
  });
});
