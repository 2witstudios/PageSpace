import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPCreateScope } from '@/lib/auth';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { releasePendingUpload } from '@pagespace/lib/services/pending-uploads';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * Release an upload slot reserved by /presign when the client-side upload fails
 * before /complete runs. Without this, a failed upload's slot leaks until the
 * semaphore's stale-slot sweep.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const { userId } = auth;

  let body: { jobId?: string };
  try {
    body = (await request.json()) as { jobId?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { jobId } = body;
  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
  }

  const reserved = uploadSemaphore.getSlotMetadata(jobId, userId);
  if (!uploadSemaphore.verifySlotOwner(jobId, userId)) {
    return NextResponse.json({ error: 'Invalid or expired jobId' }, { status: 403 });
  }

  // A drive-scoped MCP token may only cancel uploads within its scope.
  if (reserved) {
    const scopeError = checkMCPCreateScope(auth, reserved.driveId);
    if (scopeError) return scopeError;
  }

  uploadSemaphore.releaseUploadSlot(jobId);
  await releasePendingUpload(jobId);

  auditRequest(request, {
    eventType: 'data.write',
    userId,
    resourceType: 'file',
    resourceId: jobId,
    details: { action: 'upload-cancel' },
  });

  return NextResponse.json({ success: true });
}
