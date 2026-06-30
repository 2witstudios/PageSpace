/**
 * Sandbox containment verification (pure).
 *
 * The real security boundary for a full-egress sandbox is NOT the egress
 * allowlist — it is the proof that a Sprite cannot reach the Fly internal surface
 * (the Machines API over 6PN, the org private network, the cloud metadata IP,
 * Flycast, and Tigris). This module turns the raw output of containment probes
 * (run inside a live Sprite) into a deterministic verdict, and exposes the pure
 * enablement decision the provisioning path consults before handing out open
 * egress.
 *
 * Everything here is pure and dependency-free so the security logic is exhaustively
 * unit-tested; the operational side — actually executing the probes inside a Sprite
 * against the live backing topology — is a thin shell + an enablement-gate G-check.
 */

/** A single raw probe result: the exit + captured streams of a connectivity attempt. */
export interface RawProbe {
  /** The internal target the probe attempted to reach (one of CONTAINMENT_TARGETS). */
  target: string;
  /** Process exit code of the probe command (0 = connected). */
  exitCode: number;
  stdout?: string;
  stderr?: string;
  latencyMs?: number;
}

/** A normalized probe result: was the internal target reachable from the Sprite? */
export interface ProbeResult {
  target: string;
  reachable: boolean;
}

/**
 * The internal targets a contained Sprite MUST NOT be able to reach. Keyed names
 * are the canonical identifiers the probe harness emits a result for; the harness
 * maps each to a concrete connectivity command.
 */
export const CONTAINMENT_TARGETS = Object.freeze({
  /** Fly Machines API over 6PN. */
  machinesApi: '_api.internal:4280',
  /** Cloud metadata link-local IP. */
  metadataIp: '169.254.169.254',
  /** Decimal encoding of the metadata IP (SSRF bypass form). */
  metadataDecimal: '2852039166',
  /** Hex encoding of the metadata IP (SSRF bypass form). */
  metadataHex: '0xa9fea9fe',
  /** A sibling app reachable over the org 6PN (fdaa::/8). */
  sixpnPeer: '6pn-peer',
  /** Flycast internal service address. */
  flycast: 'flycast',
  /** Tigris / object-storage internal endpoint. */
  tigris: 'tigris',
} as const);

/** The ordered list of targets every containment assessment requires evidence for. */
export const REQUIRED_CONTAINMENT_TARGETS: readonly string[] = Object.freeze(
  Object.values(CONTAINMENT_TARGETS),
);

// Signatures that POSITIVELY prove a target was unreachable. Anything else on a
// failure is treated as inconclusive → fail-closed (see below). Single linear
// scan, no nested quantifiers (CodeQL js/polynomial-redos safe).
const UNREACHABLE_RE =
  /connection refused|connect: connection refused|\brefused\b|could not resolve|name or service not known|name resolution|\bnxdomain\b|timed out|timeout|no route to host|network is unreachable|host is unreachable|refused to connect/;

// An actual HTTP response means the target answered — reachable regardless of exit.
const HTTP_RESPONSE_RE = /http\/\d/;

/**
 * Normalize one raw probe into a {@link ProbeResult}. Fail-CLOSED: a successful
 * connect, an HTTP response, or any failure we cannot positively classify as
 * "unreachable" is reported as `reachable: true`. Only a recognized unreachable
 * signature on a non-zero exit proves containment for that target — an
 * unparseable/ambiguous result is never accepted as proof of isolation.
 */
export function parseContainmentProbe(raw: RawProbe): ProbeResult {
  const target = typeof raw?.target === 'string' ? raw.target : '';

  // Malformed input or empty target → cannot trust it → fail-closed.
  if (target.length === 0 || typeof raw?.exitCode !== 'number' || Number.isNaN(raw.exitCode)) {
    return { target, reachable: true };
  }

  const text = `${raw.stdout ?? ''}\n${raw.stderr ?? ''}`.toLowerCase();

  // A real HTTP response = the target answered.
  if (HTTP_RESPONSE_RE.test(text)) return { target, reachable: true };

  // Clean connect.
  if (raw.exitCode === 0) return { target, reachable: true };

  // Non-zero exit with a recognized unreachable signature = proven contained.
  if (UNREACHABLE_RE.test(text)) return { target, reachable: false };

  // Non-zero exit we cannot classify → fail-closed (not proof of containment).
  return { target, reachable: true };
}

/**
 * Decide whether the Sprite topology is contained: every required internal target
 * must have been probed AND found unreachable. A missing target (no evidence) or a
 * reachable target is a breach — absence of evidence is never treated as proof of
 * containment.
 */
export function assessContainment(
  results: readonly ProbeResult[],
  requiredTargets: readonly string[] = REQUIRED_CONTAINMENT_TARGETS,
): { contained: boolean; breaches: string[] } {
  const byTarget = new Map<string, ProbeResult>();
  for (const r of results) byTarget.set(r.target, r);

  const breaches: string[] = [];
  for (const target of requiredTargets) {
    const result = byTarget.get(target);
    if (!result || result.reachable) breaches.push(target);
  }
  return { contained: breaches.length === 0, breaches };
}

/** Why a full-egress sandbox may not be provisioned. */
export type FullEgressDenialReason = 'code_execution_disabled' | 'containment_unverified';

export type FullEgressEnablement =
  | { ok: true }
  | { ok: false; reason: FullEgressDenialReason };

/**
 * The authoritative pure decision for whether a FULL-EGRESS sandbox may be handed
 * out. Admin gate has precedence: if code execution is disabled the answer is no
 * regardless of containment. Otherwise containment must be verified
 * (`contained: true`); an unverified (`null`) or breached topology is refused with
 * a distinct `containment_unverified` reason so the boundary is never relaxed on
 * unproven isolation.
 */
export function decideFullEgressEnablement(input: {
  adminGateEnabled: boolean;
  containment: { contained: boolean } | null;
}): FullEgressEnablement {
  if (!input.adminGateEnabled) return { ok: false, reason: 'code_execution_disabled' };
  if (!input.containment || !input.containment.contained) {
    return { ok: false, reason: 'containment_unverified' };
  }
  return { ok: true };
}

/**
 * Whether containment has been verified for the live backing topology — the
 * operational G1 gate. An operator sets `SANDBOX_CONTAINMENT_VERIFIED=true` ONLY
 * after the containment probes pass against real Sprites (see
 * FULL-EGRESS-ENABLEMENT.md). Fail-closed: anything other than the exact string
 * `'true'` (including unset) is treated as UNverified, so full egress is refused
 * until the boundary is proven. Read directly from `process.env` (this also runs
 * in the realtime service, whose lean env fails full schema validation).
 */
export function isContainmentVerified(): boolean {
  return process.env.SANDBOX_CONTAINMENT_VERIFIED === 'true';
}
