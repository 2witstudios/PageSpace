import { NextResponse } from 'next/server';
import { authenticateSessionRequest, isAuthError } from '@/lib/auth';
import { isFetchBridgeInitialized, getFetchBridge } from '@/lib/fetch-bridge';

/**
 * GET /api/desktop-bridge/status
 * Returns whether the current user has an active desktop bridge connection
 */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (isAuthError(auth)) return auth.error;

  const bridge = isFetchBridgeInitialized() ? getFetchBridge() : null;

  return NextResponse.json({
    connected: bridge?.isUserConnected(auth.userId) ?? false,
    canProxyFetch: bridge?.canProxyFetch(auth.userId) ?? false,
  });
}
