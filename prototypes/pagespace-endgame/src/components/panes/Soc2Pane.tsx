import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function Soc2Pane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        Strong SOC 2 coverage.{" "}
        <span className="hl">Closing the last gaps.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        PageSpace maps well to SOC 2 Trust Service Criteria across Security,
        Monitoring, Vulnerability Management, and Change Management. SIEM
        delivery is connected (#873) and audit coverage has expanded to ~19%
        of routes (#868-870). The remaining work is expanding audit coverage
        to 100% and formalizing operational commitments.
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
          description="Processor service: non-root execution (UID 1000). Path traversal protection (blocks ../, URL-encoded, double-encoded, null bytes, absolute paths). MIME filtering (blocks HTML/SVG/XML XSS vectors). Application-level isolation &mdash; no OS-level read-only filesystem yet."
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
            Tamper-evident SHA-256 hash chain with{" "}
            <code>pg_advisory_xact_lock</code> serialization to prevent chain
            forking (works even on empty tables). 35 event types across auth,
            authorization, data access, admin, and security categories. Risk
            scoring and anomaly flags per event. ~47 of 248 routes wired
            (#868-870), covering auth, pages, drives, permissions, settings,
            account, files, and export.
          </p>
        </Card>
        <Card accent="green">
          <h4>SIEM delivery</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Full SIEM adapter: webhook (HMAC-SHA256 signed), syslog (TCP/UDP,
            RFC 5424), batched delivery, retry with backoff, SSRF protection.
            Connected via cursor-based pg-boss worker (#873) &mdash; polls{" "}
            <code>activity_logs</code> every 30s and delivers to external SIEM
            (Splunk, Datadog, etc.). Health endpoint at <code>/health</code>.
            Cursor tracking in <code>siem_delivery_cursors</code> table.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Activity logs</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            28 operation types tracked: create, update, delete, restore,
            reorder, permission changes, trash, move, agent config, membership,
            auth, files, messages, rollbacks. Content snapshots with
            <code> previousValues</code>/<code>newValues</code>. AI attribution
            (<code>isAiGenerated</code>, <code>aiModel</code>,
            <code> aiConversationId</code>). Separate hash chain for integrity.
          </p>
        </Card>
        <Card accent="green">
          <h4>Chain verification + webhook alerting</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Daily cron job recomputes every entry&apos;s hash and verifies chain
            links. Detects break points with position, stored vs. computed hash.
            HMAC-signed cron request prevents unauthorized triggering.
            On failure: webhook alert to <code>AUDIT_ALERT_WEBHOOK_URL</code>
            {" "}(HTTPS-only, fire-and-forget via <code>after()</code>).
          </p>
        </Card>
      </div>
      <Card accent="green" style={{ marginBottom: 12 }}>
        <h4>Anomaly detection</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Login pattern analysis: impossible travel detection (IP geolocation
          heuristic), high-frequency access patterns, new user agent
          detection, known bad IP blocking. Configurable risk weights.
          Results feed into security audit events.
        </p>
      </Card>

      {/* ── Vulnerability Management (CC6.5) ── */}
      <h3 style={{ marginBottom: 12 }}>
        Vulnerability Management (CC6.5)
      </h3>
      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>CodeQL: 156 &rarr; 0</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            156 CodeQL alerts triaged to zero remaining. 107 fixed via code,
            8 dismissed as mitigated, 18 true false positives. 12 security
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
        Mostly operationalized.{" "}
        <span className="hl">Three items remain.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        SIEM delivery, rate limiting, webhook alerting, and broad audit wiring
        are all shipped. What remains: expanding audit coverage from ~19% to
        100%, fixing the activity log chain fork, and formalizing an SLA.
      </p>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="amber">
          <h4>Audit coverage at ~19%</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            SecurityAuditService wired to ~47 of 248 routes: auth, pages,
            drives, permissions, settings, account, files, export. Remaining
            gaps: AI/chat endpoints, integrations, calendar, notifications,
            admin actions, trash, and invitations. The service works &mdash;
            it just needs more call sites.
          </p>
        </Card>
        <Card accent="red">
          <h4>Activity chain can fork</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Activity log hash chain writes not serialized with row locking
            (#542). Concurrent writes can create forks. Security audit chain
            is safe (uses <code>pg_advisory_xact_lock</code>). Activity logs
            do not.
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
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The infrastructure is built and increasingly wired. The end game is
        closing the last coverage gaps: every security-relevant route audited,
        both hash chains non-forkable, and a formal SLA for availability.
      </p>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="cyan">
          <h4>100% audit coverage</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Expand SecurityAuditService from ~19% to all security-relevant
            routes. Every page CRUD, permission change, file operation, admin
            action, and settings change produces an immutable audit event.
            AI/chat, integrations, calendar, notifications, trash, and
            invitations are the remaining categories.
          </p>
        </Card>
        <Card accent="cyan">
          <h4>Chain integrity</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Fix activity log hash chain: add{" "}
            <code>pg_advisory_xact_lock</code> serialization (matching security
            audit pattern). Fix GDPR anonymization chain break. Both chains
            verified and non-forkable.
          </p>
        </Card>
        <Card accent="cyan">
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
          SIEM delivery is connected (#873). Audit coverage expanded from 2%
          to ~19% (#868-870). Rate limiting, webhook alerting, and admin
          auditing are all shipped. The remaining SOC 2 work is coverage
          expansion and formalization &mdash; not new infrastructure.
        </p>
      </Card>
    </div>
  );
}
