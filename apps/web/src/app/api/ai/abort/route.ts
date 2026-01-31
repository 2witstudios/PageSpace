import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { abortStream } from '@/lib/ai/core/stream-abort-registry';
import { loggers } from '@pagespace/lib/logger';

/**
 * POST /api/ai/abort
 *
 * Explicitly abort an AI stream by its ID.
 * Used when user clicks the stop button - distinct from client disconnect.
 */
export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { streamId } = await request.json();

    if (!streamId || typeof streamId !== 'string') {
      return NextResponse.json(
        { error: 'streamId is required' },
        { status: 400 }
      );
    }

    const result = abortStream({ streamId });

    loggers.api.info('AI stream abort requested', {
      streamId,
      aborted: result.aborted,
      reason: result.reason,
    });

    return NextResponse.json(result);
  } catch (error) {
    loggers.api.error('Error aborting AI stream', { error });
    return NextResponse.json(
      { error: 'Failed to abort stream' },
      { status: 500 }
    );
  }
}
