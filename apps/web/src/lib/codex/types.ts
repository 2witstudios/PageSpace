// Core JSON-RPC shapes for the Codex app-server protocol

export interface CodexRequest {
  method: string;
  id: number;
  params?: unknown;
}

export interface CodexResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface CodexNotification {
  method: string;
  params?: unknown;
}

export type ApprovalPolicy = 'never' | 'onRequest' | 'unlessTrusted' | 'always';

// thread/start params
export interface ThreadStartParams {
  model?: string;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: string;
}

// thread/resume params
export interface ThreadResumeParams {
  threadId: string;
}

// thread/start result
export interface ThreadResult {
  thread: {
    id: string;
    preview?: string;
    ephemeral?: boolean;
    modelProvider?: string;
    createdAt?: number;
  };
}

// turn/start params
export interface TurnStartParams {
  threadId: string;
  input: TurnInput[];
  approvalPolicy?: ApprovalPolicy;
  sandboxPolicy?: unknown;
  model?: string;
}

export type TurnInput = { type: 'text'; text: string };

// turn/start result
export interface TurnResult {
  turn: {
    id: string;
    status: string;
    items: unknown[];
    error: unknown;
  };
}

// Notification payloads we care about
export interface AgentMessageDelta {
  itemId: string;
  delta: string;
}

export interface ItemStartedPayload {
  item: {
    type: string;
    id: string;
    [key: string]: unknown;
  };
}

export interface ItemCompletedPayload {
  item: {
    type: string;
    id: string;
    status?: string;
    text?: string;
    command?: string[];
    aggregatedOutput?: string;
    exitCode?: number;
    changes?: Array<{ path: string; kind: string; diff?: string }>;
    [key: string]: unknown;
  };
}

export interface TurnCompletedPayload {
  turn: {
    id: string;
    status: 'completed' | 'interrupted' | 'failed';
    error?: { message: string };
  };
}

export interface CommandApprovalPayload {
  itemId: string;
  threadId: string;
  turnId: string;
  reason?: string;
  command?: string[];
  cwd?: string;
}

export interface FileApprovalPayload {
  itemId: string;
  threadId: string;
  turnId: string;
  reason?: string;
}

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';
