"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeToken = decodeToken;
exports.generateAccessToken = generateAccessToken;
exports.generateRefreshToken = generateRefreshToken;
exports.isAdmin = isAdmin;
exports.requireAdminPayload = requireAdminPayload;
exports.createServiceToken = createServiceToken;
exports.verifyServiceToken = verifyServiceToken;
const jose = __importStar(require("jose"));
const cuid2_1 = require("@paralleldrive/cuid2");
const service_auth_1 = require("./services/service-auth");
const JWT_ALGORITHM = 'HS256';
function getJWTConfig() {
    // Validate JWT secret exists and is secure
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        throw new Error('JWT_SECRET environment variable is required');
    }
    if (jwtSecret.length < 32) {
        throw new Error('JWT_SECRET must be at least 32 characters long');
    }
    return {
        secret: new TextEncoder().encode(jwtSecret),
        issuer: process.env.JWT_ISSUER || 'pagespace',
        audience: process.env.JWT_AUDIENCE || 'pagespace-users'
    };
}
async function decodeToken(token) {
    try {
        const config = getJWTConfig();
        const { payload } = await jose.jwtVerify(token, config.secret, {
            algorithms: [JWT_ALGORITHM],
            issuer: config.issuer,
            audience: config.audience,
        });
        // Validate required payload fields
        if (!payload.userId || typeof payload.userId !== 'string') {
            throw new Error('Invalid token: missing or invalid userId');
        }
        if (typeof payload.tokenVersion !== 'number') {
            throw new Error('Invalid token: missing or invalid tokenVersion');
        }
        if (!payload.role || (payload.role !== 'user' && payload.role !== 'admin')) {
            throw new Error('Invalid token: missing or invalid role');
        }
        return payload;
    }
    catch (error) {
        console.error('Invalid token:', error);
        return null;
    }
}
async function generateAccessToken(userId, tokenVersion, role) {
    const config = getJWTConfig();
    return await new jose.SignJWT({ userId, tokenVersion, role })
        .setProtectedHeader({ alg: JWT_ALGORITHM })
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(config.secret);
}
async function generateRefreshToken(userId, tokenVersion, role) {
    const config = getJWTConfig();
    return await new jose.SignJWT({ userId, tokenVersion, role })
        .setProtectedHeader({ alg: JWT_ALGORITHM })
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt()
        .setJti((0, cuid2_1.createId)())
        .setExpirationTime('7d')
        .sign(config.secret);
}
function isAdmin(userPayload) {
    return userPayload.role === 'admin';
}
function requireAdminPayload(userPayload) {
    if (!userPayload || !isAdmin(userPayload)) {
        throw new Error('Admin access required');
    }
}
// Service JWT functions (legacy interface maintained for backwards compatibility)
async function createServiceToken(service, permissions = ['*'], options) {
    const subject = options?.userId ?? options?.tenantId ?? service;
    const scopes = (permissions.length > 0 ? permissions : ['*']);
    return (0, service_auth_1.createServiceToken)({
        service,
        subject,
        scopes,
        resource: options?.tenantId,
        driveId: options?.driveIds?.[0],
        expiresIn: options?.expirationTime ?? '1h',
        additionalClaims: {
            tenantId: options?.tenantId ?? subject,
            userId: options?.userId,
            driveIds: options?.driveIds,
        },
    });
}
async function verifyServiceToken(token) {
    try {
        return await (0, service_auth_1.verifyServiceToken)(token);
    }
    catch (error) {
        console.error('Invalid service token:', error);
        return null;
    }
}
