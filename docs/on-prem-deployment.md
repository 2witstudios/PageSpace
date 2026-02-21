# PageSpace On-Premise Deployment Guide

## Overview

PageSpace can be deployed on-premise for environments requiring data sovereignty, HIPAA compliance, or air-gapped operation. When `DEPLOYMENT_MODE=onprem` is set, the application automatically:

- Disables Stripe billing (all users get business-tier features)
- Disables OAuth (Google, Apple), magic links, and passkeys
- Enables password-only authentication
- Disables self-registration (admin creates all accounts)
- Filters AI providers to local-only (Ollama, LM Studio) + Azure OpenAI
- Enables HIPAA session idle timeout (15 minutes default)
- Sets AI usage log retention (90 days default)
- Tightens CSP headers (removes Google/Stripe external origins)
- Blocks cloud-only API routes at the middleware layer

## Prerequisites

- Mac Studio (or equivalent server hardware)
- Docker and Docker Compose
- PostgreSQL 16+
- Node.js 20+ and pnpm 9+
- Ollama (for local AI) or Azure OpenAI with BAA

## Quick Start

### 1. Clone and Configure

```bash
git clone <repository-url> pagespace
cd pagespace
cp .env.onprem.example .env
```

Edit `.env` and fill in:
- Database credentials
- Security secrets (generate with `openssl rand -hex 32`)
- Application URL
- Ollama URL (if not localhost)

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Database Setup

```bash
# Start PostgreSQL (if using Docker)
docker run -d \
  --name pagespace-db \
  -e POSTGRES_USER=pagespace \
  -e POSTGRES_PASSWORD=your_strong_password \
  -e POSTGRES_DB=pagespace \
  -p 5432:5432 \
  -v /encrypted-volume/pgdata:/var/lib/postgresql/data \
  postgres:16

# Run migrations
pnpm db:migrate
```

### 4. Create First Admin User

```bash
pnpm setup:admin \
  --email admin@clinic.local \
  --password "SecurePassword123!" \
  --name "Dr. Smith"
```

### 5. Start Services

```bash
# Development
pnpm dev

# Production build
pnpm build
pnpm start
```

### 6. Configure Ollama

Ensure Ollama is running and has at least one model pulled:

```bash
ollama pull llama3.2
ollama pull nomic-embed-text  # for embeddings
```

## Infrastructure Hardening

### PostgreSQL Encryption at Rest

HIPAA requires encryption at rest for PHI. Mount PostgreSQL data on an encrypted volume:

```bash
# Create LUKS encrypted volume (Linux)
cryptsetup luksFormat /dev/sdX
cryptsetup open /dev/sdX encrypted-pg
mkfs.ext4 /dev/mapper/encrypted-pg
mount /dev/mapper/encrypted-pg /encrypted-volume/pgdata

# macOS: Use FileVault or create an encrypted APFS volume
diskutil apfs addVolume disk1 APFS "PGData" -role V
# Enable FileVault on the volume
```

Enable SSL in PostgreSQL:
```ini
# postgresql.conf
ssl = on
ssl_cert_file = '/path/to/server.crt'
ssl_key_file = '/path/to/server.key'
```

### TLS Configuration

All traffic must use TLS. Use a reverse proxy:

```nginx
# nginx.conf
server {
    listen 443 ssl;
    server_name pagespace.clinic.local;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /socket.io/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Network Isolation

- Only the web container should reach PostgreSQL
- No egress to public internet (except Azure OpenAI endpoint if configured)
- Firewall: only allow inbound on HTTPS port (443) from clinic LAN

### Backup and Recovery

```bash
# Daily PostgreSQL backup (add to cron)
pg_dump -Fc pagespace > /encrypted-backup/pagespace-$(date +%Y%m%d).dump

# File storage backup
rsync -av /data/files/ /encrypted-backup/files/

# Backup audit chain tip separately for tamper detection
psql -c "SELECT event_hash FROM security_audit_log ORDER BY created_at DESC LIMIT 1" > /encrypted-backup/chain-tip.txt
```

## Security Architecture

### What's Already Built

- AES-256-GCM encryption for API keys at rest
- Dual SHA-256 hash-chain audit logs (activity + security events)
- Opaque session tokens with server-side revocation
- CSRF dual-layer protection (cookie + header)
- CSP with nonces and strict-dynamic
- Rate limiting + account lockout (5 failed attempts)
- Origin validation on all API routes
- bcrypt cost 12 for all password hashing

### On-Prem Additions

- Idle session timeout (15 min default, configurable via `SESSION_IDLE_TIMEOUT_MS`)
- Middleware route blocking (cloud-only routes return 404)
- Tightened CSP (no external Google/Stripe origins)
- AI usage log retention with configurable TTL

## HIPAA Compliance Checklist

### Technical Safeguards (Implemented)
- [x] Access control: Role-based (admin/user)
- [x] Audit controls: Hash-chain verified security audit log
- [x] Integrity controls: AES-256-GCM encryption, hash chain verification
- [x] Transmission security: TLS required (configure via reverse proxy)
- [x] Automatic logoff: Idle session timeout (15 min)
- [x] Encryption at rest: PostgreSQL on encrypted volume

### Administrative Safeguards (Document These)
- [ ] Business Associate Agreement (BAA) with Microsoft for Azure OpenAI
- [ ] Staff data handling policy
- [ ] Incident response procedure
- [ ] Annual risk assessment
- [ ] Workforce training on PHI handling

### Physical Safeguards (Document These)
- [ ] Server in locked room/closet
- [ ] Physical access log
- [ ] Workstation use policy
- [ ] Device and media controls

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DEPLOYMENT_MODE` | (none) | Set to `onprem` to enable on-prem mode |
| `NEXT_PUBLIC_DEPLOYMENT_MODE` | (none) | Client-side mirror of DEPLOYMENT_MODE |
| `SESSION_IDLE_TIMEOUT_MS` | `900000` (15 min) | Idle timeout before session revocation |
| `AI_LOG_RETENTION_DAYS` | `90` | Days before AI usage logs are purged |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
