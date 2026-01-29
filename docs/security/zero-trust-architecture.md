# Zero-Trust Security Architecture for PageSpace Cloud

## Executive Summary

This document specifies a comprehensive security hardening for PageSpace cloud deployment, adopting zero-trust principles where no service implicitly trusts claims from another service.

**Core Principles:**
1. Never trust, always verify
2. Auth happens at point of data access
3. Opaque tokens with centralized session store
4. Hash all secrets before storage/comparison
5. Instant revocation capability
6. Defense in depth at every layer

---

## 1. Token Architecture Overhaul

### 1.1 Replace JWTs with Opaque Tokens

**Current State (Vulnerable):**
```text
Web App → JWT with claims → Processor (trusts claims)
```

**Target State (Zero-Trust):**
```text
Web App → Opaque Token → Processor → Auth Service → Session Store
                                            ↓
                                    Verified Claims
```

#### Session Token Schema

```typescript
// packages/db/src/schema/sessions.ts

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Token storage - ALWAYS hashed
  tokenHash: text('token_hash').unique().notNull(),
  tokenPrefix: text('token_prefix').notNull(), // First 8 chars for debugging

  // Identity
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Session metadata
  type: text('type', { enum: ['user', 'service', 'mcp', 'device'] }).notNull(),
  scopes: text('scopes').array().notNull().default([]),

  // Resource binding (for service tokens)
  resourceType: text('resource_type'), // 'page', 'drive', 'file'
  resourceId: text('resource_id'),

  // Security context
  tokenVersion: integer('token_version').notNull(),
  createdByService: text('created_by_service'),
  createdByIp: text('created_by_ip'),

  // Lifecycle
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
  lastUsedIp: text('last_used_ip'),
  revokedAt: timestamp('revoked_at', { mode: 'date' }),
  revokedReason: text('revoked_reason'),

  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

// Indexes for fast lookup
export const sessionsTokenHashIdx = index('sessions_token_hash_idx').on(sessions.tokenHash);
export const sessionsUserIdIdx = index('sessions_user_id_idx').on(sessions.userId);
export const sessionsExpiresAtIdx = index('sessions_expires_at_idx').on(sessions.expiresAt);
```

#### Token Generation

```typescript
// packages/lib/src/auth/opaque-tokens.ts

import { createId } from '@paralleldrive/cuid2';
import { createHash, randomBytes } from 'crypto';

export interface OpaqueToken {
  token: string;      // Full token (never stored)
  tokenHash: string;  // SHA-256 hash (stored in DB)
  tokenPrefix: string; // First 8 chars (for debugging)
}

/**
 * Generate a cryptographically secure opaque token
 * Format: ps_{type}_{random} e.g., ps_sess_x7k2m9p1n3v5z2b4w6j8q0
 */
export function generateOpaqueToken(type: 'sess' | 'svc' | 'mcp' | 'dev'): OpaqueToken {
  // 32 bytes = 256 bits of entropy
  const randomPart = randomBytes(32).toString('base64url');
  const token = `ps_${type}_${randomPart}`;

  return {
    token,
    tokenHash: hashToken(token),
    tokenPrefix: token.substring(0, 12),
  };
}

/**
 * Hash token using SHA-256
 * Both sides hash before comparison - immune to timing attacks
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Validate token format before processing
 */
export function isValidTokenFormat(token: string): boolean {
  if (typeof token !== 'string') return false;
  if (token.length < 40 || token.length > 100) return false;
  if (!token.startsWith('ps_')) return false;
  return /^ps_(sess|svc|mcp|dev)_[A-Za-z0-9_-]+$/.test(token);
}
```

### 1.2 Session Service (Centralized Auth)

```typescript
// packages/lib/src/auth/session-service.ts

import { db, sessions, users } from '@pagespace/db';
import { eq, and, isNull, gt, lt } from 'drizzle-orm';
import { hashToken, generateOpaqueToken, isValidTokenFormat } from './opaque-tokens';

export interface SessionClaims {
  sessionId: string;
  userId: string;
  userRole: 'user' | 'admin';
  tokenVersion: number;
  type: 'user' | 'service' | 'mcp' | 'device';
  scopes: string[];
  resourceType?: string;
  resourceId?: string;
}

export interface CreateSessionOptions {
  userId: string;
  type: 'user' | 'service' | 'mcp' | 'device';
  scopes: string[];
  expiresInMs: number;
  resourceType?: string;
  resourceId?: string;
  createdByService?: string;
  createdByIp?: string;
}

export class SessionService {
  /**
   * Create a new session and return the opaque token
   * The raw token is returned ONCE and never stored
   */
  async createSession(options: CreateSessionOptions): Promise<string> {
    // Verify user exists and get current tokenVersion
    const user = await db.query.users.findFirst({
      where: eq(users.id, options.userId),
      columns: { id: true, tokenVersion: true, role: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    const tokenType = options.type === 'service' ? 'svc'
      : options.type === 'mcp' ? 'mcp'
      : options.type === 'device' ? 'dev'
      : 'sess';

    const { token, tokenHash, tokenPrefix } = generateOpaqueToken(tokenType);

    await db.insert(sessions).values({
      tokenHash,
      tokenPrefix,
      userId: options.userId,
      type: options.type,
      scopes: options.scopes,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      tokenVersion: user.tokenVersion,
      createdByService: options.createdByService,
      createdByIp: options.createdByIp,
      expiresAt: new Date(Date.now() + options.expiresInMs),
    });

    return token;
  }

  /**
   * Validate token and return claims
   * This is the ONLY way to get claims - no JWT decoding
   */
  async validateSession(token: string): Promise<SessionClaims | null> {
    // Validate format first (fast rejection)
    if (!isValidTokenFormat(token)) {
      return null;
    }

    // Hash the provided token
    const tokenHash = hashToken(token);

    // Look up session with user
    const session = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date())
      ),
      with: {
        user: {
          columns: { id: true, tokenVersion: true, role: true, suspendedAt: true }
        }
      }
    });

    if (!session) {
      return null;
    }

    // Verify user still valid
    if (!session.user || session.user.suspendedAt) {
      return null;
    }

    // Verify tokenVersion matches (instant revocation)
    if (session.tokenVersion !== session.user.tokenVersion) {
      // Token was invalidated by password change, logout all, etc.
      await this.revokeSession(token, 'token_version_mismatch');
      return null;
    }

    // Update last used (fire and forget)
    db.update(sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash))
      .catch(() => {}); // Non-blocking

    return {
      sessionId: session.id,
      userId: session.userId,
      userRole: session.user.role,
      tokenVersion: session.tokenVersion,
      type: session.type,
      scopes: session.scopes,
      resourceType: session.resourceType ?? undefined,
      resourceId: session.resourceId ?? undefined,
    };
  }

  /**
   * Revoke a specific session
   */
  async revokeSession(token: string, reason: string): Promise<void> {
    const tokenHash = hashToken(token);
    await db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(eq(sessions.tokenHash, tokenHash));
  }

  /**
   * Revoke all sessions for a user (logout everywhere)
   */
  async revokeAllUserSessions(userId: string, reason: string): Promise<number> {
    const result = await db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt)
      ));
    return result.rowCount ?? 0;
  }

  /**
   * Revoke all sessions of a specific type for a user
   */
  async revokeUserSessionsByType(
    userId: string,
    type: 'user' | 'service' | 'mcp' | 'device',
    reason: string
  ): Promise<number> {
    const result = await db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(
        eq(sessions.userId, userId),
        eq(sessions.type, type),
        isNull(sessions.revokedAt)
      ));
    return result.rowCount ?? 0;
  }

  /**
   * Clean up expired sessions (run periodically)
   */
  async cleanupExpiredSessions(): Promise<number> {
    const result = await db.delete(sessions)
      .where(lt(sessions.expiresAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
    return result.rowCount ?? 0;
  }
}

export const sessionService = new SessionService();
```

### 1.3 Service-to-Service Authentication

```typescript
// packages/lib/src/auth/service-client.ts

import { sessionService, type SessionClaims } from './session-service';

export interface ServiceTokenRequest {
  userId: string;
  scopes: string[];
  resourceType?: string;
  resourceId?: string;
  expiresInMs?: number;
}

const DEFAULT_SERVICE_TOKEN_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Create a service token for inter-service calls
 * Called by web app when making requests to processor
 */
export async function createServiceToken(
  callingService: string,
  request: ServiceTokenRequest,
  clientIp?: string
): Promise<string> {
  return sessionService.createSession({
    userId: request.userId,
    type: 'service',
    scopes: request.scopes,
    resourceType: request.resourceType,
    resourceId: request.resourceId,
    expiresInMs: request.expiresInMs ?? DEFAULT_SERVICE_TOKEN_TTL,
    createdByService: callingService,
    createdByIp: clientIp,
  });
}

/**
 * Validate a service token (called by processor)
 * Returns null if invalid, revoked, or expired
 */
export async function validateServiceToken(token: string): Promise<SessionClaims | null> {
  const claims = await sessionService.validateSession(token);

  if (!claims) {
    return null;
  }

  if (claims.type !== 'service') {
    return null;
  }

  return claims;
}

/**
 * Check if claims have required scope
 */
export function hasScope(claims: SessionClaims, requiredScope: string): boolean {
  if (claims.scopes.includes('*')) return true;
  if (claims.scopes.includes(requiredScope)) return true;

  // Check namespace wildcards (e.g., 'files:*' covers 'files:read')
  const [namespace] = requiredScope.split(':');
  return claims.scopes.includes(`${namespace}:*`);
}

/**
 * Check if claims allow access to a specific resource
 */
export function canAccessResource(
  claims: SessionClaims,
  resourceType: string,
  resourceId: string
): boolean {
  // If token is bound to a specific resource, verify it matches
  if (claims.resourceType && claims.resourceId) {
    return claims.resourceType === resourceType && claims.resourceId === resourceId;
  }

  // Unbound tokens can access based on scopes only
  // (Additional RBAC check should happen at data layer)
  return true;
}
```

---

## 2. Password & Credential Hardening

### 2.1 Passwordless Options

```typescript
// packages/lib/src/auth/passwordless.ts

import { createId } from '@paralleldrive/cuid2';
import { createHash, randomBytes } from 'crypto';

/**
 * Magic Link Authentication
 */
export interface MagicLinkToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function generateMagicLinkToken(): MagicLinkToken {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  return {
    token,
    tokenHash,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
  };
}

/**
 * Passkey / WebAuthn Support
 */
export interface PasskeyCredential {
  id: string;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  counter: number;
  deviceType: 'platform' | 'cross-platform';
  backedUp: boolean;
  transports?: AuthenticatorTransport[];
}

// Schema addition for passkeys
export const passkeys = pgTable('passkeys', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // WebAuthn credential data
  credentialId: bytea('credential_id').unique().notNull(),
  publicKey: bytea('public_key').notNull(),
  counter: integer('counter').notNull().default(0),

  // Credential metadata
  deviceType: text('device_type', { enum: ['platform', 'cross-platform'] }).notNull(),
  backedUp: boolean('backed_up').default(false),
  transports: text('transports').array(),

  // User-friendly naming
  name: text('name'),

  // Audit
  lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});
```

### 2.2 Password Upgrade Path

```typescript
// packages/lib/src/auth/password-policy.ts

import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

/**
 * Argon2id-equivalent using scrypt with OWASP-recommended parameters
 * scrypt is available in Node.js without external dependencies
 */
export interface HashedPassword {
  hash: string;
  algorithm: 'scrypt-n32768-r8-p1';
}

const SCRYPT_PARAMS = {
  N: 32768,  // CPU/memory cost (2^15)
  r: 8,      // Block size
  p: 1,      // Parallelization
  keyLen: 64 // Output length
};

export async function hashPassword(password: string): Promise<HashedPassword> {
  const salt = randomBytes(32);
  const derivedKey = await scryptAsync(password, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  }) as Buffer;

  // Format: $algorithm$params$salt$hash
  const hash = [
    '$scrypt',
    `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`,
    salt.toString('base64'),
    derivedKey.toString('base64'),
  ].join('$');

  return { hash, algorithm: 'scrypt-n32768-r8-p1' };
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');

  // Handle legacy bcrypt hashes (migration path)
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$')) {
    const bcrypt = await import('bcryptjs');
    return bcrypt.compare(password, storedHash);
  }

  if (parts[1] !== 'scrypt') {
    throw new Error('Unknown password hash algorithm');
  }

  const salt = Buffer.from(parts[3], 'base64');
  const storedKey = Buffer.from(parts[4], 'base64');

  const derivedKey = await scryptAsync(password, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  }) as Buffer;

  // Timing-safe comparison
  return timingSafeEqual(derivedKey, storedKey);
}

/**
 * Check if password needs rehashing (algorithm upgrade)
 */
export function needsRehash(storedHash: string): boolean {
  return storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$');
}
```

---

## 3. RBAC at Data Access Layer

### 3.1 Permission Enforcement in Repositories

```typescript
// packages/lib/src/permissions/enforced-context.ts

import type { SessionClaims } from '../auth/session-service';

/**
 * Enforced auth context - MUST be created from validated session
 * This cannot be constructed directly, only via fromSession()
 */
export class EnforcedAuthContext {
  private constructor(
    public readonly userId: string,
    public readonly userRole: 'user' | 'admin',
    public readonly scopes: ReadonlySet<string>,
    public readonly resourceBinding?: { type: string; id: string }
  ) {
    Object.freeze(this);
  }

  static fromSession(claims: SessionClaims): EnforcedAuthContext {
    return new EnforcedAuthContext(
      claims.userId,
      claims.userRole,
      new Set(claims.scopes),
      claims.resourceType && claims.resourceId
        ? { type: claims.resourceType, id: claims.resourceId }
        : undefined
    );
  }

  hasScope(scope: string): boolean {
    if (this.scopes.has('*')) return true;
    if (this.scopes.has(scope)) return true;
    const [namespace] = scope.split(':');
    return this.scopes.has(`${namespace}:*`);
  }

  isAdmin(): boolean {
    return this.userRole === 'admin';
  }

  isBoundToResource(type: string, id: string): boolean {
    if (!this.resourceBinding) return true; // Unbound = flexible
    return this.resourceBinding.type === type && this.resourceBinding.id === id;
  }
}
```

### 3.2 Enforced Repository Pattern

```typescript
// packages/lib/src/repositories/enforced-file-repository.ts

import { db, files, driveMembers, pages } from '@pagespace/db';
import { eq, and } from 'drizzle-orm';
import { EnforcedAuthContext } from '../permissions/enforced-context';

export class EnforcedFileRepository {
  constructor(private ctx: EnforcedAuthContext) {}

  /**
   * Get file - enforces permission check at data layer
   */
  async getFile(fileId: string) {
    // First, get the file with its page and drive context
    const file = await db.query.files.findFirst({
      where: eq(files.id, fileId),
      with: {
        page: {
          with: {
            drive: true
          }
        }
      }
    });

    if (!file) {
      return null;
    }

    // Enforce resource binding if present
    if (!this.ctx.isBoundToResource('file', fileId) &&
        !this.ctx.isBoundToResource('page', file.pageId) &&
        !this.ctx.isBoundToResource('drive', file.page.driveId)) {
      throw new ForbiddenError('Token not authorized for this resource');
    }

    // Check drive membership (unless admin)
    if (!this.ctx.isAdmin()) {
      const membership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, file.page.driveId),
          eq(driveMembers.userId, this.ctx.userId)
        )
      });

      if (!membership) {
        throw new ForbiddenError('User not a member of this drive');
      }
    }

    // Check scope
    if (!this.ctx.hasScope('files:read')) {
      throw new ForbiddenError('Missing files:read scope');
    }

    return file;
  }

  /**
   * Update file - enforces write permission
   */
  async updateFile(fileId: string, data: Partial<typeof files.$inferInsert>) {
    // Get file first (includes read permission check)
    const file = await this.getFile(fileId);
    if (!file) {
      throw new NotFoundError('File not found');
    }

    // Check write scope
    if (!this.ctx.hasScope('files:write')) {
      throw new ForbiddenError('Missing files:write scope');
    }

    // Check drive role allows editing
    const membership = await db.query.driveMembers.findFirst({
      where: and(
        eq(driveMembers.driveId, file.page.driveId),
        eq(driveMembers.userId, this.ctx.userId)
      )
    });

    if (!this.ctx.isAdmin() && membership?.role === 'viewer') {
      throw new ForbiddenError('Viewer role cannot modify files');
    }

    return db.update(files)
      .set(data)
      .where(eq(files.id, fileId))
      .returning();
  }
}

class ForbiddenError extends Error {
  status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

class NotFoundError extends Error {
  status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
```

---

## 4. Processor Service Hardening

### 4.1 Updated Auth Middleware

```typescript
// apps/processor/src/middleware/zero-trust-auth.ts

import type { NextFunction, Request, Response } from 'express';
import { validateServiceToken, hasScope, canAccessResource, type SessionClaims } from '@pagespace/lib';
import { EnforcedAuthContext } from '@pagespace/lib/permissions';

declare global {
  namespace Express {
    interface Request {
      auth?: EnforcedAuthContext;
      claims?: SessionClaims;
    }
  }
}

export async function authenticateRequest(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = header.slice(7).trim();

  try {
    // Validate token against session store (NOT JWT decode)
    const claims = await validateServiceToken(token);

    if (!claims) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // Create enforced context - this is the ONLY way to get auth context
    req.auth = EnforcedAuthContext.fromSession(claims);
    req.claims = claims;

    next();
  } catch (error) {
    console.error('Authentication failed:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!req.auth.hasScope(scope)) {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: scope
      });
      return;
    }

    next();
  };
}

export function requireResource(type: string, idParam: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const resourceId = req.params[idParam] || req.body?.[idParam];

    if (!resourceId) {
      res.status(400).json({ error: `Missing ${idParam}` });
      return;
    }

    if (!req.auth.isBoundToResource(type, resourceId)) {
      res.status(403).json({
        error: 'Token not authorized for this resource',
        resourceType: type,
        resourceId
      });
      return;
    }

    next();
  };
}
```

### 4.2 Enforced File Operations

```typescript
// apps/processor/src/services/enforced-file-service.ts

import { EnforcedAuthContext } from '@pagespace/lib/permissions';
import { EnforcedFileRepository } from '@pagespace/lib/repositories';

export interface OptimizeOptions {
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  format?: 'webp' | 'avif' | 'jpeg' | 'png';
}

export class EnforcedFileService {
  private fileRepo: EnforcedFileRepository;

  constructor(auth: EnforcedAuthContext) {
    // Repository is bound to this auth context
    // All operations will be permission-checked
    this.fileRepo = new EnforcedFileRepository(auth);
  }

  async optimizeImage(fileId: string, options: OptimizeOptions) {
    // Permission check happens inside getFile()
    const file = await this.fileRepo.getFile(fileId);

    if (!file) {
      throw new Error('File not found');
    }

    // Perform optimization...
    const optimizedData = await this.performOptimization(file, options);

    // Permission check happens inside updateFile()
    return this.fileRepo.updateFile(fileId, {
      optimizedPath: optimizedData.path,
      optimizedAt: new Date(),
    });
  }
}
```

---

## 5. Token Comparison Security

### 5.1 Hash-Before-Compare Pattern

```typescript
// packages/lib/src/auth/secure-compare.ts

import { createHash, timingSafeEqual } from 'crypto';

/**
 * Secure token comparison that is immune to:
 * 1. Timing attacks (uses timingSafeEqual on fixed-length hashes)
 * 2. Compiler optimizations (hashing prevents shortcut evaluation)
 * 3. Length-based leakage (all hashes are same length)
 */
export function secureTokenCompare(provided: string, stored: string): boolean {
  // Hash both tokens before comparison
  const providedHash = createHash('sha256').update(provided).digest();
  const storedHash = createHash('sha256').update(stored).digest();

  // timingSafeEqual on fixed-length buffers
  return timingSafeEqual(providedHash, storedHash);
}

/**
 * For tokens already stored as hashes, compare hash to hash
 */
export function secureHashCompare(providedToken: string, storedHash: string): boolean {
  const providedHash = createHash('sha256').update(providedToken).digest('hex');

  // Convert to buffers for timing-safe comparison
  const providedBuffer = Buffer.from(providedHash, 'hex');
  const storedBuffer = Buffer.from(storedHash, 'hex');

  if (providedBuffer.length !== storedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, storedBuffer);
}
```

---

## 6. Audit Logging

### 6.1 Security Event Schema

```typescript
// packages/db/src/schema/security-audit.ts

export const securityAuditLog = pgTable('security_audit_log', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Event classification
  eventType: text('event_type', {
    enum: [
      'auth.login.success',
      'auth.login.failure',
      'auth.logout',
      'auth.token.created',
      'auth.token.revoked',
      'auth.password.changed',
      'auth.mfa.enabled',
      'auth.mfa.disabled',
      'authz.access.granted',
      'authz.access.denied',
      'data.read',
      'data.write',
      'data.delete',
      'admin.user.created',
      'admin.user.suspended',
      'security.anomaly.detected',
    ]
  }).notNull(),

  // Actor
  userId: text('user_id'),
  sessionId: text('session_id'),
  serviceId: text('service_id'),

  // Target
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),

  // Context
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  geoLocation: text('geo_location'),

  // Details
  details: jsonb('details'),

  // Risk assessment
  riskScore: real('risk_score'),
  anomalyFlags: text('anomaly_flags').array(),

  // Timing
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),

  // Integrity (hash chain)
  previousHash: text('previous_hash'),
  eventHash: text('event_hash').notNull(),
});
```

### 6.2 Audit Service

```typescript
// packages/lib/src/audit/security-audit.ts

import { createHash } from 'crypto';
import { db, securityAuditLog } from '@pagespace/db';
import { desc, eq } from 'drizzle-orm';

export interface AuditEvent {
  eventType: string;
  userId?: string;
  sessionId?: string;
  serviceId?: string;
  resourceType?: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  riskScore?: number;
  anomalyFlags?: string[];
}

/**
 * Security Audit Service with hash chain integrity
 *
 * IMPORTANT: Multi-instance considerations
 * - This service maintains an in-memory lastHash for the hash chain
 * - In multi-instance deployments, use database-backed state instead:
 *   1. Use a Redis lock or database advisory lock before inserting
 *   2. Always read the latest hash from DB within the transaction
 *   3. Or use a dedicated single-instance audit writer service
 *
 * For production cloud deployments, consider:
 * - Running as a singleton service behind a queue
 * - Using database sequences for ordering
 * - Accepting eventual consistency with per-instance chains merged later
 */
export class SecurityAuditService {
  private lastHash: string | null = null;
  private initialized = false;

  /**
   * Initialize the service by loading the last hash from the database
   * Call this during service startup, not lazily
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const lastEvent = await db.query.securityAuditLog.findFirst({
      orderBy: desc(securityAuditLog.timestamp),
      columns: { eventHash: true }
    });
    this.lastHash = lastEvent?.eventHash ?? 'genesis';
    this.initialized = true;
  }

  async logEvent(event: AuditEvent): Promise<void> {
    // Ensure initialized (fallback for lazy init, but prefer explicit init)
    if (!this.initialized) {
      await this.initialize();
    }

    // Create hash of this event (includes previous hash for chain)
    const eventData = JSON.stringify({
      ...event,
      timestamp: new Date().toISOString(),
      previousHash: this.lastHash,
    });

    const eventHash = createHash('sha256').update(eventData).digest('hex');

    await db.insert(securityAuditLog).values({
      ...event,
      previousHash: this.lastHash,
      eventHash,
    });

    this.lastHash = eventHash;
  }

  // Convenience methods
  async logAuthSuccess(userId: string, sessionId: string, ip: string, userAgent: string) {
    return this.logEvent({
      eventType: 'auth.login.success',
      userId,
      sessionId,
      ipAddress: ip,
      userAgent,
    });
  }

  async logAuthFailure(attemptedUser: string, ip: string, reason: string) {
    return this.logEvent({
      eventType: 'auth.login.failure',
      details: { attemptedUser, reason },
      ipAddress: ip,
      riskScore: 0.3,
    });
  }

  async logAccessDenied(
    userId: string,
    resourceType: string,
    resourceId: string,
    reason: string
  ) {
    return this.logEvent({
      eventType: 'authz.access.denied',
      userId,
      resourceType,
      resourceId,
      details: { reason },
      riskScore: 0.5,
    });
  }
}

export const securityAudit = new SecurityAuditService();
```

---

## 7. Rate Limiting & Anomaly Detection

### 7.1 Distributed Rate Limiting

```typescript
// packages/lib/src/security/distributed-rate-limit.ts

import { Redis } from 'ioredis';

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}

export class DistributedRateLimiter {
  constructor(private redis: Redis) {}

  async checkLimit(
    key: string,
    config: RateLimitConfig
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    const fullKey = `ratelimit:${config.keyPrefix}:${key}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    // Use Redis sorted set for sliding window
    const pipe = this.redis.pipeline();

    // Remove old entries
    pipe.zremrangebyscore(fullKey, 0, windowStart);

    // Count current entries
    pipe.zcard(fullKey);

    // Add current request
    pipe.zadd(fullKey, now, `${now}-${Math.random()}`);

    // Set expiry
    pipe.pexpire(fullKey, config.windowMs);

    const results = await pipe.exec();
    const currentCount = (results?.[1]?.[1] as number) ?? 0;

    const allowed = currentCount < config.maxRequests;
    const remaining = Math.max(0, config.maxRequests - currentCount - 1);
    const resetAt = new Date(now + config.windowMs);

    return { allowed, remaining, resetAt };
  }
}

// Rate limit configurations
export const RATE_LIMITS = {
  LOGIN: { windowMs: 15 * 60 * 1000, maxRequests: 5, keyPrefix: 'login' },
  API: { windowMs: 60 * 1000, maxRequests: 100, keyPrefix: 'api' },
  SERVICE: { windowMs: 60 * 1000, maxRequests: 1000, keyPrefix: 'service' },
} as const;
```

### 7.2 Anomaly Detection

```typescript
// packages/lib/src/security/anomaly-detection.ts

import { Redis } from 'ioredis';
import { securityAudit } from '../audit/security-audit';

export interface AnomalyContext {
  userId: string;
  ipAddress: string;
  userAgent: string;
  action: string;
}

export class AnomalyDetector {
  constructor(private redis: Redis) {}

  async analyzeRequest(ctx: AnomalyContext): Promise<{
    riskScore: number;
    flags: string[];
  }> {
    const flags: string[] = [];
    let riskScore = 0;

    // Check for impossible travel
    const lastLocation = await this.getLastLocation(ctx.userId);
    if (lastLocation && await this.isImpossibleTravel(lastLocation, ctx.ipAddress)) {
      flags.push('impossible_travel');
      riskScore += 0.4;
    }

    // Update last location for future checks
    await this.redis.set(
      `user:${ctx.userId}:last_location`,
      JSON.stringify({ ip: ctx.ipAddress, timestamp: Date.now() }),
      'EX',
      86400 // 24 hour TTL
    );

    // Check for unusual user agent
    const knownAgents = await this.getKnownUserAgents(ctx.userId);
    if (knownAgents.length > 0 && !knownAgents.includes(ctx.userAgent)) {
      flags.push('new_user_agent');
      riskScore += 0.2;
    }

    // Check for high-frequency access
    const recentActions = await this.getRecentActionCount(ctx.userId, ctx.action);
    if (recentActions > 100) {
      flags.push('high_frequency');
      riskScore += 0.3;
    }

    // Check for known bad IP
    if (await this.isKnownBadIP(ctx.ipAddress)) {
      flags.push('known_bad_ip');
      riskScore += 0.5;
    }

    // Log if high risk
    if (riskScore > 0.5) {
      await securityAudit.logEvent({
        eventType: 'security.anomaly.detected',
        userId: ctx.userId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        details: { action: ctx.action },
        riskScore,
        anomalyFlags: flags,
      });
    }

    return { riskScore, flags };
  }

  private async getLastLocation(userId: string): Promise<{ ip: string; timestamp: number } | null> {
    const data = await this.redis.get(`user:${userId}:last_location`);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Detect impossible travel based on IP geolocation and time
   *
   * Implementation notes:
   * - Requires a GeoIP database (e.g., MaxMind GeoIP2)
   * - Calculate distance between coordinates using Haversine formula
   * - Compare against maximum feasible travel speed (~900 km/h for commercial flight)
   *
   * For production, integrate with:
   * - @maxmind/geoip2-node for IP geolocation
   * - A proper geo distance library
   */
  private async isImpossibleTravel(
    lastLocation: { ip: string; timestamp: number },
    currentIp: string
  ): Promise<boolean> {
    // Skip if same IP
    if (lastLocation.ip === currentIp) return false;

    const timeDiffMs = Date.now() - lastLocation.timestamp;
    const timeDiffHours = timeDiffMs / (1000 * 60 * 60);

    // If less than 1 hour, flag IPs from different /16 subnets as suspicious
    // This is a simplified heuristic - production should use GeoIP
    if (timeDiffHours < 1) {
      const lastPrefix = lastLocation.ip.split('.').slice(0, 2).join('.');
      const currentPrefix = currentIp.split('.').slice(0, 2).join('.');
      if (lastPrefix !== currentPrefix) {
        // Different /16 subnet in under an hour - potentially suspicious
        // In production, use actual geo coordinates and distance calculation
        return true;
      }
    }

    // For proper implementation:
    // 1. const lastGeo = await geoip.lookup(lastLocation.ip);
    // 2. const currentGeo = await geoip.lookup(currentIp);
    // 3. const distanceKm = haversine(lastGeo.coords, currentGeo.coords);
    // 4. const maxPossibleDistanceKm = timeDiffHours * 900; // Max flight speed
    // 5. return distanceKm > maxPossibleDistanceKm;

    return false;
  }

  private async getKnownUserAgents(userId: string): Promise<string[]> {
    return this.redis.smembers(`user:${userId}:user_agents`);
  }

  private async getRecentActionCount(userId: string, action: string): Promise<number> {
    const key = `user:${userId}:action:${action}`;
    const count = await this.redis.get(key);
    return parseInt(count ?? '0', 10);
  }

  private async isKnownBadIP(ip: string): Promise<boolean> {
    return this.redis.sismember('security:bad_ips', ip).then(r => r === 1);
  }
}
```

---

## 8. Migration Strategy

### 8.1 Dual-Mode Operation

During migration, support both old JWT and new opaque token systems:

```typescript
// packages/lib/src/auth/dual-mode-auth.ts

import { validateServiceToken, type SessionClaims } from './service-client';
import { verifyServiceToken as verifyLegacyJWT } from './legacy-service-auth';
import { securityAudit } from '../audit/security-audit';

export async function validateToken(token: string): Promise<SessionClaims | null> {
  // New opaque tokens start with 'ps_'
  if (token.startsWith('ps_')) {
    return validateServiceToken(token);
  }

  // Legacy JWT tokens
  try {
    const claims = await verifyLegacyJWT(token);

    // Log legacy token usage for migration tracking via audit system
    await securityAudit.logEvent({
      eventType: 'auth.token.created', // Using existing enum, consider adding 'auth.legacy.jwt.used'
      serviceId: claims.service,
      userId: claims.sub,
      details: {
        tokenType: 'legacy_jwt',
        migrationNote: 'Legacy JWT token still in use - should migrate to opaque tokens',
      },
      riskScore: 0.1, // Low risk but worth tracking
    });

    return {
      sessionId: 'legacy',
      userId: claims.sub,
      userRole: 'user',
      tokenVersion: 0,
      type: 'service',
      scopes: claims.scopes,
      resourceType: claims.resource ? 'page' : undefined,
      resourceId: claims.resource,
    };
  } catch {
    return null;
  }
}
```

### 8.2 Migration Phases

| Phase | Duration | Actions | Status |
|-------|----------|---------|--------|
| 1 | Week 1-2 | Deploy session store, dual-mode auth | ✅ Complete |
| 2 | Week 3-4 | Migrate web app to opaque tokens | ✅ Complete |
| 3 | Week 5-6 | Migrate processor to verify via session store | ✅ Complete |
| 4 | Week 7-8 | Migrate realtime service | ✅ Complete |
| 5 | Week 9+ | Deprecate and remove JWT code paths | ✅ Complete |

### 8.3 Device Token Migration (Phase 5 - Completed Jan 2026)

Device tokens have been migrated from JWT to opaque session-based tokens:

**Changes Made:**
- `generateDeviceToken()` now returns opaque `ps_dev_*` tokens (synchronous, no params)
- `validateDeviceToken()` uses hash-only DB lookup, validates opaque token format
- Removed JWT/jose dependency for device tokens
- Added `tokenVersion` column to `device_tokens` table for "logout all devices" support
- Updated `atomicDeviceTokenRotation()` and `atomicValidateOrCreateDeviceToken()` for opaque tokens

**Security Improvements:**

| Aspect | Before | After |
|--------|--------|-------|
| Token format | JWT (eyJhbGc...) | Opaque (ps_dev_...) |
| Token payload | userId, deviceId, tokenVersion visible | Nothing visible (zero-trust) |
| Validation | JWT verify + DB lookup | DB lookup only |
| TokenVersion storage | Embedded in JWT | Stored in DB record |

**Breaking Change:** Existing JWT device tokens will fail validation. Users need to re-authenticate once after deployment.

**Files Modified:**
- `packages/lib/src/auth/device-auth-utils.ts`
- `packages/db/src/schema/auth.ts` (added tokenVersion column)
- `packages/db/src/transactions/auth-transactions.ts`
- `apps/web/src/app/api/auth/google/callback/route.ts` (OAuth redirect fix for desktop)
- `apps/web/src/app/api/account/devices/route.ts`

---

## 9. Infrastructure Requirements

### 9.1 Redis for Session Store

```yaml
# docker-compose.security.yml
services:
  redis-sessions:
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy volatile-ttl
    volumes:
      - redis-sessions-data:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  redis-sessions-data:
```

### 9.2 Environment Variables

```bash
# .env.production.security
# Session store
REDIS_SESSION_URL=redis://redis-sessions:6379/0

# Secrets (minimum 32 chars, rotate regularly)
SESSION_ENCRYPTION_KEY=<64-char-hex-for-sensitive-session-data>
CSRF_SECRET=<32-char-random>

# Deprecated (migration complete - can be removed)
# JWT_SECRET is still used for user session JWTs (separate from service tokens)
JWT_SECRET=<rotate-regularly>
# SERVICE_JWT_SECRET has been removed - system now uses opaque tokens
```

---

## 10. Security Checklist

### Pre-Deployment

- [ ] Redis session store deployed and tested
- [ ] Database migrations for sessions table applied
- [ ] All secrets rotated and properly secured
- [ ] Rate limiting configured and tested
- [ ] Audit logging enabled and verified
- [ ] Anomaly detection thresholds tuned

### Post-Deployment

- [ ] Monitor legacy JWT usage (should decline to zero)
- [ ] Verify session revocation works (test logout everywhere)
- [ ] Confirm rate limits are effective
- [ ] Review audit logs for anomalies
- [ ] Penetration test service-to-service auth
- [ ] Document incident response procedures

---

## Appendix: File Structure

```text
packages/lib/src/
├── auth/
│   ├── opaque-tokens.ts          # Token generation
│   ├── session-service.ts        # Centralized session management
│   ├── service-client.ts         # Service-to-service auth
│   ├── secure-compare.ts         # Hash-before-compare
│   ├── passwordless.ts           # Magic links, passkeys
│   ├── password-policy.ts        # Scrypt hashing
│   └── dual-mode-auth.ts         # Migration support
├── permissions/
│   └── enforced-context.ts       # Immutable auth context
├── repositories/
│   └── enforced-file-repository.ts
├── security/
│   ├── distributed-rate-limit.ts
│   └── anomaly-detection.ts
└── audit/
    └── security-audit.ts

packages/db/src/schema/
├── sessions.ts                   # New session table
├── passkeys.ts                   # WebAuthn credentials
└── security-audit.ts             # Audit log table

apps/processor/src/middleware/
└── zero-trust-auth.ts            # New auth middleware
```
