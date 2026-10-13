// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { SWRConfig } from 'swr';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { TaskAgentTriggersDialog } from './TaskAgentTriggersDialog';

type TriggerFixture = {
  id: string;
  triggerType: 'due_date' | 'completion';
  agentPageId: string;
  prompt: string;
  isEnabled: boolean;
  lastFiredAt: string | null;
  lastFireError: string | null;
  instructionPageId: string | null;
  contextPageIds: string[] | null;
};

const fixtures = vi.hoisted(() => ({
  triggers: [] as TriggerFixture[],
}));

const spies = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: spies.fetchWithAuth,
  put: spies.put,
  del: spies.del,
  post: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Radix's switch measures itself with ResizeObserver, which jsdom does not ship.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const DUE_HELP = 'Requires a due date on this task. The agent runs once at the scheduled time.';
const DONE_HELP = 'Fires the moment the task is moved to a status in the Done group.';
const DUE_PLACEHOLDER = 'What should the agent do when the due date arrives?';

const trigger = (overrides: Partial<TriggerFixture> = {}): TriggerFixture => ({
  id: 'tr1',
  triggerType: 'completion',
  agentPageId: 'a1',
  prompt: 'Post the final on-call rota in #launch-ops.',
  isEnabled: true,
  lastFiredAt: null,
  lastFireError: null,
  instructionPageId: null,
  contextPageIds: null,
  ...overrides,
});

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Lets SWR resolve and React flush, then runs the check. */
const settle = async (check: () => void): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  check();
};

const open = (props: { hasDueDate?: boolean } = {}) =>
  mount(
    createElement(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      createElement(TaskAgentTriggersDialog, {
        open: true,
        onOpenChange: () => {},
        taskId: 't1',
        taskTitle: 'Launch-day on-call rota',
        pageId: 'p1',
        driveId: 'd1',
        hasDueDate: props.hasDueDate ?? true,
      }),
    ),
  );

const switchNamed = (name: string): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`);

const buttonsNamed = (name: string): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(
    (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
  );

const bodyText = () => document.body.textContent ?? '';

const labelled = (text: string): boolean =>
  Array.from(document.querySelectorAll('label, span, p, h2')).some((el) => el.textContent?.trim() === text);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  fixtures.triggers = [];
  spies.fetchWithAuth.mockImplementation(async (url: string) => {
    if (url === '/api/drives/d1/agents') return respond({ agents: [{ id: 'a1', title: 'Launch Agent' }] });
    if (url === '/api/tasks/t1/triggers') return respond({ triggers: fixtures.triggers });
    return respond({});
  });
  spies.put.mockResolvedValue({});
  spies.del.mockImplementation(async () => {
    fixtures.triggers = [];
    return {};
  });
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('TaskAgentTriggersDialog', () => {
  test('starts with both switches off, shows both help lines and a Close footer', async () => {
    open();
    await settle(() => {
      assert({
        given: 'a task with no triggers and a due date',
        should: 'show both switches off with their help lines and the Close footer button',
        actual: {
          title: labelled('Agent triggers'),
          due: switchNamed('Run when due date arrives')?.getAttribute('aria-checked') ?? null,
          done: switchNamed('Run when task is completed')?.getAttribute('aria-checked') ?? null,
          dueHelp: bodyText().includes(DUE_HELP),
          doneHelp: bodyText().includes(DONE_HELP),
          close: buttonsNamed('Close').length > 0,
        },
        expected: {
          title: true,
          due: 'false',
          done: 'false',
          dueHelp: true,
          doneHelp: true,
          close: true,
        },
      });
    });
  });

  test('turning on the due-date switch expands Agent, a due-date prompt, Save and Advanced', async () => {
    open();
    await settle(() => {});
    const dueSwitch = switchNamed('Run when due date arrives');
    if (dueSwitch) click(dueSwitch);
    await settle(() => {
      assert({
        given: 'the due-date switch turned on for a task with a due date',
        should: 'expand the Agent and prompt fields, offer Save, and keep Advanced so existing instruction and context pages stay editable',
        actual: {
          agent: labelled('Agent'),
          prompt: document.querySelector<HTMLTextAreaElement>(`textarea[placeholder="${DUE_PLACEHOLDER}"]`) !== null,
          save: buttonsNamed('Save').length > 0,
          advanced: buttonsNamed('Advanced').length,
        },
        expected: { agent: true, prompt: true, save: true, advanced: 1 },
      });
    });
  });

  test('the due-date switch is disabled when the task has no due date', async () => {
    open({ hasDueDate: false });
    await settle(() => {
      assert({
        given: 'a task without a due date',
        should: 'disable the due-date switch',
        actual: switchNamed('Run when due date arrives')?.disabled ?? null,
        expected: true,
      });
    });
  });

  test('a saved completion trigger shows its prompt, Remove and Update, and Advanced reveals the two page pickers', async () => {
    fixtures.triggers = [trigger()];
    open();
    await settle(() => {});
    const before = labelled('Instruction page');
    const advanced = buttonsNamed('Advanced')[0];
    if (advanced) click(advanced);
    await settle(() => {
      assert({
        given: 'a saved completion trigger with no instruction or context pages',
        should: 'show Remove and Update, hide the pickers until Advanced opens, then show Instruction page and Context pages',
        actual: {
          remove: buttonsNamed('Remove').length > 0,
          update: buttonsNamed('Update').length > 0,
          hiddenBefore: before,
          instruction: labelled('Instruction page'),
          context: labelled('Context pages'),
          expanded: advanced?.getAttribute('aria-expanded') ?? null,
        },
        expected: {
          remove: true,
          update: true,
          hiddenBefore: false,
          instruction: true,
          context: true,
          expanded: 'true',
        },
      });
    });
  });

  test('the creator and spend lines stay hidden until the trigger creator lands', async () => {
    fixtures.triggers = [trigger()];
    open();
    await settle(() => {});
    assert({
      given: 'an enabled completion trigger with Advanced opened',
      should: 'not show the As / Created by line or the wallet spend note',
      actual: {
        createdBy: bodyText().includes('Created by'),
        spend: bodyText().includes('spends only Studio wallet'),
      },
      expected: { createdBy: false, spend: false },
    });
  });

  test('Update PUTs the completion trigger with its agent, prompt and page selections', async () => {
    fixtures.triggers = [trigger()];
    open();
    await settle(() => {});
    const update = buttonsNamed('Update')[0];
    if (update) click(update);
    await settle(() => {
      const [url, body] = spies.put.mock.calls[0] ?? [];
      assert({
        given: 'the viewer presses Update on the completion trigger',
        should: 'PUT the task triggers endpoint with the completion trigger type and its fields',
        actual: {
          url,
          triggerType: (body as { triggerType?: string } | undefined)?.triggerType,
          agentPageId: (body as { agentPageId?: string } | undefined)?.agentPageId,
          prompt: (body as { prompt?: string } | undefined)?.prompt,
        },
        expected: {
          url: '/api/tasks/t1/triggers',
          triggerType: 'completion',
          agentPageId: 'a1',
          prompt: 'Post the final on-call rota in #launch-ops.',
        },
      });
    });
  });

  test('Remove DELETEs the completion trigger and turns its switch off', async () => {
    fixtures.triggers = [trigger()];
    open();
    await settle(() => {});
    const remove = buttonsNamed('Remove')[0];
    if (remove) click(remove);
    await settle(() => {
      assert({
        given: 'the viewer removes an enabled completion trigger',
        should: 'DELETE that trigger type and show the switch off with no Remove button',
        actual: {
          url: spies.del.mock.calls[0]?.[0] ?? null,
          switchState: switchNamed('Run when task is completed')?.getAttribute('aria-checked') ?? null,
          remove: buttonsNamed('Remove').length,
        },
        expected: {
          url: '/api/tasks/t1/triggers/completion',
          switchState: 'false',
          remove: 0,
        },
      });
    });
  });
});
