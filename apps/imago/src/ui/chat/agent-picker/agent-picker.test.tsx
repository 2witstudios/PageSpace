// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, press, unmountAll } from '../../test-support/dom';
import { agentMenu } from '../chat-agents/chat-agents';
import { AgentPicker, type AgentPickerProps } from './agent-picker';
import { agentTileClass, pickerRowClass, pickerTriggerClass } from './agent-picker-class';
import { imagoOrbClass } from '../../metal/imago-orb/imago-orb-class';

afterEach(unmountAll);

const menu = (selected: { id: string; title: string } | null) =>
  agentMenu({
    builtins: [{ key: 'imago', title: 'Imago', pageId: 'p-imago' }],
    driveAgents: [{ id: 'a1', title: 'Launch Agent', aiModel: 'claude-sonnet-5-5', parentId: 'f-launch' }],
    driveName: 'Studio',
    selected,
    folderTitle: (id) => (id === 'f-launch' ? 'Launch' : undefined),
  });

const show = (overrides: Partial<AgentPickerProps> = {}) => {
  const picked: string[] = [];
  const created: string[] = [];
  const container = mount(
    <AgentPicker
      agentName="Imago"
      imago={true}
      agents={menu(null)}
      selectAgent={(value) => picked.push(value)}
      model={<div data-model="" />}
      allAgentsHref="/d1/agents"
      onNewAgent={() => created.push('new')}
      {...overrides}
    />,
  );
  return { container, picked, created };
};

const details = (container: HTMLElement) => container.querySelector('details');
const summary = (container: HTMLElement) => container.querySelector<HTMLElement>('summary');
const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]')];
/** The browser flips `open` at once but fires `toggle` as a later task; only that reaches React. */
const open = async (container: HTMLElement): Promise<void> => {
  const element = details(container);
  if (element === null) throw new Error('no picker');
  const toggled = new Promise<void>((resolve) => element.addEventListener('toggle', () => resolve(), { once: true }));
  act(() => summary(container)?.click());
  await act(() => toggled);
};

describe('AgentPicker', () => {
  test('the trigger', () => {
    const { container } = show();
    assert({
      given: 'Imago talking, the picker closed',
      should: 'name the agent in a labelled trigger with Imago’s orb (its still chrome without WebGL2), and keep the popover shut',
      actual: [
        summary(container)?.getAttribute('aria-label'),
        summary(container)?.className,
        summary(container)?.firstElementChild?.className,
        summary(container)?.textContent,
        details(container)?.open,
      ],
      expected: ['Choose agent: Imago', pickerTriggerClass, imagoOrbClass('tile', true), 'Imago', false],
    });
  });

  test('opening it', async () => {
    const { container } = show();
    await open(container);
    const dialog = container.querySelector('[role="dialog"]');
    assert({
      given: 'the trigger pressed',
      should: 'open a "Choose agent" dialog headed "Talk to", Imago first and Active, then "Agents in Studio" with model · folder',
      actual: [
        details(container)?.open,
        dialog?.getAttribute('aria-label'),
        dialog?.firstElementChild?.textContent,
        container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label'),
        rows(container).map((row) => [
          row.querySelector('span span')?.textContent,
          row.querySelector('span span + span')?.textContent,
          row.getAttribute('aria-checked'),
          row.lastElementChild?.textContent === 'Active',
          row.className,
          row.firstElementChild?.className,
        ]),
        [...container.querySelectorAll('[role="radiogroup"] > div > div:not([role])')].map((label) => label.textContent),
      ],
      expected: [
        true,
        'Choose agent',
        'Talk to',
        'Agent',
        [
          ['Imago', 'Global · your chosen model', 'true', true, pickerRowClass(true, false), imagoOrbClass('row', true)],
          ['Launch Agent', 'claude-sonnet-5-5 · Launch', 'false', false, pickerRowClass(false, false), agentTileClass(false, 'row')],
        ],
        ['Agents in Studio'],
      ],
    });
  });

  test('the Model section', () => {
    const imago = show().container;
    const agent = show({ agentName: 'Launch Agent', imago: false, agents: menu({ id: 'a1', title: 'Launch Agent' }) }).container;
    assert({
      given: 'Imago picked, then a drive agent picked',
      should: 'show Imago’s Model section only while Imago is picked, and mark the agent Active instead',
      actual: [
        [Boolean(imago.querySelector('[data-model]')), imago.textContent?.includes('Model')],
        [agent.querySelector('[data-model]'), rows(agent).map((row) => row.getAttribute('aria-checked'))],
      ],
      expected: [
        [true, true],
        [null, ['false', 'true']],
      ],
    });
  });

  test('picking an agent', async () => {
    const { container, picked } = show();
    await open(container);
    click(rows(container)[1]);
    assert({
      given: 'the picker open and Launch Agent pressed',
      should: 'choose that agent and close',
      actual: [picked, details(container)?.open],
      expected: [['a1'], false],
    });
  });

  test('closing it', async () => {
    const { container, picked } = show();
    await open(container);
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close agent picker"]');
    if (close === null) throw new Error('no close');
    click(close);
    const closed = details(container)?.open;
    await open(container);
    press(document.body, 'Escape');
    assert({
      given: 'the picker open, then its close button, then opened again and Escape',
      should: 'close each time without choosing an agent, returning focus to the trigger',
      actual: [closed, details(container)?.open, document.activeElement === summary(container), picked],
      expected: [false, false, true, []],
    });
  });

  test('a press in a portaled model popover', async () => {
    const { container } = show();
    await open(container);
    const portal = document.createElement('div');
    portal.setAttribute('data-radix-popper-content-wrapper', '');
    const option = document.createElement('button');
    portal.append(option);
    document.body.append(portal);
    act(() => {
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    const inPortal = details(container)?.open;
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    portal.remove();
    assert({
      given: 'the picker open, a press in the model selector’s portaled popover, then a press outside',
      should: 'stay open for the popover and close for the outside press',
      actual: [inPortal, details(container)?.open],
      expected: [true, false],
    });
  });

  test('the footer', async () => {
    const { container, created } = show();
    await open(container);
    const newAgent = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'New agent');
    const allAgents = container.querySelector('a');
    if (newAgent === undefined) throw new Error('no New agent');
    click(newAgent);
    const none = show({ allAgentsHref: null, onNewAgent: null }).container;
    assert({
      given: 'a drive open, New agent pressed, then no drive',
      should: 'link All agents to the drive’s agents and start a new agent, closing; and offer neither without a drive',
      actual: [
        [allAgents?.textContent, allAgents?.getAttribute('href'), created, details(container)?.open],
        [none.querySelector('a'), [...none.querySelectorAll('button')].some((button) => button.textContent === 'New agent')],
      ],
      expected: [
        ['All agents', '/d1/agents', ['new'], false],
        [null, false],
      ],
    });
  });
});
