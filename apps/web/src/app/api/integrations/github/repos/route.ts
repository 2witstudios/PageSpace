/**
 * GitHub Repos API — lists the connected user's own GitHub repositories, for
 * the Terminal Navigator's "Add project" repo picker (`apps/web/src/components/
 * layout/middle-content/page-views/terminal/workspace/Navigator.tsx`).
 *
 * GET ?page=<n> → { connected: false } | { connected: true, repos, page }
 *
 * Session-only, no terminalId or driveId — this only ever returns the
 * calling user's own repos via their own GitHub connection, using the same
 * declarative `list_repos` tool the AI agent's integration tools already use
 * (packages/lib/src/integrations/providers/github.ts).
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { getProviderBySlug } from '@pagespace/lib/integrations/repositories/provider-repository';
import { findUserConnection, getConnectionWithProvider } from '@pagespace/lib/integrations/repositories/connection-repository';
import { logAuditEntry } from '@pagespace/lib/integrations/repositories/audit-repository';
import { createToolExecutor, type ExecuteToolDependencies } from '@pagespace/lib/integrations/saga/execute-tool';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

/** The connection type expected by the tool executor's loadConnection dependency (see integration-tool-resolver.ts). */
type LoadConnectionResult = ExecuteToolDependencies['loadConnection'] extends
  (id: string) => Promise<infer R> ? R : never;

function parsePage(raw: string | null): number {
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const page = parsePage(url.searchParams.get('page'));

  const provider = await getProviderBySlug(db, 'github');
  const connection = provider ? await findUserConnection(db, auth.userId, provider.id) : null;

  if (!connection || connection.status !== 'active') {
    return NextResponse.json({ connected: false });
  }

  const executor = createToolExecutor({
    loadConnection: (connectionId) =>
      getConnectionWithProvider(db, connectionId) as Promise<LoadConnectionResult>,
    logAudit: async (entry) => {
      await logAuditEntry(db, {
        driveId: entry.driveId,
        agentId: null,
        userId: auth.userId,
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

  const result = await executor({
    userId: auth.userId,
    agentId: null,
    driveId: null,
    connectionId: connection.id,
    toolName: 'list_repos',
    input: { type: 'all', sort: 'updated', per_page: 100, page },
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? 'Failed to list repositories' }, { status: 502 });
  }

  return NextResponse.json({ connected: true, repos: result.data, page });
}
