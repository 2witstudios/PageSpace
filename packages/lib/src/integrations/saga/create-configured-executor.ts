/**
 * Wires the generic tool-execution saga (`execute-tool.ts`) to real DB
 * dependencies for a given acting identity. Shared by every caller of the
 * saga — AI-agent tool-calling (apps/web/src/lib/ai/core/integration-tool-
 * resolver.ts) and direct UI-triggered integration routes (e.g. GET
 * /api/integrations/github/repos) alike — so the executor-wiring contract
 * has exactly one implementation to keep in sync with `ExecuteToolDependencies`.
 */

import type { db as defaultDb } from '@pagespace/db/db';
import { getConnectionWithProvider } from '../repositories/connection-repository';
import { logAuditEntry } from '../repositories/audit-repository';
import { createToolExecutor, type ExecuteToolDependencies } from './execute-tool';

/** The connection type expected by the tool executor's loadConnection dependency. */
type LoadConnectionResult = ExecuteToolDependencies['loadConnection'] extends
  (id: string) => Promise<infer R> ? R : never;

export function createConfiguredToolExecutor({
  db,
  userId,
  agentId,
  driveId,
}: {
  db: typeof defaultDb;
  userId: string;
  agentId: string | null;
  driveId: string | null;
}) {
  return createToolExecutor({
    loadConnection: (connectionId) =>
      getConnectionWithProvider(db, connectionId) as Promise<LoadConnectionResult>,
    logAudit: async (entry) => {
      await logAuditEntry(db, {
        driveId: entry.driveId ?? driveId,
        agentId,
        userId,
        connectionId: entry.connectionId,
        toolName: entry.toolName,
        success: entry.success,
        errorType: entry.errorType,
        errorMessage: entry.errorMessage,
        responseCode: entry.responseCode,
        durationMs: entry.durationMs,
      });
    },
  });
}
