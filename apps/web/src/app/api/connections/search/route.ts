import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, or } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { userProfiles } from '@pagespace/db/schema/members'
import { connections } from '@pagespace/db/schema/social';
import { verifyAuth } from '@/lib/auth';
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

    // Get current user's email to check for self-connection
    const [currentUser] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

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

    // Decrypt PII at the edge so the search result shows plaintext name/email —
    // one batched decrypt for the caller + target, once per unique user. The
    // target row goes FIRST: on a self-search both rows share an id and
    // decryptUsersByIdOnce keeps the first row per id, so the full profile row
    // must win over the email-only caller row.
    type SearchUserRow = {
      id: string;
      name: string | null;
      email: string;
      displayName?: string | null;
      bio?: string | null;
      avatarUrl?: string | null;
    };
    const decryptedUsersById = await decryptUsersByIdOnce<SearchUserRow>([
      targetRow ?? null,
      currentUser ? { id: currentUser.id, name: null, email: currentUser.email } : null,
    ]);

    // Decrypted stored email for the self-connection comparison.
    const currentUserEmail = currentUser
      ? decryptedUsersById.get(currentUser.id)?.email ?? null
      : null;
    const isSelf = !!currentUserEmail && email === currentUserEmail;

    const targetUser = targetRow ? decryptedUsersById.get(targetRow.id) : undefined;

    let existingStatus: ConnectionStatus | null = null;
    let target: ConnectionSearchProfile | null = null;

    if (targetUser) {
      target = {
        id: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
        displayName: targetUser.displayName || targetUser.name,
        bio: targetUser.bio ?? null,
        avatarUrl: targetUser.avatarUrl ?? null,
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