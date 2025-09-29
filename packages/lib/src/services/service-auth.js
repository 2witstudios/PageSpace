"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServiceToken = createServiceToken;
exports.verifyServiceToken = verifyServiceToken;
exports.decodeServiceTokenHeader = decodeServiceTokenHeader;
exports.hasScope = hasScope;
exports.assertScope = assertScope;
exports.authenticateServiceToken = authenticateServiceToken;
exports.requireResource = requireResource;
const jose_1 = require("jose");
const cuid2_1 = require("@paralleldrive/cuid2");
const SERVICE_JWT_ALG = 'HS256';
function getServiceConfig() {
    const rawSecret = process.env.SERVICE_JWT_SECRET;
    if (!rawSecret) {
        throw new Error('SERVICE_JWT_SECRET environment variable is required');
    }
    if (rawSecret.length < 32) {
        throw new Error('SERVICE_JWT_SECRET must be at least 32 characters long');
    }
    return {
        secret: new TextEncoder().encode(rawSecret),
        issuer: process.env.JWT_ISSUER || 'pagespace',
        audience: 'pagespace-processor',
    };
}
async function createServiceToken(options) {
    const config = getServiceConfig();
    if (!options.scopes || options.scopes.length === 0) {
        throw new Error('Service token requires at least one scope');
    }
    const payload = {
        sub: options.subject,
        service: options.service,
        resource: options.resource,
        driveId: options.driveId,
        scopes: Array.from(new Set(options.scopes)),
        tokenType: 'service',
        jti: (0, cuid2_1.createId)(),
        ...options.additionalClaims,
    };
    return await new jose_1.SignJWT(payload)
        .setProtectedHeader({ alg: SERVICE_JWT_ALG })
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? '5m')
        .sign(config.secret);
}
async function verifyServiceToken(token) {
    const config = getServiceConfig();
    try {
        const { payload, protectedHeader } = await (0, jose_1.jwtVerify)(token, config.secret, {
            algorithms: [SERVICE_JWT_ALG],
            issuer: config.issuer,
            audience: config.audience,
        });
        if (protectedHeader.alg !== SERVICE_JWT_ALG) {
            throw new Error('Unexpected service token algorithm');
        }
        const claims = payload;
        if (claims.tokenType !== 'service') {
            throw new Error('Invalid service token type');
        }
        if (!claims.sub || typeof claims.sub !== 'string') {
            throw new Error('Service token missing subject');
        }
        if (!claims.service || typeof claims.service !== 'string') {
            throw new Error('Service token missing service identifier');
        }
        if (!Array.isArray(claims.scopes) || claims.scopes.length === 0) {
            throw new Error('Service token missing scopes');
        }
        if (claims.resource && typeof claims.resource !== 'string') {
            throw new Error('Service token resource must be a string');
        }
        return claims;
    }
    catch (error) {
        if (error instanceof Error) {
            error.message = `Service token verification failed: ${error.message}`;
        }
        throw error;
    }
}
function decodeServiceTokenHeader(token) {
    return (0, jose_1.decodeProtectedHeader)(token);
}
function hasScope(claims, scope) {
    if (claims.scopes.includes('*')) {
        return true;
    }
    if (claims.scopes.includes(scope)) {
        return true;
    }
    const [namespace] = scope.split(':');
    const wildcard = `${namespace}:*`;
    return claims.scopes.includes(wildcard);
}
function assertScope(claims, scope) {
    if (!hasScope(claims, scope)) {
        const available = claims.scopes.join(', ');
        throw new Error(`Insufficient service scopes. Required: ${scope}. Token scopes: ${available}`);
    }
}
async function authenticateServiceToken(token) {
    const claims = await verifyServiceToken(token);
    return { claims };
}
function requireResource(claims, resource, kind) {
    const resolved = resource ?? claims.resource;
    if (!resolved) {
        throw new Error(`Service token missing ${kind} resource`);
    }
    return resolved;
}
