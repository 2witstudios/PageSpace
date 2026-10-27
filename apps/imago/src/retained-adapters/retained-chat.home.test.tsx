// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { createInitialState } from '@/ui/store/state';
import { getUiState, setUiState } from '@/ui/store/store';
import { useRetainedChatSelection } from './session-selection';
import type { ComposedLine } from '@pagespace/lib/home-signals/composer';

const home = vi.hoisted(() => ({
  line: {
    greeting: 'Good morning, Jono.',
    lead: '2 mentions waiting',
    rest: ['1 task overdue'],
    icon: 'at',
    suggestions: ['Show my mentions', 'Plan today', 'Draft a page'],
    leadHref: null,
  } as ComposedLine,
}));

vi.mock('@/retained/hooks/useHomeSignals', () => ({ useHomeSignals: () => ({ line: home.line, isLoading: false }) }));
vi.mock('@/retained/hooks/usePermissions', () => ({ usePermissions: () => ({ permissions: { canEdit: true } }) }));
// JOURNEYS-2's first-send readiness reads the drive's spend preview; the shell fixtures test
// the home chrome, so hand them the resolved preview (the normal state).
vi.mock('@/retained/hooks/useConversationSpend', () => ({
  useConversationSpend: () => ({ spend: null, isPending: false, error: null, isLoading: false, choose: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined) }),
  useDriveSpend: () => ({ spend: { driveId: 'd1', options: [], resolved: { kind: 'spend', source: 'drive_wallet', walletId: 'w-d1' } }, isPending: false, error: null, isLoading: false, refresh: vi.fn(async () => undefined) }),
}));
vi.mock('@/retained/components/ai/shared/chat/ChatMessagesArea', () => ({ ChatMessagesArea: () => <div data-empty-messages="" /> }));
vi.mock('./retained-provider', () => ({ RetainedSurface: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./chat-attachments', () => ({ useChatAttachments: () => ({ attachments: [], getFilesForSend: () => [], addFiles: vi.fn(), removeFile: vi.fn() }) }));
vi.mock('@/retained/components/ai/chat/input', () => ({ ChatInput: () => <textarea data-composer="" /> }));
vi.mock('@/retained/components/agents/chat/SessionChat', () => ({ default: () => <div data-session="" /> }));
vi.mock('@/retained/components/agents/chat/AssistantSessionChat', () => ({ default: () => <div data-global-assistant="" /> }));
const { RetainedChat } = await import('./retained-chat');

beforeEach(() => { setUiState(createInitialState()); useRetainedChatSelection.getState().select(null); });
afterEach(unmountAll);

const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };

function show(props: { home?: boolean; conversationId: string | null }) {
  const web = fakeWeb({ 'GET /api/pages/a1': () => Response.json({ id: 'a1', title: 'Support', driveId: 'd1', aiModel: '' }) });
  return mount(<ImagoSWRProvider client={web.client}>
    <RetainedChat agentId="a1" name="Support" resolving={false} {...props} />
  </ImagoSWRProvider>);
}

it('shows the greeting, Home line and suggestions for a home with a new empty conversation', async () => {
  const container = show({ home: true, conversationId: null }); await settle();
  expect(container.textContent).toContain('Good morning, Jono.');
  expect(container.textContent).toContain('2 mentions waiting');
  expect(container.textContent).toContain('Show my mentions');
  expect(container.querySelectorAll('button')).toHaveLength(3);
});

it('does not show the welcome without home mode', async () => {
  const container = show({ conversationId: null }); await settle();
  expect(container.textContent).not.toContain('Good morning, Jono.');
  expect(container.querySelector('[data-empty-messages]')).not.toBeNull();
});

it('does not show the welcome for a home that already has a conversation', async () => {
  const container = show({ home: true, conversationId: 'c1' }); await settle();
  expect(container.textContent).not.toContain('Good morning, Jono.');
  expect(container.querySelector('[data-session]')).not.toBeNull();
});

it('fills the composer draft when a suggestion is picked without sending', async () => {
  const container = show({ home: true, conversationId: null }); await settle();
  const suggestion = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Plan today')!;
  act(() => { suggestion.click(); });
  expect(getUiState().resources.chatDraft).toBe('Plan today');
});
