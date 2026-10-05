import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { chatContextFor, paneLayout, stageFor, type Section } from './stage';

const page = (pageId: string) => ({ kind: 'page', pageId }) as const;

describe('stageFor() chat', () => {
  test('a drive', () => {
    assert({
      given: 'a drive path',
      should: 'open that drive’s chat with the list closed and no object',
      actual: stageFor('/drive-1'),
      expected: { driveId: 'drive-1', section: 'chat', list: 'closed', object: null },
    });
  });

  test('no drive', () => {
    assert({
      given: 'the bare root (the server sends it on to the Home drive)',
      should: 'open the chat with no drive, no list and no object',
      actual: stageFor('/'),
      expected: { driveId: null, section: 'chat', list: 'closed', object: null },
    });
  });
});

describe('stageFor() files', () => {
  test('the files list is stage 2', () => {
    assert({
      given: 'a drive’s files path',
      should: 'open the wide list and no object',
      actual: stageFor('/drive-1/files'),
      expected: { driveId: 'drive-1', section: 'files', list: 'list', object: null },
    });
  });

  test('a page is stage 3', () => {
    assert({
      given: 'a page path',
      should: 'narrow the list to the tree and open the page as the object',
      actual: stageFor('/drive-1/files/page-1'),
      expected: { driveId: 'drive-1', section: 'files', list: 'tree', object: page('page-1') },
    });
  });
});

describe('stageFor() messages', () => {
  test('channels', () => {
    assert({
      given: 'a drive’s messages path and a channel path',
      should: 'open the wide list alone, then narrow it beside the channel',
      actual: [stageFor('/drive-1/messages'), stageFor('/drive-1/messages/channel-1')],
      expected: [
        { driveId: 'drive-1', section: 'messages', list: 'list', object: null },
        { driveId: 'drive-1', section: 'messages', list: 'tree', object: page('channel-1') },
      ],
    });
  });

  test('direct messages', () => {
    assert({
      given: 'the user-level DM path and a conversation path',
      should:
        'open the messages list with no drive, then narrow it beside the conversation',
      actual: [stageFor('/dm'), stageFor('/dm/conversation-1')],
      expected: [
        { driveId: null, section: 'messages', list: 'list', object: null },
        {
          driveId: null,
          section: 'messages',
          list: 'tree',
          object: { kind: 'conversation', conversationId: 'conversation-1' },
        },
      ],
    });
  });
});

describe('stageFor() tasks', () => {
  test('task lists', () => {
    assert({
      given: 'a drive’s tasks path and a task list path',
      should: 'open the wide list alone, then narrow it beside the task list',
      actual: [stageFor('/drive-1/tasks'), stageFor('/drive-1/tasks/list-1')],
      expected: [
        { driveId: 'drive-1', section: 'tasks', list: 'list', object: null },
        { driveId: 'drive-1', section: 'tasks', list: 'tree', object: page('list-1') },
      ],
    });
  });
});

describe('stageFor() settings and account', () => {
  test('drive settings', () => {
    assert({
      given: 'a drive’s settings path',
      should: 'open the settings as the object, with no list',
      actual: stageFor('/drive-1/settings'),
      expected: {
        driveId: 'drive-1',
        section: 'settings',
        list: 'closed',
        object: { kind: 'settings' },
      },
    });
  });

  test('account', () => {
    assert({
      given: 'the user-level account path',
      should: 'open the account as the object, with no drive and no list',
      actual: stageFor('/account'),
      expected: { driveId: null, section: 'account', list: 'closed', object: { kind: 'account' } },
    });
  });
});

describe('stageFor() normalisation', () => {
  test('trailing and doubled slashes', () => {
    assert({
      given: 'paths with a trailing slash or an empty segment',
      should: 'read them as the same route without the extra slash',
      actual: [stageFor('/drive-1/files/'), stageFor('/drive-1//files/page-1'), stageFor('')],
      expected: [stageFor('/drive-1/files'), stageFor('/drive-1/files/page-1'), stageFor('/')],
    });
  });

  test('section names are exact', () => {
    assert({
      given: 'a section name in another case',
      should: 'not claim the section, and fall back to the drive’s chat',
      actual: stageFor('/drive-1/Files'),
      expected: stageFor('/drive-1'),
    });
  });
});

describe('stageFor() unknown and malformed paths', () => {
  const driveChat = stageFor('/drive-1');
  const root = stageFor('/');

  test('unknown shapes under a drive', () => {
    assert({
      given: 'a section no stage claims, or a known section with extra segments',
      should: 'fall back to that drive’s chat',
      actual: [
        stageFor('/drive-1/nowhere'),
        stageFor('/drive-1/nowhere/page-1'),
        stageFor('/drive-1/files/page-1/extra'),
        stageFor('/drive-1/messages/channel-1/extra'),
        stageFor('/drive-1/tasks/list-1/extra'),
        stageFor('/drive-1/settings/extra'),
      ],
      expected: [driveChat, driveChat, driveChat, driveChat, driveChat, driveChat],
    });
  });

  test('unknown shapes with no drive', () => {
    assert({
      given: 'a user-level route with extra segments',
      should: 'fall back to the root chat, never read a reserved word as a drive',
      actual: [stageFor('/dm/conversation-1/extra'), stageFor('/account/extra')],
      expected: [root, root],
    });
  });

  test('a section with no drive', () => {
    assert({
      given: 'a drive section addressed without a drive (imago’s driveless shape)',
      should: 'fall back to the root chat, never read the section name as a drive',
      actual: [
        stageFor('/files'),
        stageFor('/files/page-1'),
        stageFor('/messages'),
        stageFor('/tasks/list-1'),
        stageFor('/settings'),
        stageFor('/chat'),
      ],
      expected: [root, root, root, root, root, root],
    });
  });

  test('ids that are not ids', () => {
    assert({
      given: 'a page, conversation or drive id carrying characters no id holds',
      should:
        'claim no object for it: an object falls back to the drive’s chat, a drive to the root',
      actual: [
        stageFor('/drive-1/files/%2E%2E'),
        stageFor('/drive-1/files/a.b'),
        stageFor('/drive-1/messages/a%2Fb'),
        stageFor('/dm/..'),
        stageFor('/%2E%2E/files'),
        stageFor('/drive 1'),
        stageFor('/drive-1?x=1'),
        stageFor(`/drive-1/files/${'a'.repeat(129)}`),
      ],
      expected: [driveChat, driveChat, driveChat, root, root, root, root, driveChat],
    });
  });

  test('not a path', () => {
    assert({
      given: 'a pathname without a leading slash',
      should: 'fall back to the root chat rather than guess',
      actual: [stageFor('drive-1/files'), stageFor('https://evil.example/drive-1')],
      expected: [root, root],
    });
  });

  test('the longest id', () => {
    const id = 'a'.repeat(128);
    assert({
      given: 'an id at the length limit',
      should: 'still claim it as the object',
      actual: stageFor(`/drive-1/files/${id}`).object,
      expected: page(id),
    });
  });
});

describe('paneLayout()', () => {
  const none: readonly Section[] = [];

  test('nothing collapsed', () => {
    assert({
      given: 'each stage with no section collapsed',
      should: 'show the list the URL asks for and the object when there is one',
      actual: [
        paneLayout(stageFor('/drive-1'), { collapsedSections: none }),
        paneLayout(stageFor('/drive-1/files'), { collapsedSections: none }),
        paneLayout(stageFor('/drive-1/files/page-1'), { collapsedSections: none }),
        paneLayout(stageFor('/drive-1/settings'), { collapsedSections: none }),
      ],
      expected: [
        { list: 'closed', listHidden: false, object: false },
        { list: 'list', listHidden: false, object: false },
        { list: 'tree', listHidden: false, object: true },
        { list: 'closed', listHidden: false, object: true },
      ],
    });
  });

  test('collapsing a section hides its tree beside an object', () => {
    assert({
      given: 'stage 3 with its own section collapsed',
      should: 'close the list, mark it hidden and keep the object',
      actual: [
        paneLayout(stageFor('/drive-1/files/page-1'), { collapsedSections: ['files'] }),
        paneLayout(stageFor('/drive-1/messages/channel-1'), { collapsedSections: ['messages'] }),
        paneLayout(stageFor('/dm/conversation-1'), { collapsedSections: ['messages'] }),
        paneLayout(stageFor('/drive-1/tasks/list-1'), { collapsedSections: ['tasks'] }),
      ],
      expected: [
        { list: 'closed', listHidden: true, object: true },
        { list: 'closed', listHidden: true, object: true },
        { list: 'closed', listHidden: true, object: true },
        { list: 'closed', listHidden: true, object: true },
      ],
    });
  });

  test('only that section’s list', () => {
    assert({
      given: 'one section collapsed and a stage 3 in each other section',
      should: 'leave every other section’s tree open',
      actual: [
        paneLayout(stageFor('/drive-1/messages/channel-1'), { collapsedSections: ['files'] }).list,
        paneLayout(stageFor('/drive-1/tasks/list-1'), { collapsedSections: ['files'] }).list,
        paneLayout(stageFor('/drive-1/files/page-1'), { collapsedSections: ['tasks'] }).list,
        paneLayout(stageFor('/drive-1/files/page-1'), {
          collapsedSections: ['chat', 'messages', 'tasks', 'settings', 'account'],
        }).list,
      ],
      expected: ['tree', 'tree', 'tree', 'tree'],
    });
  });

  test('the stage 2 list never hides', () => {
    assert({
      given: 'stage 2 with its section collapsed',
      should: 'keep the wide list open, because it is the whole stage',
      actual: [
        paneLayout(stageFor('/drive-1/files'), { collapsedSections: ['files'] }),
        paneLayout(stageFor('/dm'), { collapsedSections: ['messages'] }),
      ],
      expected: [
        { list: 'list', listHidden: false, object: false },
        { list: 'list', listHidden: false, object: false },
      ],
    });
  });

  test('stages with no list', () => {
    assert({
      given: 'the chat, settings and account with their own section collapsed',
      should: 'have no list to hide, so report none hidden',
      actual: [
        paneLayout(stageFor('/drive-1'), { collapsedSections: ['chat'] }).listHidden,
        paneLayout(stageFor('/drive-1/settings'), { collapsedSections: ['settings'] }).listHidden,
        paneLayout(stageFor('/account'), { collapsedSections: ['account'] }).listHidden,
      ],
      expected: [false, false, false],
    });
  });
});

describe('chatContextFor() density', () => {
  test('roomy alone, dense beside an object', () => {
    assert({
      given: 'each stage',
      should: 'be dense only when an object is open beside the chat',
      actual: [
        stageFor('/drive-1'),
        stageFor('/drive-1/files'),
        stageFor('/drive-1/files/page-1'),
        stageFor('/drive-1/messages'),
        stageFor('/drive-1/messages/channel-1'),
        stageFor('/dm'),
        stageFor('/dm/conversation-1'),
        stageFor('/drive-1/tasks'),
        stageFor('/drive-1/tasks/list-1'),
        stageFor('/drive-1/settings'),
        stageFor('/account'),
      ].map((stage) => chatContextFor(stage).density),
      expected: [
        'roomy',
        'roomy',
        'dense',
        'roomy',
        'dense',
        'roomy',
        'dense',
        'roomy',
        'dense',
        'dense',
        'dense',
      ],
    });
  });
});

describe('chatContextFor() with names', () => {
  test('the chat answers against its drive', () => {
    assert({
      given: 'the chat stage and the drive’s name',
      should: 'name the drive and invite any question',
      actual: chatContextFor(stageFor('/drive-1'), { drive: 'Home' }),
      expected: {
        density: 'roomy',
        contextLabel: 'Home in context',
        placeholder: 'Ask anything…',
      },
    });
  });

  test('a list answers against its section', () => {
    assert({
      given: 'each stage 2 list',
      should: 'name the section and invite questions about it',
      actual: [
        chatContextFor(stageFor('/drive-1/files'), { drive: 'Home' }),
        chatContextFor(stageFor('/drive-1/messages')),
        chatContextFor(stageFor('/dm')),
        chatContextFor(stageFor('/drive-1/tasks')),
      ],
      expected: [
        { density: 'roomy', contextLabel: 'Files in context', placeholder: 'Ask about your files…' },
        {
          density: 'roomy',
          contextLabel: 'Messages in context',
          placeholder: 'Ask about your messages…',
        },
        {
          density: 'roomy',
          contextLabel: 'Messages in context',
          placeholder: 'Ask about your messages…',
        },
        { density: 'roomy', contextLabel: 'Tasks in context', placeholder: 'Ask about your tasks…' },
      ],
    });
  });

  test('an object answers against itself by name', () => {
    assert({
      given: 'a page, channel, conversation and task list open with their names',
      should: 'name each in the label and the composer',
      actual: [
        chatContextFor(stageFor('/drive-1/files/page-1'), { object: 'Q3 Launch Brief' }),
        chatContextFor(stageFor('/drive-1/messages/channel-1'), { object: '# launch' }),
        chatContextFor(stageFor('/dm/conversation-1'), { object: 'Ada' }),
        chatContextFor(stageFor('/drive-1/tasks/list-1'), { object: 'Launch tasks' }),
      ].map(({ contextLabel, placeholder }) => [contextLabel, placeholder]),
      expected: [
        ['Q3 Launch Brief in context', 'Ask about Q3 Launch Brief…'],
        ['# launch in context', 'Ask about # launch…'],
        ['Ada in context', 'Ask about Ada…'],
        ['Launch tasks in context', 'Ask about Launch tasks…'],
      ],
    });
  });

  test('settings and account name themselves', () => {
    assert({
      given: 'the drive settings and the account',
      should: 'label them by what they are and invite any question',
      actual: [
        chatContextFor(stageFor('/drive-1/settings'), { drive: 'Home' }),
        chatContextFor(stageFor('/account')),
      ],
      expected: [
        { density: 'dense', contextLabel: 'Home settings in context', placeholder: 'Ask anything…' },
        { density: 'dense', contextLabel: 'Account in context', placeholder: 'Ask anything…' },
      ],
    });
  });
});

describe('chatContextFor() before names load', () => {
  test('falls back to what the URL alone says', () => {
    assert({
      given: 'each stage with no drive or object name yet',
      should: 'label it generically rather than print an id or "undefined"',
      actual: [
        chatContextFor(stageFor('/drive-1')),
        chatContextFor(stageFor('/drive-1/files/page-1')),
        chatContextFor(stageFor('/drive-1/messages/channel-1')),
        chatContextFor(stageFor('/dm/conversation-1')),
        chatContextFor(stageFor('/drive-1/tasks/list-1')),
        chatContextFor(stageFor('/drive-1/settings')),
      ].map(({ contextLabel, placeholder }) => [contextLabel, placeholder]),
      expected: [
        ['This drive in context', 'Ask anything…'],
        ['This page in context', 'Ask about this page…'],
        ['This channel in context', 'Ask about this channel…'],
        ['This conversation in context', 'Ask about this conversation…'],
        ['This task list in context', 'Ask about this task list…'],
        ['Drive settings in context', 'Ask anything…'],
      ],
    });
  });

  test('blank names count as not loaded', () => {
    assert({
      given: 'an empty or whitespace-only name',
      should: 'use the generic label instead of an empty one',
      actual: [
        chatContextFor(stageFor('/drive-1'), { drive: '' }).contextLabel,
        chatContextFor(stageFor('/drive-1/files/page-1'), { object: '   ' }).contextLabel,
      ],
      expected: ['This drive in context', 'This page in context'],
    });
  });
});
