import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function Soc2Pane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        Strong SOC 2 coverage.{" "}
        <span className="hl">Gaps are in operationalization.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        PageSpace maps well to SOC 2 Trust Service Criteria across Security,
        Monitoring, Vulnerability Management, and Change Management. The
        infrastructure is built. The gap is wiring it comprehensively and
        making the audit trail operational.
      </p>

      {/* ── Security (CC6) ── */}
      <h3 style={{ marginBottom: 12 }}>Security (CC6)</h3>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--green)"
          name="Authentication"
          description="Opaque session tokens (SHA-256 hashed, never stored plaintext). Passkeys (WebAuthn) with counter-based replay detection. Magic links. OAuth (Google/Apple). Device flow for mobile."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Access control"
          description="RBAC: drive membership (Owner/Admin/Member), page-level permissions (canView/canEdit/canShare/canDelete), expiring permissions. Redis-cached resolution (L1 memory + L2 Redis + L3 Postgres)."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Brute force protection"
          description="Account lockout: 10 failed attempts &rarr; 15-minute lockout. Distributed rate limiting (Redis-backed, fail-closed in production). Progressive delay. Per-IP and per-account tracking."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--green)"
          name="CSRF protection"
          description="HMAC-SHA256 with timing-safe comparison. 1-hour max age. Applied to all state-changing operations."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Encryption"
          description="AES-256-GCM with scrypt key derivation for integration credentials. Per-field encryption with unique salt + IV. Session tokens SHA-256 hashed. TLS in transit."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Sandboxing"
          description="Processor service: read-only filesystem with tmpfs. Path traversal protection (blocks ../, URL-encoded, null bytes). MIME filtering (blocks XSS vectors). Non-root execution (UID 1000)."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      {/* ── Monitoring & Logging (CC7) ── */}
      <h3 style={{ marginBottom: 12, marginTop: 20 }}>
        Monitoring &amp; Logging (CC7)
      </h3>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Security audit log</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Tamper-evident SHA-256 hash chain with <code>FOR UPDATE</code>{" "}
            row locking to prevent chain forking. 27 event types across auth,
            authorization, data access, admin, and security categories. Risk
            scoring and anomaly flags per event.
          </p>
        </Card>
        <Card accent="amber">
          <h4>
            Coverage gap: 5 of 252 routes{" "}
            <span style={{ color: "var(--red)" }}>(~2%)</span>
          </h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            SecurityAuditService is only wired to login, logout, and mobile
            login routes. Core operations (page CRUD, drive management, settings
            changes, file uploads, permission changes) are <strong>not covered</strong>.
            The service works &mdash; it just needs to be called from more places.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Activity logs</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            26+ operation types tracked: create, update, delete, restore,
            reorder, permission changes, trash, move, agent config, membership,
            auth, files, messages, rollbacks. Content snapshots with
            <code> previousValues</code>/<code>newValues</code>. AI attribution
            (<code>isAiGenerated</code>, <code>aiModel</code>,
            <code> aiConversationId</code>). Separate hash chain for integrity.
          </p>
        </Card>
        <Card accent="green">
          <h4>Chain verification</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Daily cron job recomputes every entry&apos;s hash and verifies chain
            links. Detects break points with position, stored vs. computed hash.
            HMAC-signed cron request prevents unauthorized triggering.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Anomaly detection</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Login pattern analysis: impossible travel detection (IP geolocation
            heuristic), high-frequency access patterns, new user agent
            detection, known bad IP blocking. Configurable risk weights.
            Results feed into security audit events.
          </p>
        </Card>
        <Card accent="amber">
          <h4>SIEM adapter (built, not connected)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Full SIEM adapter exists: webhook delivery with HMAC-SHA256
            signatures, syslog (TCP/UDP) with RFC 5424 format, batched delivery,
            retry with backoff, SSRF protection. <strong>Gap:</strong> zero
            production calls to <code>deliverToSiem()</code>. The adapter is
            built but not wired to the logging pipeline.
          </p>
        </Card>
      </div>

      {/* ── Vulnerability Management (CC6.5) ── */}
      <h3 style={{ marginBottom: 12 }}>
        Vulnerability Management (CC6.5)
      </h3>
      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>CodeQL: 156 &rarr; 0</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            156 CodeQL alerts triaged to zero remaining. 64 fixed via code,
            36 dismissed as mitigated, 42 true false positives. 12 security
            PRs merged. Covers SSRF, ReDoS, shell injection, timing attacks,
            OAuth state.
          </p>
        </Card>
        <Card accent="green">
          <h4>Security test suite</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Dedicated <code>pnpm test:security</code> command. Tests for auth,
            permissions, encryption, CSRF. Cloud security hardening plan
            tracks 22 identified vulnerabilities (4 critical, 8 high, 6 medium,
            4 low).
          </p>
        </Card>
        <Card accent="green">
          <h4>Security documentation</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Compliance sovereignty analysis (549 lines), security posture
            assessment, cloud hardening plan, zero-trust architecture doc,
            permission cache threat model, CSRF audit report, CodeQL triage log.
          </p>
        </Card>
      </div>

      {/* ── Change Management (CC9) ── */}
      <h3 style={{ marginBottom: 12 }}>Change Management (CC9)</h3>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Content versioning</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            30-day page version retention. Pinnable versions exempt from expiry.
            Source tracking (manual, auto, pre_ai, pre_restore). Drive backups
            with full restore. Version comparison API.
          </p>
        </Card>
        <Card accent="green">
          <h4>Rollback &amp; audit</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Activity log-based rollback via <code>rollbackFromActivityId</code>.
            Denormalized source data survives deletion. Product changelog
            maintained. AI changes attributed with model, provider, and
            conversation ID.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Controls exist.{" "}
        <span className="hl">Operationalization doesn&apos;t.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The security infrastructure is solid. The gap is making it
        comprehensive: wiring the audit service to all routes, connecting the
        SIEM adapter, fixing known integrity issues, and formalizing what
        exists into auditable controls.
      </p>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--red)"
          name="Audit coverage at 2%"
          description="SecurityAuditService exists with hash chain integrity, but only 5 of 252 API routes call it. Core product operations (pages, drives, files, settings) are not security-audited."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="Activity chain can fork"
          description="Activity log hash chain writes not serialized with row locking (#542). Concurrent writes can create forks. Security audit chain is safe (uses FOR UPDATE). Activity logs do not."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="SIEM not connected"
          description="Full SIEM adapter built (webhook + syslog, HMAC-signed, RFC 5424) but zero production calls. Audit events go to database only. No external SIEM delivery."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="red">
          <h4>Verification alerting (#544)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Chain verification failures only go to <code>console.error</code>.
            A broken audit chain is a high-severity compliance event. No
            durable alerting, no webhook routing, no paging integration.
          </p>
        </Card>
        <Card accent="red">
          <h4>Missing audit events (#535-537)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Login rate-limit denials (429s) not logged as security audit events.
            Privileged admin reads (viewing other users&apos; data) not covered.
            These are compliance-relevant operations with no audit trail.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="amber">
          <h4>In-memory rate limiting (#842)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Marketing contact route (public, unauthenticated) uses
            <code> Map()</code> instead of Redis. State lost on deploy. Not
            shared across instances. Distributed rate limiter exists and is
            used elsewhere &mdash; just not wired here.
          </p>
        </Card>
        <Card accent="amber">
          <h4>No formal SLA</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Availability trust criteria (A1) has no documented SLA. No uptime
            commitment, no incident response SLA, no RTO/RPO targets.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        Audit-ready.{" "}
        <span className="hl">Every control operationalized.</span>
      </h2>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--cyan)"
          name="100% audit coverage"
          description="SecurityAuditService wired to all security-relevant routes. Every page CRUD, permission change, file operation, admin action, and settings change produces an immutable audit event."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="SIEM delivery"
          description="Connect the existing SIEM adapter to the logging pipeline. Audit events stream to external SIEM (Splunk, Datadog, etc.) in real time. The adapter is built — it just needs wiring."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Chain integrity"
          description="Fix activity log hash chain: add FOR UPDATE locking (matching security audit pattern). Fix GDPR anonymization chain break. Both chains verified and non-forkable."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2">
        <Card accent="blue">
          <h4>Durable alerting</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Chain verification failures route to structured alerting:
            webhook, SIEM, paging integration. Machine-parseable payloads
            with environment, break point, and severity. Not just
            <code> console.error</code>.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Formal SLA + evidence collection</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Documented availability SLA with RTO/RPO targets. Automated
            SOC 2 evidence collection: control descriptions mapped to code,
            periodic evidence snapshots, auditor-ready export.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)", marginTop: 12 }}>
        <h4 style={{ color: "var(--dim)" }}>The pattern</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          Most SOC 2 gaps are &ldquo;built but not connected&rdquo; or
          &ldquo;connected but not comprehensive.&rdquo; The SIEM adapter
          exists but isn&apos;t wired. The audit service exists but only
          covers 2% of routes. The rate limiter exists but one route
          doesn&apos;t use it. The fix is operationalization, not new
          infrastructure.
        </p>
      </Card>
    </div>
  );
}
