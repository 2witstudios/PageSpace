import { NextResponse } from 'next/server';
import type { EnforcedAuthContext } from '@pagespace/lib/permissions/enforced-context';
import type { AttachmentTarget } from '@pagespace/lib/services/attachment-upload-core';
import { presignAttachment, completeAttachment, cancelAttachment } from './attachment-direct';

/**
 * Body-parse + orchestrator dispatch for the attachment routes. Kept apart from
 * the resolvers so a route is just `resolve → handle`, and the orchestrator's S3
 * deps don't leak into the resolver unit tests.
 */

interface Resolved {
  ctx: EnforcedAuthContext;
  target: AttachmentTarget;
}

function badJson(): NextResponse {
  return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
}

export async function handlePresign(request: Request, resolved: Resolved): Promise<NextResponse> {
  let body: { contentHash?: unknown; filename?: unknown; mimeType?: unknown; fileSize?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badJson();
  }
  const { contentHash, filename, mimeType, fileSize } = body;
  if (
    typeof contentHash !== 'string' ||
    typeof filename !== 'string' ||
    typeof mimeType !== 'string' ||
    typeof fileSize !== 'number'
  ) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const result = await presignAttachment({
    userId: resolved.ctx.userId,
    target: resolved.target,
    request,
    contentHash,
    filename,
    mimeType,
    fileSize,
  });
  return NextResponse.json(result.body, { status: result.status });
}

export async function handleComplete(request: Request, resolved: Resolved): Promise<NextResponse> {
  let body: { jobId?: unknown; filename?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badJson();
  }
  const { jobId, filename } = body;
  if (typeof jobId !== 'string' || typeof filename !== 'string') {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const result = await completeAttachment({
    userId: resolved.ctx.userId,
    target: resolved.target,
    request,
    jobId,
    filename,
  });
  return NextResponse.json(result.body, { status: result.status });
}

export async function handleCancel(request: Request, ctx: EnforcedAuthContext): Promise<NextResponse> {
  let body: { jobId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badJson();
  }
  if (typeof body.jobId !== 'string') {
    return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
  }

  const result = await cancelAttachment({ userId: ctx.userId, jobId: body.jobId });
  return NextResponse.json(result.body, { status: result.status });
}
