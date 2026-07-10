import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, or } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { userProfiles } from '@pagespace/db/schema/members'
import { connections } from '@pagespace/db/schema/social';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { userEmailMatch, decryptUsersByIdOnce } from '@pagespace/lib/auth/user-repository';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import {
  buildConnectionSearchResult,
  type ConnectionStatus,
  type ConnectionSearchProfile,
} from '@/lib/users/enumeration-safe';
import { verifyAuth } from '@/lib/auth/auth';

// GET /api/connections/search - Search for users by email to connect with
export async function GET(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Rate limit per caller — exact-email probe used to enumerate accounts (L2).
    const rateLimit = await checkDistributedRateLimit(
      `connections-search:${user.id}`,
      DISTRIBUTED_RATE_LIMITS.API,
    );
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter ?? 60) } },
      );
    }

    auditRequest(request, { eventType: 'data.read', userId: user.id, resourceType: 'connection_search', resourceId: 'self' });

    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');

    if (!email) {
      return NextResponse.json({ user: null });
    }

    // Find user by exact email match (dual blind-index/raw-email lookup)
    const [targetRow] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        displayName: userProfiles.displayName,
        bio: userProfiles.bio,
        avatarUrl: userProfiles.avatarUrl,
      })
      .from(users)
      .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
      .where(userEmailMatch(email))
      .limit(1);

    // Self-search detection by id: the dual lookup above already resolves the
    // caller's own email — in any letter case, via the normalized blind index —
    // to the caller's row, so no separate fetch-and-decrypt of the caller's
    // stored email is needed. (The old plaintext string compare also missed
    // case-variant self-searches, leaking the caller's own profile as
    // actionable; the id compare closes that.)
    const isSelf = targetRow?.id === user.id;

    // Decrypt PII at the edge so the search result shows plaintext name/email
    // (at most one user here; the batch helper is the shared decrypt path).
    const decryptedUsersById = await decryptUsersByIdOnce([targetRow ?? null]);
    const targetUser = targetRow ? decryptedUsersById.get(targetRow.id) : undefined;

    let existingStatus: ConnectionStatus | null = null;
    let target: ConnectionSearchProfile | null = null;

    if (targetUser) {
      target = {
        id: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
        displayName: targetUser.displayName || targetUser.name,
        bio: targetUser.bio,
        avatarUrl: targetUser.avatarUrl,
      };

      // Check if a connection already exists - select ALL fields (status enum)
      const existingConnections = await db
        .select()
        .from(connections)
        .where(
          or(
            and(
              eq(connections.user1Id, user.id),
              eq(connections.user2Id, targetUser.id)
            ),
            and(
              eq(connections.user1Id, targetUser.id),
              eq(connections.user2Id, user.id)
            )
          )
        )
        .limit(1);

      existingStatus = existingConnections[0]?.status ?? null;
    }

    // Collapse self-search / no-account / any existing-relationship state into a
    // single generic `{ user: null }` so existence and relationship state are not
    // distinguishable (L2). A profile is returned only when a request can be sent.
    return NextResponse.json(
      buildConnectionSearchResult({ isSelf, target, existingStatus }),
    );
  } catch (error) {
    loggers.api.error('Error searching for user:', error as Error);
    return NextResponse.json(
      { error: 'Failed to search user' },
      { status: 500 }
    );
  }
}