import type { RunEvent, RunPart, RunState } from './types';

export function initialRunState(runId: string): RunState {
  return {
    runId,
    lastSeq: 0,
    status: 'streaming',
    parts: [],
    metadata: {},
  };
}

export function applyEvent(state: RunState, event: RunEvent): RunState {
  if (event.runId !== state.runId) {
    throw new Error(
      `applyEvent: runId mismatch — state is "${state.runId}", event is "${event.runId}"`,
    );
  }
  if (event.seq !== state.lastSeq + 1) {
    throw new Error(
      `applyEvent: out of order event — expected seq ${state.lastSeq + 1}, got ${event.seq}`,
    );
  }
  if (state.status !== 'streaming') {
    throw new Error(
      `applyEvent: event applied after terminal status "${state.status}" at seq ${event.seq}`,
    );
  }

  const next: RunState = { ...state, lastSeq: event.seq, metadata: { ...state.metadata } };

  switch (event.type) {
    case 'text-segment':
      next.parts = appendText(state.parts, event.payload.text);
      return next;

    case 'tool-input': {
      const part: RunPart = {
        kind: 'tool-call',
        callId: event.payload.callId,
        toolName: event.payload.toolName,
        input: event.payload.input,
        state: 'pending',
      };
      next.parts = [...state.parts, part];
      return next;
    }

    case 'tool-result': {
      const idx = state.parts.findIndex(
        (p) => p.kind === 'tool-call' && p.callId === event.payload.callId,
      );
      if (idx === -1) {
        throw new Error(
          `applyEvent: tool-result for unknown callId "${event.payload.callId}" at seq ${event.seq}`,
        );
      }
      const existing = state.parts[idx] as Extract<RunPart, { kind: 'tool-call' }>;
      const updated: RunPart = {
        ...existing,
        state: event.payload.isError ? 'error' : 'complete',
        output: event.payload.output,
      };
      next.parts = [...state.parts.slice(0, idx), updated, ...state.parts.slice(idx + 1)];
      return next;
    }

    case 'metadata':
      next.metadata = { ...state.metadata, ...event.payload };
      return next;

    case 'finish':
      next.status = 'completed';
      if (event.payload.tokenUsageInput !== undefined) {
        next.tokenUsageInput = event.payload.tokenUsageInput;
      }
      if (event.payload.tokenUsageOutput !== undefined) {
        next.tokenUsageOutput = event.payload.tokenUsageOutput;
      }
      return next;

    case 'error':
      next.status = 'failed';
      next.errorMessage = event.payload.message;
      return next;

    case 'aborted':
      next.status = 'aborted';
      return next;
  }
}

function appendText(parts: readonly RunPart[], text: string): RunPart[] {
  if (parts.length === 0) {
    return [{ kind: 'text', text }];
  }
  const last = parts[parts.length - 1];
  if (last.kind === 'text') {
    return [...parts.slice(0, -1), { kind: 'text', text: last.text + text }];
  }
  return [...parts, { kind: 'text', text }];
}
