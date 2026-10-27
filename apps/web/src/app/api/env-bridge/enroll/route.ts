/**
 * Env-bridge enrollment — `POST /api/env-bridge/enroll`.
 *
 * The daemon on a user's machine presents the ONE-TIME code the user was shown
 * when they created a local environment, together with the public half of the
 * keypair it just generated. The server verifies the code (single use, short
 * TTL, hash at rest), pins the key, and answers with its own public signing
 * key for the daemon to pin in return (Local Environments epic, invariants 2
 * and 3).
 *
 * UNAUTHENTICATED by design: the machine has no session yet — the code IS the
 * credential, and it is spent by this call. What stands in for auth: the
 * per-IP and per-enrollment rate limits below (a 100-bit code cannot be
 * brute-forced, but the endpoint should still not be a free oracle), the
 * cloud opt-in flag (off ⇒ 404, the route does not exist), and an audit row
 * for every refusal.
 *
 *   body   { enrollmentId, code, machinePublicKey (base64 SPKI DER) }
 *   200    { enrollmentId, envId, serverKeyId, serverPublicKey (base64 SPKI DER), ownerId, serverPolicy, ownerCredentials }
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getClientIP } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { enrollLocalEnv } from '@/lib/drive-envs/drive-envs-runtime';

const bodySchema = z
  .object({
    enrollmentId: z.string().min(1).max(128),
    code: z.string().min(1).max(64),
    machinePublicKey: z.string().min(1).max(512),
  })
  .strict();

/** A machine enrolls once; a handful of retries covers a mistyped code. */
const ENROLL_RATE_LIMIT_PER_IP = { maxAttempts: 10, windowMs: 60_000 };
const ENROLL_RATE_LIMIT_PER_ENROLLMENT = { maxAttempts: 5, windowMs: 10 * 60_000 };

const STATUS_FOR_REASON = {
  not_found: 404,
  revoked: 410,
  expired: 410,
  used: 409,
  already_enrolled: 409,
  race: 409,
  // The owner's passkeys could not be read, so nothing was pinned and the code
  // was NOT spent (hardening B, leaf B1): pinning an empty set on a database
  // hiccup would silently cost the owner chat approvals forever. Retryable.
  owner_credentials_unavailable: 503,
  mismatch: 401,
  malformed: 400,
  bad_public_key: 400,
} as const;

export async function POST(request: Request) {
  // Off ⇒ the route does not exist. No hint that local envs are a thing here.
  if (!isLocalEnvsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const ip = getClientIP(request);
  const ipLimit = await checkDistributedRateLimit(`env-bridge-enroll:ip:${ip}`, ENROLL_RATE_LIMIT_PER_IP);
  if (!ipLimit.allowed) {
    auditRequest(request, { eventType: 'security.rate.limited', details: { route: 'env-bridge/enroll', scope: 'ip' } });
    return NextResponse.json({ error: 'Too many enrollment attempts' }, { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfter || 60) } });
  }

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'enrollmentId, code and machinePublicKey are required' }, { status: 400 });
  const { enrollmentId, code, machinePublicKey } = parsed.data;

  const enrollmentLimit = await checkDistributedRateLimit(`env-bridge-enroll:enrollment:${enrollmentId}`, ENROLL_RATE_LIMIT_PER_ENROLLMENT);
  if (!enrollmentLimit.allowed) {
    auditRequest(request, { eventType: 'security.rate.limited', details: { route: 'env-bridge/enroll', scope: 'enrollment', enrollmentId } });
    return NextResponse.json({ error: 'Too many enrollment attempts' }, { status: 429, headers: { 'Retry-After': String(enrollmentLimit.retryAfter || 60) } });
  }

  const result = await enrollLocalEnv({ enrollmentId, code, machinePublicKey });
  if (!result.ok) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      resourceType: 'drive_env_enrollment',
      resourceId: enrollmentId,
      riskScore: result.reason === 'mismatch' ? 0.5 : 0.2,
      details: { route: 'env-bridge/enroll', reason: result.reason },
    });
    return NextResponse.json({ error: `Enrollment refused: ${result.reason}`, reason: result.reason }, { status: STATUS_FOR_REASON[result.reason] });
  }

  auditRequest(request, {
    eventType: 'auth.token.created',
    resourceType: 'drive_env',
    resourceId: result.envId,
    details: { route: 'env-bridge/enroll', enrollmentId: result.enrollmentId, serverKeyId: result.serverKeyId, kind: 'machine_key_pinned' },
  });
  // `ownerId` is the enrolling user's id — no secret, and exactly what the
  // machine needs to scaffold `principals: [owner]` in its own policy (D-6).
  // `serverPolicy` is the env's allow-set — no secret either (the owner chose
  // it in the dialog), and what the machine needs to scaffold the file ops it
  // may run headless (GA wave 2, Tier A). The enroller never scaffolds `exec`.
  // `ownerCredentials` is the owner's PASSKEY PUBLIC KEYS plus the rpId and
  // origin an assertion must be made under (hardening B, leaf B1). No secret
  // — a public key verifies signatures and cannot make them — and it is the
  // one thing that lets the machine stop taking this server's word that a
  // human clicked. Pinned once, here; nothing may add to it afterwards.
  return NextResponse.json({
    enrollmentId: result.enrollmentId,
    envId: result.envId,
    serverKeyId: result.serverKeyId,
    serverPublicKey: result.serverPublicKey,
    ownerId: result.ownerId,
    serverPolicy: result.serverPolicy,
    ownerCredentials: result.ownerCredentials,
  });
}
