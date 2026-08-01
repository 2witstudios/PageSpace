import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConversations } from '../useConversations';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/ai/core/browser-session-id', () => ({ getBrowserSessionId: () => 'sess-1' }));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const mockFetchWithAuth = fetchWithAuth as unknown as ReturnType<typeof vi.fn>;

describe('useConversations createConversation', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
  });

  it('given createConversation is called, should invoke onConversationCreate synchronously with a client-generated id before the create request resolves', async () => {
    let resolveFetch!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    mockFetchWithAuth.mockReturnValue(pending);

    const onConversationCreate = vi.fn();
    const { result } = renderHook(() =>
      useConversations({
        agentId: 'agent-1',
        currentConversationId: null,
        enabled: false,
        onConversationCreate,
      })
    );

    let createPromise!: Promise<string | null>;
    act(() => {
      createPromise = result.current.createConversation();
    });

    // Must fire before the network request resolves — this is the whole point.
    expect(onConversationCreate).toHaveBeenCalledTimes(1);
    const generatedId = onConversationCreate.mock.calls[0][0] as string;
    expect(typeof generatedId).toBe('string');
    expect(generatedId.length).toBeGreaterThan(0);

    resolveFetch({ ok: true, json: async () => ({ conversationId: generatedId }) });
    const resolvedId = await act(() => createPromise);
    expect(resolvedId).toBe(generatedId);
  });

  it('given createConversation is called twice back to back, should generate distinct ids without waiting on the network', () => {
    mockFetchWithAuth.mockReturnValue(new Promise(() => {}));
    const onConversationCreate = vi.fn();
    const { result } = renderHook(() =>
      useConversations({
        agentId: 'agent-1',
        currentConversationId: null,
        enabled: false,
        onConversationCreate,
      })
    );

    act(() => {
      void result.current.createConversation();
      void result.current.createConversation();
    });

    expect(onConversationCreate).toHaveBeenCalledTimes(2);
    const firstId = onConversationCreate.mock.calls[0][0];
    const secondId = onConversationCreate.mock.calls[1][0];
    expect(firstId).not.toBe(secondId);
  });

  it('given the create request ultimately fails, should not retract the already-issued id (no rollback of identity)', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: false });
    const onConversationCreate = vi.fn();
    const { result } = renderHook(() =>
      useConversations({
        agentId: 'agent-1',
        currentConversationId: null,
        enabled: false,
        onConversationCreate,
      })
    );

    let createPromise!: Promise<string | null>;
    act(() => {
      createPromise = result.current.createConversation();
    });
    const issuedId = onConversationCreate.mock.calls[0][0];

    const resolvedId = await act(() => createPromise);
    expect(resolvedId).toBe(issuedId);
    expect(onConversationCreate).toHaveBeenCalledTimes(1);
  });

  describe('global mode (agentId: null)', () => {
    it('given the create POST resolves, should adopt the server-returned id, not a client-generated one — /api/ai/global does not honor a client-supplied id', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: async () => ({ conversationId: 'server-minted-id' }),
      });

      const onConversationCreate = vi.fn();
      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
          enabled: false,
          onConversationCreate,
        })
      );

      const resolvedId = await act(() => result.current.createConversation());

      expect(resolvedId).toBe('server-minted-id');
      expect(onConversationCreate).toHaveBeenCalledWith('server-minted-id');
      expect(onConversationCreate).toHaveBeenCalledTimes(1);

      const [, requestInit] = mockFetchWithAuth.mock.calls[0];
      const body = JSON.parse((requestInit as RequestInit).body as string);
      expect(body).not.toHaveProperty('conversationId');
    });

    it('given the create POST fails, should return null and not call onConversationCreate', async () => {
      mockFetchWithAuth.mockResolvedValue({ ok: false });
      const onConversationCreate = vi.fn();
      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
          enabled: false,
          onConversationCreate,
        })
      );

      const resolvedId = await act(() => result.current.createConversation());

      expect(resolvedId).toBeNull();
      expect(onConversationCreate).not.toHaveBeenCalled();
    });
  });
});

// A caller reacting to the deletion (resetting UI bound to this
// conversationId) needs to tell success from failure — the previous version
// resolved regardless of outcome, with no signal either way (review finding
// — chatgpt-codex-connector and coderabbitai on PR #2299).
describe('useConversations deleteConversation', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
  });

  it('given the DELETE succeeds, resolves true and notifies the parent', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: true });
    const onConversationDelete = vi.fn();
    const { result } = renderHook(() =>
      useConversations({
        agentId: 'agent-1',
        currentConversationId: 'conv-1',
        enabled: false,
        onConversationDelete,
      })
    );

    const succeeded = await act(() => result.current.deleteConversation('conv-1'));

    expect(succeeded).toBe(true);
    expect(onConversationDelete).toHaveBeenCalledWith('conv-1');
  });

  it('given the DELETE is refused (e.g. a 409), resolves false, surfaces the server-provided reason, and does NOT notify the parent', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'This is the only open conversation in its session.' }),
    });
    const onConversationDelete = vi.fn();
    const { result } = renderHook(() =>
      useConversations({
        agentId: 'agent-1',
        currentConversationId: 'conv-1',
        enabled: false,
        onConversationDelete,
      })
    );

    const { toast } = await import('sonner');
    const succeeded = await act(() => result.current.deleteConversation('conv-1'));

    expect(succeeded).toBe(false);
    expect(onConversationDelete).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('This is the only open conversation in its session.');
  });

  it('given the DELETE request throws (network failure), resolves false and does NOT notify the parent', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('network down'));
    const onConversationDelete = vi.fn();
    const { result } = renderHook(() =>
      useConversations({
        agentId: 'agent-1',
        currentConversationId: 'conv-1',
        enabled: false,
        onConversationDelete,
      })
    );

    const succeeded = await act(() => result.current.deleteConversation('conv-1'));

    expect(succeeded).toBe(false);
    expect(onConversationDelete).not.toHaveBeenCalled();
  });
});
