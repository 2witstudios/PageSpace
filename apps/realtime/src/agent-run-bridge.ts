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
import type { Pool } from 'pg';
import { db, eq, agentRuns, conversations } from '@pagespace/db';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/permissions-cached';
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
};

/**
 * Wire a LISTEN on `agent_run_events` from Postgres and re-emit each valid
 * notification to its agent-run:${runId} room. Returns a dispose function
 * that releases the dedicated client.
 */
export async function startAgentRunBridge(deps: BridgeDeps): Promise<() => Promise<void>> {
  const { pool, io } = deps;
  const client = await pool.connect();

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

  client.on('error', (err) => {
    loggers.realtime.error('Agent run bridge: pg client error', err);
  });

  await client.query('LISTEN agent_run_events');
  loggers.realtime.info('Agent run bridge: listening on agent_run_events');

  return async () => {
    try {
      await client.query('UNLISTEN agent_run_events');
    } catch {
      /* shutdown — ignore */
    } finally {
      client.release();
    }
  };
}
