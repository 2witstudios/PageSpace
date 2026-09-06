/**
 * The preview proxy's FORWARD decision — pure, zero IO.
 *
 * Every request that reaches the proxy (HTTP in the web tier, WebSocket
 * upgrade in the realtime tier) asks ONE question before a byte leaves for
 * the sprite: may this request be forwarded, and would forwarding it wake a
 * hibernated VM that this user is not entitled to wake? Both tiers answer it
 * here, from data, so the two halves of the proxy cannot drift.
 *
 * ORDER IS THE SECURITY PROPERTY. The checks run cheapest-and-most-refusing
 * first, and nothing later in the list is consulted when an earlier one
 * refuses:
 *
 *  1. the feature gate — dark means the surface does not exist (404);
 *  2. the holder's drive/session gate, re-run PER REQUEST by the caller
 *     (`decideAgentSessionAccess` for a session preview, drive membership +
 *     env-belongs-to-drive for an env preview) — a denial here means the
 *     request never learns whether a sprite, a preview or a relay exists,
 *     and NEVER wakes anything (spike §6: an inbound URL request wakes a
 *     paused sprite even when nothing answers, so a denied request that was
 *     forwarded "just to see" would bill the payer for a stranger's probe);
 *  3. the preview's own state, as `describeServiceState` folds the row with
 *     the live service read — rendered from a control-plane read only,
 *     never a probe (the never-probe-to-render rule): `stale` (the row names
 *     a VM that no longer exists) is refused, never routed, never woken;
 *  4. the WAKE gate — only reached for a live preview on a sprite that is not
 *     currently `running`. A request to a paused sprite IS a wake, and a wake
 *     is a billable act on the holder's payer, so it is authorized on the
 *     same posture as a session ensure: the centralized `canRunCode` check
 *     (kill switch, payer tier, drive edit access). The caller consults it
 *     lazily — this decision says `needs-wake-gate` and is re-asked with the
 *     answer — so the gate's DB reads happen only when a wake is actually on
 *     the table. `'unknown'` power state is treated as a possible wake (fail
 *     closed on the billing question, never awake by assumption).
 *
 * The decision names a suggested HTTP status and a reason code; the caller
 * maps them onto its own not-found/denied policy (the session family answers
 * an unknown id and a denied one identically — see
 * `workspace-unavailable-response.ts`).
 */

import type { CanRunCodeResult } from '../can-run-code';
import type { SandboxPowerState } from '../sandbox-host';
import type { DevPreviewServiceState } from './dev-preview-core';

export type PreviewAuthz = { allowed: true } | { allowed: false; reason: string };

export interface PreviewForwardInput {
  /** `isDevPreviewEnabled()` — asked first so a dark deployment reveals nothing. */
  featureEnabled: boolean;
  /** The holder's own gate, re-run for THIS request by the caller. */
  authz: PreviewAuthz;
  /**
   * The preview's state from `describeServiceState`, or `null` when the
   * caller could not attach to the holder's sprite at all (no live pointer,
   * or the control plane says it is gone) — which is "no preview", not an
   * error to surface.
   */
  state: DevPreviewServiceState | null;
  /** The sprite's power state from a control-plane read; `null` when unreadable (treated as a possible wake). */
  power: SandboxPowerState | null;
  /**
   * The wake gate's answer, once the caller has consulted it; `'not-consulted'`
   * on the first pass. Never consulted — and never needed — when the
   * sprite is `running`.
   */
  wakeAuthorization: CanRunCodeResult | 'not-consulted';
}

export type PreviewForwardDecision =
  | {
      kind: 'forward';
      /** True when the sprite is not running and this forward will wake it (authorized above). For the access log. */
      wake: boolean;
    }
  | {
      /** The sprite is not running: consult `canRunCode` on the holder's payer and ask again. */
      kind: 'needs-wake-gate';
    }
  | {
      kind: 'refuse';
      reason:
        | 'feature-disabled'
        | 'not-authorized'
        | 'no-preview'
        | 'instance-unknown'
        | 'stale-instance'
        | 'stopped-by-user'
        | 'http-port-busy'
        | 'preview-down'
        | 'preview-starting'
        | 'wake-denied';
      /** Suggested HTTP status; the caller's not-found/denied policy may collapse it. */
      status: 403 | 404 | 409 | 502 | 503;
      /** Human copy for the response body — never a sprite name, URL or token. */
      message: string;
      /** The gate's own reason, for the audit trail (never the response body). */
      detail?: string;
    };

/** Pure: may this request be forwarded to the holder's sprite, and is it a wake? */
export function decidePreviewForward(input: PreviewForwardInput): PreviewForwardDecision {
  if (!input.featureEnabled) {
    return { kind: 'refuse', reason: 'feature-disabled', status: 404, message: 'Not found' };
  }
  if (!input.authz.allowed) {
    return { kind: 'refuse', reason: 'not-authorized', status: 404, message: 'Not found', detail: input.authz.reason };
  }

  const state = input.state;
  if (state === null || state.status === 'none') {
    return { kind: 'refuse', reason: 'no-preview', status: 404, message: 'No dev server is being previewed in this sandbox.' };
  }
  switch (state.status) {
    case 'instance-unknown':
      return { kind: 'refuse', reason: 'instance-unknown', status: 409, message: state.message };
    case 'stale':
      return { kind: 'refuse', reason: 'stale-instance', status: 409, message: state.message };
    case 'stopped':
      return { kind: 'refuse', reason: 'stopped-by-user', status: 409, message: state.message };
    case 'blocked':
      return { kind: 'refuse', reason: 'http-port-busy', status: 409, message: state.message };
    case 'down':
      return { kind: 'refuse', reason: 'preview-down', status: 502, message: state.message };
    case 'starting':
      return { kind: 'refuse', reason: 'preview-starting', status: 503, message: state.message };
    case 'live':
      break;
  }

  if (input.power === 'running') return { kind: 'forward', wake: false };

  // Not running (paused), or not provably running (unknown / unreadable):
  // forwarding is a wake, and a wake needs the code-execution posture.
  if (input.wakeAuthorization === 'not-consulted') return { kind: 'needs-wake-gate' };
  if (!input.wakeAuthorization.ok) {
    return {
      kind: 'refuse',
      reason: 'wake-denied',
      status: 403,
      message: 'This sandbox is asleep, and you are not permitted to wake it.',
      detail: input.wakeAuthorization.reason,
    };
  }
  return { kind: 'forward', wake: true };
}
