import { NextResponse } from 'next/server';
import {
  authenticateHybridRequest,
  authenticateMCPRequest,
  authenticateWebRequest,
  AuthResult,
  AuthError,
  AuthenticationResult,
} from '@/lib/auth';

function toLegacyShape(result: AuthenticationResult):
  | { userId: string; error?: never }
  | { userId?: never; error: NextResponse } {
  if ('error' in result) {
    return { error: result.error };
  }

  return { userId: result.userId };
}

/**
 * @deprecated Prefer `authenticateMCPRequest`, `authenticateWebRequest`, or `authenticateHybridRequest`.
 */
export async function authenticateRequest(request: Request): Promise<
  { userId: string; error?: never } | { userId?: never; error: NextResponse }
> {
  const result = await authenticateHybridRequest(request);
  return toLegacyShape(result);
}

export {
  authenticateHybridRequest,
  authenticateMCPRequest,
  authenticateWebRequest,
};

export type { AuthResult, AuthError, AuthenticationResult };
