import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { userEmailMatch, decryptUserRow } from '@pagespace/lib/auth/user-repository';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { callerCanViewUser } from '@/lib/users/visibility';
import { resolveFindUser } from '@/lib/users/enumeration-safe';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false } as const;

export async function GET(request: Request) {
  // Support both Bearer tokens (desktop) and cookies (web)
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');

  if (!email) {
    return NextResponse.json({ error: 'Email parameter is missing' }, { status: 400 });
  }

  // Rate limit per caller — this is an exact-email existence probe (L1); cap how
  // fast one account can test addresses.
  const rateLimit = await checkDistributedRateLimit(
    `users-find:${auth.userId}`,
    DISTRIBUTED_RATE_LIMITS.API,
  );
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter ?? 60) } },
    );
  }

  try {
    const candidateRow = await db.query.users.findFirst({
      where: userEmailMatch(email),
      columns: { id: true, name: true, email: true, image: true },
    });
    // Decrypt PII at the edge so downstream visibility + response see plaintext.
    const candidate = candidateRow ? await decryptUserRow(candidateRow) : undefined;

    // Relationship scoping (L1): only surface a user's identity to a caller who
    // already shares context (a drive or accepted connection) — or to the user
    // themselves. "No such account" and "exists but not visible to you" collapse
    // into the SAME 404, so the endpoint can no longer be used to enumerate which
    // emails have accounts or to harvest names/avatars.
    const callerCanView = candidate
      ? await callerCanViewUser(auth.userId, candidate.id)
      : false;
    const outcome = resolveFindUser(candidate ?? null, auth.userId, callerCanView);

    if (!outcome.found) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'user_search', resourceId: outcome.user.id, details: { queryLength: email.length, resultCount: 1 } });

    return NextResponse.json(outcome.user);
  } catch (error) {
    loggers.api.error('Error finding user:', error as Error);
    return NextResponse.json({ error: 'Failed to find user' }, { status: 500 });
  }
}