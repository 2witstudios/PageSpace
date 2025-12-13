import {
  db,
  users,
  drives,
  pages,
  chatMessages,
  messages,
  refreshTokens,
  userAiSettings,
  subscriptions,
  eq,

  inArray,
  desc,
  count
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

    // Get active subscriptions for all users
    const activeSubscriptions = await db
      .select()
      .from(subscriptions)
      .where(inArray(subscriptions.status, ['active', 'trialing']))
      .orderBy(desc(subscriptions.updatedAt));

    // Create a map of userId to subscription
    const subscriptionsByUserId = new Map(
      activeSubscriptions.map(sub => [sub.userId, sub])
    );

    // Get stats for each user
    const usersWithStats = await Promise.all(
      allUsers.map(async (user) => {
        const [
          drivesCount,
          pagesCount,
          chatMessagesCount,
          globalMessagesCount,
          refreshTokensCount,
          aiSettingsCount
        ] = await Promise.all([
          // Count drives owned by user
          db.select({ count: count() }).from(drives).where(eq(drives.ownerId, user.id)),
          // Count pages in user's drives
          db.select({ count: count() })
            .from(pages)
            .innerJoin(drives, eq(pages.driveId, drives.id))
            .where(eq(drives.ownerId, user.id)),
          // Count chat messages
          db.select({ count: count() }).from(chatMessages).where(eq(chatMessages.userId, user.id)),
          // Count global messages (conversations)
          db.select({ count: count() }).from(messages).where(eq(messages.userId, user.id)),
          // Count refresh tokens
          db.select({ count: count() }).from(refreshTokens).where(eq(refreshTokens.userId, user.id)),
          // Count AI settings
          db.select({ count: count() }).from(userAiSettings).where(eq(userAiSettings.userId, user.id))
        ]);

        return {
          ...user,
          drivesCount: drivesCount[0]?.count || 0,
          pagesCount: pagesCount[0]?.count || 0,
          chatMessagesCount: chatMessagesCount[0]?.count || 0,
          globalMessagesCount: globalMessagesCount[0]?.count || 0,
          refreshTokensCount: refreshTokensCount[0]?.count || 0,
          aiSettingsCount: aiSettingsCount[0]?.count || 0,
        };
      })
    );

    // Get AI settings details for each user
    const allAiSettings = await db
      .select({
        userId: userAiSettings.userId,
        provider: userAiSettings.provider,
        baseUrl: userAiSettings.baseUrl,
        createdAt: userAiSettings.createdAt,
        updatedAt: userAiSettings.updatedAt
      })
      .from(userAiSettings);

    // Get recent refresh tokens for each user
    const recentTokens = await db
      .select({
        userId: refreshTokens.userId,
        device: refreshTokens.device,
        ip: refreshTokens.ip,
        userAgent: refreshTokens.userAgent,
        createdAt: refreshTokens.createdAt
      })
      .from(refreshTokens)
      .orderBy(refreshTokens.createdAt);

    // Fetch Stripe subscription details to check if gifted
    const stripeSubscriptionDetails = new Map<string, { isGifted: boolean; giftedBy?: string; reason?: string }>();

    // Batch fetch Stripe subscriptions for users with active subscriptions
    const usersWithSubscriptions = allUsers.filter(user =>
      subscriptionsByUserId.has(user.id)
    );

    await Promise.all(
      usersWithSubscriptions.map(async (user) => {
        const sub = subscriptionsByUserId.get(user.id);
        if (sub) {
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
        }
      })
    );

    // Combine the data
    const enrichedUsers = usersWithStats.map(user => {
      const userAiSettings = allAiSettings.filter(setting => setting.userId === user.id);
      const userTokens = recentTokens.filter(token => token.userId === user.id);
      const subscription = subscriptionsByUserId.get(user.id);
      const stripeDetails = stripeSubscriptionDetails.get(user.id);

      return {
        ...user,
        stats: {
          drives: user.drivesCount,
          pages: user.pagesCount,
          chatMessages: user.chatMessagesCount,
          globalMessages: user.globalMessagesCount,
          refreshTokens: user.refreshTokensCount,
          aiSettings: user.aiSettingsCount,
          totalMessages: user.chatMessagesCount + user.globalMessagesCount
        },
        aiSettings: userAiSettings,
        recentTokens: userTokens.slice(-3), // Last 3 tokens
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
        refreshTokensCount,
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