import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { eq, and, desc } from '@pagespace/db/operators'
import { chatMessages } from '@pagespace/db/schema/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

/**
 * Debug endpoint for inspecting the FROZEN legacy `chat_messages` table.
 *
 * GET only: list the legacy rows a page still has, or test DB connectivity.
 * Non-production, and read-only by construction — the POST that used to
 * fabricate fixture rows here was deleted by Phase 4 PR 14 of the epic
 * "Agent-Session Single Source of Truth". Nothing may INSERT or UPDATE
 * `chat_messages` any more: `messages` is the sole write target, and a seeded
 * legacy row with no unified twin is exactly what the reconcile cron now pages
 * on. (That POST had in fact been broken since migration 0248 anyway — its
 * self-minted `conversationId` names no `conversations` row, and the FK 0248
 * added enforces that for every new row.)
 *
 * The GET survives on purpose: during the soak this is how an operator looks
 * at what the legacy table still holds. PR 15 deletes it with the table.
 */

export async function GET(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    loggers.api.debug('🔍 Debug: GET /api/debug/chat-messages', {});

    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const { searchParams } = new URL(request.url);
    const pageId = searchParams.get('pageId');
    const action = searchParams.get('action') || 'list';

    if (action === 'test-db') {
      // Intentionally no page-level auth — only tests DB connectivity, exposes no page data
      loggers.api.debug('🔗 Debug: Testing database connectivity...', {});

      try {
        const result = await db.select().from(chatMessages).limit(1);
        loggers.api.debug('✅ Debug: Database connection successful', {});

        return NextResponse.json({
          success: true,
          message: 'Database connectivity test passed',
          sampleRecordExists: result.length > 0
        });
      } catch (dbError) {
        loggers.api.error('❌ Debug: Database connection failed:', dbError as Error);
        return NextResponse.json({
          success: false,
          error: 'Database connection failed',
          details: dbError instanceof Error ? dbError.message : String(dbError)
        }, { status: 500 });
      }
    }

    if (!pageId) {
      return NextResponse.json({
        error: 'pageId is required for listing messages'
      }, { status: 400 });
    }

    if (!await canUserViewPage(auth.userId, pageId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    loggers.api.debug('📋 Debug: Listing messages for pageId:', { pageId });

    // Get raw database records
    const rawMessages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.pageId, pageId))
      .orderBy(desc(chatMessages.createdAt));

    loggers.api.debug('📊 Debug: Found total records (including inactive)', { count: rawMessages.length });

    // Get active messages only
    const activeMessages = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, pageId),
        eq(chatMessages.isActive, true)
      ))
      .orderBy(chatMessages.createdAt);

    loggers.api.debug('✅ Debug: Found active messages', { count: activeMessages.length });

    return NextResponse.json({
      pageId,
      rawMessageCount: rawMessages.length,
      activeMessageCount: activeMessages.length,
      rawMessages: rawMessages.map(msg => ({
        id: msg.id,
        role: msg.role,
        contentLength: msg.content?.length || 0,
        isActive: msg.isActive,
        createdAt: msg.createdAt,
        userId: msg.userId
      })),
      activeMessages: activeMessages.map(msg => ({
        id: msg.id,
        role: msg.role,
        contentLength: msg.content?.length || 0,
        createdAt: msg.createdAt,
        content: (msg.content ?? '').substring(0, 100) + ((msg.content ?? '').length > 100 ? '...' : '')
      }))
    });

  } catch (error) {
    loggers.api.error('❌ Debug: Error in debug endpoint:', error as Error);
    return NextResponse.json({
      error: 'Debug endpoint failed',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}
