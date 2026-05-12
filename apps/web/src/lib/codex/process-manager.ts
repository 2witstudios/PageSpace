import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { createId } from '@paralleldrive/cuid2';
import type {
  CodexRequest,
  CodexResponse,
  CodexNotification,
  PendingApproval,
  ApprovalDecision,
  ThreadStartParams,
  ThreadResumeParams,
  TurnStartParams,
  ThreadResult,
  TurnResult,
} from './types';

interface ApprovalMeta {
  requestId: string;
  rpcId: number;
  kind: 'command' | 'fileChange';
  command?: string;
  cwd?: string;
  reason?: string;
  resolve: (decision: ApprovalDecision) => void;
}

interface ProcessState {
  proc: ChildProcessWithoutNullStreams;
  initialized: boolean;
  nextId: number;
  pending: Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>;
  // threadId → set of notification callbacks
  subscribers: Map<string, Set<(notification: CodexNotification) => void>>;
  // requestId → pending approval with metadata
  approvals: Map<string, ApprovalMeta>;
}

// Singleton map: userId → process state
const processes = new Map<string, ProcessState>();

function getNextId(state: ProcessState): number {
  return state.nextId++;
}

function sendLine(state: ProcessState, msg: CodexRequest | { method: string; params?: unknown }): void {
  state.proc.stdin.write(JSON.stringify(msg) + '\n');
}

async function sendRequest(state: ProcessState, method: string, params?: unknown): Promise<unknown> {
  const id = getNextId(state);
  const req: CodexRequest = { method, id, params };
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    sendLine(state, req);
    // 30-second per-request timeout
    setTimeout(() => {
      if (state.pending.has(id)) {
        state.pending.delete(id);
        reject(new Error(`Codex RPC timeout: ${method}`));
      }
    }, 30_000);
  });
}

function handleLine(state: ProcessState, line: string): void {
  let msg: CodexResponse | CodexNotification;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if ('id' in msg && msg.id !== undefined) {
    // It's a response
    const response = msg as CodexResponse;
    const pending = state.pending.get(response.id);
    if (pending) {
      state.pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result);
      }
    }
  } else {
    // It's a notification
    const notification = msg as CodexNotification;
    fanoutNotification(state, notification);
  }
}

function fanoutNotification(state: ProcessState, notification: CodexNotification): void {
  // Route to all subscribers (all threads on this user's process get all notifications)
  for (const callbacks of state.subscribers.values()) {
    for (const cb of callbacks) {
      try { cb(notification); } catch { /* ignore */ }
    }
  }

  // Handle approval requests as server-initiated requests
  if (
    notification.method === 'item/commandExecution/requestApproval' ||
    notification.method === 'item/fileChange/requestApproval'
  ) {
    const params = notification.params as {
      command?: string[];
      cwd?: string;
      reason?: string;
    } | undefined;
    const requestId = createId();
    const msgWithId = notification as unknown as { id?: number };
    const rpcId = msgWithId.id ?? -1;
    const isCommand = notification.method === 'item/commandExecution/requestApproval';

    let resolveApproval!: (d: ApprovalDecision) => void;
    const promise = new Promise<ApprovalDecision>((res) => {
      resolveApproval = res;
    });

    const meta: ApprovalMeta = {
      requestId,
      rpcId,
      kind: isCommand ? 'command' : 'fileChange',
      command: params?.command?.join(' '),
      cwd: params?.cwd,
      reason: params?.reason,
      resolve: resolveApproval,
    };
    state.approvals.set(requestId, meta);

    // Enrich notification with our requestId so subscribers can surface it to the client
    (notification.params as Record<string, unknown>).__requestId = requestId;

    promise.then((decision) => {
      state.approvals.delete(requestId);
      if (rpcId >= 0) {
        const response = { id: rpcId, result: decision };
        state.proc.stdin.write(JSON.stringify(response) + '\n');
      }
    });
  }
}

async function spawnProcess(userId: string, openAiKey: string): Promise<ProcessState> {
  const proc = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENAI_API_KEY: openAiKey,
    },
  });

  const state: ProcessState = {
    proc,
    initialized: false,
    nextId: 0,
    pending: new Map(),
    subscribers: new Map(),
    approvals: new Map(),
  };

  const rl = createInterface({ input: proc.stdout });
  rl.on('line', (line) => handleLine(state, line));

  proc.on('exit', () => {
    processes.delete(userId);
    // Reject all pending requests
    for (const { reject } of state.pending.values()) {
      reject(new Error('Codex process exited'));
    }
    state.pending.clear();
  });

  // initialize handshake
  await sendRequest(state, 'initialize', {
    clientInfo: {
      name: 'pagespace',
      title: 'PageSpace',
      version: '1.0.0',
    },
  });
  sendLine(state, { method: 'initialized', params: {} });
  state.initialized = true;

  return state;
}

export async function getOrSpawnProcess(userId: string, openAiKey: string): Promise<ProcessState> {
  const existing = processes.get(userId);
  if (existing?.initialized) return existing;
  const state = await spawnProcess(userId, openAiKey);
  processes.set(userId, state);
  return state;
}

export async function threadStart(userId: string, openAiKey: string, params: ThreadStartParams): Promise<ThreadResult> {
  const state = await getOrSpawnProcess(userId, openAiKey);
  return sendRequest(state, 'thread/start', params) as Promise<ThreadResult>;
}

export async function threadResume(userId: string, openAiKey: string, params: ThreadResumeParams): Promise<ThreadResult> {
  const state = await getOrSpawnProcess(userId, openAiKey);
  return sendRequest(state, 'thread/resume', params) as Promise<ThreadResult>;
}

export async function turnStart(userId: string, openAiKey: string, params: TurnStartParams): Promise<TurnResult> {
  const state = await getOrSpawnProcess(userId, openAiKey);
  return sendRequest(state, 'turn/start', params) as Promise<TurnResult>;
}

export async function turnInterrupt(userId: string, openAiKey: string, threadId: string, turnId: string): Promise<void> {
  const state = await getOrSpawnProcess(userId, openAiKey);
  await sendRequest(state, 'turn/interrupt', { threadId, turnId });
}

export function subscribeToThread(
  userId: string,
  threadId: string,
  callback: (notification: CodexNotification) => void,
): () => void {
  const state = processes.get(userId);
  if (!state) return () => {};

  if (!state.subscribers.has(threadId)) {
    state.subscribers.set(threadId, new Set());
  }
  state.subscribers.get(threadId)!.add(callback);

  return () => {
    state.subscribers.get(threadId)?.delete(callback);
  };
}

export interface PendingApprovalInfo {
  requestId: string;
  kind: 'command' | 'fileChange';
  command?: string;
  cwd?: string;
  reason?: string;
}

export function resolveApproval(userId: string, requestId: string, decision: ApprovalDecision): boolean {
  const state = processes.get(userId);
  if (!state) return false;
  const approval = state.approvals.get(requestId);
  if (!approval) return false;
  approval.resolve(decision);
  return true;
}

export function getPendingApprovals(userId: string): PendingApprovalInfo[] {
  const state = processes.get(userId);
  if (!state) return [];
  return [...state.approvals.values()].map(({ requestId, kind, command, cwd, reason }) => ({
    requestId, kind, command, cwd, reason,
  }));
}
