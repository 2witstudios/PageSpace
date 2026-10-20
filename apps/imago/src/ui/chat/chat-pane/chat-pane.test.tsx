// @vitest-environment jsdom
import { act, isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { createInitialState } from '@/ui/store/state';
import { setUiState, getUiState } from '@/ui/store/store';
import { dispatch, transactions } from '@/ui/store/transactions';
import { useRetainedChatSelection } from '@/retained-adapters/session-selection';
import { stageFor } from '@/ui/frame/stage/stage';
import { pointers, conversationsPage, agentConversation, driveAgentsBody } from '../chat-model/fixtures';
import { chatPaths } from '../chat-api/chat-api';

// This suite checks the shell/host contract; the retained pipeline and input
// have their own behavioral suites and real-server browser coverage in 36.
const host = vi.hoisted(() => ({ props: null as { agentId: string | null; conversationId: string | null; resolving: boolean; name: string; placeholder?: string; aboveComposer?: ReactNode } | null }));
vi.mock('@/retained-adapters/retained-chat', () => ({ RetainedChat: (props: NonNullable<typeof host.props>) => { host.props = props; return <div data-retained-host="" />; } }));
// Imago's Model section reuses classic's selector inside a themed retained surface; both have
// their own suites. Here the section only has to be there while Imago is picked.
vi.mock('@/retained-adapters/retained-provider', () => ({ RetainedSurface: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/retained/components/ai/chat/input/ProviderModelSelector', () => ({ ProviderModelSelector: () => <div data-model-selector="" /> }));
// The drive's tree names an agent's folder in its picker row.
vi.mock('@/retained/hooks/usePageTree', () => ({ usePageTree: () => ({ tree: [{ id: 'f-launch', title: 'Launch', children: [] }] }) }));
const sourceRead = vi.hoisted(() => vi.fn());
vi.mock('@/retained/hooks/useConversationSpend', () => ({ useConversationSpend: (conversationId: string | null, scope: unknown) => { sourceRead(conversationId, scope); return { spend: { options: [{ source: 'own_credits', walletId: 'own', label: 'Your credits', remainingCredits: '900' }], resolved: { kind: 'spend', source: 'own_credits', walletId: 'own', fallbackApplied: false, fallbackFrom: null } }, choose: vi.fn(), isPending: false }; }, useDriveSpend: () => ({ spend: null }) }));
import { useSpendContextStore } from '@/retained/stores/useSpendContextStore';
const { ChatPane } = await import('./chat-pane');
beforeEach(() => { useSpendContextStore.setState({ entries: [], active: null }); setUiState(createInitialState()); host.props = null; useRetainedChatSelection.getState().select(null); });
afterEach(unmountAll);
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
function show(path = '/d1', conversations = [agentConversation('c1')]) {
  const web = fakeWeb({
    [`GET ${chatPaths.builtinAgents}`]: () => Response.json(pointers()),
    [`GET ${chatPaths.conversations('p-imago', 0)}`]: () => Response.json(conversationsPage(conversations)),
    [`GET ${chatPaths.driveAgents('d1')}`]: () => Response.json(driveAgentsBody([])),
    'GET /api/pages/p1/breadcrumbs': () => Response.json([{ id: 'p1', title: 'Brief' }]),
  });
  const container = mount(<ImagoSWRProvider client={web.client}><ChatPane stage={stageFor(path)} driveName="Alpha" homeDriveId="d1" /></ImagoSWRProvider>);
  return { container, web };
}
describe('persistent chat orchestration', () => {
  it('mounts exactly one retained host with the provisioned agent and latest conversation', async () => {
    const { container } = show(); await settle();
    expect(container.querySelectorAll('[data-retained-host]')).toHaveLength(1);
    expect(host.props).toMatchObject({ agentId: 'p-imago', conversationId: 'c1', name: 'Imago', resolving: false, placeholder: 'Ask anything…' });
    expect(isValidElement(host.props?.aboveComposer)).toBe(true);
  });
  it('keeps explicit history selection and the draft through object navigation', async () => {
    dispatch(transactions.openConversation, 'c2'); dispatch(transactions.setChatDraft, 'Unsent draft');
    const { container } = show('/d1/files/p1'); await settle();
    expect(host.props?.conversationId).toBe('c2');
    expect(getUiState().resources.chatDraft).toBe('Unsent draft');
    expect(container.querySelector('aside > header > span')?.textContent).toBe('Brief');
    expect(host.props?.placeholder).toBe('Ask about Brief…');
  });
  it('passes a new thread to the host without displaying an older conversation', async () => {
    dispatch(transactions.startNewChat, undefined); show(); await settle();
    expect(host.props?.conversationId).toBeNull();
    expect(host.props?.resolving).toBe(false);
  });
  it('does not fetch messages through the obsolete summary renderer', async () => {
    const { web } = show(); await settle();
    expect(web.requests.some(request => request.url.includes('/messages'))).toBe(false);
  });
  it('uses dense context beside a settings screen without changing the selected agent', async () => {
    dispatch(transactions.selectAgent, { id: 'p-imago', title: 'Imago' });
    const { container } = show('/d1/settings/general'); await settle();
    expect(container.querySelector('aside[aria-label="Imago"]')?.getAttribute('data-density')).toBe('dense');
    expect(host.props?.agentId).toBe('p-imago');
  });

  it('is roomy on the settings nav alone, where Imago is the ground', async () => {
    const { container } = show('/d1/settings'); await settle();
    expect(container.querySelector('aside[aria-label="Imago"]')?.getAttribute('data-density')).toBe('roomy');
  });
});

const radio = (container: HTMLElement, title: string): HTMLButtonElement => {
  const row = [...container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Agent"] [role="radio"]')].find((entry) => entry.textContent?.startsWith(title));
  if (row === undefined) throw new Error(`no ${title} row`);
  return row;
};
const summary = (container: HTMLElement) => container.querySelector('aside > header summary')?.getAttribute('aria-label');

it.each([
  ['support', 'Support', 'Support'],
  [null, undefined, 'Imago'],
] as const)('names the retained %s session and lets Imago clear it', async (id, agentTitle, shown) => {
  useRetainedChatSelection.getState().select({ sessionId: 'w1', conversationId: 's1', agentId: id, agentTitle, driveId: 'd1', isReadOnly: false });
  const { container } = show('/d1/agents'); await settle();
  expect(summary(container)).toBe(`Choose agent: ${shown}`);
  // The retained global session IS Imago: its row is the checked one, never a second "Chosen" Imago.
  expect(radio(container, shown).getAttribute('aria-checked')).toBe('true');
  expect(container.querySelectorAll('[role="radio"]').length).toBe(container.querySelectorAll('[role="radio"][aria-checked]').length);
  await act(async () => { radio(container, 'Imago').click(); });
  await settle();
  expect(useRetainedChatSelection.getState().selection).toBeNull();
  expect(getUiState().resources.chatAgent).toBeNull();
  expect(summary(container)).toBe('Choose agent: Imago');
  expect(radio(container, 'Imago').getAttribute('aria-checked')).toBe('true');
});

describe('the agent picker in the head', () => {
  function withAgents() {
    const web = fakeWeb({
      [`GET ${chatPaths.builtinAgents}`]: () => Response.json(pointers()),
      [`GET ${chatPaths.conversations('p-imago', 0)}`]: () => Response.json(conversationsPage([agentConversation('c1')])),
      [`GET ${chatPaths.conversations('a1', 0)}`]: () => Response.json(conversationsPage([agentConversation('k1')])),
      [`GET ${chatPaths.driveAgents('d1')}`]: () => Response.json(driveAgentsBody([{ id: 'a1', title: 'Launch Agent', aiModel: 'claude-sonnet-5-5', parentId: 'f-launch' }])),
    });
    return mount(<ImagoSWRProvider client={web.client}><ChatPane stage={stageFor('/d1')} driveName="Alpha" homeDriveId="d1" /></ImagoSWRProvider>);
  }

  it('offers Imago with its Model section, then the drive’s agents, and switches agent', async () => {
    const container = withAgents(); await settle();
    const groups = [...container.querySelectorAll('[role="radiogroup"] [role="radio"]')].map((row) => row.textContent);
    expect(groups).toEqual(['ImagoGlobal · your chosen modelActive', 'Launch Agentclaude-sonnet-5-5 · Launch']);
    expect(container.textContent).toContain('Agents in Alpha');
    expect(container.querySelector('[data-model-selector]')).not.toBeNull();
    expect(container.querySelector('a[href="/d1/agents"]')?.textContent).toBe('All agents');
    await act(async () => { radio(container, 'Launch Agent').click(); });
    await settle();
    expect(getUiState().resources.chatAgent).toEqual({ id: 'a1', title: 'Launch Agent' });
    expect(summary(container)).toBe('Choose agent: Launch Agent');
    expect(host.props?.agentId).toBe('a1');
    expect(container.querySelector('[data-model-selector]')).toBeNull();
  });
});

describe('History and New chat in the head', () => {
  it('toggles the History view and opens a new chat, clearing a retained session', async () => {
    const { container } = show(); await settle();
    const history = container.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]')!;
    expect(history.getAttribute('aria-pressed')).toBe('false');
    click(history);
    expect(getUiState().resources.chatView).toBe('history');
    expect(container.querySelector('button[aria-label="Chat history"]')?.getAttribute('aria-pressed')).toBe('true');
    useRetainedChatSelection.getState().select({ sessionId: 'w1', conversationId: 's1', agentId: 'support', agentTitle: 'Support', driveId: 'd1', isReadOnly: false });
    click(container.querySelector<HTMLButtonElement>('button[aria-label="New chat"]')!);
    await settle();
    expect(useRetainedChatSelection.getState().selection).toBeNull();
    expect(getUiState().resources).toMatchObject({ chatNew: true, chatConversationId: null, chatView: 'thread' });
    expect(host.props?.conversationId).toBeNull();
  });

  it('names no context on the chat home and the section on a list', async () => {
    const home = show('/d1').container; await settle();
    const files = show('/d1/files').container; await settle();
    expect(home.querySelector('aside > header > span:not(.flex-1)')).toBeNull();
    expect(files.querySelector('aside > header > span:not(.flex-1)')?.textContent).toBe('Files');
  });
});

it('the header names the active conversation source rather than the open route drive', async () => {
  useSpendContextStore.getState().register('focused-other', { conversationId: 'c-other', driveId: 'd-other', isGlobal: false });
  const { container } = show('/d1'); await settle();
  const chip = container.querySelector('aside > header [data-testid="spend-source-chip"]');
  expect(chip).not.toBeNull();
  expect(sourceRead).toHaveBeenCalledWith('c-other', { driveId: 'd-other', isGlobal: false });
});
