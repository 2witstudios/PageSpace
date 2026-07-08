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
import { withAdminAuth } from '@/lib/auth';

export const GET = withAdminAuth(async (_adminUser, _request) => {
  try {
    // Get all users
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
      })
      .from(users);

    // name/email are encrypted at rest; decrypt before any sorting/display.
    const allUsers = (await decryptUserRows(rawUsers)).sort((a, b) =>
      (a.name ?? '').localeCompare(b.name ?? '')
    );

    if (allUsers.length === 0) {
      return Response.json({ users: [] });
    }

    const userIds = allUsers.map((user) => user.id);

    // Get active subscriptions for all users
    const activeSubscriptions = await db
      .select()
      .from(subscriptions)
      .where(and(
        inArray(subscriptions.status, ['active', 'trialing']),
        inArray(subscriptions.userId, userIds)
      ))
      .orderBy(desc(subscriptions.updatedAt));

    // Create a map of userId to subscription
    const subscriptionsByUserId = new Map(
      activeSubscriptions.map(sub => [sub.userId, sub])
    );

    // Batch aggregate stats instead of per-user N+1 queries
    const [driveCounts, pageCounts, chatMessageCounts, globalMessageCounts, lastActiveDates] = await Promise.all([
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
      // Last active: across ALL sessions regardless of revoked state — a user who was
      // active yesterday and then logged out still has a recent lastActiveAt. Use
      // COALESCE to handle sessions where lastUsedAt was never set (fall back to createdAt).
      db.select({
        userId: sessions.userId,
        lastActiveAt: sql<Date>`MAX(COALESCE(${sessions.lastUsedAt}, ${sessions.createdAt}))`,
      })
        .from(sessions)
        .where(inArray(sessions.userId, userIds))
        .groupBy(sessions.userId),
    ]);

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

    const lastActiveMap = new Map<string, Date | null>(
      lastActiveDates.map(row => [row.userId, row.lastActiveAt ?? null])
    );

    const usersWithStats = allUsers.map((user) => ({
      ...user,
      drivesCount: drivesCountMap.get(user.id) ?? 0,
      pagesCount: pagesCountMap.get(user.id) ?? 0,
      chatMessagesCount: chatMessagesCountMap.get(user.id) ?? 0,
      globalMessagesCount: globalMessagesCountMap.get(user.id) ?? 0,
      lastActiveAt: lastActiveMap.get(user.id) ?? null,
    }));

    // Fetch Stripe subscription details to check if gifted (skip on-prem - no Stripe)
    const stripeSubscriptionDetails = new Map<string, { isGifted: boolean; giftedBy?: string; reason?: string }>();

    if (!isOnPrem()) {
      const usersWithSubscriptions = allUsers.filter(user =>
        subscriptionsByUserId.has(user.id)
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

    // Combine the data
    const enrichedUsers = usersWithStats.map(user => {
      const subscription = subscriptionsByUserId.get(user.id);
      const stripeDetails = stripeSubscriptionDetails.get(user.id);

      return {
        ...user,
        stats: {
          drives: user.drivesCount,
          pages: user.pagesCount,
          chatMessages: user.chatMessagesCount,
          globalMessages: user.globalMessagesCount,
          totalMessages: user.chatMessagesCount + user.globalMessagesCount
        },
        subscription: subscription ? {
          id: subscription.id,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          isGifted: stripeDetails?.isGifted || false,
          giftedBy: stripeDetails?.giftedBy,
          giftReason: stripeDetails?.reason,
        } : null,
      };
    });

    // Remove raw count fields (they live under stats); keep lastActiveAt
    const cleanUsers = enrichedUsers.map((userData) => {
      const {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        drivesCount,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        pagesCount,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        chatMessagesCount,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        globalMessagesCount,
        ...user
      } = userData;
      return user;
    });

    auditRequest(_request, { eventType: 'data.read', userId: _adminUser.id, resourceType: 'user', resourceId: '*', details: {
      source: 'admin',
      userCount: cleanUsers.length,
    } });

    return Response.json({ users: cleanUsers });
  } catch (error) {
    loggers.api.error('Error fetching users:', error as Error);
    return Response.json(
      { error: 'Failed to fetch users data' },
      { status: 500 }
    );
  }
});
