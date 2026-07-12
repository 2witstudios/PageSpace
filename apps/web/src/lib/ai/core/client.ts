/**
 * Client-only exports from @/lib/ai/core
 *
 * Import from '@/lib/ai/core/client' in React components.
 * DO NOT import in server routes - this file has 'use client' dependencies.
 */

export {
  abortActiveStream,
  abortActiveStreamByConversation,
  abortActiveStreamByMessageId,
  createStreamTrackingFetch,
  setActiveStreamId,
  getActiveStreamId,
  clearActiveStreamId,
  reportAbortOutcome,
  reportAbortOutcomes,
  type AbortResult,
} from './stream-abort-client';

export { getBrowserSessionId } from './browser-session-id';
