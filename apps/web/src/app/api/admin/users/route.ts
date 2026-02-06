import {
  db,
  users,
  drives,
  pages,
  chatMessages,
  messages,
  userAiSettings,
  subscriptions,
  and,
  eq,
  inArray,
  desc,
  count,
} from '@pagespace/db';
import { stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/server';
import { verifyAdminAuth } from '@/lib/auth';

export async function GET(request: Request) {
  try {
    // Verify user is authenticated and is an admin
    const adminUser = await verifyAdminAuth(request);

    if (!adminUser) {
      return Response.json(
        { error: 'Unauthorized: Admin access required' },
        { status: 403 }
      );
    }
    // Get all users
    const allUsers = await db
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
      .from(users)
      .orderBy(users.name);

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
    const [driveCounts, pageCounts, chatMessageCounts, globalMessageCounts, aiSettingCounts] = await Promise.all([
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
      db.select({
        userId: userAiSettings.userId,
        count: count(),
      })
        .from(userAiSettings)
        .where(inArray(userAiSettings.userId, userIds))
        .groupBy(userAiSettings.userId),
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
    const aiSettingsCountMap = toCountMap(aiSettingCounts);

    const usersWithStats = allUsers.map((user) => ({
      ...user,
      drivesCount: drivesCountMap.get(user.id) ?? 0,
      pagesCount: pagesCountMap.get(user.id) ?? 0,
      chatMessagesCount: chatMessagesCountMap.get(user.id) ?? 0,
      globalMessagesCount: globalMessagesCountMap.get(user.id) ?? 0,
      aiSettingsCount: aiSettingsCountMap.get(user.id) ?? 0,
    }));

    // Get AI settings details for each user
    const allAiSettings = await db
      .select({
        userId: userAiSettings.userId,
        provider: userAiSettings.provider,
        baseUrl: userAiSettings.baseUrl,
        createdAt: userAiSettings.createdAt,
        updatedAt: userAiSettings.updatedAt
      })
      .from(userAiSettings)
      .where(inArray(userAiSettings.userId, userIds));

    const aiSettingsByUserId = new Map<string, typeof allAiSettings>();
    for (const setting of allAiSettings) {
      const existing = aiSettingsByUserId.get(setting.userId);
      if (existing) {
        existing.push(setting);
      } else {
        aiSettingsByUserId.set(setting.userId, [setting]);
      }
    }

    // Fetch Stripe subscription details to check if gifted
    const stripeSubscriptionDetails = new Map<string, { isGifted: boolean; giftedBy?: string; reason?: string }>();

    // Batch fetch Stripe subscriptions for users with active subscriptions
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

    // Combine the data
    const enrichedUsers = usersWithStats.map(user => {
      const userAiSettings = aiSettingsByUserId.get(user.id) ?? [];
      const subscription = subscriptionsByUserId.get(user.id);
      const stripeDetails = stripeSubscriptionDetails.get(user.id);

      return {
        ...user,
        stats: {
          drives: user.drivesCount,
          pages: user.pagesCount,
          chatMessages: user.chatMessagesCount,
          globalMessages: user.globalMessagesCount,
          aiSettings: user.aiSettingsCount,
          totalMessages: user.chatMessagesCount + user.globalMessagesCount
        },
        aiSettings: userAiSettings,
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

    // Remove the count fields from the response
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
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        aiSettingsCount,
        ...user
      } = userData;
      return user;
    });

    return Response.json({ users: cleanUsers });
  } catch (error) {
    loggers.api.error('Error fetching users:', error as Error);
    return Response.json(
      { error: 'Failed to fetch users data' },
      { status: 500 }
    );
  }
}
