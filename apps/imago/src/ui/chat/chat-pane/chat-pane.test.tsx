// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '@/ui/test-support/dom';
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
const host = vi.hoisted(() => ({ props: null as { agentId: string | null; conversationId: string | null; resolving: boolean; name: string } | null }));
vi.mock('@/retained-adapters/retained-chat', () => ({ RetainedChat: (props: NonNullable<typeof host.props>) => { host.props = props; return <div data-retained-host="" />; } }));
const { ChatPane } = await import('./chat-pane');
beforeEach(() => { setUiState(createInitialState()); host.props = null; useRetainedChatSelection.getState().select(null); });
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
    expect(host.props).toMatchObject({ agentId: 'p-imago', conversationId: 'c1', name: 'Imago', resolving: false });
  });
  it('keeps explicit history selection and the draft through object navigation', async () => {
    dispatch(transactions.openConversation, 'c2'); dispatch(transactions.setChatDraft, 'Unsent draft');
    const { container } = show('/d1/files/p1'); await settle();
    expect(host.props?.conversationId).toBe('c2');
    expect(getUiState().resources.chatDraft).toBe('Unsent draft');
    expect(container.textContent).toContain('Brief in context');
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
  it('uses dense context for settings without changing the selected agent', async () => {
    dispatch(transactions.selectAgent, { id: 'p-imago', title: 'Imago' });
    const { container } = show('/d1/settings'); await settle();
    expect(container.querySelector('[aria-label="Chat"]')?.getAttribute('data-density')).toBe('dense');
    expect(host.props?.agentId).toBe('p-imago');
  });
});

it.each([
  ['support', 'Support'],
  [null, 'Global Assistant'],
] as const)('names the retained %s session and lets Imago clear it', async (id, title) => {
  useRetainedChatSelection.getState().select({ sessionId: 'w1', conversationId: 's1', agentId: id, agentTitle: title, driveId: 'd1', isReadOnly: false });
  const { container } = show('/d1/agents'); await settle();
  const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Agent"]')!;
  expect(picker.value).toBe(id ?? 'retained-global-assistant');
  expect(picker.selectedOptions[0].textContent).toBe(title);
  await act(async () => { picker.value = 'p-imago'; picker.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(useRetainedChatSelection.getState().selection).toBeNull();
  expect(picker.value).toBe('p-imago');
});
