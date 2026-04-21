export type RunEventType =
  | 'text-segment'
  | 'tool-input'
  | 'tool-result'
  | 'metadata'
  | 'finish'
  | 'error'
  | 'aborted';

export type RunEvent =
  | { runId: string; seq: number; type: 'text-segment'; payload: { text: string } }
  | { runId: string; seq: number; type: 'tool-input'; payload: { callId: string; toolName: string; input: unknown } }
  | { runId: string; seq: number; type: 'tool-result'; payload: { callId: string; output: unknown; isError?: boolean } }
  | { runId: string; seq: number; type: 'metadata'; payload: { [key: string]: unknown } }
  | { runId: string; seq: number; type: 'finish'; payload: { tokenUsageInput?: number; tokenUsageOutput?: number } }
  | { runId: string; seq: number; type: 'error'; payload: { message: string } }
  | { runId: string; seq: number; type: 'aborted'; payload: { [key: string]: unknown } };

export type RunPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool-call';
      callId: string;
      toolName: string;
      input: unknown;
      state: 'pending' | 'complete' | 'error';
      output?: unknown;
    };

export type RunStatus = 'streaming' | 'completed' | 'failed' | 'aborted';

export type RunState = {
  runId: string;
  lastSeq: number;
  status: RunStatus;
  parts: RunPart[];
  metadata: { [key: string]: unknown };
  tokenUsageInput?: number;
  tokenUsageOutput?: number;
  errorMessage?: string;
};
