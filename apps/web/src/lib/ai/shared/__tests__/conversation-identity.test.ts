/**
 * Tests for the pure conversation-identity state machine.
 * RITE tests: Readable, Isolated, Thorough, Explicit.
 */

import { describe, it, expect } from 'vitest';
import {
  conversationIdentityReducer,
  canSend,
  type ConversationIdentityState,
} from '../conversation-identity';

describe('conversationIdentityReducer', () => {
  it('given idle state and RESOLVE_STARTED, should transition to resolving', () => {
    const result = conversationIdentityReducer({ status: 'idle' }, { type: 'RESOLVE_STARTED' });
    expect(result).toEqual({ status: 'resolving' });
  });

  it('given resolving state and RESOLVED, should transition to ready with the resolved id', () => {
    const result = conversationIdentityReducer(
      { status: 'resolving' },
      { type: 'RESOLVED', conversationId: 'conv-1' }
    );
    expect(result).toEqual({ status: 'ready', conversationId: 'conv-1' });
  });

  it('given resolving state and RESOLVE_FAILED, should transition to error', () => {
    const result = conversationIdentityReducer(
      { status: 'resolving' },
      { type: 'RESOLVE_FAILED', message: 'network error' }
    );
    expect(result).toEqual({ status: 'error', message: 'network error' });
  });

  it('given error state and RETRY, should transition back to resolving', () => {
    const result = conversationIdentityReducer(
      { status: 'error', message: 'network error' },
      { type: 'RETRY' }
    );
    expect(result).toEqual({ status: 'resolving' });
  });

  it('given a non-error state and RETRY, should be a no-op (illegal transition)', () => {
    const state: ConversationIdentityState = { status: 'ready', conversationId: 'conv-1' };
    const result = conversationIdentityReducer(state, { type: 'RETRY' });
    expect(result).toEqual(state);
  });

  it('given idle state and RESOLVED (no matching RESOLVE_STARTED), should be a no-op', () => {
    const state: ConversationIdentityState = { status: 'idle' };
    const result = conversationIdentityReducer(state, { type: 'RESOLVED', conversationId: 'conv-1' });
    expect(result).toEqual(state);
  });

  describe('IDENTITY_SET (client-generated create, or select-existing) — always legal', () => {
    const cases: Array<[string, ConversationIdentityState]> = [
      ['idle', { status: 'idle' }],
      ['resolving', { status: 'resolving' }],
      ['ready(otherId)', { status: 'ready', conversationId: 'other-conv' }],
      ['error', { status: 'error', message: 'oops' }],
    ];

    for (const [label, state] of cases) {
      it(`given ${label} state, should transition straight to ready with the new id`, () => {
        const result = conversationIdentityReducer(state, {
          type: 'IDENTITY_SET',
          conversationId: 'new-conv',
        });
        expect(result).toEqual({ status: 'ready', conversationId: 'new-conv' });
      });
    }
  });

  describe('stale async responses must not clobber a newer identity', () => {
    it('given ready(id) reached via IDENTITY_SET, a late RESOLVED from a prior resolve should be ignored', () => {
      const readyState: ConversationIdentityState = { status: 'ready', conversationId: 'new-conv' };
      const result = conversationIdentityReducer(readyState, {
        type: 'RESOLVED',
        conversationId: 'stale-conv',
      });
      expect(result).toEqual(readyState);
    });

    it('given ready(id) reached via IDENTITY_SET, a late RESOLVE_FAILED from a prior resolve should be ignored', () => {
      const readyState: ConversationIdentityState = { status: 'ready', conversationId: 'new-conv' };
      const result = conversationIdentityReducer(readyState, {
        type: 'RESOLVE_FAILED',
        message: 'stale failure',
      });
      expect(result).toEqual(readyState);
    });

    it('given ready(id), a duplicate RESOLVE_STARTED should be a no-op, not restart resolution', () => {
      const readyState: ConversationIdentityState = { status: 'ready', conversationId: 'conv-1' };
      const result = conversationIdentityReducer(readyState, { type: 'RESOLVE_STARTED' });
      expect(result).toEqual(readyState);
    });
  });

  it('given the same state and action, should produce equal output on every call (purity)', () => {
    const state: ConversationIdentityState = { status: 'resolving' };
    const action = { type: 'RESOLVED' as const, conversationId: 'conv-1' };
    const a = conversationIdentityReducer(state, action);
    const b = conversationIdentityReducer(state, action);
    expect(a).toEqual(b);
  });

  it('given a frozen input state, should not mutate it', () => {
    const state = Object.freeze({ status: 'resolving' as const });
    expect(() => conversationIdentityReducer(state, { type: 'RESOLVED', conversationId: 'conv-1' })).not.toThrow();
    expect(state).toEqual({ status: 'resolving' });
  });
});

describe('canSend', () => {
  it('given a ready state, should return true', () => {
    expect(canSend({ status: 'ready', conversationId: 'conv-1' })).toBe(true);
  });

  it('given an idle state, should return false', () => {
    expect(canSend({ status: 'idle' })).toBe(false);
  });

  it('given a resolving state, should return false', () => {
    expect(canSend({ status: 'resolving' })).toBe(false);
  });

  it('given an error state, should return false', () => {
    expect(canSend({ status: 'error', message: 'oops' })).toBe(false);
  });
});
