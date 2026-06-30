/**
 * Dedicated egress-IP attribution for sandboxes (pure).
 *
 * Fly's DEFAULT outbound egress is a SHARED NAT IPv4 pool — so abuse from a
 * compromised full-egress sandbox would blocklist an IP that production traffic
 * may share. To keep abuse attributable and protect prod reputation, sandbox
 * egress should leave via a DEDICATED egress IP (allocated per the deploy note
 * below), tagged here so the driver/ops layer can pin it.
 *
 * This resolver is pure (the caller reads the env). When no dedicated tag is
 * configured it falls back to a sandbox-scoped default and reports
 * `dedicated: false` so the enablement checklist can flag that the attribution
 * guarantee is degraded.
 *
 * ── DEPLOY NOTE (PageSpace-Deploy / Fly ops) ─────────────────────────────────
 * Allocate a dedicated egress IP for the sandbox pool, separate from the prod
 * apps' shared NAT pool, and expose its tag via SANDBOX_EGRESS_IP_TAG:
 *   fly machine egress ip allocate -a <sandbox-app>     # ~$3.60/mo per IPv4
 * Pin sandbox VMs to that app/region so their outbound is attributable to that IP.
 * Until this is done, sandbox abuse shares prod IP reputation (degraded mode).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { SandboxSurface } from './network-options';

const DEFAULT_EGRESS_TAG = 'sandbox-egress-default';

/**
 * Resolve the egress-IP attribution tag for a sandbox surface. A configured
 * (non-empty) tag is dedicated; an unset/blank tag falls back to a sandbox-scoped
 * default with `dedicated: false` (degraded attribution).
 */
export function resolveEgressIpTag({
  configuredTag,
}: {
  surface: SandboxSurface;
  configuredTag?: string | null;
}): { tag: string; dedicated: boolean } {
  const trimmed = (configuredTag ?? '').trim();
  if (trimmed.length === 0) {
    return { tag: DEFAULT_EGRESS_TAG, dedicated: false };
  }
  return { tag: trimmed, dedicated: true };
}
