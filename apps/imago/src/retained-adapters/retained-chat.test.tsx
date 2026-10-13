// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { createInitialState } from '@/ui/store/state';
import { getUiState, setUiState, useUiState } from '@/ui/store/store';
import { dispatch, transactions } from '@/ui/store/transactions';
import { useRetainedChatSelection } from './session-selection';
import type { SessionChatProps } from '@/retained/components/agents/chat/SessionChat';
import type { ChatInputProps } from '@/retained/components/ai/chat/input/ChatInput';

const boundary = vi.hoisted(() => ({ canEdit: true, session: null as SessionChatProps | null }));
vi.mock('@/retained/hooks/usePermissions', () => ({ usePermissions: () => ({ permissions: { canEdit: boundary.canEdit } }) }));
vi.mock('@/retained/components/ai/shared/chat/ChatMessagesArea', () => ({ ChatMessagesArea: () => <div data-empty-messages="" /> }));
vi.mock('./retained-provider', () => ({ RetainedSurface: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./chat-attachments', () => ({ useChatAttachments: () => ({ attachments: [], getFilesForSend: () => [], addFiles: vi.fn(), removeFile: vi.fn() }) }));
vi.mock('@/retained/components/ai/chat/input', () => ({ ChatInput: (props: ChatInputProps) => <><textarea aria-label={props.inputLabel} value={props.value} disabled={props.disabled} onChange={event => props.onChange(event.target.value)} /><button disabled={props.disabled} onClick={props.onSend}>Send</button></> }));
vi.mock('@/retained/components/agents/chat/SessionChat', () => ({ default: (props: SessionChatProps) => { boundary.session = props; return <div data-conversation={props.conversationId} />; } }));
vi.mock('@/retained/components/agents/chat/AssistantSessionChat', () => ({ default: () => <div data-global-assistant="" /> }));
vi.mock('@/ui/chat/spend-strip/spend-strip', () => ({ SpendStrip: (props: { conversationId: string | null; driveId: string | null; onChooseDraftSource?: (walletId: string) => Promise<void> }) => <div data-spend-conversation={props.conversationId ?? 'new'} data-spend-drive={props.driveId ?? 'personal'}><button type="button" data-start-wallet="" disabled={!props.onChooseDraftSource} onClick={() => void props.onChooseDraftSource?.('own')}>Change source</button></div> }));
const { RetainedChat } = await import('./retained-chat');

beforeEach(() => { setUiState(createInitialState()); useRetainedChatSelection.getState().select(null); boundary.canEdit = true; boundary.session = null; });
afterEach(unmountAll);
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
function Host() {
  const conversationId = useUiState(state => state.resources.chatConversationId);
  return <RetainedChat agentId="a1" name="Support" conversationId={conversationId} resolving={false} />;
}
function show(create: FakeRoute = () => Response.json({ conversationId: 'created' })) {
  const web = fakeWeb({
    'GET /api/pages/a1': () => Response.json({ id: 'a1', title: 'Support', driveId: 'd1', aiModel: '' }),
    'POST /api/ai/page-agents/a1/conversations': create,
    'PUT /api/wallets/conversations/created': () => Response.json({ conversationId: 'created', driveId: 'd1', chosenWalletId: 'own', options: [], resolved: { kind: 'spend', source: 'own_credits', walletId: 'own', fallbackApplied: false, fallbackFrom: null } }),
  });
  const container = mount(<ImagoSWRProvider client={web.client}><Host /></ImagoSWRProvider>);
  return { container, web };
}
function send(container: HTMLElement, text: string) {
  act(() => { dispatch(transactions.setChatDraft, text); });
  act(() => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Send')!.click(); });
}

it('names the first-message composer after the agent, as the session composer is', async () => {
  const { container } = show(); await settle();
  expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe('Message Support');
});

it('opening, typing and reopening a new draft never creates a conversation', async () => {
  const { web } = show(); await settle();
  act(() => { dispatch(transactions.setChatDraft, 'Unsent'); dispatch(transactions.startNewChat, undefined); });
  await settle();
  expect(getUiState().resources.chatDraft).toBe('Unsent');
  expect(web.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  expect(boundary.session).toBeNull();
});

it('creates on the first send and hands its content to the existing session pipeline', async () => {
  const { container, web } = show(); await settle();
  send(container, 'First real turn'); await settle();
  expect(web.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  expect(boundary.session).toMatchObject({ conversationId: 'created', initialSend: { text: 'First real turn' } });
  expect(getUiState().resources.chatDraft).toBe('');
  act(() => boundary.session?.onInitialSend?.(true));
  await settle();
  expect(boundary.session?.initialSend).toBeUndefined();
});

it('restores the draft when conversation creation is refused and allows a real retry', async () => {
  let refuse = true;
  const { container, web } = show(() => refuse ? Response.json({ error: 'refused' }, { status: 403 }) : Response.json({ conversationId: 'retry' }));
  await settle(); send(container, 'Keep this draft'); await settle();
  expect(getUiState().resources.chatDraft).toBe('Keep this draft');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Try sending again');
  refuse = false; send(container, 'Keep this draft'); await settle();
  expect(boundary.session?.conversationId).toBe('retry');
  expect(web.requests.filter(request => request.method === 'POST')).toHaveLength(2);
  act(() => boundary.session?.onInitialSend?.(false));
  expect(getUiState().resources.chatDraft).toBe('Keep this draft');
});

it('does not create through read-only controls', async () => {
  boundary.canEdit = false;
  const { container, web } = show(); await settle(); send(container, 'Refused'); await settle();
  expect(container.querySelector('textarea')?.disabled).toBe(true);
  expect(web.requests.filter(request => request.method === 'POST')).toHaveLength(0);
});

it('deduplicates a pending first send and recovers its draft if the selection changes', async () => {
  let release: (response: Response) => void = () => {};
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const { container, web } = show(() => pending); await settle(); send(container, 'Pending'); await settle();
  act(() => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Send')!.click(); });
  expect(web.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  act(() => useRetainedChatSelection.getState().select({ sessionId: 'w1', conversationId: 'global', agentId: null, driveId: null, isReadOnly: false }));
  release(Response.json({ conversationId: 'created' })); await settle();
  expect(getUiState().resources.chatDraft).toBe('Pending');
  expect(container.querySelector('[data-global-assistant]')).not.toBeNull();
  expect(boundary.session).toBeNull();
});

const agentPage = (id: string, title: string) => () => Response.json({ id, title, driveId: 'd1', aiModel: '' });

function showWith(props: Partial<Parameters<typeof RetainedChat>[0]>, routes: Record<string, FakeRoute> = {}) {
  const web = fakeWeb({ 'GET /api/pages/a1': agentPage('a1', 'Support'), ...routes });
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RetainedChat agentId="a1" name="Support" conversationId={null} resolving={false} {...props} />
    </ImagoSWRProvider>,
  );
  return { container, web };
}

it('offers a retry when the agent page cannot be loaded', async () => {
  let fail = true;
  const { container } = showWith({}, { 'GET /api/pages/a1': () => (fail ? Response.json({ error: 'down' }, { status: 500 }) : Response.json({ id: 'a1', title: 'Support', driveId: 'd1', aiModel: '' })) });
  await settle(); await settle();
  expect(container.textContent).toContain('Could not open this chat');
  fail = false;
  const retry = [...container.querySelectorAll('button')].find(button => /retry|try again/i.test(button.textContent ?? ''));
  expect(retry).toBeDefined();
  act(() => retry?.click());
  await settle();
  expect(container.querySelector('textarea')).not.toBeNull();
});

it('shows the opening state while the conversation is still resolving', async () => {
  const { container } = showWith({ resolving: true });
  await settle();
  expect(container.textContent).toContain('Opening chat');
  expect(container.querySelector('textarea')).toBeNull();
});

it('shows the opening state while there is no agent to load', async () => {
  const { container } = showWith({ agentId: null });
  await settle();
  expect(container.textContent).toContain('Opening chat');
});

it('an empty draft is never sent', async () => {
  const { container, web } = show(); await settle();
  send(container, '   '); await settle();
  expect(web.requests.filter(request => request.method === 'POST')).toHaveLength(0);
});

it('an isolated chat ignores the shared selection and stays on its own agent', async () => {
  act(() => useRetainedChatSelection.getState().select({ sessionId: 's9', conversationId: 'other', agentId: 'a2', driveId: 'd1', isReadOnly: true }));
  const { container } = showWith({ isolated: true, conversationId: 'mine' });
  await settle();
  expect(container.querySelector('[data-conversation="mine"]')).not.toBeNull();
  expect(boundary.session).toMatchObject({ conversationId: 'mine', isReadOnly: false });
  expect(boundary.session?.agent.id).toBe('a1');
});

it('a selected conversation on another agent opens read-only as the selection says, titled by that agent', async () => {
  act(() => useRetainedChatSelection.getState().select({ sessionId: 's9', conversationId: 'c9', agentId: 'a2', driveId: 'd1', isReadOnly: true }));
  const { container } = showWith({}, { 'GET /api/pages/a2': agentPage('a2', 'Billing bot') });
  await settle();
  expect(container.querySelector('[data-conversation="c9"]')).not.toBeNull();
  expect(boundary.session).toMatchObject({ conversationId: 'c9', sessionId: 's9', isReadOnly: true });
  expect(boundary.session?.agent).toMatchObject({ id: 'a2', title: 'Billing bot' });
  expect(boundary.session?.initialSend).toBeUndefined();
});

it('without permission to edit, an open conversation is read-only', async () => {
  boundary.canEdit = false;
  showWith({ conversationId: 'c1' });
  await settle();
  expect(boundary.session?.isReadOnly).toBe(true);
});

it('passes the host composer settings to the open conversation', async () => {
  showWith({ conversationId: 'c1', placeholder: 'Ask about this page…', ownsCreditsAlert: true });
  await settle();
  expect(boundary.session?.imagoComposer).toMatchObject({ placeholder: 'Ask about this page…', ownsCreditsAlert: true });
});

it('the first-message spend preview follows the selected agent drive', async () => {
  const { container } = show(); await settle();
  expect(container.querySelector('[data-spend-drive]')?.getAttribute('data-spend-drive')).toBe('d1');
  expect(container.querySelector('[data-spend-conversation]')?.getAttribute('data-spend-conversation')).toBe('new');
});

it('choosing a wallet explicitly materializes an empty agent conversation before the first message', async () => {
  const { container, web } = show(); await settle();
  act(() => { container.querySelector<HTMLButtonElement>('[data-start-wallet]')!.click(); });
  await settle();
  expect(web.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  expect(web.writes().map(request => [request.method, request.url, request.body])).toEqual([['POST', '/api/ai/page-agents/a1/conversations', { walletId: 'own' }]]);
  expect(boundary.session?.conversationId).toBe('created');
  expect(boundary.session?.initialSend).toBeUndefined();
  expect(getUiState().resources.chatDraft).toBe('');
});
