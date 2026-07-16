/**
 * The seam between "who gets this and in what order" and "how it physically ships".
 *
 * Phase 1 has exactly one implementation (`transactional-engine.ts`: one rate-limited
 * Resend send per recipient). Phase 2 adds a Resend Broadcasts engine that batches an
 * uploaded audience instead. The interface exists from day one because the two differ in
 * how they send and in nothing else that matters: the exclusions, the resume set, and the
 * unsubscribe contract must be identical either way, so they live outside the engine and
 * the engine stays small enough that a second one cannot quietly diverge from them.
 */

import type { PreflightResult } from './core';

/** One person an engine is about to mail. */
export interface BroadcastRecipientInput {
  userId: string;
  userName: string;
  email: string;
}

export interface BroadcastEnginePreflightInput {
  live: boolean;
  baseUrl: string;
  /** null = the erasure-suppression audience could not be read (fail closed). */
  suppressed: Set<string> | null;
  isOnPrem: boolean;
  fromEmail?: string;
}

export interface BroadcastEngine {
  /** Stable identifier, matching the `email_broadcast_engine` enum value. */
  readonly name: string;

  /**
   * The guards that must pass before this engine may send anything live. An engine may
   * add its own on top of the shared `core.preflight` checks, but may not skip them.
   */
  preflight(input: BroadcastEnginePreflightInput): Promise<PreflightResult>;

  /** Send to one recipient. Throwing marks that recipient failed and retryable. */
  sendOne(recipient: BroadcastRecipientInput): Promise<void>;

  /**
   * Render what `sendOne` would send, without sending it. Used by dry runs so a template
   * error surfaces before the live send rather than during it.
   */
  renderOne(recipient: BroadcastRecipientInput): Promise<string>;
}