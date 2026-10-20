// @vitest-environment jsdom
import '@/retained/test/setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const server = vi.hoisted(() => ({ pending: new Map<string, (value: string | null) => void>() }));
vi.mock('@/retained/lib/draft/draft.io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/retained/lib/draft/draft.io')>()),
  fetchDraft: vi.fn((key: string) => new Promise<string | null>((resolve) => server.pending.set(key, resolve))),
  saveDraft: vi.fn(async () => {}),
  deleteDraft: vi.fn(async () => {}),
}));

const { useDraft } = await import('./useDraft');

const answer = async (key: string, value: string | null) => {
  await act(async () => server.pending.get(key)?.(value));
};

beforeEach(() => {
  localStorage.clear();
  server.pending.clear();
});

describe('useDraft', () => {
  it('fills an empty draft from the server', async () => {
    const { result } = renderHook(() => useDraft('ai:c1'));
    await answer('ai:c1', 'from another device');
    expect(result.current.draft).toBe('from another device');
  });

  it("drops a late server draft for a key it has moved off, instead of filling the new key's composer", async () => {
    const { result, rerender } = renderHook(({ key }) => useDraft(key), { initialProps: { key: 'ai:c1' } });
    rerender({ key: 'ai:c2' });
    await answer('ai:c1', 'meant for the first conversation');
    expect(result.current.draft).toBe('');
  });

  it('does not restore the server draft after the draft was sent (cleared) before the read came back', async () => {
    const { result } = renderHook(() => useDraft('ai:c1'));
    act(() => result.current.setDraft('typed'));
    act(() => result.current.setDraft(''));
    await answer('ai:c1', 'typed');
    expect(result.current.draft).toBe('');
  });

  it('takes an updater, applied to the latest draft', () => {
    const { result } = renderHook(() => useDraft('ai:c1'));
    act(() => result.current.setDraft('hello'));
    act(() => result.current.setDraft((current) => `${current} world`));
    expect(result.current.draft).toBe('hello world');
  });
});
