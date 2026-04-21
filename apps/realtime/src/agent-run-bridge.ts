/**
 * Agent Run Bridge
 *
 * Bridges Postgres LISTEN/NOTIFY for `agent_run_events` to Socket.IO
 * `agent-run:${runId}` rooms, and authorises clients that try to join them.
 *
 * The bridge is the read path for the durable event log: workers append
 * events via `appendEvent` (which `pg_notify`s in the same transaction);
 * the bridge re-emits to subscribed clients. If no client is subscribed,
 * the emission is a no-op — the row is already persisted.
 */

import type { Server } from 'socket.io';
import type { Pool, PoolClient } from 'pg';
import { db, eq, agentRuns, conversations } from '@pagespace/db';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/permissions';
import { loggers } from '@pagespace/lib/logger-config';
import { isCUID2, type ValidationResult } from './validation';

export type AgentRunNotification = {
  runId: string;
  seq: number;
  type: string;
};

/**
 * Parse a pg_notify payload string into an AgentRunNotification.
 * Returns null for malformed payloads instead of throwing — a single bad
 * notify must not crash the bridge.
 */
export function parseAgentRunNotification(raw: string): AgentRunNotification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const { runId, seq, type } = obj;
  if (typeof runId !== 'string' || !isCUID2(runId)) return null;
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= 0) return null;
  if (typeof type !== 'string' || type.length === 0) return null;
  return { runId, seq, type };
}

/**
 * Emit an agent-run notification to its room. No-op if no client is subscribed.
 */
export function emitAgentRunNotification(
  io: Pick<Server, 'to'>,
  notification: AgentRunNotification,
): void {
  io.to(`agent-run:${notification.runId}`).emit('agent_run_event', notification);
}

/**
 * Validate a runId payload from the client. RunIds are CUID2 strings.
 */
export function validateRunId(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Run ID must be a string' };
  }
  if (!isCUID2(input)) {
    return { ok: false, error: 'Run ID must be a valid ID' };
  }
  return { ok: true, value: input };
}

/**
 * Default access policy for agent-run rooms.
 *
 * - Run owner: always allowed
 * - Conversation owner: always allowed
 * - Page conversation: needs view access on the page
 * - Drive conversation: needs drive access
 * - Global conversation: only the conversation owner
 */
export async function isAgentRunAccessibleDefault(
  userId: string,
  runId: string,
): Promise<boolean> {
  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, runId),
  });
  if (!run) return false;
  if (run.ownerUserId === userId) return true;

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, run.conversationId),
  });
  if (!conv) return false;
  if (conv.userId === userId) return true;

  if (conv.type === 'page' && conv.contextId) {
    const accessLevel = await getUserAccessLevel(userId, conv.contextId);
    return Boolean(accessLevel?.canView);
  }
  if (conv.type === 'drive' && conv.contextId) {
    return await getUserDriveAccess(userId, conv.contextId);
  }
  return false;
}

type BridgeDeps = {
  pool: Pool;
  io: Pick<Server, 'to'>;
  /** Override reconnect scheduler (tests inject a synchronous scheduler). */
  scheduleReconnect?: (attempt: number, cb: () => void) => () => void;
};

const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;

function defaultScheduleReconnect(attempt: number, cb: () => void): () => void {
  const delay = Math.min(
    MAX_RECONNECT_DELAY_MS,
    BASE_RECONNECT_DELAY_MS * 2 ** Math.min(attempt, 6),
  );
  const timer = setTimeout(cb, delay);
  return () => clearTimeout(timer);
}

/**
 * Wire a LISTEN on `agent_run_events` from Postgres and re-emit each valid
 * notification to its agent-run:${runId} room.
 *
 * Resilient to pg client errors/disconnects: on `error` or `end` the bridge
 * releases the failed client and reconnects with exponential backoff, so a
 * transient DB restart can't silently stop realtime forwarding for the
 * lifetime of the process.
 *
 * Returns a dispose function that cancels any pending reconnect and releases
 * the dedicated client.
 */
export async function startAgentRunBridge(deps: BridgeDeps): Promise<() => Promise<void>> {
  const { pool, io } = deps;
  const scheduleReconnect = deps.scheduleReconnect ?? defaultScheduleReconnect;

  let disposed = false;
  let currentClient: PoolClient | null = null;
  let cancelReconnect: (() => void) | null = null;

  const scheduleReconnectAttempt = (attempt: number) => {
    if (disposed || cancelReconnect) return;
    cancelReconnect = scheduleReconnect(attempt, () => {
      cancelReconnect = null;
      void connect(attempt);
    });
  };

  const destroyClient = (client: PoolClient, err?: Error) => {
    try {
      // Truthy arg tells pg to discard the client instead of returning it
      // to the pool — the connection is in an unknown state after failure.
      client.release(err ?? true);
    } catch {
      /* ignore release-after-destroy */
    }
  };

  const cleanReleaseClient = (client: PoolClient) => {
    try {
      client.release();
    } catch {
      /* ignore */
    }
  };

  const connect = async (attempt: number): Promise<void> => {
    if (disposed) return;
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      loggers.realtime.error(
        'Agent run bridge: failed to acquire pg client; will retry',
        err as Error,
        { attempt },
      );
      scheduleReconnectAttempt(attempt + 1);
      return;
    }

    currentClient = client;

    client.on('notification', (msg) => {
      if (msg.channel !== 'agent_run_events' || !msg.payload) return;
      const parsed = parseAgentRunNotification(msg.payload);
      if (!parsed) {
        loggers.realtime.warn('Agent run bridge: malformed notification dropped', {
          payloadLength: msg.payload.length,
        });
        return;
      }
      emitAgentRunNotification(io, parsed);
    });

    const handleFailure = (reason: string, err?: Error) => {
      if (currentClient !== client) return;
      currentClient = null;
      loggers.realtime.error(`Agent run bridge: ${reason}; reconnecting`, err, { attempt });
      destroyClient(client, err);
      scheduleReconnectAttempt(attempt + 1);
    };

    client.on('error', (err) => handleFailure('pg client error', err));
    client.on('end', () => handleFailure('pg client ended'));

    try {
      await client.query('LISTEN agent_run_events');
    } catch (err) {
      handleFailure('LISTEN failed', err as Error);
      return;
    }

    if (disposed) {
      currentClient = null;
      cleanReleaseClient(client);
      return;
    }
    loggers.realtime.info('Agent run bridge: listening on agent_run_events', { attempt });
  };

  await connect(0);

  return async () => {
    disposed = true;
    if (cancelReconnect) {
      cancelReconnect();
      cancelReconnect = null;
    }
    const client = currentClient;
    currentClient = null;
    if (!client) return;
    try {
      await client.query('UNLISTEN agent_run_events');
    } catch {
      /* shutdown — ignore */
    } finally {
      cleanReleaseClient(client);
    }
  };
}
