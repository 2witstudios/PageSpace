import { describe, test, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { assert } from './riteway';
import { useEditingStore } from '../useEditingStore';
import { useEditingSession } from '../useEditingSession';

beforeEach(() => {
  useEditingStore.getState().clearAllSessions();
});

const sessionSummary = () =>
  useEditingStore
    .getState()
    .getActiveSessions()
    .map((s) => ({ id: s.id, type: s.type, metadata: s.metadata }));

describe('useEditingSession', () => {
  test('active=true on mount registers session', () => {
    renderHook(() => useEditingSession('sess-1', true));
    assert({
      given: 'active=true on mount',
      should: 'register a session with the supplied id and default type=form',
      actual: sessionSummary(),
      expected: [{ id: 'sess-1', type: 'form', metadata: {} }],
    });
  });

  test('unmount with active=true clears the session', () => {
    const { unmount } = renderHook(() => useEditingSession('sess-1', true));
    unmount();
    assert({
      given: 'unmount while active=true',
      should: 'clear the session',
      actual: sessionSummary(),
      expected: [],
    });
  });

  test('active flipping true to false clears the session', () => {
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useEditingSession('sess-1', active),
      { initialProps: { active: true } },
    );
    assert({
      given: 'active=true on mount',
      should: 'register the session',
      actual: sessionSummary().map((s) => s.id),
      expected: ['sess-1'],
    });
    rerender({ active: false });
    assert({
      given: 'active flipped to false',
      should: 'clear the session',
      actual: sessionSummary(),
      expected: [],
    });
  });

  test('active=false on mount does not register', () => {
    renderHook(() => useEditingSession('sess-1', false));
    assert({
      given: 'active=false on mount',
      should: 'not register any session',
      actual: sessionSummary(),
      expected: [],
    });
  });

  test('metadata is forwarded to the store', () => {
    renderHook(() =>
      useEditingSession('sess-1', true, 'form', {
        pageId: 'page-42',
        componentName: 'TaskAgentTriggersDialog',
      }),
    );
    assert({
      given: 'metadata with pageId and componentName',
      should: 'forward those fields verbatim into the registered session',
      actual: sessionSummary().map((s) => s.metadata),
      expected: [
        {
          pageId: 'page-42',
          componentName: 'TaskAgentTriggersDialog',
          conversationId: undefined,
        },
      ],
    });
  });

  test('non-default session type is honored', () => {
    renderHook(() => useEditingSession('sess-1', true, 'document'));
    assert({
      given: 'an explicit session type=document',
      should: 'register the session with that type',
      actual: sessionSummary().map((s) => s.type),
      expected: ['document'],
    });
  });
});
