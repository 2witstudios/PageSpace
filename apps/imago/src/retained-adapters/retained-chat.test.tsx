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
vi.mock('@/retained/components/ai/chat/input', () => ({ ChatInput: (props: ChatInputProps) => <><textarea value={props.value} disabled={props.disabled} onChange={event => props.onChange(event.target.value)} /><button disabled={props.disabled} onClick={props.onSend}>Send</button></> }));
vi.mock('@/retained/components/agents/chat/SessionChat', () => ({ default: (props: SessionChatProps) => { boundary.session = props; return <div data-conversation={props.conversationId} />; } }));
vi.mock('@/retained/components/agents/chat/AssistantSessionChat', () => ({ default: () => <div data-global-assistant="" /> }));
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
  });
  const container = mount(<ImagoSWRProvider client={web.client}><Host /></ImagoSWRProvider>);
  return { container, web };
}
function send(container: HTMLElement, text: string) {
  act(() => { dispatch(transactions.setChatDraft, text); });
  act(() => { container.querySelector('button')!.click(); });
}

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
  act(() => { container.querySelector('button')!.click(); });
  expect(web.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  act(() => useRetainedChatSelection.getState().select({ sessionId: 'w1', conversationId: 'global', agentId: null, driveId: null, isReadOnly: false }));
  release(Response.json({ conversationId: 'created' })); await settle();
  expect(getUiState().resources.chatDraft).toBe('Pending');
  expect(container.querySelector('[data-global-assistant]')).not.toBeNull();
  expect(boundary.session).toBeNull();
});
