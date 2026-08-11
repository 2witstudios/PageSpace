import { describe, expect, it } from 'vitest';
import { NO_REBIND_INTENT, rebindAction } from '../voice-rebind';
import type { VoiceBinding } from '../voice-binding';

/**
 * THE distinction the whole voice lifecycle turns on: navigating must not
 * rebind, switching agent must. Both look identical in the derived target, so
 * every case below is really one question — did the user ASK for this?
 */

const ready = (agentPageId: string | null, conversationId: string): VoiceBinding =>
  agentPageId === null
    ? {
        kind: 'ready',
        surface: 'sidebar',
        target: { conversationId, type: 'global' },
      }
    : {
        kind: 'ready',
        surface: 'sidebar',
        target: {
          conversationId,
          type: 'page',
          contextId: agentPageId,
          agentPageId,
        },
      };

const resolving: VoiceBinding = { kind: 'resolving', surface: 'sidebar' };

describe('rebindAction — navigating vs switching', () => {
  it('should do NOTHING when no switch was made, however the target changed', () => {
    // This is navigation: the derived binding moved from one agent to another
    // because the user walked to a different surface. No intent was recorded,
    // so nothing happens — which is the entire reason the intent exists.
    expect(rebindAction(NO_REBIND_INTENT, ready('agent-b', 'conv-b'), true)).toEqual({
      kind: 'wait',
    });
  });

  it('should rebind to the chosen agent once its conversation has resolved', () => {
    const intent = { kind: 'pending' as const, agentPageId: 'agent-b' };

    expect(rebindAction(intent, ready('agent-b', 'conv-b'), true)).toEqual({
      kind: 'rebind',
      target: {
        conversationId: 'conv-b',
        type: 'page',
        contextId: 'agent-b',
        agentPageId: 'agent-b',
      },
    });
  });

  it('should WAIT while the chosen agent\'s conversation is still being resolved', () => {
    // `selectAgent` clears the conversation id first. Acting now would bind to
    // nothing; guessing would bind to the wrong thread.
    expect(
      rebindAction({ kind: 'pending', agentPageId: 'agent-b' }, resolving, true),
    ).toEqual({ kind: 'wait' });
  });

  it('should WAIT rather than rebind when the surface is showing someone else', () => {
    // The user switched, then navigated before it resolved. Moving the call to
    // whoever happens to be on screen now is not what was asked for.
    expect(
      rebindAction({ kind: 'pending', agentPageId: 'agent-b' }, ready('agent-c', 'conv-c'), true),
    ).toEqual({ kind: 'wait' });
  });

  it('should treat the global assistant as a real destination, not as "no intent"', () => {
    // Switching AWAY from an agent, back to the global assistant, is a rebind
    // like any other. `null` here must not be read as "nothing was chosen".
    expect(
      rebindAction({ kind: 'pending', agentPageId: null }, ready(null, 'conv-global'), true),
    ).toEqual({
      kind: 'rebind',
      target: { conversationId: 'conv-global', type: 'global' },
    });
  });

  it('should drop the intent when no call is live', () => {
    // Switching agent with nothing running is just switching agent. Holding the
    // intent would make the NEXT press of the trigger — possibly minutes later,
    // possibly after more switches — behave as a rebind of something it never
    // asked about.
    expect(
      rebindAction({ kind: 'pending', agentPageId: 'agent-b' }, ready('agent-b', 'conv-b'), false),
    ).toEqual({ kind: 'clear' });
  });

  it('should not clear an intent that does not exist', () => {
    expect(rebindAction(NO_REBIND_INTENT, resolving, false)).toEqual({ kind: 'wait' });
  });
});
