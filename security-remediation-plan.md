# PageSpace Security Remediation Plan
*Comprehensive Security Assessment and Remediation Roadmap*

## Executive Summary

Multiple critical security vulnerabilities exist across PageSpace's authentication, authorization, file handling, and infrastructure layers that prevent safe deployment to cloud or on-premises environments. These issues collectively allow complete authentication bypass, unauthorized data access/deletion, and service abuse by both external attackers and malicious insiders.

**Key Risk Areas:**
- **Authentication Layer**: Missing await statements bypass JWT validation entirely
- **Authorization Layer**: File and resource operations lack user permission validation
- **Infrastructure**: Services exposed without authentication, default credentials in deployment
- **Data Protection**: Tokens stored in plaintext, no encryption at rest, weak legacy encryption
- **Operational**: In-memory rate limiting fails in distributed deployments

**Impact Assessment:**
- **Cloud Deployment**: Complete security failure, unsuitable for multi-tenant SaaS
- **On-Premises (Legal/Medical)**: Fails compliance requirements, exposes client data
- **Current State**: Any deployment represents unacceptable risk to customer data

---

## Critical Launch Blockers (Must Fix Immediately)

### 1. Authentication Bypass via Missing await

**Research Findings:**
Several Next.js route handlers call the asynchronous `decodeToken` function but never await it. Because a pending Promise is truthy, the subsequent `if (!decoded)` checks never fail, so any caller who sets an `accessToken` cookie (even with junk data) is treated as authenticated.

**Technical Evidence:**
```typescript
// VULNERABLE PATTERN - Current Code
const decoded = decodeToken(accessToken); // Returns Promise<DecodedToken | null>
if (!decoded) { // Promise is always truthy, check never fails
  return unauthorized();
}
```

**Impact:**
- Unauthenticated attackers can fetch user records by email
- Complete enumeration of page structures possible
- Destructive trash-deletion workflows accessible
- Total compromise of tenant isolation and data confidentiality

**Affected Components:**
- Next.js API route handlers using JWT validation
- User profile endpoints
- Page hierarchy endpoints
- Trash management endpoints

**Remediation:**
```typescript
// SECURE PATTERN - Required Fix
const decoded = await decodeToken(accessToken);
if (!decoded) {
  return unauthorized();
}
// Additional: Verify user permissions on target resources
```

**Files to Update:**
- All API routes in `apps/web/src/app/api/`
- Authentication middleware
- Route handler implementations

---

### 2. Processor Service Completely Exposed

**Research Findings:**
The processor Express server exposes unauthenticated upload, ingestion, optimization, and file-serving endpoints on a host-visible port (3003:3003), enabling direct manipulation or exfiltration of stored documents if the service is reachable on the network.

**Technical Evidence:**
- Upload endpoints accept arbitrary files without authentication
- Optimization routes process files for any caller
- File serving routes return content by hash without validation
- Avatar management allows overwriting any user's avatar by ID
- Job queue can be flooded by unauthorized requests

**Impact:**
- Anyone on network can upload arbitrary files and force ingestion jobs
- Complete data exfiltration by guessing content hashes
- Service disruption through job queue flooding
- Avatar hijacking across all users
- Storage exhaustion and CPU abuse

**Attack Scenarios:**
1. **Data Exfiltration**: `curl http://processor:3003/files/download/{known_hash}` returns any stored file
2. **Storage Abuse**: Unlimited file uploads consume disk space and processing resources
3. **Queue Flooding**: Malicious ingestion jobs degrade service for legitimate users
4. **Avatar Hijacking**: `POST /avatar/upload` with another user's ID overwrites their avatar

**Remediation:**
- Implement service-to-service authentication (signed JWT or mTLS)
- Move processor to internal network segment
- Validate user permissions before processing files
- Add comprehensive rate limiting and quotas
- Implement audit logging for all processor operations

**Files to Update:**
- `processor/src/routes/` - All route handlers
- `processor/src/middleware/` - Authentication middleware
- Docker Compose networking configuration

---

### 3. Missing File Authorization

**Research Findings:**
File-handling APIs only verify that a drive or page exists, not that the caller has access. Any authenticated user can upload into, read from, or transform files in drives they do not own.

**Technical Evidence:**
```typescript
// VULNERABLE PATTERN - Current Code
const drive = await db.select().from(drives).where(eq(drives.id, driveId)).first();
if (!drive) {
  return notFound();
}
// No check if user can access this drive
```

**Impact:**
- Cross-tenant file uploads and quota exhaustion
- Complete file access across all user drives and pages
- Unauthorized file transformations and conversions
- Data exfiltration from any accessible page/drive

**Attack Scenarios:**
1. **Cross-Tenant Upload**: User A uploads files to User B's drive
2. **Data Theft**: User A downloads all files from User B's pages
3. **Storage Abuse**: Attacker fills other users' quotas with junk files
4. **Content Manipulation**: Unauthorized file transformations consume resources

**Remediation:**
- Implement comprehensive authorization checks on all file operations
- Validate user ownership or explicit permissions before any file access
- Add resource-level permission validation middleware
- Implement audit logging for all file access attempts

**Files to Update:**
- `apps/web/src/app/api/upload/` - Upload endpoints
- `apps/web/src/app/api/files/` - File access endpoints
- `apps/web/src/app/api/pages/` - Page file operations
- Authorization middleware and permission utilities

---

### 4. Plaintext Token Storage

**Research Findings:**
Refresh tokens and MCP API keys are persisted in cleartext in both the login flow and database schema. The validation path reads them directly without hashing. A database leak would immediately yield reusable credentials.

**Technical Evidence:**
```sql
-- VULNERABLE SCHEMA - Current Database
CREATE TABLE refresh_tokens (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL, -- Stored in plaintext
  user_id INTEGER REFERENCES users(id)
);

CREATE TABLE mcp_tokens (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL, -- Stored in plaintext
  user_id INTEGER REFERENCES users(id)
);
```

**Impact:**
- Database compromise grants immediate, long-lived access to all user accounts
- Backup leaks expose persistent authentication credentials
- Unacceptable for regulated industries (HIPAA, GLBA, SOX)
- Token rotation becomes ineffective security control

**Attack Scenarios:**
1. **Database Breach**: Direct access to reusable tokens for all users
2. **Backup Theft**: Historical tokens remain valid until rotation
3. **Insider Threat**: DBA access grants authentication bypass
4. **Compliance Violation**: Fails audit requirements for credential protection

**Remediation:**
- Hash tokens with bcrypt/argon2 before database storage
- Store only token fingerprints/JTIs for identification
- Implement constant-time comparison for token validation
- Add token rotation and revocation capabilities
- Migrate existing plaintext tokens securely

**Files to Update:**
- `packages/db/src/schema/auth.ts` - Database schema
- Authentication service token handling
- Login flow token generation and validation
- MCP token management endpoints

---

### 5. Default Credentials in Deployment

**Research Findings:**
Docker manifests ship with hard-coded database and Redis credentials exposed on host ports. Services bind to 0.0.0.0 by default, making them accessible beyond localhost.

**Technical Evidence:**
```yaml
# VULNERABLE CONFIG - Current docker-compose.yml
services:
  postgres:
    environment:
      POSTGRES_USER: postgres      # Hard-coded
      POSTGRES_PASSWORD: password  # Hard-coded
    ports:
      - "5432:5432"  # Exposed to host

  redis:
    ports:
      - "6379:6379"  # Exposed to host
```

**Impact:**
- Immediate database access for anyone on the network
- Shared default credentials across all installations
- Unacceptable for cloud hosting environments
- Dangerous for on-premises if credentials unchanged
- Fails basic security hardening requirements

**Attack Scenarios:**
1. **Network Access**: Any host on network can access databases directly
2. **Credential Reuse**: Default passwords enable cross-installation access
3. **Data Exfiltration**: Direct database access bypasses all application controls
4. **Lateral Movement**: Compromised database enables privilege escalation

**Remediation:**
- Generate unique secrets per deployment installation
- Bind services to internal networks only (no host port exposure)
- Implement proper secrets management (environment variables, vaults)
- Provide secure deployment templates with proper networking
- Add startup validation to ensure secrets are changed

**Files to Update:**
- `docker-compose.yml` - Service configuration
- `docker-compose.prod.yml` - Production configuration
- Deployment documentation and templates
- Environment configuration examples

---

### 6. Unauthenticated File Access via Content Hash

**Research Findings:**
The processor serves originals, thumbnails, OCR text, and metadata to anyone who knows a contentHash, and the web API returns these hashes to clients. Attackers can enumerate or replay leaked hashes to exfiltrate documents.

**Technical Evidence:**
```typescript
// VULNERABLE PATTERN - Current Processor
app.get('/files/original/:hash', (req, res) => {
  const { hash } = req.params;
  // No authentication or authorization check
  const filePath = getOriginalPath(hash);
  res.sendFile(filePath);
});
```

**Impact:**
- Complete data exfiltration using known or guessed content hashes
- File access bypasses all application-level permissions
- Thumbnails and metadata exposure without authorization
- Hash enumeration enables systematic data theft

**Attack Scenarios:**
1. **Hash Replay**: Leaked hashes from logs/traffic enable file access
2. **Hash Enumeration**: Systematic guessing of hash values
3. **Metadata Leak**: OCR text and thumbnails expose document content
4. **Cross-Reference**: Combine API responses with direct processor access

**Remediation:**
- Require authentication for all file serving endpoints
- Validate user permissions before serving any file content
- Implement secure content serving with temporary, signed URLs
- Remove content hashes from client-facing APIs where possible
- Add comprehensive access logging

**Files to Update:**
- `processor/src/routes/files.ts` - File serving routes
- `processor/src/routes/optimize.ts` - Optimization endpoints
- Authentication middleware for processor service
- Web API responses containing content hashes

---

## High Severity Issues (Pre-Launch Required)

### 7. In-Memory Rate Limiting Only

**Research Findings:**
Rate limiting utilities maintain counters in local memory, which is ineffective once the service scales horizontally or restarts. Cloud deployments behind load balancers lose brute-force protection.

**Technical Evidence:**
```typescript
// VULNERABLE PATTERN - Current Implementation
const rateLimitMap = new Map<string, RateLimitInfo>(); // In-memory only

export function checkRateLimit(key: string): boolean {
  const info = rateLimitMap.get(key);
  // Lost on restart, not shared across instances
}
```

**Impact:**
- Brute-force protection ineffective in distributed deployments
- Rate limits reset on application restart
- Load balancer spreads requests across instances, bypassing limits
- Account lockout expectations undermined

**Remediation:**
- Migrate to distributed store (Redis/database-backed counters)
- Implement sliding window or token bucket algorithms
- Add IP reputation tracking across instances
- Support gateway-level throttling configuration

---

### 8. Single Static JWT Secret with No Rotation

**Research Findings:**
All access and refresh tokens are signed with one symmetric key loaded from `JWT_SECRET`. There's no key identifier, rotation cadence, or audit trail—raising operational and compliance risk.

**Technical Evidence:**
```typescript
// VULNERABLE PATTERN - Current Implementation
const JWT_SECRET = process.env.JWT_SECRET; // Single key
const token = jwt.sign(payload, JWT_SECRET); // No key ID
```

**Impact:**
- Key compromise affects all tokens across all users
- No graceful key rotation capability
- Difficult incident response and forensics
- Fails compliance requirements for key management

**Remediation:**
- Implement JWKS (JSON Web Key Set) with multiple active keys
- Add key identifiers (`kid`) to token headers
- Support seamless key rotation without service disruption
- Add key lifecycle management and audit trails

---

### 9. Weak Legacy Encryption Defaults

**Research Findings:**
Legacy decrypt functionality falls back to a hard-coded salt string when `ENCRYPTION_SALT` isn't set, so any instance using default configs shares the same derived key material.

**Technical Evidence:**
```typescript
// VULNERABLE PATTERN - Current Code
const salt = process.env.ENCRYPTION_SALT || 'default-salt-string';
```

**Impact:**
- Shared encryption keys across installations using defaults
- Legacy secret compromise affects multiple deployments
- Fails compliance expectations for data encryption
- Difficult to audit encryption key usage

**Remediation:**
- Remove insecure fallback defaults entirely
- Require per-installation unique salts
- Migrate existing legacy secrets to new salted format
- Add configuration validation at startup

---

### 10. No Inter-Service TLS/mTLS

**Research Findings:**
All inter-service traffic (including file downloads) uses plain HTTP with no encryption or service authentication. This is unacceptable for multi-tenant cloud deployment.

**Impact:**
- Service-to-service traffic visible to network observers
- No authentication between internal services
- Man-in-the-middle attacks possible on internal network
- Fails compliance requirements for data in transit

**Remediation:**
- Implement TLS for all inter-service communication
- Add mutual TLS (mTLS) for service authentication
- Use service mesh or API gateway for traffic management
- Certificate lifecycle management for service identities

---

### 11. Unvalidated Database Writes from Processor

**Research Findings:**
The processor updates pages records with no tenant context validation. It trusts caller-supplied `pageId`/`userId` values when writing directly to PostgreSQL.

**Impact:**
- Cross-tenant data corruption possible
- Unauthorized metadata updates
- Database integrity compromise
- Audit trail gaps for data modifications

**Remediation:**
- Enforce tenant-scoped database operations
- Validate page ownership before any database writes
- Use scoped service accounts with limited permissions
- Implement stored procedures with built-in authorization

---

### 12. Missing Security Audit Logging

**Research Findings:**
Security-sensitive routes (file reads, processor downloads) lack structured logging or tamper-evident audit trails—mandatory for legal/medical tenants.

**Impact:**
- No forensic capability after security incidents
- Compliance failures for regulated industries
- Inability to detect ongoing attacks
- No accountability for data access

**Remediation:**
- Implement comprehensive audit logging for all security events
- Use tamper-evident storage (append-only logs)
- Add real-time security monitoring and alerting
- Support SIEM integration for enterprise customers

---

## Medium Priority (Compliance & Hardening)

### 13. Data at Rest Encryption
**Issue**: Files and metadata stored without encryption on local volumes
**Fix**: Implement volume-level or application-layer encryption using existing AES utilities

### 14. Enhanced Token Management
**Issue**: No token-type claims, device binding, or anomaly detection
**Fix**: Add token metadata, device fingerprinting, and abuse detection

### 15. HTTPS Enforcement
**Issue**: No consistent HTTPS enforcement or secure cookie flags
**Fix**: Mandatory HTTPS even for local deployments, secure cookie configuration

### 16. Compliance Features for Regulated Industries
**Issue**: Missing audit capabilities, retention policies, customer-managed keys
**Fix**: Configurable compliance features, SIEM integration, data residency controls

---

## Detailed Research Evidence

### Report 1: Authentication & Authorization Failures

**Executive Summary:**
Multiple Next.js API routes attempt to "validate" JWTs without awaiting the asynchronous decodeToken call, so any request with a dummy accessToken cookie bypasses authentication entirely. These handlers also skip authorization checks, allowing unauthenticated users to enumerate page hierarchies, read profile data, and permanently delete trashed content by ID.

**Critical Findings:**

1. **Authentication Bypass via Missing await**
   - Several Next.js route handlers call asynchronous `decodeToken` function without await
   - Pending Promise is truthy, so `if (!decoded)` checks never fail
   - Any caller with accessToken cookie (even junk data) treated as authenticated
   - Complete compromise of tenant isolation and data confidentiality

2. **Unauthorized Destructive Actions on Trash and Pages**
   - Trash deletion routes never validate user ownership of referenced pages/drives
   - Even after auth fix, unauthorized users can delete any trashed resource by ID
   - Breadcrumb fetching routes expose private hierarchies without permission checks
   - Malicious insiders can permanently erase other users' data

3. **Processor Service Exposed Without Authentication**
   - Express server mounts all routes without authentication, CORS, or abuse protections
   - Upload arbitrary files, delete avatars, retrieve assets by hash
   - Flood job queue to degrade service
   - Complete data exfiltration and service abuse possible

**High Severity Findings:**

4. **Plaintext Refresh Tokens**
   - Stored verbatim in refresh_tokens table
   - Database leak grants long-lived session replay
   - Unacceptable for regulated industries

5. **Weak Legacy Encryption Defaults**
   - Hard-coded salt fallback when ENCRYPTION_SALT not set
   - Shared key material across installations using defaults
   - Compliance failure for legal/medical tenants

6. **In-Memory Rate Limiting Only**
   - Counters in local memory, ineffective for horizontal scaling
   - Brute-force protection lost on restart or load balancing
   - Account lockout expectations undermined

### Report 2: Token Management & Session Security

**Executive Summary:**
The custom authentication stack has critical flaws in JWT session handling, refresh-token rotation, and MCP API tokens that create release blockers for both cloud MVP and on-premises deployments.

**Critical Blockers:**

1. **Plaintext Long-Lived Token Storage**
   - Refresh tokens and MCP API keys persisted in cleartext
   - Database leak yields immediately reusable credentials
   - Hash tokens at rest with bcrypt/argon2

2. **Rate Limiting is In-Memory Only**
   - Map-based limiter designed for single-node development
   - Won't protect cloud deployment or HA on-premises cluster
   - Replace with shared data store (Redis/Memcached/Postgres)

3. **Single Static HS256 Secret**
   - All tokens signed with one symmetric key from JWT_SECRET
   - No key identifier, rotation cadence, or audit trail
   - Adopt managed secret storage, introduce key IDs, support rotation

**Additional Pre-Launch Requirements:**
- Add token-type claims to prevent confusion across token classes
- Enforce HTTPS and Secure cookie flags for production deployments
- Expand anomaly detection for refresh-token reuse and device changes

### Report 3: File Security & Infrastructure

**Executive Summary:**
File-handling lacks basic authorization checks and the processor microservice exposes unauthenticated endpoints. Default deployment manifests ship with exposed credentials and no encryption—critical failures for regulated customers.

**Critical Blockers:**

1. **Missing File Authorization**
   - Upload routes only check drive existence, not user permissions
   - File view/download/convert endpoints skip permission checks entirely
   - Any authenticated user can access files in drives they don't own

2. **Processor Service Locked Down**
   - Listens publicly (3003:3003) with no authentication
   - Trusts caller-supplied pageId/userId when writing to Postgres
   - Direct file serving by contentHash without validation

3. **Unauthorized File Retrieval via Content Hashes**
   - Processor serves files to anyone knowing contentHash
   - Web API returns hashes to clients, enabling enumeration
   - Complete data exfiltration possible with leaked/guessed hashes

4. **Default Credentials in Deployment**
   - Docker manifests publish Postgres/Redis with default passwords
   - Services bind to 0.0.0.0, exposing databases to host network
   - Unacceptable for any production deployment

**Additional High-Risk Findings:**
- No TLS between services (plain HTTP for all inter-service traffic)
- Direct database writes from processor without tenant validation
- Data at rest stored unencrypted on local volumes
- Missing audit trails for file operations and processor activity

---

## Implementation Timeline

### Phase 1: Critical Blockers (Week 1)
**Priority**: Launch blocking issues that enable complete security bypass

1. **Authentication Bypass Fix**
   - Add await to all decodeToken calls
   - Implement proper error handling
   - Add authorization checks to all protected routes

2. **Processor Security**
   - Implement service-to-service authentication
   - Move to internal network segment
   - Add comprehensive request validation

3. **File Authorization**
   - Implement permission middleware for all file operations
   - Validate user access to target drives/pages
   - Add resource-level authorization checks

### Phase 2: High Severity (Week 2)
**Priority**: Infrastructure and operational security

4. **Token Security**
   - Hash refresh and MCP tokens in database
   - Implement distributed rate limiting
   - Add JWT key rotation capability

5. **Service Hardening**
   - Inter-service TLS implementation
   - Remove default credentials from deployment
   - Secure processor database operations

6. **Audit & Monitoring**
   - Comprehensive security event logging
   - Real-time monitoring and alerting
   - Tamper-evident audit trails

### Phase 3: Compliance (Week 3)
**Priority**: Regulatory and enterprise requirements

7. **Data Protection**
   - Encryption at rest implementation
   - Enhanced token management features
   - HTTPS enforcement across all services

8. **Compliance Features**
   - Configurable retention policies
   - SIEM integration capabilities
   - Customer-managed encryption keys

### Phase 4: Validation (Week 4)
**Priority**: Security testing and compliance verification

9. **Security Testing**
   - Penetration testing of all fixed vulnerabilities
   - Automated security regression testing
   - Load testing with security controls enabled

10. **Compliance Validation**
    - Audit readiness verification
    - Documentation completion
    - Deployment runbook validation

---

## Success Criteria

### Authentication & Authorization
- [ ] No authentication bypass possible with any token combination
- [ ] All protected routes require valid, awaited JWT validation
- [ ] Complete authorization enforcement on all resource operations
- [ ] User permissions validated before any file or page access

### Service Security
- [ ] All services require authentication for access
- [ ] Inter-service communication encrypted with TLS/mTLS
- [ ] Processor service requires authorization for all operations
- [ ] No default credentials in any deployment configuration

### Token Management
- [ ] All long-lived tokens hashed in database storage
- [ ] Distributed rate limiting functional across instances
- [ ] JWT key rotation implemented and tested
- [ ] Token lifecycle management and revocation working

### Infrastructure Hardening
- [ ] Services isolated on internal networks only
- [ ] Database writes validated for tenant context
- [ ] Comprehensive audit logging for all security events
- [ ] Real-time monitoring and alerting operational

### Compliance Readiness
- [ ] Data encryption at rest implemented
- [ ] Audit trails tamper-evident and complete
- [ ] SIEM integration tested and documented
- [ ] Regulatory compliance requirements satisfied

### Deployment Security
- [ ] No shared secrets or default credentials
- [ ] All services properly networked and isolated
- [ ] Security configuration validated at startup
- [ ] Deployment runbooks include security hardening steps

---

## Risk Assessment Matrix

| Vulnerability | Current Risk | Post-Fix Risk | Business Impact |
|---------------|--------------|---------------|-----------------|
| Auth Bypass | **CRITICAL** | LOW | Complete data breach |
| File Authorization | **CRITICAL** | LOW | Cross-tenant data access |
| Processor Exposure | **CRITICAL** | LOW | Data exfiltration |
| Plaintext Tokens | **HIGH** | LOW | Account takeover |
| Default Credentials | **CRITICAL** | LOW | System compromise |
| Content Hash Access | **CRITICAL** | LOW | Document theft |
| Rate Limiting | **HIGH** | MEDIUM | Brute force attacks |
| Legacy Encryption | **MEDIUM** | LOW | Historic data exposure |

**Overall Risk Level**: **CRITICAL** → **LOW** (post-remediation)
**Deployment Recommendation**: **BLOCK** → **APPROVED** (post-remediation)

---

*This document represents a comprehensive security assessment combining findings from multiple security reviews. All issues must be addressed before any production deployment to cloud or on-premises environments.*