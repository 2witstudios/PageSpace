'use client';

import { createCSRFHook } from './createCSRFHook';

/**
 * Hook to manage CSRF token for authenticated users.
 * Fetches CSRF token from /api/auth/csrf endpoint.
 */
export const useCSRFToken = createCSRFHook('/api/auth/csrf');
