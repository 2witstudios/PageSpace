import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { and, eq, lt } from '@pagespace/db/operators';
import { messageDrafts } from '@pagespace/db/schema/drafts';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { draftExpiresAt } from '@/lib/draft/draft';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const MAX_CONTENT_LENGTH = 50_000;

// GET /api/drafts?key=… — fetch a single draft; lazily prune expired rows
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');
    if (!key) {
      return NextResponse.json({ error: 'key is required' }, { status: 400 });
    }

    // Lazy expiry cleanup: delete any expired drafts for this user in one shot
    await db
      .delete(messageDrafts)
      .where(and(eq(messageDrafts.userId, userId), lt(messageDrafts.expiresAt, new Date())));

    const draft = await db.query.messageDrafts.findFirst({
      where: and(eq(messageDrafts.userId, userId), eq(messageDrafts.contextKey, key)),
    });

    return NextResponse.json({ content: draft?.content ?? null });
  } catch (error) {
    loggers.api.error('Error fetching draft:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch draft' }, { status: 500 });
  }
}

// PUT /api/drafts — upsert a draft; resets expiry
export async function PUT(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { key, content } = body as { key?: unknown; content?: unknown };

    if (typeof key !== 'string' || !key) {
      return NextResponse.json({ error: 'key must be a non-empty string' }, { status: 400 });
    }
    if (typeof content !== 'string') {
      return NextResponse.json({ error: 'content must be a string' }, { status: 400 });
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return NextResponse.json({ error: `content must be ${MAX_CONTENT_LENGTH} characters or less` }, { status: 400 });
    }

    const expiresAt = draftExpiresAt(Date.now());

    await db
      .insert(messageDrafts)
      .values({ userId, contextKey: key, content, expiresAt })
      .onConflictDoUpdate({
        target: [messageDrafts.userId, messageDrafts.contextKey],
        set: { content, updatedAt: new Date(), expiresAt },
      });

    return NextResponse.json({ ok: true });
  } catch (error) {
    loggers.api.error('Error saving draft:', error as Error);
    return NextResponse.json({ error: 'Failed to save draft' }, { status: 500 });
  }
}

// DELETE /api/drafts?key=… — remove a draft on send
export async function DELETE(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');
    if (!key) {
      return NextResponse.json({ error: 'key is required' }, { status: 400 });
    }

    await db
      .delete(messageDrafts)
      .where(and(eq(messageDrafts.userId, userId), eq(messageDrafts.contextKey, key)));

    return NextResponse.json({ ok: true });
  } catch (error) {
    loggers.api.error('Error deleting draft:', error as Error);
    return NextResponse.json({ error: 'Failed to delete draft' }, { status: 500 });
  }
}
