import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { NO_SCOPES, hasScope, parseScopes, resolveScope, serializeScopes } from './section-scope';

describe('hasScope()', () => {
  test('which heads carry the switch', () => {
    assert({
      given: 'Files, Messages, Tasks, Calendar, Console, Activity, Workflows, Members, Trash and the chat',
      should: 'switch only the sections that can read every drive',
      actual: (['files', 'messages', 'tasks', 'calendar', 'agents', 'activity', 'workflows', 'members', 'trash', 'chat'] as const).map(hasScope),
      expected: [true, true, true, true, true, true, false, false, false, false],
    });
  });
});

describe('resolveScope()', () => {
  test('no choice yet', () => {
    assert({
      given: 'a section never switched, on Home and on another drive',
      should: 'read every drive on Home and the drive itself elsewhere',
      actual: [resolveScope(NO_SCOPES, 'tasks', true), resolveScope(NO_SCOPES, 'tasks', false)],
      expected: ['all', 'drive'],
    });
  });

  test('the viewer’s choice', () => {
    assert({
      given: 'Tasks switched to this drive and Files to All drives',
      should: 'hold each section’s choice on every drive',
      actual: [
        resolveScope({ tasks: 'drive' }, 'tasks', true),
        resolveScope({ files: 'all' }, 'files', false),
        resolveScope({ files: 'all' }, 'messages', false),
      ],
      expected: ['drive', 'all', 'drive'],
    });
  });
});

describe('parseScopes()', () => {
  test('a stored choice round-trips', () => {
    const scopes = { files: 'all', tasks: 'drive' } as const;
    assert({
      given: 'choices written by serializeScopes',
      should: 'read back the same choices',
      actual: parseScopes(serializeScopes(scopes)),
      expected: scopes,
    });
  });

  test('anything malformed', () => {
    assert({
      given: 'nothing stored, broken JSON, a non-object, and unknown sections or scopes',
      should: 'keep only the valid choices',
      actual: [parseScopes(null), parseScopes('{'), parseScopes('3'), parseScopes('{"files":"some","chat":"all","tasks":"all"}')],
      expected: [NO_SCOPES, NO_SCOPES, NO_SCOPES, { tasks: 'all' }],
    });
  });
});
