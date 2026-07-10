import { NextResponse } from 'next/server';
import { isFetchBridgeInitialized, getFetchBridge } from '@/lib/fetch-bridge';
import { authenticateSessionRequest } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

/**
 * GET /api/desktop-bridge/status
 * Returns whether the current user has an active desktop bridge connection
 */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (isAuthError(auth)) return auth.error;

  const connected = isFetchBridgeInitialized() && getFetchBridge().isUserConnected(auth.userId);

  return NextResponse.json({ connected });
}
