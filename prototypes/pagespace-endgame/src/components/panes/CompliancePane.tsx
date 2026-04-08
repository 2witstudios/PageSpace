import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function CompliancePane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        Production security infrastructure.{" "}
        <span className="hl">Not bolted on.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        Tamper-evident audit logs, AES-256-GCM encryption, anomaly detection,
        per-event re-authorization, and processor sandboxing are production
        features today. See the GDPR, SOC 2, and HIPAA tabs for how these
        map to specific compliance frameworks.
      </p>

      <h3 style={{ marginBottom: 12 }}>Audit trail</h3>
      <div className="g2" style={{ marginBottom: 16 }}>
        <Card accent="green">
          <h4>Security audit log (hash chain)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Every security event is recorded in a tamper-evident SHA-256 hash
            chain. Each entry stores <code>previousHash</code> and its own
            <code> eventHash</code>. <code>FOR UPDATE</code> locking prevents
            chain forking on concurrent writes. 27 event types across auth,
            authorization, data access, admin, and security categories.
            Risk scoring and anomaly flags per event.
          </p>
        </Card>
        <Card accent="green">
          <h4>Chain verification (cron)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Daily cron job (<code>/api/cron/verify-audit-chain</code>)
            recomputes every entry&apos;s hash and verifies chain links.
            Detects break points with position, stored vs computed hash.
            HMAC-signed cron request prevents unauthorized triggering.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>Activity logs</h3>
      <div className="g2" style={{ marginBottom: 16 }}>
        <Card accent="green">
          <h4>26+ operations tracked</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Create, update, delete, restore, reorder, permission changes,
            trash, move, agent config, membership, auth events, file ops,
            account changes, messages, rollbacks. Each with content snapshots,
            <code> previousValues</code>/<code>newValues</code>, and its own
            hash chain.
          </p>
        </Card>
        <Card accent="green">
          <h4>AI attribution + rollback</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Every change tracks: <code>isAiGenerated</code>,
            <code> aiProvider</code>, <code>aiModel</code>,
            <code> aiConversationId</code>. Rollback support via
            <code> rollbackFromActivityId</code> with denormalized source
            data (survives deletion). Deterministic event stream with
            <code> streamId</code>/<code>streamSeq</code>.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>Versioning, GDPR, &amp; data protection</h3>
      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--green)"
          name="Page versions"
          description="30-day auto-retention. Pinnable versions exempt from expiry. Source tracking (manual, auto, pre_ai, pre_restore). Content snapshots with compression metadata."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Drive backups"
          description="Full snapshots: pages, permissions, members, roles, files. Status tracking (pending/ready/failed). Restore from any backup point."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="GDPR export"
          description="Complete right-to-access: user profile, drives, pages, messages (AI chat, channels, DMs), files, activity logs, AI usage. PII scrubbing. Data retention policies."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Encryption at rest (partial)"
          description="Integration credentials: AES-256-GCM with scrypt, unique salt. Session tokens: SHA-256 hashed. Audit trail: tamper-evident hash chain. <strong style='color:var(--amber)'>Page content is NOT application-level encrypted</strong> &mdash; it would break Postgres search. DB-level encryption at rest is the practical path."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Security</h3>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--green)"
          name="Auth model"
          description="Opaque tokens (SHA-256 hashed, never stored plaintext). Passkeys (WebAuthn). Magic links. OAuth (Google/Apple). Device flow. Account lockout after N failures."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="CSRF &amp; rate limiting"
          description="CSRF: HMAC-SHA256 with timing-safe comparison, 1-hour max age. Rate limiting: 5 login attempts / 15 min, progressive delay (exponential backoff capped at 30 min)."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Per-event re-auth"
          description="Socket.IO sensitive events (document_update, page_delete, file_upload) bypass Redis cache and re-verify permissions directly from DB. Fails closed on errors."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Processor sandboxing</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Read-only filesystem with tmpfs for /tmp (noexec, nosuid). Path
            traversal protection (blocks ../, URL-encoded variants, null bytes).
            MIME type filtering (blocks HTML/SVG/XML XSS vectors). Filename
            sanitization. Runs as non-root user (UID 1000).
          </p>
        </Card>
        <Card accent="green">
          <h4>Anomaly detection</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Login pattern analysis: impossible travel (IP geolocation
            heuristic), high-frequency access detection, new user agent
            flagging, known bad IP blocking. Configurable risk weights.
            Results feed into security audit events.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Infrastructure exists.{" "}
        <span className="hl">Operationalization doesn&apos;t.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The security infrastructure is solid but has coverage gaps.
        The SIEM adapter is built but not connected. The audit service
        covers 2% of routes. The activity log hash chain has a known
        fork vulnerability. Agent-level security is missing entirely.
      </p>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="red">
          <h4>SecurityAuditService: 5 of 252 routes (~2%)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Hash chain audit service exists with FOR UPDATE locking and
            27 event types. But only wired to login, logout, and mobile
            login. Core operations (pages, drives, files, settings) are
            not security-audited.
          </p>
        </Card>
        <Card accent="red">
          <h4>SIEM adapter built but not connected</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Full SIEM adapter: webhook + syslog (TCP/UDP), HMAC-SHA256
            signatures, RFC 5424 format, batched delivery, retry with
            backoff. Zero production calls. Audit events go to database
            only, not to external SIEM.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="red">
          <h4>Activity log hash chain can fork (#542)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Activity log writes not serialized with row locking. Concurrent
            writes can create chain forks. Security audit chain uses FOR
            UPDATE and is safe. Activity logs do not.
          </p>
        </Card>
        <Card accent="red">
          <h4>No agent-specific audit trails</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Security audit is user-centric. When an agent makes a change,
            it&apos;s attributed to the user who triggered it, not the agent.
            Can&apos;t answer: &ldquo;what did agent X do across all its
            conversations?&rdquo;
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="red">
          <h4>No capability gates</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Agents can call any enabled tool without limits. No per-agent
            boundaries, no budget enforcement, no &ldquo;this agent can
            only read, not write.&rdquo;
          </p>
        </Card>
        <Card accent="red">
          <h4>No container security</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            No Firecracker isolation, no container auth (scoped tokens),
            no secrets management (uses .env files on disk). Chain
            verification failures only go to <code>console.error</code>
            (#544) &mdash; no real alerting.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        Every action accountable.{" "}
        <span className="hl">Humans and agents.</span>
      </h2>

      <h3 style={{ marginBottom: 12 }}>Operationalize what exists</h3>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--cyan)"
          name="100% audit coverage"
          description="Wire SecurityAuditService to all security-relevant routes. Every page CRUD, permission change, file upload, admin action produces an immutable audit event."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Connect SIEM"
          description="Wire the existing SIEM adapter to the logging pipeline. Audit events stream to external SIEM in real time. The code is built — it just needs connecting."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Fix chain integrity"
          description="Add FOR UPDATE locking to activity log hash chain (matching security audit pattern). Fix GDPR anonymization chain break (#541). Durable alerting for failures."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Agent-level security</h3>
      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--cyan)"
          name="Agent audit trails"
          description="Every agent action tracked with agent ID, not just user ID. Query: what did this agent do, across all conversations, with what tools, at what cost."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Capability gates"
          description="Agents declare required tools. Runtime enforces boundaries. Per-agent budgets (token/hour, cost ceilings). Automatic pause when limits hit."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Container auth"
          description="Scoped service tokens for agent-to-PageSpace API calls from inside Firecracker VMs. Drive-level permissions. Revocable. Audited."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Firecracker isolation"
          description="Hardware-level VM isolation (KVM). Not namespace isolation (Docker). Each branch gets its own micro-VM. No kernel sharing."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2">
        <Card accent="blue">
          <h4>Secrets management</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            AWS Secrets Manager replaces .env files on disk. Per-tenant
            secrets rotation. Agent credentials scoped to their container.
            Integration tokens encrypted in transit and at rest.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Per-org compliance controls</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Org-level retention policies, data residency requirements,
            audit access controls. Real-time chain monitoring (not just
            daily cron). Redis-backed rate limiting for cloud scale.
          </p>
        </Card>
      </div>
    </div>
  );
}
