/**
 * Stream Abort Registry
 *
 * Manages AbortControllers for active AI streams, enabling explicit user-initiated
 * abort while allowing streams to complete server-side on client disconnect.
 *
 * Flow:
 * 1. Server creates AbortController and registers with streamId
 * 2. streamId sent to client via response header
 * 3. Client calls abort endpoint with streamId when user clicks stop
 * 4. Server looks up controller and aborts the stream
 * 5. Cleanup happens automatically via onFinish or timeout
 */

import { createId } from '@paralleldrive/cuid2';

interface StreamEntry {
  controller: AbortController;
  createdAt: number;
}

const registry = new Map<string, StreamEntry>();

// Cleanup streams older than 10 minutes (safety net for orphaned entries)
const MAX_STREAM_AGE_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

const startCleanupInterval = () => {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [streamId, entry] of registry.entries()) {
      if (now - entry.createdAt > MAX_STREAM_AGE_MS) {
        registry.delete(streamId);
      }
    }
  }, CLEANUP_INTERVAL_MS);
};

/**
 * Create and register a new AbortController for a stream
 * Returns the streamId and AbortSignal to use with streamText
 */
export const createStreamAbortController = ({
  streamId = createId(),
}: { streamId?: string } = {}): {
  streamId: string;
  signal: AbortSignal;
  controller: AbortController;
} => {
  startCleanupInterval();

  const controller = new AbortController();
  registry.set(streamId, {
    controller,
    createdAt: Date.now(),
  });

  return {
    streamId,
    signal: controller.signal,
    controller,
  };
};

/**
 * Abort a stream by its ID
 * Returns true if stream was found and aborted, false if not found
 */
export const abortStream = ({
  streamId,
}: {
  streamId: string;
}): { aborted: boolean; reason: string } => {
  const entry = registry.get(streamId);

  if (!entry) {
    return { aborted: false, reason: 'Stream not found or already completed' };
  }

  entry.controller.abort();
  registry.delete(streamId);

  return { aborted: true, reason: 'Stream aborted by user request' };
};

/**
 * Remove a stream from the registry (call in onFinish)
 */
export const removeStream = ({ streamId }: { streamId: string }): void => {
  registry.delete(streamId);
};

/**
 * Check if a stream is registered and active
 */
export const isStreamActive = ({ streamId }: { streamId: string }): boolean => {
  return registry.has(streamId);
};

/**
 * Get the count of active streams (for monitoring/debugging)
 */
export const getActiveStreamCount = (): number => {
  return registry.size;
};

// Header name for passing stream ID to client
export const STREAM_ID_HEADER = 'X-Stream-Id';
