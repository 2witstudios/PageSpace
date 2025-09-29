"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCSRFToken = generateCSRFToken;
exports.validateCSRFToken = validateCSRFToken;
exports.getSessionIdFromJWT = getSessionIdFromJWT;
const crypto_1 = require("crypto");
function getCSRFSecret() {
    const CSRF_SECRET = process.env.CSRF_SECRET;
    if (!CSRF_SECRET) {
        throw new Error('CSRF_SECRET environment variable is required');
    }
    return CSRF_SECRET;
}
const CSRF_TOKEN_LENGTH = 32;
const CSRF_SEPARATOR = '.';
/**
 * Generates a CSRF token for the given session ID
 */
function generateCSRFToken(sessionId) {
    const tokenValue = (0, crypto_1.randomBytes)(CSRF_TOKEN_LENGTH).toString('hex');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Create HMAC signature: sessionId.tokenValue.timestamp
    const payload = `${sessionId}${CSRF_SEPARATOR}${tokenValue}${CSRF_SEPARATOR}${timestamp}`;
    const signature = (0, crypto_1.createHmac)('sha256', getCSRFSecret())
        .update(payload)
        .digest('hex');
    return `${tokenValue}${CSRF_SEPARATOR}${timestamp}${CSRF_SEPARATOR}${signature}`;
}
/**
 * Validates a CSRF token against the given session ID
 */
function validateCSRFToken(token, sessionId, maxAge = 3600) {
    if (!token || !sessionId) {
        return false;
    }
    try {
        const parts = token.split(CSRF_SEPARATOR);
        if (parts.length !== 3) {
            return false;
        }
        const [tokenValue, timestamp, signature] = parts;
        // Check if token has expired
        const tokenTime = parseInt(timestamp, 10);
        const currentTime = Math.floor(Date.now() / 1000);
        if (currentTime - tokenTime > maxAge) {
            return false;
        }
        // Recreate the expected signature
        const payload = `${sessionId}${CSRF_SEPARATOR}${tokenValue}${CSRF_SEPARATOR}${timestamp}`;
        const expectedSignature = (0, crypto_1.createHmac)('sha256', getCSRFSecret())
            .update(payload)
            .digest('hex');
        // Compare signatures using timing-safe comparison
        const expectedBuffer = Buffer.from(expectedSignature, 'hex');
        const actualBuffer = Buffer.from(signature, 'hex');
        if (expectedBuffer.length !== actualBuffer.length) {
            return false;
        }
        return (0, crypto_1.timingSafeEqual)(expectedBuffer, actualBuffer);
    }
    catch (error) {
        console.error('CSRF token validation error:', error);
        return false;
    }
}
/**
 * Extracts session ID from JWT token (for CSRF validation)
 */
function getSessionIdFromJWT(payload) {
    // Create a deterministic session ID from user info and issued time
    return (0, crypto_1.createHmac)('sha256', getCSRFSecret())
        .update(`${payload.userId}-${payload.tokenVersion}-${payload.iat || 0}`)
        .digest('hex')
        .substring(0, 16); // Use first 16 chars for session ID
}
