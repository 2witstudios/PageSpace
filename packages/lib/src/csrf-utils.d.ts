/**
 * Generates a CSRF token for the given session ID
 */
export declare function generateCSRFToken(sessionId: string): string;
/**
 * Validates a CSRF token against the given session ID
 */
export declare function validateCSRFToken(token: string, sessionId: string, maxAge?: number): boolean;
/**
 * Extracts session ID from JWT token (for CSRF validation)
 */
export declare function getSessionIdFromJWT(payload: {
    userId: string;
    tokenVersion: number;
    iat?: number;
}): string;
//# sourceMappingURL=csrf-utils.d.ts.map