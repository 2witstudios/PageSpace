'use client';

import { createCSRFHook } from './createCSRFHook';

/**
 * Hook to manage auth CSRF token for unauthenticated auth flows.
 * Used for passkey authentication, magic link, and other public auth endpoints.
 */
export const useAuthCSRF = createCSRFHook('/api/auth/login-csrf');
