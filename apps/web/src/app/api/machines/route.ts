/**
 * Machines API — the Development surface's aggregated tree needs the one thing
 * no other machine route serves: every Machine in a drive, not one Machine by
 * id.
 *
 * GET ?driveId=<id> → { machines: [{ id, title, updatedAt }] }
 *
 * Session-only (no MCP/agent tokens) — a human/UI surface, like the rest of
 * `/api/machines/*`. The list is filtered to the machines the caller may view,
 * so a drive member who has been withheld an individual Machine page never sees
 * it in the tree.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { listDriveMachines } from '@/lib/machines/machine-list-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const driveId = new URL(request.url).searchParams.get('driveId');
  if (!driveId) {
    return NextResponse.json({ error: 'driveId is required' }, { status: 400 });
  }

  const machines = await listDriveMachines(auth.userId, driveId);
  return NextResponse.json({ machines });
}
