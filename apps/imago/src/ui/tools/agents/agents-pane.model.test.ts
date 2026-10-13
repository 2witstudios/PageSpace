import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { AgentSessionRow } from './agents-data';
import {
  agoLabel,
  filterSessions,
  groupSessionsByEnv,
  hostOf,
  LOOSE_GROUP_NAME,
  ORPHAN_GROUP_NAME,
  substrateLabel,
} from './agents-pane.model';

const session = (workspaceId: string, envId: string | null, name = workspaceId): AgentSessionRow => ({
  workspaceId,
  driveId: 'd1',
  envId,
  name,
  sandboxStatus: 'running',
  createdAt: '2026-10-12T10:00:00.000Z',
  lastActiveAt: null,
  conversations: [],
  rev: 1,
  nodes: [],
  targets: [],
});

const envs = [
  { id: 'e1', name: 'studio-web', substrate: 'sprite' as const },
  { id: 'e2', name: 'laptop', substrate: 'local' as const },
];

describe('groupSessionsByEnv (IMC-6.3)', () => {
  test('sessions group under their environment, in roster order', () => {
    const groups = groupSessionsByEnv([session('s1', 'e2'), session('s2', 'e1'), session('s3', 'e1')], envs);
    assert({
      given: 'sessions across two environments',
      should: 'group each under its environment name and substrate, in roster order',
      actual: groups.map((g) => [g.name, g.substrate, g.sessions.map((s) => s.workspaceId)]),
      expected: [
        ['studio-web', 'sprite', ['s2', 's3']],
        ['laptop', 'local', ['s1']],
      ],
    });
  });

  test('an environment with no sessions still shows', () => {
    const groups = groupSessionsByEnv([session('s1', 'e1')], envs);
    assert({
      given: 'an environment the roster lists but no session uses',
      should: 'keep its group, empty',
      actual: groups.find((g) => g.envId === 'e2')?.sessions.length,
      expected: 0,
    });
  });

  test('sessions naming an unknown environment are kept as an orphan group', () => {
    const groups = groupSessionsByEnv([session('s1', 'gone')], envs);
    assert({
      given: 'a session whose environment the roster does not return',
      should: 'place it in an orphan group named for the absence, not drop it',
      actual: groups.filter((g) => g.key === 'orphan').map((g) => [g.name, g.sessions.map((s) => s.workspaceId)]),
      expected: [[ORPHAN_GROUP_NAME, ['s1']]],
    });
  });

  test('sessions with no environment are loose, and last', () => {
    const groups = groupSessionsByEnv([session('s1', null), session('s2', 'e1')], envs);
    assert({
      given: 'a session with no environment',
      should: 'list it in a loose group after the environments',
      actual: groups.map((g) => g.name),
      expected: ['studio-web', 'laptop', LOOSE_GROUP_NAME],
    });
  });
});

describe('filterSessions (IMC-6.3)', () => {
  test('matches names case-insensitively and ignores blank queries', () => {
    const rows = [session('s1', 'e1', 'Ship status page'), session('s2', 'e1', 'Docs')];
    assert({
      given: 'a search query',
      should: 'match session names without regard to case, and return every row for a blank query',
      actual: [filterSessions(rows, ' STATUS ').map((s) => s.workspaceId), filterSessions(rows, '  ').length],
      expected: [['s1'], 2],
    });
  });
});

describe('labels (IMC-6.3)', () => {
  test('agoLabel reads minutes, hours and days', () => {
    const now = new Date('2026-10-12T10:42:00.000Z');
    assert({
      given: 'a session started 42 minutes ago',
      should: 'read "42 min ago"',
      actual: [agoLabel('2026-10-12T10:00:00.000Z', now), agoLabel('2026-10-12T10:41:30.000Z', now)],
      expected: ['42 min ago', 'just now'],
    });
  });

  test('substrateLabel names the machine kind', () => {
    assert({
      given: 'the two substrates',
      should: 'name a Sprite or a Local machine',
      actual: [substrateLabel('sprite'), substrateLabel('local')],
      expected: ['Sprite', 'Local'],
    });
  });

  test('hostOf returns the hostname of a published app URL', () => {
    assert({
      given: 'a published app URL',
      should: 'show only its host',
      actual: hostOf('https://status.studio.example/path'),
      expected: 'status.studio.example',
    });
  });
});
