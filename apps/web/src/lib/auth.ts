export * from './auth/index';

import { authenticateWebRequest, isAuthError } from './auth/index';

export interface VerifiedUser {
  id: string;
  role: 'user' | 'admin';
  tokenVersion: number;
}

export async function verifyAuth(request: Request): Promise<VerifiedUser | null> {
  const result = await authenticateWebRequest(request);
  if (isAuthError(result)) {
    return null;
  }

  return {
    id: result.userId,
    role: result.role,
    tokenVersion: result.tokenVersion,
  } satisfies VerifiedUser;
}

export async function verifyAdminAuth(request: Request): Promise<VerifiedUser | null> {
  const user = await verifyAuth(request);
  if (!user || user.role !== 'admin') {
    return null;
  }

  return user;
}
