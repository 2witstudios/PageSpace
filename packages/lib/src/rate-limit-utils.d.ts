interface RateLimitConfig {
    maxAttempts: number;
    windowMs: number;
    blockDurationMs?: number;
    progressiveDelay?: boolean;
}
/**
 * Rate limiting for authentication endpoints
 */
export declare function checkRateLimit(identifier: string, config: RateLimitConfig): {
    allowed: boolean;
    retryAfter?: number;
    attemptsRemaining?: number;
};
/**
 * Record a successful authentication (resets the rate limit for this identifier)
 */
export declare function resetRateLimit(identifier: string): void;
/**
 * Get rate limit status without incrementing
 */
export declare function getRateLimitStatus(identifier: string, config: RateLimitConfig): {
    blocked: boolean;
    retryAfter?: number;
    attemptsRemaining?: number;
};
export declare const RATE_LIMIT_CONFIGS: {
    readonly LOGIN: {
        readonly maxAttempts: 5;
        readonly windowMs: number;
        readonly blockDurationMs: number;
        readonly progressiveDelay: true;
    };
    readonly SIGNUP: {
        readonly maxAttempts: 3;
        readonly windowMs: number;
        readonly blockDurationMs: number;
        readonly progressiveDelay: false;
    };
    readonly PASSWORD_RESET: {
        readonly maxAttempts: 3;
        readonly windowMs: number;
        readonly blockDurationMs: number;
        readonly progressiveDelay: false;
    };
    readonly REFRESH: {
        readonly maxAttempts: 10;
        readonly windowMs: number;
        readonly blockDurationMs: number;
        readonly progressiveDelay: false;
    };
};
export {};
//# sourceMappingURL=rate-limit-utils.d.ts.map