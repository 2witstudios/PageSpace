import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { builtinProviderList } from '@pagespace/lib/integrations/providers';
import { listEnabledProviders } from '@pagespace/lib/integrations/repositories/provider-repository';

const AUTH_OPTIONS = { allow: ['session'] as const };

/**
 * GET /api/integrations/providers/available
 * Returns builtin providers that are not yet installed in the database.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  try {
    const installed = await listEnabledProviders(db);
    const installedSlugs = new Set(installed.map((p) => p.slug));

    const available = builtinProviderList
      .filter((b) => !installedSlugs.has(b.id))
      .map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description ?? null,
        documentationUrl: b.documentationUrl ?? null,
      }));

    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'available_providers', resourceId: 'list', details: { availableCount: available.length } });

    return NextResponse.json({ providers: available });
  } catch (error) {
    loggers.api.error('Error listing available builtins:', error as Error);
    return NextResponse.json({ error: 'Failed to list available providers' }, { status: 500 });
  }
}
