import { SignJWT, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { createId } from '@paralleldrive/cuid2';

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

  const payload: ServiceTokenClaims = {
    sub: options.subject,
    service: options.service,
    resource: options.resource,
    driveId: options.driveId,
    scopes: Array.from(new Set(options.scopes)),
    tokenType: 'service',
    jti: createId(),
    ...additionalClaims,
  };

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: SERVICE_JWT_ALG })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(config.secret);
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
