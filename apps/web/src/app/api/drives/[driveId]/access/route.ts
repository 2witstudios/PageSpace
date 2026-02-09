import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { updateDriveLastAccessed } from '@pagespace/lib/services/drive-service';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    await updateDriveLastAccessed(auth.userId, driveId);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed to update access time' }, { status: 500 });
  }
}
