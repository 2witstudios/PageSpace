/**
 * Single source of truth for a sandbox's network options (pure).
 *
 * Both surfaces — agent sandboxes and human terminals — now run FULL (open)
 * egress. The agent sandbox previously ran a tight named allowlist; that allowlist
 * was never the real security boundary (Sprites egress policy is DNS-name-only and
 * cannot match IP-literal/6PN egress). The boundary is the microVM isolation +
 * verified containment off the Fly internal surface (see `containment.ts`), plus
 * the explicit internal-surface denies baked into open-mode policy construction
 * (see `egress.ts`). Unifying both surfaces here keeps the posture consistent and
 * leaves one place to evolve.
 *
 * Provisioning is still gated: the full-egress enablement check
 * (`decideFullEgressEnablement`) refuses to hand out an open-egress sandbox while
 * containment is unverified. This resolver only describes the desired options; it
 * never decides whether provisioning is allowed.
 */

import { SANDBOX_RESOURCE_CAPS } from './execution-policy';
import type { SandboxCreateOptions } from './sandbox-options';

/** The two sandbox surfaces that share the network posture. */
export type SandboxSurface = 'agent' | 'terminal';

/**
 * Resolve the create-time network options for a sandbox surface. Both surfaces get
 * open egress + the standard resource caps; the internal-surface deny is applied at
 * policy-construction time from `egressMode: 'open'`.
 */
export function resolveSandboxNetworkOptions(_input: { surface: SandboxSurface }): SandboxCreateOptions {
  return {
    egressMode: 'open',
    caps: SANDBOX_RESOURCE_CAPS,
  };
}
