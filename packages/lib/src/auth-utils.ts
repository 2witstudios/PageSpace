import * as jose from 'jose';
import { createId } from '@paralleldrive/cuid2';

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

function getServiceJWTConfig() {
  // Validate service JWT secret exists and is secure
  const serviceSecret = process.env.SERVICE_JWT_SECRET;
  if (!serviceSecret) {
    throw new Error('SERVICE_JWT_SECRET environment variable is required');
  }
  if (serviceSecret.length < 32) {
    throw new Error('SERVICE_JWT_SECRET must be at least 32 characters long');
  }

  return {
    secret: new TextEncoder().encode(serviceSecret),
    issuer: process.env.JWT_ISSUER || 'pagespace',
    audience: 'pagespace-services'
  };
}

interface UserPayload extends jose.JWTPayload {
  userId: string;
  tokenVersion: number;
  role: 'user' | 'admin';
}

interface ServiceTokenPayload extends jose.JWTPayload {
  service: string;
  permissions: string[];
  tenantId?: string;
  userId?: string;
  driveIds?: string[];
}

export async function decodeToken(token: string): Promise<UserPayload | null> {
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

export async function generateRefreshToken(userId: string, tokenVersion: number, role: 'user' | 'admin'): Promise<string> {
  const config = getJWTConfig();
  return await new jose.SignJWT({ userId, tokenVersion, role })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setJti(createId())
    .setExpirationTime('7d')
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

// Service JWT functions
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
  const config = getServiceJWTConfig();
  const payload: ServiceTokenPayload = {
    service,
    permissions,
    ...options
  };

  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(options?.expirationTime || '1h')
    .sign(config.secret);
}

export async function verifyServiceToken(token: string): Promise<ServiceTokenPayload | null> {
  try {
    const config = getServiceJWTConfig();
    const { payload } = await jose.jwtVerify(token, config.secret, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.issuer,
      audience: config.audience,
    });

    // Validate required payload fields
    if (!payload.service || typeof payload.service !== 'string') {
      throw new Error('Invalid service token: missing or invalid service');
    }
    if (!Array.isArray(payload.permissions)) {
      throw new Error('Invalid service token: missing or invalid permissions');
    }

    return payload as ServiceTokenPayload;
  } catch (error) {
    console.error('Invalid service token:', error);
    return null;
  }
}