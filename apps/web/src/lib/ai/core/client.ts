/**
 * Client-only exports from @/lib/ai/core
 *
 * Import from '@/lib/ai/core/client' in React components.
 * DO NOT import in server routes - this file has 'use client' dependencies.
 */

export {
  abortActiveStream,
  createStreamTrackingFetch,
  setActiveStreamId,
  getActiveStreamId,
  clearActiveStreamId,
} from './stream-abort-client';
