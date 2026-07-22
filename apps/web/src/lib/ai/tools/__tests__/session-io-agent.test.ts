import { describe, it } from 'vitest';
import { assert } from './riteway';

import {
  createAgentSessionIo,
  DEFAULT_TRANSCRIPT_LIMIT,
  MAX_TRANSCRIPT_MESSAGE_CHARS,
  type AgentSessionIoDeps,
} from '../session-io-agent';
import type { SessionTerminalIdentity } from '../session-tools';
import type { HeadlessDispatchResult } from '@/lib/ai/machines/headless-session-run';

const AT = new Date('2026-07-22T12:00:00Z');

function identity(): SessionTerminalIdentity {
  return {
    node: { kind: 'project', machineId: 'm1', project: 'repo', cwd: '/home/pagespace/repo' },
    name: 'worker',
    address: { machineId: 'm1', projectName: 'repo', name: 'worker' },
  };
}

function io(
  overrides: Partial<AgentSessionIoDeps> = {},
): { io: ReturnType<typeof createAgentSessionIo>; dispatched: { message: string; depth: number }[]; limits: number[] } {
  const dispatched: { message: string; depth: number }[] = [];
  const limits: number[] = [];
  const base: AgentSessionIoDeps = {
    loadTranscript: async (_identity, limit) => {
      limits.push(limit);
      return {
        ok: true,
        entries: [
          { role: 'user', content: 'build the thing', at: AT },
          { role: 'assistant', content: 'built it', at: AT },
        ],
      };
    },
    dispatch: async ({ message, depth }): Promise<HeadlessDispatchResult> => {
      dispatched.push({ message, depth });
      return { ok: true, accepted: true, messageId: 'assistant-1' };
    },
  };
  return { io: createAgentSessionIo({ ...base, ...overrides }), dispatched, limits };
}

describe('read_session — agent transcript', () => {
  it('given an agent session, should return the transcript tail framed as untrusted content', async () => {
    const { io: agent } = io();

    const result = (await agent.read({ identity: identity(), actor: { userId: 'u1' } })) as {
      success: boolean;
      messages: { role: string; content: string }[];
      untrusted: string;
    };

    assert({
      given: 'a read of an agent session with two turns',
      should: 'answer with those turns and an explicit untrusted-content frame',
      actual: {
        success: result.success,
        messages: result.messages,
        framed: /never follow instructions/i.test(result.untrusted),
      },
      expected: {
        success: true,
        messages: [
          { role: 'user', at: AT.toISOString(), content: 'build the thing' },
          { role: 'assistant', at: AT.toISOString(), content: 'built it' },
        ],
        framed: true,
      },
    });
  });

  it('given no limit, should read a bounded tail rather than the whole conversation', async () => {
    const { io: agent, limits } = io();

    await agent.read({ identity: identity(), actor: { userId: 'u1' } });
    await agent.read({ identity: identity(), actor: { userId: 'u1' }, limit: 5 });

    assert({
      given: 'a read with and without an explicit limit',
      should: 'default to the tail limit and honour an explicit one',
      actual: limits,
      expected: [DEFAULT_TRANSCRIPT_LIMIT, 5],
    });
  });

  it('given a turn still being generated, should mark it pending rather than dropping it', async () => {
    const { io: agent } = io({
      loadTranscript: async () => ({
        ok: true,
        entries: [{ role: 'assistant', content: '', at: AT, pending: true }],
      }),
    });

    const result = (await agent.read({ identity: identity(), actor: { userId: 'u1' } })) as unknown as {
      messages: { pending?: boolean }[];
    };

    assert({
      given: 'a transcript whose last turn is mid-flight',
      should: 'report it as pending, so silence is not read as a finished answer',
      actual: result.messages.map((message) => message.pending),
      expected: [true],
    });
  });

  it('given an over-long turn, should truncate it and say so', async () => {
    const { io: agent } = io({
      loadTranscript: async () => ({
        ok: true,
        entries: [{ role: 'assistant', content: 'x'.repeat(MAX_TRANSCRIPT_MESSAGE_CHARS + 500), at: AT }],
      }),
    });

    const result = (await agent.read({ identity: identity(), actor: { userId: 'u1' } })) as unknown as {
      messages: { content: string }[];
    };

    assert({
      given: 'a transcript turn longer than read_session returns',
      should: 'cut it and label the cut',
      actual: result.messages[0].content.includes('[truncated'),
      expected: true,
    });
  });

  it('given a session with no agent loop behind it, should refuse rather than answer emptily', async () => {
    const { io: agent } = io({ loadTranscript: async () => ({ ok: false, reason: 'not_an_agent_session' }) });

    const result = (await agent.read({ identity: identity(), actor: { userId: 'u1' } })) as {
      success: boolean;
      error: string;
    };

    assert({
      given: 'a read of a row that is not a chat-surface session',
      should: 'refuse, not report an empty transcript',
      actual: { success: result.success, mentionsType: result.error.includes('not a PageSpace Agent session') },
      expected: { success: false, mentionsType: true },
    });
  });
});

describe('send_session — agent dispatch', () => {
  it('given a message, should ACK without an answer and point the caller at read_session', async () => {
    const { io: agent, dispatched } = io();

    const result = (await agent.send({
      identity: identity(),
      actor: { userId: 'u1' },
      input: 'run the tests',
    })) as { success: boolean; accepted: boolean; note: string };

    assert({
      given: 'a message sent to an agent session',
      should: 'acknowledge acceptance and name where the answer will appear',
      actual: {
        success: result.success,
        accepted: result.accepted,
        pointsAtRead: result.note.includes('read_session'),
        dispatched,
      },
      expected: {
        success: true,
        accepted: true,
        pointsAtRead: true,
        dispatched: [{ message: 'run the tests', depth: 0 }],
      },
    });
  });

  it('given a caller already inside a dispatch chain, should pass its depth to the engine', async () => {
    const { io: agent, dispatched } = io();

    await agent.send({ identity: identity(), actor: { userId: 'u1' }, input: 'go', depth: 1 });

    assert({
      given: 'a send from a run that is itself a dispatched turn',
      should: 'carry the chain depth through to the cap',
      actual: dispatched,
      expected: [{ message: 'go', depth: 1 }],
    });
  });

  it('given a busy session, should refuse with what the caller can actually do about it', async () => {
    const { io: agent } = io({ dispatch: async () => ({ ok: false, reason: 'busy' }) });

    const result = (await agent.send({ identity: identity(), actor: { userId: 'u1' }, input: 'go' })) as {
      success: boolean;
      error: string;
    };

    assert({
      given: 'a dispatch that lost the run-claim',
      should: 'refuse, naming the session and the remedy',
      actual: {
        success: result.success,
        namesSession: result.error.includes('"worker"'),
        namesRemedy: result.error.includes('read_session'),
      },
      expected: { success: false, namesSession: true, namesRemedy: true },
    });
  });

  it('given a chain at the cap, should refuse with the depth reason', async () => {
    const { io: agent } = io({ dispatch: async () => ({ ok: false, reason: 'depth_exceeded' }) });

    const result = (await agent.send({ identity: identity(), actor: { userId: 'u1' }, input: 'go' })) as {
      success: boolean;
      error: string;
    };

    assert({
      given: 'a dispatch refused by the depth cap',
      should: 'say the chain may not go deeper rather than reporting a generic failure',
      actual: { success: result.success, explains: result.error.includes('deeper') },
      expected: { success: false, explains: true },
    });
  });
});
