import { db, pushNotificationTokens, eq, and } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import * as crypto from 'crypto';

type PushPlatform = 'ios' | 'android' | 'web';

interface PushNotificationPayload {
  title: string;
  body: string;
  badge?: number;
  sound?: string;
  data?: Record<string, unknown>;
  category?: string;
  threadId?: string;
}

interface SendPushResult {
  success: boolean;
  tokenId: string;
  error?: string;
  shouldRemoveToken?: boolean;
}

// APNs JWT token cache
let apnsJwtToken: string | null = null;
let apnsJwtExpiry: number = 0;

function getApnsJwtToken(): string {
  const now = Math.floor(Date.now() / 1000);

  // Return cached token if still valid (tokens are valid for 1 hour, refresh at 50 min)
  if (apnsJwtToken && apnsJwtExpiry > now + 600) {
    return apnsJwtToken;
  }

  const teamId = process.env.APNS_TEAM_ID;
  const keyId = process.env.APNS_KEY_ID;
  const privateKey = process.env.APNS_PRIVATE_KEY;

  if (!teamId || !keyId || !privateKey) {
    throw new Error('APNs configuration missing: APNS_TEAM_ID, APNS_KEY_ID, and APNS_PRIVATE_KEY are required');
  }

  // Create JWT header and claims
  const header = {
    alg: 'ES256',
    kid: keyId,
  };

  const claims = {
    iss: teamId,
    iat: now,
  };

  // Base64url encode
  const base64url = (obj: object) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

  const headerB64 = base64url(header);
  const claimsB64 = base64url(claims);
  const signingInput = `${headerB64}.${claimsB64}`;

  // Sign with ES256 (ECDSA P-256)
  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  sign.end();

  // The private key should be in PEM format
  const formattedKey = privateKey.includes('-----BEGIN')
    ? privateKey
    : `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;

  const signature = sign.sign(formattedKey);

  // Convert DER signature to raw r||s format for JWT
  // DER format: 0x30 [len] 0x02 [r_len] [r] 0x02 [s_len] [s]
  const derToRaw = (der: Buffer): Buffer => {
    let offset = 2; // Skip sequence tag and length
    const rLen = der[offset + 1];
    const r = der.slice(offset + 2, offset + 2 + rLen);
    offset = offset + 2 + rLen;
    const sLen = der[offset + 1];
    const s = der.slice(offset + 2, offset + 2 + sLen);

    // Ensure r and s are 32 bytes each (pad or trim leading zeros)
    const rPadded = Buffer.alloc(32);
    const sPadded = Buffer.alloc(32);

    if (r.length <= 32) {
      r.copy(rPadded, 32 - r.length);
    } else {
      r.copy(rPadded, 0, r.length - 32);
    }

    if (s.length <= 32) {
      s.copy(sPadded, 32 - s.length);
    } else {
      s.copy(sPadded, 0, s.length - 32);
    }

    return Buffer.concat([rPadded, sPadded]);
  };

  const rawSignature = derToRaw(signature);
  const signatureB64 = rawSignature
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  apnsJwtToken = `${signingInput}.${signatureB64}`;
  apnsJwtExpiry = now + 3600; // Token is valid for 1 hour

  return apnsJwtToken;
}

async function sendToApns(
  deviceToken: string,
  payload: PushNotificationPayload,
  tokenId: string
): Promise<SendPushResult> {
  const bundleId = process.env.APNS_BUNDLE_ID || 'ai.pagespace.ios';
  const isProduction = process.env.NODE_ENV === 'production';
  const apnsHost = isProduction
    ? 'api.push.apple.com'
    : 'api.sandbox.push.apple.com';

  try {
    const jwtToken = getApnsJwtToken();

    const apnsPayload = {
      aps: {
        alert: {
          title: payload.title,
          body: payload.body,
        },
        badge: payload.badge,
        sound: payload.sound || 'default',
        'thread-id': payload.threadId,
        category: payload.category,
      },
      ...payload.data,
    };

    const response = await fetch(
      `https://${apnsHost}/3/device/${deviceToken}`,
      {
        method: 'POST',
        headers: {
          'authorization': `bearer ${jwtToken}`,
          'apns-topic': bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        body: JSON.stringify(apnsPayload),
      }
    );

    if (response.ok) {
      return { success: true, tokenId };
    }

    const errorBody = await response.json().catch(() => ({}));
    const reason = (errorBody as { reason?: string }).reason || 'Unknown error';

    // Check if token should be removed (invalid or unregistered)
    const invalidTokenReasons = [
      'BadDeviceToken',
      'Unregistered',
      'DeviceTokenNotForTopic',
      'ExpiredToken',
    ];

    return {
      success: false,
      tokenId,
      error: reason,
      shouldRemoveToken: invalidTokenReasons.includes(reason),
    };
  } catch (error) {
    console.error('APNs send error:', error);
    return {
      success: false,
      tokenId,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function registerPushToken(
  userId: string,
  token: string,
  platform: PushPlatform,
  deviceId?: string,
  deviceName?: string,
  webPushSubscription?: string
): Promise<{ id: string }> {
  // Check if this token already exists for this user
  const existing = await db.query.pushNotificationTokens.findFirst({
    where: and(
      eq(pushNotificationTokens.userId, userId),
      eq(pushNotificationTokens.token, token)
    ),
  });

  if (existing) {
    // Update the existing token
    await db
      .update(pushNotificationTokens)
      .set({
        isActive: true,
        deviceId,
        deviceName,
        webPushSubscription,
        updatedAt: new Date(),
        failedAttempts: '0',
        lastFailedAt: null,
      })
      .where(eq(pushNotificationTokens.id, existing.id));

    return { id: existing.id };
  }

  // If deviceId is provided, deactivate other tokens for the same device
  if (deviceId) {
    await db
      .update(pushNotificationTokens)
      .set({ isActive: false })
      .where(
        and(
          eq(pushNotificationTokens.userId, userId),
          eq(pushNotificationTokens.deviceId, deviceId),
          eq(pushNotificationTokens.platform, platform)
        )
      );
  }

  // Create new token
  const id = createId();
  await db.insert(pushNotificationTokens).values({
    id,
    userId,
    token,
    platform,
    deviceId,
    deviceName,
    webPushSubscription,
    isActive: true,
  });

  return { id };
}

export async function unregisterPushToken(
  userId: string,
  token: string
): Promise<void> {
  await db
    .update(pushNotificationTokens)
    .set({ isActive: false })
    .where(
      and(
        eq(pushNotificationTokens.userId, userId),
        eq(pushNotificationTokens.token, token)
      )
    );
}

export async function unregisterAllPushTokens(userId: string): Promise<void> {
  await db
    .update(pushNotificationTokens)
    .set({ isActive: false })
    .where(eq(pushNotificationTokens.userId, userId));
}

export async function sendPushNotification(
  userId: string,
  payload: PushNotificationPayload
): Promise<{ sent: number; failed: number; errors: string[] }> {
  // Get all active push tokens for the user
  const tokens = await db.query.pushNotificationTokens.findMany({
    where: and(
      eq(pushNotificationTokens.userId, userId),
      eq(pushNotificationTokens.isActive, true)
    ),
  });

  if (tokens.length === 0) {
    return { sent: 0, failed: 0, errors: [] };
  }

  const results: SendPushResult[] = [];

  for (const tokenRecord of tokens) {
    let result: SendPushResult;

    switch (tokenRecord.platform) {
      case 'ios':
        result = await sendToApns(tokenRecord.token, payload, tokenRecord.id);
        break;
      case 'android':
        // TODO: Implement FCM when Android app is added
        result = {
          success: false,
          tokenId: tokenRecord.id,
          error: 'Android push not yet implemented',
        };
        break;
      case 'web':
        // TODO: Implement Web Push when PWA push is added
        result = {
          success: false,
          tokenId: tokenRecord.id,
          error: 'Web push not yet implemented',
        };
        break;
      default:
        result = {
          success: false,
          tokenId: tokenRecord.id,
          error: `Unknown platform: ${tokenRecord.platform}`,
        };
    }

    results.push(result);

    // Handle token cleanup for invalid tokens
    if (result.shouldRemoveToken) {
      await db
        .update(pushNotificationTokens)
        .set({ isActive: false })
        .where(eq(pushNotificationTokens.id, tokenRecord.id));
    } else if (!result.success) {
      // Track failed attempts
      const failedAttempts = parseInt(tokenRecord.failedAttempts || '0', 10) + 1;
      await db
        .update(pushNotificationTokens)
        .set({
          failedAttempts: String(failedAttempts),
          lastFailedAt: new Date(),
          // Deactivate after 5 consecutive failures
          isActive: failedAttempts < 5,
        })
        .where(eq(pushNotificationTokens.id, tokenRecord.id));
    } else {
      // Reset failed attempts on success and update lastUsedAt
      await db
        .update(pushNotificationTokens)
        .set({
          failedAttempts: '0',
          lastFailedAt: null,
          lastUsedAt: new Date(),
        })
        .where(eq(pushNotificationTokens.id, tokenRecord.id));
    }
  }

  const sent = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const errors = results.filter((r) => r.error).map((r) => r.error!);

  return { sent, failed, errors };
}

export async function getUserPushTokens(userId: string) {
  return db.query.pushNotificationTokens.findMany({
    where: and(
      eq(pushNotificationTokens.userId, userId),
      eq(pushNotificationTokens.isActive, true)
    ),
    columns: {
      id: true,
      platform: true,
      deviceId: true,
      deviceName: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
}
