import { NextResponse } from 'next/server';
import {
  registerPushToken,
  unregisterPushToken,
  getUserPushTokens,
} from '@pagespace/lib/notifications';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const tokens = await getUserPushTokens(userId);
    return NextResponse.json({ tokens });
  } catch (error) {
    loggers.api.error('Error fetching push tokens:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch push tokens' },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { token, platform, deviceId, deviceName, webPushSubscription } = body;

    if (!token || !platform) {
      return NextResponse.json(
        { error: 'Token and platform are required' },
        { status: 400 }
      );
    }

    if (!['ios', 'android', 'web'].includes(platform)) {
      return NextResponse.json(
        { error: 'Invalid platform. Must be ios, android, or web' },
        { status: 400 }
      );
    }

    const result = await registerPushToken(
      userId,
      token,
      platform,
      deviceId,
      deviceName,
      webPushSubscription
    );

    return NextResponse.json({
      success: true,
      tokenId: result.id,
    });
  } catch (error) {
    loggers.api.error('Error registering push token:', error as Error);
    return NextResponse.json(
      { error: 'Failed to register push token' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json(
        { error: 'Token is required' },
        { status: 400 }
      );
    }

    await unregisterPushToken(userId, token);

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error unregistering push token:', error as Error);
    return NextResponse.json(
      { error: 'Failed to unregister push token' },
      { status: 500 }
    );
  }
}
