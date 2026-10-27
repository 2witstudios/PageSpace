// @vitest-environment jsdom
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderToString } from 'react-dom/server';
import { WorkflowDetailView, type WorkflowDetailViewProps } from './WorkflowDetail';
import type { Workflow } from './types';

const workflow: Workflow = {
  id: 'wf1',
  driveId: 'd1',
  createdBy: 'u1',
  name: 'Launch digest',
  agentPageId: 'a1',
  instructionPageId: null,
  prompt: '',
  steps: [{ kind: 'ai', prompt: 'Summarize the launch', agentPageId: 'a1' }],
  contextPageIds: [],
  triggerType: 'cron',
  cronExpression: '0 8 * * 1-5',
  timezone: 'America/Los_Angeles',
  isEnabled: true,
  nextRunAt: '2026-10-13T15:00:00.000Z',
  lastRun: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const now = new Date('2026-10-12T17:00:00.000Z');

const props = (overrides: Partial<WorkflowDetailViewProps> = {}): WorkflowDetailViewProps => ({
  workflow,
  agentTitle: 'Launch Agent',
  agentsLoaded: true,
  agentTitles: new Map([['a1', 'Launch Agent']]),
  createdByName: 'Jono',
  running: false,
  toggling: false,
  now,
  onToggle: () => {},
  onRun: () => {},
  onEdit: () => {},
  onDelete: () => {},
  ...overrides,
});

describe('WorkflowDetailView', () => {
  test('a delete action, named for the workflow', () => {
    const html = renderToString(<WorkflowDetailView {...props()} />);
    assert({
      given: 'a workflow open in the detail',
      should: 'keep a Delete control so a workflow can still be removed',
      actual: html.includes('aria-label="Delete Launch digest"'),
      expected: true,
    });
  });

  test('a cron workflow, enabled', () => {
    const html = renderToString(<WorkflowDetailView {...props()} />).replaceAll('<!-- -->', '');
    assert({
      given: 'an enabled cron workflow with an agent, a schedule and steps',
      should: 'show the h1, Created by, the Enabled switch, both actions, the schedule with next run, the agent and the steps',
      actual: [
        html.includes('<h1 class="text-2xl font-bold tracking-tight">Launch digest</h1>'),
        /Created by Jono/.test(html),
        html.includes('aria-label="Enabled"'),
        html.includes('Edit workflow'),
        html.includes('Run workflow'),
        html.includes('0 8 * * 1-5 · America/Los_Angeles'),
        html.includes('in 22 hours'),
        html.includes('Launch Agent'),
        html.includes('Summarize the launch'),
        html.includes('>AI<'),
        html.includes('Context pages'),
        html.includes('No context pages'),
      ],
      expected: [true, true, true, true, true, true, true, true, true, true, true, true],
    });
  });

  test('a disabled workflow', () => {
    const html = renderToString(<WorkflowDetailView {...props({ workflow: { ...workflow, isEnabled: false } })} />).replaceAll('<!-- -->', '');
    assert({
      given: 'a workflow whose Enabled switch is off',
      should: 'leave the switch unchecked and hide the next run, which does not apply while disabled',
      actual: [
        html.includes('aria-label="Enabled"') && !/aria-label="Enabled"[^>]*checked/.test(html),
        html.includes('Next run'),
        html.includes('0 8 * * 1-5'),
      ],
      expected: [true, false, true],
    });
  });

  test('a workflow with no cron expression and no agent', () => {
    const html = renderToString(
      <WorkflowDetailView
        {...props({
          workflow: { ...workflow, cronExpression: null, nextRunAt: null, agentPageId: null, steps: null, prompt: 'Do it' },
          agentTitle: null,
          createdByName: null,
        })}
      />,
    ).replaceAll('<!-- -->', '');
    assert({
      given: 'a workflow with no schedule, no agent and no creator name',
      should: 'hide the schedule and the Created by line, say there is no agent, and show the legacy prompt as one AI step',
      actual: [
        html.includes('aria-label="Schedule"'),
        html.includes('Created by'),
        html.includes('No agent'),
        html.includes('Do it'),
      ],
      expected: [false, false, true, true],
    });
  });

  test('context pages and the instructions page are linked to their pages', () => {
    const html = renderToString(
      <WorkflowDetailView
        {...props({ workflow: { ...workflow, contextPageIds: ['p1'], instructionPageId: 'p2' } })}
      />,
    ).replaceAll('<!-- -->', '');
    assert({
      given: 'a workflow with one context page and an instructions page',
      should: 'link both to their pages, reading Loading until their titles arrive',
      actual: [
        html.includes('href="/p/p1"'),
        html.includes('href="/p/p2"'),
        html.includes('Instructions: '),
      ],
      expected: [true, true, true],
    });
  });
});

test('a workflow whose creator left cannot run or be enabled', () => {
  const html = renderToString(<WorkflowDetailView {...props({ workflow: { ...workflow, ownerLeftAt: '2026-09-30T00:00:00Z' } })} />);
  const node = document.createElement('div'); node.innerHTML = html;
  const toggle = node.querySelector('[role="switch"]');
  const run = [...node.querySelectorAll('button')].find(button => button.textContent?.includes('Run workflow'));
  assert({ given: 'a departed automation creator', should: 'show Owner left, disable Run and turn off and disable its Enabled switch', actual: { ownerLeft: node.textContent?.includes('Owner left'), canRun: !run?.hasAttribute('disabled'), canEnable: !toggle?.hasAttribute('disabled'), enabled: toggle?.getAttribute('aria-checked') }, expected: { ownerLeft: true, canRun: false, canEnable: false, enabled: 'false' } });
});

test('workflow detail names the creator and source wallet', () => {
  const html = renderToString(<WorkflowDetailView {...props()} spendContext={{ creatorNames: { u1: 'Jono' }, walletLabel: 'Product wallet', orgName: 'Northwind' }} />).replaceAll('<!-- -->', '');
  assert({ given: 'a workflow spending in an organization drive', should: 'name its creator and drive wallet', actual: { creator: html.includes('Created by Jono'), wallet: html.includes('Product wallet') }, expected: { creator: true, wallet: true } });
});
