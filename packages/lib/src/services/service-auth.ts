import { SignJWT, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { createId } from '@paralleldrive/cuid2';
import { recordJTI, isJTIRevoked, tryGetSecurityRedisClient } from '../security/security-redis';

export type ServiceScope =
  | '*'
  | 'files:read'
  | 'files:write'
  | 'files:link'
  | 'files:delete'
  | 'files:optimize'
  | 'files:ingest'
  | 'files:write:any'
  | 'avatars:write'
  | 'avatars:write:any'
  | 'queue:read';

export interface ServiceTokenClaims extends JWTPayload {
  sub: string; // user id or system id
  service: string; // calling service name (e.g., "web", "worker")
  resource?: string; // pageId or driveId depending on scope
  driveId?: string;
  tenantId?: string;
  userId?: string;
  driveIds?: string[];
  scopes: ServiceScope[];
  tokenType: 'service';
  jti: string;
}

export interface ServiceTokenOptions {
  service: string;
  subject: string;
  resource?: string;
  driveId?: string;
  scopes: ServiceScope[];
  expiresIn?: string; // jose duration string
  additionalClaims?: Record<string, unknown>;
}

interface ServiceJWTConfig {
  secret: Uint8Array;
  issuer: string;
  audience: string;
}

const SERVICE_JWT_ALG = 'HS256';
const DEFAULT_SERVICE_TOKEN_EXPIRY = '5m';
const DEFAULT_SERVICE_TOKEN_EXPIRY_SECONDS = 300;

/**
 * Convert jose duration string to seconds.
 * Supports: 's' (seconds), 'm' (minutes), 'h' (hours), 'd' (days)
 */
function durationToSeconds(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) return DEFAULT_SERVICE_TOKEN_EXPIRY_SECONDS;

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
      return DEFAULT_SERVICE_TOKEN_EXPIRY_SECONDS;
  }
}

function getServiceConfig(): ServiceJWTConfig {
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

const RESERVED_SUPPLEMENTAL_CLAIMS = new Set<keyof ServiceTokenClaims | 'scopes' | 'tokenType' | 'aud' | 'iss' | 'exp' | 'iat' | 'nbf'>([
  'sub',
  'service',
  'scopes',
  'tokenType',
  'jti',
  'resource',
  'driveId',
  'driveIds',
  'tenantId',
  'userId',
]);

export async function createServiceToken(options: ServiceTokenOptions): Promise<string> {
  const config = getServiceConfig();

  if (!options.scopes || options.scopes.length === 0) {
    throw new Error('Service token requires at least one scope');
  }

  if (!options.subject || typeof options.subject !== 'string') {
    throw new Error('Service token requires a string subject');
  }

  const additionalClaims = options.additionalClaims ?? {};
  for (const key of Object.keys(additionalClaims)) {
    if (RESERVED_SUPPLEMENTAL_CLAIMS.has(key as keyof ServiceTokenClaims)) {
      throw new Error(`additionalClaims cannot override reserved service token claim: ${key}`);
    }
  }

  const jti = createId();
  const expiresIn = options.expiresIn ?? DEFAULT_SERVICE_TOKEN_EXPIRY;
  const expiresInSeconds = durationToSeconds(expiresIn);

  const payload: ServiceTokenClaims = {
    sub: options.subject,
    service: options.service,
    resource: options.resource,
    driveId: options.driveId,
    scopes: Array.from(new Set(options.scopes)),
    tokenType: 'service',
    jti,
    ...additionalClaims,
  };

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: SERVICE_JWT_ALG })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(config.secret);

  // Record JTI in Redis for tracking/revocation (graceful degradation)
  try {
    const redis = await tryGetSecurityRedisClient();
    if (redis) {
      await recordJTI(jti, options.subject, expiresInSeconds);
    }
  } catch {
    // Log but don't fail token creation - graceful degradation
  }

  return token;
}

export async function verifyServiceToken(token: string): Promise<ServiceTokenClaims> {
  const config = getServiceConfig();

  try {
    const { payload, protectedHeader } = await jwtVerify(token, config.secret, {
      algorithms: [SERVICE_JWT_ALG],
      issuer: config.issuer,
      audience: config.audience,
    });

    if (protectedHeader.alg !== SERVICE_JWT_ALG) {
      throw new Error('Unexpected service token algorithm');
    }

    const claims = payload as ServiceTokenClaims;

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

    // JTI validation (fail-closed in production)
    const redis = await tryGetSecurityRedisClient();
    if (redis) {
      const revoked = await isJTIRevoked(claims.jti);
      if (revoked) {
        throw new Error('Token revoked or invalid');
      }
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error('Security infrastructure unavailable');
    }

    return claims;
  } catch (error) {
    if (error instanceof Error) {
      error.message = `Service token verification failed: ${error.message}`;
    }
    throw error;
  }
}

export function decodeServiceTokenHeader(token: string) {
  return decodeProtectedHeader(token);
}

export function hasScope(claims: ServiceTokenClaims, scope: ServiceScope): boolean {
  if (claims.scopes.includes('*' as ServiceScope)) {
    return true;
  }
  if (claims.scopes.includes(scope)) {
    return true;
  }
  const [namespace] = scope.split(':');
  const wildcard = `${namespace}:*` as ServiceScope;
  return claims.scopes.includes(wildcard);
}

export function assertScope(claims: ServiceTokenClaims, scope: ServiceScope): void {
  if (!hasScope(claims, scope)) {
    const available = claims.scopes.join(', ');
    throw new Error(`Insufficient service scopes. Required: ${scope}. Token scopes: ${available}`);
  }
}

export interface ServiceAuthResult {
  claims: ServiceTokenClaims;
}

export async function authenticateServiceToken(token: string): Promise<ServiceAuthResult> {
  const claims = await verifyServiceToken(token);
  return { claims };
}

export function requireResource(claims: ServiceTokenClaims, resource: string | undefined, kind: 'page' | 'drive'): string {
  const resolved = resource ?? claims.resource;
  if (!resolved) {
    throw new Error(`Service token missing ${kind} resource`);
  }
  return resolved;
}
