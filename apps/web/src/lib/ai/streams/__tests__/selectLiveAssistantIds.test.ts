import { describe, it, expect } from 'vitest';
import { selectLiveAssistantIds } from '../selectLiveAssistantIds';

const user = (id: string) => ({ id, role: 'user' });
const assistant = (id: string) => ({ id, role: 'assistant' });

describe('selectLiveAssistantIds', () => {
  it('resolves each chat\'s live assistant id from its OWN status and messages', () => {
    expect(
      selectLiveAssistantIds({
        agent: { status: 'streaming', messages: [user('u1'), assistant('M_agent')] },
        global: { status: 'streaming', messages: [user('u2'), assistant('M_global')] },
      }),
    ).toEqual({ agentLiveId: 'M_agent', globalLiveId: 'M_global' });
  });

  // THE BUG. Both chats can stream at once (switching mode does not abort the running POST), and
  // the component used to feed ONE mode-selected id into both hold-refs. While the global stream
  // sat in 'submitted' with no id of its own, the AGENT's id was the mode-selected value — so the
  // global ref latched it and pinned it. Stop, back in global mode, aborted the AGENT's stream:
  // that answer died mid-sentence while the global generation kept billing.
  it('THE BUG: an agent stream in flight must NOT leak its id into the global slot', () => {
    const { agentLiveId, globalLiveId } = selectLiveAssistantIds({
      agent: { status: 'streaming', messages: [user('u1'), assistant('M_agent')] },
      // Global is live, but still submitted — it has no id of its own yet. The array's last
      // assistant message is the PREVIOUS turn's reply, and must not be mistaken for this one.
      global: { status: 'submitted', messages: [assistant('M_global_prev'), user('u2')] },
    });

    expect(agentLiveId).toBe('M_agent');
    expect(globalLiveId).toBeUndefined();
    expect(globalLiveId).not.toBe('M_agent');
  });

  it('THE BUG, mirrored: a global stream in flight must NOT leak its id into the agent slot', () => {
    const { agentLiveId, globalLiveId } = selectLiveAssistantIds({
      agent: { status: 'submitted', messages: [assistant('M_agent_prev'), user('u1')] },
      global: { status: 'streaming', messages: [user('u2'), assistant('M_global')] },
    });

    expect(globalLiveId).toBe('M_global');
    expect(agentLiveId).toBeUndefined();
    expect(agentLiveId).not.toBe('M_global');
  });

  it('given a chat is submitted, returns undefined rather than the PREVIOUS turn\'s assistant id', () => {
    // The submitted-window latch: useChat pushes this turn's assistant message only on reaching
    // 'streaming'. Reading the array any earlier yields the last completed reply — aborting that
    // id is a no-op the server registry no longer knows, while the real stream keeps billing.
    const { agentLiveId } = selectLiveAssistantIds({
      agent: { status: 'submitted', messages: [assistant('M_prev'), user('u_new')] },
      global: { status: 'ready', messages: [] },
    });
    expect(agentLiveId).toBeUndefined();
  });

  it('given a chat is idle, returns undefined even though a completed assistant message exists', () => {
    const { agentLiveId, globalLiveId } = selectLiveAssistantIds({
      agent: { status: 'ready', messages: [user('u1'), assistant('M_done')] },
      global: { status: 'error', messages: [user('u2'), assistant('M_partial')] },
    });
    expect(agentLiveId).toBeUndefined();
    expect(globalLiveId).toBeUndefined();
  });

  it('given a streaming chat with no assistant message yet, returns undefined', () => {
    const { agentLiveId } = selectLiveAssistantIds({
      agent: { status: 'streaming', messages: [user('u1')] },
      global: { status: 'ready', messages: [] },
    });
    expect(agentLiveId).toBeUndefined();
  });

  it('picks the LAST assistant message, not the first', () => {
    const { agentLiveId } = selectLiveAssistantIds({
      agent: {
        status: 'streaming',
        messages: [assistant('M_old'), user('u1'), assistant('M_current')],
      },
      global: { status: 'ready', messages: [] },
    });
    expect(agentLiveId).toBe('M_current');
  });
});
