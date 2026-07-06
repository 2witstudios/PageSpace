import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, or, ilike, isNotNull } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { userProfiles } from '@pagespace/db/schema/members';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { userEmailMatch, decryptUserRows } from '@pagespace/lib/auth/user-repository';
import { parseBoundedIntParam } from '@/lib/utils/query-params';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import {
  buildPublicProfileResult,
  buildExactEmailMatchResult,
} from '@/lib/users/enumeration-safe';

export async function GET(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');
    const limit = parseBoundedIntParam(searchParams.get('limit'), {
      defaultValue: 10,
      min: 1,
      max: 50,
    });

    if (!query || query.length < 2) {
      return NextResponse.json({ users: [] });
    }

    // Rate limit real searches per user. An unanchored 2-char substring search
    // iterated `aa..zz` is the email-harvest vector (M3); capping per-user
    // request volume is defense in depth on top of dropping email below.
    const rateLimit = await checkDistributedRateLimit(
      `users-search:${user.id}`,
      DISTRIBUTED_RATE_LIMITS.API,
    );
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter ?? 60) } },
      );
    }

    // Search for users by username, display name, or email
    // Only search public profiles or exact email matches
    const searchPattern = `%${query}%`;

    // First, search in user profiles (public only).
    // The inner join on users + isNotNull(emailVerified) excludes temp users
    // created by pending magic-link invites — those accounts have no human
    // behind them and must not surface as invite targets.
    //
    // Email is deliberately NOT selected here (M3): a public-profile substring
    // match must never carry an email — that is not part of the public-profile
    // model. Only the exact-email-match branch below (where the caller already
    // supplied the full address) may surface an email.
    const profileResults = await db.select({
      userId: userProfiles.userId,
      username: userProfiles.username,
      displayName: userProfiles.displayName,
      bio: userProfiles.bio,
      avatarUrl: userProfiles.avatarUrl,
    })
    .from(userProfiles)
    .leftJoin(users, eq(userProfiles.userId, users.id))
    .where(
      and(
        eq(userProfiles.isPublic, true),
        isNotNull(users.emailVerified),
        or(
          ilike(userProfiles.username, searchPattern),
          ilike(userProfiles.displayName, searchPattern)
        )
      )
    )
    .limit(limit);

    // Also search by email (exact match for privacy).
    // emailVerified IS NOT NULL is the gate that closes Review C1: an admin
    // searching `bob@example.com` while bob holds only a pending invite from
    // another drive used to get a clickable result and could fall into the
    // userId path which auto-accepts. Temp users now stay invisible.
    const emailRows = await db.select({
      userId: users.id,
      email: users.email,
      name: users.name,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(and(userEmailMatch(query), isNotNull(users.emailVerified)))
    .limit(1);
    // Decrypt PII at the edge so the exact-email match surfaces plaintext name/email.
    const emailResults = await decryptUserRows(emailRows);

    // Combine results, avoiding duplicates
    const userMap = new Map<string, ReturnType<typeof buildPublicProfileResult>>();

    // Add profile results — public-profile shape, no email (M3).
    for (const result of profileResults) {
      userMap.set(result.userId, buildPublicProfileResult(result));
    }

    // Add email results if not already in map. These are exact-email matches,
    // so the caller already knows the address and the result may carry it.
    // Defense in depth: even if the DB layer returns an unverified row,
    // drop it here so search can never surface a temp user.
    for (const result of emailResults) {
      if (result.emailVerified === null) continue;
      if (!userMap.has(result.userId)) {
        // Check if this user has a profile
        const profile = await db.select()
          .from(userProfiles)
          .where(eq(userProfiles.userId, result.userId))
          .limit(1);

        const base = profile.length > 0
          ? buildPublicProfileResult({
              userId: result.userId,
              username: profile[0].username,
              displayName: profile[0].displayName,
              bio: profile[0].bio,
              avatarUrl: profile[0].avatarUrl,
            })
          : buildPublicProfileResult({
              userId: result.userId,
              username: null,
              displayName: result.name || 'Unknown User',
              bio: null,
              avatarUrl: null,
            });

        userMap.set(result.userId, buildExactEmailMatchResult(base, result.email));
      }
    }

    const userResults = Array.from(userMap.values());

    auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'user_search', resourceId: user.id, details: { queryLength: query.length, resultCount: userResults.length } });

    return NextResponse.json({ users: userResults });
  } catch (error) {
    loggers.api.error('Error searching users:', error as Error);
    return NextResponse.json(
      { error: 'Failed to search users' },
      { status: 500 }
    );
  }
}
