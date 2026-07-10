import { db } from '@pagespace/db/db'
import { and, eq, inArray, desc, count, sql } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { drives, pages, chatMessages } from '@pagespace/db/schema/core'
import { messages } from '@pagespace/db/schema/conversations'
import { subscriptions } from '@pagespace/db/schema/subscriptions'
import { sessions } from '@pagespace/db/schema/sessions'
import { stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { decryptUserRows } from '@pagespace/lib/auth/user-repository';
import { parseListUsersParams, matchesSearch, compareUsers, isDormant } from './list-params';
import { withAdminAuth } from '@/lib/auth/auth';

/**
 * GET /api/admin/users — paginated users list.
 *
 * Query params: limit, offset, q, sort (name|email|created|lastActive|tier),
 * dir (asc|desc), dormant=true, suspended=true.
 *
 * Search/sort happen after decryption (name/email are ciphertext at rest —
 * see list-params.ts); the expensive per-user enrichment (content stats,
 * Stripe gift lookups) only runs for the requested page.
 */
export const GET = withAdminAuth(async (_adminUser, _request) => {
  try {
    const params = parseListUsersParams(new URL(_request.url));
    if (!params) {
      return Response.json({ error: 'Invalid query parameters' }, { status: 400 });
    }

    // Light projection of every user (no content stats yet).
    const rawUsers = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        image: users.image,
        currentAiProvider: users.currentAiProvider,
        currentAiModel: users.currentAiModel,
        tokenVersion: users.tokenVersion,
        subscriptionTier: users.subscriptionTier,
        stripeCustomerId: users.stripeCustomerId,
        role: users.role,
        suspendedAt: users.suspendedAt,
        suspendedReason: users.suspendedReason,
        createdAt: users.createdAt,
      })
      .from(users);

    // name/email are encrypted at rest; decrypt before any search/sort/display.
    const decryptedUsers = await decryptUserRows(rawUsers);

    // Last active across ALL sessions regardless of revoked state — a user who
    // was active yesterday and then logged out still has a recent lastActiveAt.
    // COALESCE handles sessions where lastUsedAt was never set.
    const [lastActiveDates, [driveTotal], [pageTotal], [chatMessageTotal], [globalMessageTotal]] = await Promise.all([
      db.select({
        userId: sessions.userId,
        lastActiveAt: sql<Date>`MAX(COALESCE(${sessions.lastUsedAt}, ${sessions.createdAt}))`,
      })
        .from(sessions)
        .groupBy(sessions.userId),
      db.select({ count: count() }).from(drives),
      db.select({ count: count() }).from(pages),
      db.select({ count: count() }).from(chatMessages),
      db.select({ count: count() }).from(messages),
    ]);

    const lastActiveMap = new Map<string, Date | null>(
      lastActiveDates.map(row => [row.userId, row.lastActiveAt ?? null])
    );

    const allUsers = decryptedUsers.map(user => ({
      ...user,
      lastActiveAt: lastActiveMap.get(user.id) ?? null,
    }));

    const now = Date.now();
    const summary = {
      totalUsers: allUsers.length,
      verifiedUsers: allUsers.filter(u => u.emailVerified).length,
      dormantUsers: allUsers.filter(u => isDormant(u.lastActiveAt, now)).length,
      suspendedUsers: allUsers.filter(u => u.suspendedAt != null).length,
      totalDrives: Number(driveTotal?.count ?? 0),
      totalPages: Number(pageTotal?.count ?? 0),
      totalMessages: Number(chatMessageTotal?.count ?? 0) + Number(globalMessageTotal?.count ?? 0),
    };

    // Filter → sort → page.
    const normalizedQuery = params.q.toLowerCase();
    let matched = allUsers.filter(user => matchesSearch(user, normalizedQuery));
    if (params.dormant === 'true') matched = matched.filter(u => isDormant(u.lastActiveAt, now));
    if (params.suspended === 'true') matched = matched.filter(u => u.suspendedAt != null);

    const comparator = compareUsers(params.sort);
    matched.sort((a, b) => (params.dir === 'desc' ? -comparator(a, b) : comparator(a, b)));

    const total = matched.length;
    const pageOfUsers = matched.slice(params.offset, params.offset + params.limit);
    const userIds = pageOfUsers.map(user => user.id);

    // Enrich the current page only.
    const [activeSubscriptions, driveCounts, pageCounts, chatMessageCounts, globalMessageCounts] =
      userIds.length === 0
        ? [[], [], [], [], []]
        : await Promise.all([
          db.select()
            .from(subscriptions)
            .where(and(
              inArray(subscriptions.status, ['active', 'trialing']),
              inArray(subscriptions.userId, userIds)
            ))
            .orderBy(desc(subscriptions.updatedAt)),
          db.select({
            userId: drives.ownerId,
            count: count(),
          })
            .from(drives)
            .where(inArray(drives.ownerId, userIds))
            .groupBy(drives.ownerId),
          db.select({
            userId: drives.ownerId,
            count: count(),
          })
            .from(pages)
            .innerJoin(drives, eq(pages.driveId, drives.id))
            .where(inArray(drives.ownerId, userIds))
            .groupBy(drives.ownerId),
          db.select({
            userId: chatMessages.userId,
            count: count(),
          })
            .from(chatMessages)
            .where(inArray(chatMessages.userId, userIds))
            .groupBy(chatMessages.userId),
          db.select({
            userId: messages.userId,
            count: count(),
          })
            .from(messages)
            .where(inArray(messages.userId, userIds))
            .groupBy(messages.userId),
        ]);

    // Rows are ordered newest-first; keep the FIRST row per user (Map
    // construction would let later, older duplicates overwrite it).
    const subscriptionsByUserId = new Map<string, typeof activeSubscriptions[number]>();
    for (const sub of activeSubscriptions) {
      if (!subscriptionsByUserId.has(sub.userId)) subscriptionsByUserId.set(sub.userId, sub);
    }

    const toCountMap = (rows: Array<{ userId: string | null; count: unknown }>) => {
      const map = new Map<string, number>();
      for (const row of rows) {
        if (!row.userId) continue;
        map.set(row.userId, Number(row.count ?? 0));
      }
      return map;
    };

    const drivesCountMap = toCountMap(driveCounts);
    const pagesCountMap = toCountMap(pageCounts);
    const chatMessagesCountMap = toCountMap(chatMessageCounts);
    const globalMessagesCountMap = toCountMap(globalMessageCounts);

    // Gift attribution (giftedBy/reason) lives only in Stripe metadata, but
    // whether a sub IS gifted lives in the local `gifted` column — so only
    // gifted subs (the rare subset) pay a Stripe round-trip, not every
    // subscribed user on the page.
    const stripeSubscriptionDetails = new Map<string, { isGifted: boolean; giftedBy?: string; reason?: string }>();

    if (!isOnPrem()) {
      const usersWithSubscriptions = pageOfUsers.filter(user =>
        subscriptionsByUserId.get(user.id)?.gifted === true
      );

      const STRIPE_LOOKUP_CONCURRENCY = 10;
      for (let i = 0; i < usersWithSubscriptions.length; i += STRIPE_LOOKUP_CONCURRENCY) {
        const batch = usersWithSubscriptions.slice(i, i + STRIPE_LOOKUP_CONCURRENCY);
        await Promise.all(
          batch.map(async (user) => {
            const sub = subscriptionsByUserId.get(user.id);
            if (!sub) return;

            try {
              const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
              const metadata = stripeSub.metadata || {};
              stripeSubscriptionDetails.set(user.id, {
                isGifted: metadata.type === 'gift_subscription',
                giftedBy: metadata.giftedBy,
                reason: metadata.reason,
              });
            } catch {
              // Subscription may not exist in Stripe anymore
              stripeSubscriptionDetails.set(user.id, { isGifted: false });
            }
          })
        );
      }
    }

    const enrichedUsers = pageOfUsers.map(user => {
      const subscription = subscriptionsByUserId.get(user.id);
      const stripeDetails = stripeSubscriptionDetails.get(user.id);
      const pageMessages = chatMessagesCountMap.get(user.id) ?? 0;
      const globalMessages = globalMessagesCountMap.get(user.id) ?? 0;

      return {
        ...user,
        stats: {
          drives: drivesCountMap.get(user.id) ?? 0,
          pages: pagesCountMap.get(user.id) ?? 0,
          chatMessages: pageMessages,
          globalMessages,
          totalMessages: pageMessages + globalMessages,
        },
        subscription: subscription ? {
          id: subscription.id,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          isGifted: subscription.gifted,
          giftedBy: stripeDetails?.giftedBy,
          giftReason: stripeDetails?.reason,
        } : null,
      };
    });

    auditRequest(_request, { eventType: 'data.read', userId: _adminUser.id, resourceType: 'user', resourceId: '*', details: {
      source: 'admin',
      total,
      returned: enrichedUsers.length,
      offset: params.offset,
      hasSearch: params.q.length > 0,
    } });

    return Response.json({
      users: enrichedUsers,
      total,
      limit: params.limit,
      offset: params.offset,
      summary,
    });
  } catch (error) {
    loggers.api.error('Error fetching users:', error as Error);
    return Response.json(
      { error: 'Failed to fetch users data' },
      { status: 500 }
    );
  }
});
