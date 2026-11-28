// @vitest-environment jsdom
import { beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderToString } from 'react-dom/server';
import type { Workflow } from '@/retained/components/workflows/types';
import { WorkflowsPane } from './workflows-pane';

type ListState = { data: Workflow[] | undefined; error: unknown; isLoading: boolean };

const navigation = { id: null as string | null };
const list: ListState = { data: undefined, error: undefined, isLoading: false };

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.id === null ? '' : `id=${navigation.id}`),
}));

vi.mock('@/retained-adapters/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('swr', () => ({ default: () => ({ data: list.data, error: list.error, isLoading: list.isLoading }) }));

const workflow = (id: string, name: string, lastRun: Workflow['lastRun']): Workflow => ({
  id,
  driveId: 'd1',
  createdBy: 'u1',
  name,
  agentPageId: null,
  instructionPageId: null,
  prompt: '',
  steps: null,
  contextPageIds: [],
  triggerType: 'cron',
  cronExpression: '0 8 * * 1-5',
  timezone: 'UTC',
  isEnabled: true,
  nextRunAt: null,
  lastRun,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

const close = <button type="button" aria-label="Close sidebar" />;

describe('WorkflowsPane', () => {
  beforeEach(() => {
    navigation.id = null;
    list.data = undefined;
    list.error = undefined;
    list.isLoading = false;
  });

  test('the list, with its New button and each row’s name, last-run badge, kind and trigger', () => {
    list.data = [
      workflow('wf1', 'Launch digest', { status: 'success', startedAt: '2026-10-12T08:00:00.000Z', endedAt: null, error: null, durationMs: null }),
      workflow('wf2', 'Weekly pricing check', null),
    ];
    const html = renderToString(<WorkflowsPane driveId="d1" close={close} />).replaceAll('<!-- -->', '');
    assert({
      given: 'two cron workflows, one that has run and one that never has',
      should: 'head the workflows pane with New, and list each name, badge, kind and trigger',
      actual: [
        html.includes('aria-label="Workflows"'),
        html.includes('New'),
        html.includes('Launch digest'),
        html.includes('Success'),
        html.includes('Weekly pricing check'),
        html.includes('Never run'),
        html.includes('cron · At 08:00 AM, Monday through Friday'),
        html.includes('href="/d1/workflows/view?id=wf1"'),
      ],
      expected: [true, true, true, true, true, true, true, true],
    });
  });

  test('the selected row', () => {
    navigation.id = 'wf2';
    list.data = [workflow('wf1', 'Launch digest', null), workflow('wf2', 'Weekly pricing check', null)];
    const html = renderToString(<WorkflowsPane driveId="d1" close={close} />).replaceAll('<!-- -->', '');
    const current = (html.match(/<a [^>]*>/g) ?? []).filter((anchor) => anchor.includes('aria-current="page"'));
    assert({
      given: 'a URL that selects the second workflow',
      should: 'mark only that row as the current page',
      actual: [
        current.length,
        current.every((anchor) => anchor.includes('href="/d1/workflows/view?id=wf2"')),
      ],
      expected: [1, true],
    });
  });

  test('loading, failed and empty lists say so', () => {
    const loading = renderToString(<WorkflowsPane driveId="d1" close={close} />);
    list.error = new Error('down');
    const failed = renderToString(<WorkflowsPane driveId="d1" close={close} />);
    list.error = undefined;
    list.data = [];
    const empty = renderToString(<WorkflowsPane driveId="d1" close={close} />);
    assert({
      given: 'a list still loading, one that failed, and one with no workflows',
      should: 'read each state plainly',
      actual: [
        loading.includes('Loading workflows…'),
        failed.includes('Could not load workflows.'),
        empty.includes('No workflows yet.'),
      ],
      expected: [true, true, true],
    });
  });
});
