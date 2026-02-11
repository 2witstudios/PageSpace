import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';
import { updateDriveLastAccessed } from '@pagespace/lib/services/drive-service';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    // Check MCP token scope before drive access
    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    await updateDriveLastAccessed(auth.userId, driveId);
    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Failed to update drive access time', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Failed to update access time' }, { status: 500 });
  }
}
