import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { pointers } from '../chat-model/fixtures';
import { agentFor, agentMenu } from './chat-agents';

const builtins = pointers().agents;
const driveAgents = [
  { id: 'a1', title: 'Support' },
  { id: 'a2', title: 'Release notes' },
];

describe('agentMenu()', () => {
  test('Imago agents first, then the drive’s', () => {
    assert({
      given: "the viewer's Imago and the agents the server lists in the open drive, with Imago answering",
      should: 'offer Imago first, then the drive’s agents under its name, with Imago chosen',
      actual: agentMenu({ builtins, driveAgents, driveName: 'Alpha', selected: null }),
      expected: {
        value: 'p-imago',
        groups: [
          {
            label: 'Imago',
            options: [
              { value: 'p-imago', title: 'Imago', disabled: false },
            ],
          },
          {
            label: 'Alpha',
            options: [
              { value: 'a1', title: 'Support', disabled: false },
              { value: 'a2', title: 'Release notes', disabled: false },
            ],
          },
        ],
      },
    });
  });

  test('in the Home drive', () => {
    const home = [{ id: 'p-imago', title: 'Imago' }, { id: 'a9', title: 'Journal' }];
    assert({
      given: 'the Home drive, whose agent list holds Imago too',
      should: 'list Imago once, in the Imago group',
      actual: agentMenu({ builtins, driveAgents: home, driveName: 'Home', selected: null }).groups.map((group) =>
        group.options.map((option) => option.value),
      ),
      expected: [['p-imago'], ['a9']],
    });
  });

  test('Imago not provisioned yet', () => {
    assert({
      given: 'Imago with no page yet',
      should: 'show it, but not as something to choose',
      actual: agentMenu({ builtins: pointers({ imago: null }).agents, driveAgents: [], selected: null }).groups,
      expected: [
        {
          label: 'Imago',
          options: [{ value: 'pending:imago', title: 'Imago', disabled: true }],
        },
      ],
    });
  });

  test('the chosen agent', () => {
    const elsewhere = agentMenu({ builtins, driveAgents, driveName: 'Beta', selected: { id: 'b7', title: 'Legal' } });
    assert({
      given: 'an agent of the drive chosen, and one chosen in another drive before moving here',
      should: 'name the chosen one as the value, and keep the one from elsewhere offered so the header still names it',
      actual: [
        agentMenu({ builtins, driveAgents, driveName: 'Alpha', selected: { id: 'a2', title: 'Release notes' } }).value,
        elsewhere.value,
        elsewhere.groups.map((group) => group.label),
        elsewhere.groups.at(-1)?.options,
      ],
      expected: ['a2', 'b7', ['Imago', 'Beta', 'Chosen'], [{ value: 'b7', title: 'Legal', disabled: false }]],
    });
  });

  test('nothing loaded yet', () => {
    assert({
      given: 'neither list loaded, and no drive open',
      should: 'offer nothing and choose nothing',
      actual: [agentMenu({ selected: null }), agentMenu({ builtins, selected: null }).groups.length],
      expected: [{ value: '', groups: [] }, 1],
    });
  });
});

describe('agentFor()', () => {
  test('a chosen option', () => {
    const lists = { builtins, driveAgents };
    assert({
      given: 'Imago, a drive agent, an unprovisioned Imago and an unknown value',
      should: 'answer null for Imago (the default), the agent for the drive one, and undefined for what cannot be chosen',
      actual: [
        agentFor(lists, 'p-imago'),
        agentFor(lists, 'a1'),
        agentFor({ builtins: pointers({ imago: null }).agents }, 'pending:imago'),
        agentFor(lists, 'zz'),
      ],
      expected: [null, { id: 'a1', title: 'Support' }, undefined, undefined],
    });
  });
});
