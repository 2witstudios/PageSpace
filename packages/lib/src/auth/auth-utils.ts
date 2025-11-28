import * as jose from 'jose';
import { createId } from '@paralleldrive/cuid2';
import {
  createServiceToken as createServiceTokenV2,
  verifyServiceToken as verifyServiceTokenV2,
  type ServiceScope,
  type ServiceTokenClaims,
} from '../services/service-auth';

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

/**
 * Get refresh token TTL from environment variable
 * Defaults to 30 days for better UX (was 7 days)
 * Supports: '7d', '30d', '90d', or any valid time string
 */
function getRefreshTokenTTL(): string {
  const ttl = process.env.REFRESH_TOKEN_TTL || '30d';

  // Validate format (basic check)
  if (!/^\d+[smhd]$/.test(ttl)) {
    console.warn(`Invalid REFRESH_TOKEN_TTL format: ${ttl}, using default: 30d`);
    return '30d';
  }

  return ttl;
}

/**
 * Convert time string (e.g., '7d', '30d', '24h') to seconds
 * Used for cookie maxAge calculation
 */
export function timeStringToSeconds(timeStr: string): number {
  const match = timeStr.match(/^(\d+)([smhd])$/);
  if (!match) {
    console.warn(`Invalid time format: ${timeStr}, defaulting to 30 days`);
    return 30 * 24 * 60 * 60; // 30 days in seconds
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 24 * 60 * 60;
    default:
      return 30 * 24 * 60 * 60; // Default 30 days
  }
}

/**
 * Get refresh token cookie maxAge in seconds
 */
export function getRefreshTokenMaxAge(): number {
  const ttl = getRefreshTokenTTL();
  return timeStringToSeconds(ttl);
}

interface UserPayload extends jose.JWTPayload {
  userId: string;
  tokenVersion: number;
  role: 'user' | 'admin';
}

export async function decodeToken(token: string): Promise<UserPayload | null> {
  // Validate input type
  if (typeof token !== 'string') {
    return null;
  }

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
    
    return payload as UserPayload;
  } catch (error) {
    console.error('Invalid token:', error);
    return null;
  }
}

export async function generateAccessToken(userId: string, tokenVersion: number, role: 'user' | 'admin'): Promise<string> {
  const config = getJWTConfig();
  return await new jose.SignJWT({ userId, tokenVersion, role })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(config.secret);
}

export async function generateRefreshToken(
  userId: string,
  tokenVersion: number,
  role: 'user' | 'admin',
  expirationTime?: string
): Promise<string> {
  const config = getJWTConfig();
  const ttl = expirationTime || getRefreshTokenTTL();

  return await new jose.SignJWT({ userId, tokenVersion, role })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setJti(createId())
    .setExpirationTime(ttl)
    .sign(config.secret);
}

export function isAdmin(userPayload: UserPayload): boolean {
  return userPayload.role === 'admin';
}

export function requireAdminPayload(userPayload: UserPayload | null): void {
  if (!userPayload || !isAdmin(userPayload)) {
    throw new Error('Admin access required');
  }
}

// Service JWT functions (legacy interface maintained for backwards compatibility)
export async function createServiceToken(
  service: string,
  permissions: string[] = ['*'],
  options?: {
    tenantId?: string;
    userId?: string;
    driveIds?: string[];
    expirationTime?: string;
  }
): Promise<string> {
  const subject = options?.userId ?? options?.tenantId ?? service;
  const scopes = (permissions.length > 0 ? permissions : ['*']) as ServiceScope[];

  return createServiceTokenV2({
    service,
    subject,
    scopes,
    resource: options?.tenantId,
    driveId: options?.driveIds?.[0],
    expiresIn: options?.expirationTime ?? '1h',
  });
}

export async function verifyServiceToken(token: string): Promise<ServiceTokenClaims | null> {
  try {
    return await verifyServiceTokenV2(token);
  } catch (error) {
    console.error('Invalid service token:', error);
    return null;
  }
}

export type { ServiceScope, ServiceTokenClaims };
