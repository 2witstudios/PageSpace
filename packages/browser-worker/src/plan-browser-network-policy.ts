/**
 * The Sprite DNS policy for a browser Sprite — the hostname BACKSTOP under
 * the worker's egress proxy (S3 §3.5, third layer), pure.
 *
 * DNS cannot express scheme or port, so this is never the control; the proxy
 * is. What it adds: no process in the browser Sprite — Chromium, the worker,
 * anything — can even resolve a name outside the set, which bounds the
 * proxy's own reach and closes a direct-resolution bypass. Built from
 * `egress.ts`'s internal-surface deny rules and allowlist sanitizer so the
 * agent sandbox and the browser share one definition of "internal", plus a
 * deny on every Sprite edge URL: a browser has no business reaching another
 * sandbox. Denies are exact or `*.` wildcards, which beat the global rule
 * under the platform's specificity precedence.
 */
import { buildInternalSurfaceDenyRules, sanitizeEgressAllowlist } from '@pagespace/lib/services/sandbox/egress';

export type BrowserPolicyRule = { readonly domain: string; readonly action: 'allow' | 'deny' };
export type BrowserNetworkPolicy = { readonly rules: readonly BrowserPolicyRule[] };

export type PlanBrowserNetworkPolicyOptions = { readonly allowedOrigins: readonly string[] | null };

const SANDBOX_EDGE_ZONE = 'sprites.app';

const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
};

const isSandboxEdge = (host: string): boolean => host === SANDBOX_EDGE_ZONE || host.endsWith(`.${SANDBOX_EDGE_ZONE}`);

export const planBrowserNetworkPolicy = ({ allowedOrigins }: PlanBrowserNetworkPolicyOptions): BrowserNetworkPolicy => {
  const denies: readonly BrowserPolicyRule[] = [
    ...buildInternalSurfaceDenyRules().map((rule) => ({ domain: String(rule.domain), action: 'deny' as const })),
    { domain: SANDBOX_EDGE_ZONE, action: 'deny' },
    { domain: `*.${SANDBOX_EDGE_ZONE}`, action: 'deny' },
  ];
  if (allowedOrigins === null) return { rules: [...denies, { domain: '*', action: 'allow' }] };

  const hosts = sanitizeEgressAllowlist(allowedOrigins.flatMap((origin) => hostOf(origin) ?? [])).filter((host) => !isSandboxEdge(host));
  return { rules: [...denies, ...hosts.map((domain) => ({ domain, action: 'allow' as const })), { domain: '*', action: 'deny' }] };
};
