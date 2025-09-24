import { cache } from 'react';
import { cookies } from 'next/headers';
import { users, db, eq } from '@pagespace/db';
import { authenticateWebRequest, isAuthError } from '@/lib/auth';

interface ServerSession {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    image?: string | null;
    role: string;
  } | null;
  isAuthenticated: boolean;
}

/**
 * Server-side authentication session helper with Next.js 15 cache.
 * Uses React cache() to ensure single database query per request/page load.
 * This eliminates multiple auth checks during SSR/initial hydration.
 */
export const getServerSession = cache(async (): Promise<ServerSession> => {
  try {
    // Create a minimal request object with cookies
    const cookieStore = await cookies();
    const cookiesString = cookieStore.getAll()
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');

    const mockRequest = {
      headers: {
        get: (name: string) => {
          if (name.toLowerCase() === 'cookie') {
            return cookiesString;
          }
          return null;
        },
      },
    } as Request;

    // Use existing auth system
    const authResult = await authenticateWebRequest(mockRequest);

    if (isAuthError(authResult)) {
      return { user: null, isAuthenticated: false };
    }

    // Single database query with React cache deduplication
    const user = await db.query.users.findFirst({
      where: eq(users.id, authResult.userId),
      columns: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
      },
    });

    if (!user) {
      return { user: null, isAuthenticated: false };
    }

    return {
      user,
      isAuthenticated: true,
    };
  } catch (error) {
    // Silent failure for server-side auth check
    // Client-side auth will handle error cases
    console.error('[SERVER_AUTH] Session validation failed:', error);
    return { user: null, isAuthenticated: false };
  }
});

/**
 * Lightweight server-side auth check for route protection.
 * Returns boolean without full user data for performance.
 */
export const isServerAuthenticated = cache(async (): Promise<boolean> => {
  const session = await getServerSession();
  return session.isAuthenticated;
});

/**
 * Get user ID from server session for database queries.
 * Returns null if not authenticated.
 */
export const getServerUserId = cache(async (): Promise<string | null> => {
  const session = await getServerSession();
  return session.user?.id || null;
});