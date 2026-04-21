import { describe, it, expect } from 'vitest';
import { applyEvent, initialRunState } from '../applyEvent';
import type { RunEvent } from '../types';

const baseRunId = 'run_abc';

function event<T extends RunEvent['type']>(
  seq: number,
  type: T,
  payload: Extract<RunEvent, { type: T }>['payload'],
): RunEvent {
  return { runId: baseRunId, seq, type, payload } as RunEvent;
}

describe('applyEvent', () => {
  describe('initialRunState', () => {
    it('given a runId, should produce a streaming state with empty parts and lastSeq 0', () => {
      const state = initialRunState(baseRunId);
      expect(state).toEqual({
        runId: baseRunId,
        lastSeq: 0,
        status: 'streaming',
        parts: [],
        metadata: {},
      });
    });
  });

  describe('sequence ordering', () => {
    it('given an event with seq equal to lastSeq + 1, should accept it and advance lastSeq', () => {
      const state = applyEvent(initialRunState(baseRunId), event(1, 'text-segment', { text: 'hi' }));
      expect(state.lastSeq).toBe(1);
    });

    it('given an event whose seq skips past lastSeq + 1, should throw so gaps surface loudly', () => {
      expect(() =>
        applyEvent(initialRunState(baseRunId), event(2, 'text-segment', { text: 'hi' })),
      ).toThrow(/out of order/i);
    });

    it('given an event whose seq repeats lastSeq, should throw so duplicates surface loudly', () => {
      const s1 = applyEvent(initialRunState(baseRunId), event(1, 'text-segment', { text: 'hi' }));
      expect(() => applyEvent(s1, event(1, 'text-segment', { text: 'again' }))).toThrow(
        /out of order/i,
      );
    });

    it('given an event whose runId does not match the state, should throw so cross-run contamination surfaces', () => {
      const s = initialRunState(baseRunId);
      const other: RunEvent = {
        runId: 'run_other',
        seq: 1,
        type: 'text-segment',
        payload: { text: 'x' },
      };
      expect(() => applyEvent(s, other)).toThrow(/runId/i);
    });
  });

  describe('text-segment', () => {
    it('given the last part is not text, should append a new text part', () => {
      const state = applyEvent(
        initialRunState(baseRunId),
        event(1, 'text-segment', { text: 'hello' }),
      );
      expect(state.parts).toEqual([{ kind: 'text', text: 'hello' }]);
    });

    it('given consecutive text segments, should merge into the last text part', () => {
      let s = initialRunState(baseRunId);
      s = applyEvent(s, event(1, 'text-segment', { text: 'hel' }));
      s = applyEvent(s, event(2, 'text-segment', { text: 'lo' }));
      expect(s.parts).toEqual([{ kind: 'text', text: 'hello' }]);
    });

    it('given text after a tool call, should start a new text part so order is preserved', () => {
      let s = initialRunState(baseRunId);
      s = applyEvent(s, event(1, 'text-segment', { text: 'thinking' }));
      s = applyEvent(s, event(2, 'tool-input', { callId: 'c1', toolName: 'search', input: {} }));
      s = applyEvent(s, event(3, 'tool-result', { callId: 'c1', output: 'ok' }));
      s = applyEvent(s, event(4, 'text-segment', { text: 'done' }));
      expect(s.parts.map((p) => p.kind)).toEqual(['text', 'tool-call', 'text']);
      expect((s.parts[2] as { kind: 'text'; text: string }).text).toBe('done');
    });
  });

  describe('tool correlation', () => {
    it('given a tool-input, should append a pending tool-call part carrying its callId', () => {
      const s = applyEvent(
        initialRunState(baseRunId),
        event(1, 'tool-input', { callId: 'c1', toolName: 'search', input: { q: 'x' } }),
      );
      expect(s.parts).toEqual([
        { kind: 'tool-call', callId: 'c1', toolName: 'search', input: { q: 'x' }, state: 'pending' },
      ]);
    });

    it('given a tool-result for a known callId, should transition its part to complete with the output', () => {
      let s = initialRunState(baseRunId);
      s = applyEvent(s, event(1, 'tool-input', { callId: 'c1', toolName: 'search', input: {} }));
      s = applyEvent(s, event(2, 'tool-result', { callId: 'c1', output: { hits: 3 } }));
      expect(s.parts[0]).toEqual({
        kind: 'tool-call',
        callId: 'c1',
        toolName: 'search',
        input: {},
        state: 'complete',
        output: { hits: 3 },
      });
    });

    it('given a tool-result with isError true, should transition its part to error', () => {
      let s = initialRunState(baseRunId);
      s = applyEvent(s, event(1, 'tool-input', { callId: 'c1', toolName: 'search', input: {} }));
      s = applyEvent(
        s,
        event(2, 'tool-result', { callId: 'c1', output: 'boom', isError: true }),
      );
      expect((s.parts[0] as { state: string }).state).toBe('error');
    });

    it('given a tool-result for an unknown callId, should throw so orphan results surface', () => {
      const s = initialRunState(baseRunId);
      expect(() =>
        applyEvent(s, event(1, 'tool-result', { callId: 'nope', output: 'x' })),
      ).toThrow(/unknown.*callId/i);
    });
  });

  describe('terminal events', () => {
    it('given a finish event, should mark status completed and record token usage', () => {
      let s = initialRunState(baseRunId);
      s = applyEvent(s, event(1, 'text-segment', { text: 'hi' }));
      s = applyEvent(s, event(2, 'finish', { tokenUsageInput: 10, tokenUsageOutput: 20 }));
      expect(s.status).toBe('completed');
      expect(s.tokenUsageInput).toBe(10);
      expect(s.tokenUsageOutput).toBe(20);
    });

    it('given an error event, should mark status failed and record the message', () => {
      const s = applyEvent(
        initialRunState(baseRunId),
        event(1, 'error', { message: 'provider 500' }),
      );
      expect(s.status).toBe('failed');
      expect(s.errorMessage).toBe('provider 500');
    });

    it('given an aborted event, should mark status aborted', () => {
      const s = applyEvent(initialRunState(baseRunId), event(1, 'aborted', {}));
      expect(s.status).toBe('aborted');
    });

    it('given an event after a terminal status, should throw so post-terminal writes surface', () => {
      let s = initialRunState(baseRunId);
      s = applyEvent(s, event(1, 'finish', {}));
      expect(() => applyEvent(s, event(2, 'text-segment', { text: 'late' }))).toThrow(
        /terminal/i,
      );
    });
  });

  describe('metadata', () => {
    it('given a metadata event, should shallow-merge its payload into state.metadata', () => {
      let s = initialRunState(baseRunId);
      s = applyEvent(s, event(1, 'metadata', { model: 'claude-opus-4-7' }));
      s = applyEvent(s, event(2, 'metadata', { region: 'us-east-1' }));
      expect(s.metadata).toEqual({ model: 'claude-opus-4-7', region: 'us-east-1' });
    });
  });

  describe('purity', () => {
    it('given a state, should not mutate the input when applying an event', () => {
      const s0 = initialRunState(baseRunId);
      const s0Snapshot = JSON.stringify(s0);
      applyEvent(s0, event(1, 'text-segment', { text: 'hi' }));
      expect(JSON.stringify(s0)).toBe(s0Snapshot);
    });

    it('given the same event sequence applied twice, should produce deep-equal states', () => {
      const events = [
        event(1, 'text-segment', { text: 'a' }),
        event(2, 'tool-input', { callId: 'c', toolName: 't', input: {} }),
        event(3, 'tool-result', { callId: 'c', output: 'r' }),
        event(4, 'text-segment', { text: 'b' }),
        event(5, 'finish', { tokenUsageInput: 1, tokenUsageOutput: 2 }),
      ];
      const apply = (): unknown =>
        events.reduce<ReturnType<typeof initialRunState>>(
          (s, e) => applyEvent(s, e),
          initialRunState(baseRunId),
        );
      expect(apply()).toEqual(apply());
    });
  });
});
