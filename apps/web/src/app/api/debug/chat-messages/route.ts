import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth-utils';
import { db, chatMessages, eq, and, desc } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * Debug endpoint to test chat message persistence
 * GET: View all messages for a pageId or test database connectivity
 * POST: Manually test saving messages
 */

export async function GET(request: Request) {
  try {
    loggers.api.debug('🔍 Debug: GET /api/debug/chat-messages', {});
    
    const { error } = await authenticateRequest(request);
    if (error) return error;

    const { searchParams } = new URL(request.url);
    const pageId = searchParams.get('pageId');
    const action = searchParams.get('action') || 'list';

    if (action === 'test-db') {
      // Test basic database connectivity
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
        content: msg.content?.substring(0, 100) + (msg.content?.length > 100 ? '...' : '')
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

interface TestMessage {
  id: string;
  role: string;
  parts: { type: string; text: string }[];
  createdAt: Date;
}

export async function POST(request: Request) {
  try {
    loggers.api.debug('🧪 Debug: POST /api/debug/chat-messages - Manual save test', {});
    
    const { error } = await authenticateRequest(request);
    if (error) return error;

    const { pageId, testMessages }: { pageId: string; testMessages?: TestMessage[] } = await request.json();

    if (!pageId) {
      return NextResponse.json({ 
        error: 'pageId is required' 
      }, { status: 400 });
    }

    // Create test messages if none provided
    const messagesToSave = testMessages || [
      {
        id: 'test-user-' + Date.now(),
        role: 'user',
        parts: [{ type: 'text', text: 'Test user message from debug endpoint' }],
        createdAt: new Date()
      },
      {
        id: 'test-assistant-' + Date.now(),
        role: 'assistant',
        parts: [{ type: 'text', text: 'Test assistant response from debug endpoint' }],
        createdAt: new Date()
      }
    ];

    loggers.api.debug('💾 Debug: Testing manual save', { messageCount: messagesToSave.length });

    // Direct database insert for test messages
    const messageRecords = messagesToSave.map((msg: TestMessage) => ({
      id: msg.id,
      pageId,
      userId: 'debug-user',
      role: msg.role,
      content: msg.parts?.find(p => p.type === 'text')?.text || '',
      toolCalls: null,
      toolResults: null,
      createdAt: new Date(),
      isActive: true,
    }));

    await db.insert(chatMessages).values(messageRecords);

    loggers.api.debug('✅ Debug: Manual save test completed', {});

    // Verify the save worked
    const savedMessages = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, pageId),
        eq(chatMessages.isActive, true)
      ))
      .orderBy(chatMessages.createdAt);

    return NextResponse.json({
      success: true,
      message: 'Manual save test completed',
      messagesSaved: messagesToSave.length,
      messagesLoaded: savedMessages.length,
      savedMessages: savedMessages.map(msg => ({
        id: msg.id,
        role: msg.role,
        contentLength: msg.content?.length || 0
      }))
    });

  } catch (error) {
    loggers.api.error('❌ Debug: Error in manual save test:', error as Error);
    return NextResponse.json({ 
      error: 'Manual save test failed',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}