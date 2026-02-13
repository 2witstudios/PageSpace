'use client';

import { createCSRFHook } from './createCSRFHook';

/**
 * Hook to manage login CSRF token for unauthenticated auth flows.
 * Used for passkey authentication, magic link, and other public auth endpoints.
 */
export const useLoginCSRF = createCSRFHook('/api/auth/login-csrf');
