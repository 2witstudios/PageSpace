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
        per-event re-authorization, distributed rate limiting, and GDPR export
        are production features today. Every claim below is verified against
        the codebase.
      </p>

      <h3 style={{ marginBottom: 12 }}>Audit trail</h3>
      <div className="g2" style={{ marginBottom: 16 }}>
        <Card accent="green">
          <h4>Security audit log (hash chain)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Every security event is recorded in a tamper-evident SHA-256 hash
            chain. Each entry stores <code>previousHash</code> and its own
            <code> eventHash</code>. <code>pg_advisory_xact_lock</code>{" "}
            serialization prevents chain forking on concurrent writes
            (works even on empty tables). 35 event types across auth,
            authorization, data access, admin, and security categories.
            Risk scoring and anomaly flags per event.
          </p>
        </Card>
        <Card accent="green">
          <h4>Chain verification + webhook alerting</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Daily cron job (<code>/api/cron/verify-audit-chain</code>)
            recomputes every entry&apos;s hash and verifies chain links.
            Detects break points with position, stored vs computed hash.
            HMAC-signed cron request prevents unauthorized triggering.
            On failure: pluggable <code>ChainAlertHandler</code> callback
            via <code>verifyAndAlert()</code> — wire to Slack, email,
            PagerDuty at startup. Structured logging via <code>loggers.security</code>.
          </p>
        </Card>
      </div>

      <Card accent="green" style={{ marginBottom: 16 }}>
        <h4>Activity log hash chain integrity</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Activity log writes serialized with{" "}
          <code>pg_advisory_xact_lock</code> (#867), matching the security
          audit chain pattern. PII fields excluded from hash computation
          (#866) so GDPR anonymization preserves chain integrity. Both
          chains are now tamper-evident and GDPR-safe.
        </p>
      </Card>

      <h3 style={{ marginBottom: 12 }}>Activity logs</h3>
      <div className="g2" style={{ marginBottom: 16 }}>
        <Card accent="green">
          <h4>28 operations tracked</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Create, update, delete, restore, reorder, permission changes
            (grant/update/revoke), trash, move, agent config, membership,
            auth events (login/logout/signup), password/email change,
            token lifecycle, file ops, account changes, messages,
            role reorder, ownership transfer, rollback, AI conversation undo.
            Each with content snapshots,{" "}
            <code>previousValues</code>/<code>newValues</code>.
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
          description="30-day auto-retention. Pinnable versions exempt from expiry. Source tracking (manual, auto, pre_ai, pre_restore, restore, system). Content snapshots with compression metadata."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Drive backups"
          description="Full snapshots: pages, permissions, members, roles, files. Status tracking (pending/ready/failed). Pinnable backups with configurable retention. Restore from any backup point."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="GDPR export"
          description="Complete right-to-access: user profile, drives, pages, messages (AI chat, channels, conversations, DMs), files, task lists, activity logs, AI usage logs. PII anonymization via deterministic SHA-256 hashing."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Encryption at rest (partial)"
          description="Integration credentials: AES-256-GCM with scrypt key derivation, unique 32-byte salt per operation. Session tokens: SHA-256 hashed (never stored plaintext). Audit trail: tamper-evident hash chain. <strong style='color:var(--amber)'>Page content is NOT application-level encrypted</strong> &mdash; it would break Postgres search. DB-level encryption at rest is the practical path."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Security</h3>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--green)"
          name="Auth model"
          description="Opaque tokens (SHA-256 hashed, never stored plaintext). Passkeys (WebAuthn). Magic links. OAuth (Google/Apple) with HMAC-signed state + timing-safe validation. Device flow. Account lockout after 10 consecutive failures (15-min lock, database-backed, persists across restarts)."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="CSRF &amp; rate limiting"
          description="CSRF: HMAC-SHA256 with double-hash timing-safe comparison, 1-hour max age. Distributed rate limiting (Redis-backed): 5 login / 15 min with progressive exponential backoff capped at 30 min. Also covers signup, password reset, magic links, marketing, integration auth. Fails closed in production."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Per-event re-auth"
          description="Socket.IO sensitive events (document_update, page_delete, file_upload, comment/task CRUD) bypass Redis cache and re-verify permissions directly from DB. Read-only events (cursor, presence, typing) skip re-auth. Fails closed on errors."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>GDPR data rights</h3>
      <div className="g2" style={{ marginBottom: 16 }}>
        <Card accent="green">
          <h4>Right to Access &amp; Portability (Art. 15/20)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            User DSAR export (<code>GET /api/account/export</code>): ZIP
            archive with JSON files for profile, drives, pages, messages,
            files metadata, activity logs, AI usage logs, tasks. Distributed
            Redis-backed rate limit (1 per 24 hours, survives deploys).
            Admin DSAR endpoint
            (<code>GET /api/admin/users/[userId]/export</code>) with
            security audit logging of which admin accessed which user&apos;s data.
          </p>
        </Card>
        <Card accent="green">
          <h4>Right to Erasure (Art. 17)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Email-confirmed account deletion. Checks for multi-member owned
            drives (must transfer ownership first). Auto-deletes solo-owned
            drives. Deletes AI usage logs. Activity logs anonymized &mdash; not
            deleted: actor email replaced with deterministic SHA-256 hash
            (<code>deleted_user_&lt;12-char-hex&gt;</code>), display name
            set to &ldquo;Deleted User.&rdquo; Preserves audit trail while
            removing PII.
          </p>
        </Card>
      </div>

      <div className="g2" style={{ marginBottom: 16 }}>
        <Card accent="green">
          <h4>Data retention &amp; AI log lifecycle</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            TTL-based retention engine for sessions, tokens, page versions,
            drive backups, page permissions. AI logs: anonymize
            prompt/completion content at 30 days (metadata preserved), purge
            entire rows at 90 days. Individual cleanup jobs run on cron
            (token cleanup hourly, AI purge daily 3am, message purge daily 4am).
          </p>
        </Card>
        <Card accent="amber">
          <h4>PII scrubber</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            PII scrubbing utility exists (email, phone, SSN, credit card with
            Luhn validation) but is{" "}
            <strong style={{ color: "var(--amber)" }}>
              not yet integrated into the AI logging pipeline
            </strong>
            .
          </p>
        </Card>
        <Card accent="green">
          <h4>Orphaned file cleanup</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Cron job detects orphaned files (zero references across filePages,
            channelMessages, and pages), attempts physical deletion via the
            processor service, then removes DB records only for files whose
            physical deletion succeeded. Runs weekly on Sundays at 5am UTC.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>Privacy &amp; data sovereignty</h3>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--green)"
          name="Privacy policy"
          description="Comprehensive policy at /privacy covering data collection, AI provider data flows (Anthropic, OpenAI, Google, OpenRouter listed explicitly), security measures, user rights, data retention, and international transfers. TOS acceptance tracked via tosAcceptedAt. <strong style='color:var(--amber)'>xAI/Grok not yet listed</strong> despite full codebase support."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="On-prem data sovereignty"
          description="Self-hosted deployment with local AI (Ollama/LM Studio) means no data leaves the customer's infrastructure. Full control over data residency, retention, and processing."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="AI consent via TOS"
          description="PageSpace is an AI product &mdash; AI processing is the core function. Privacy policy lists all AI providers. Users consent via TOS acceptance on signup. On-prem with local AI avoids external data flows entirely."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Processor security</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Runs as non-root user (UID 1000). Path traversal protection
            (blocks <code>../</code>, URL-encoded variants, double-encoded,
            null bytes, absolute paths). MIME type filtering (blocks
            HTML/SVG/XML XSS vectors). Filename sanitization. Multer file
            filter validates types at upload boundary.
          </p>
        </Card>
        <Card accent="amber">
          <h4>Anomaly detection (heuristic)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Login pattern analysis: impossible travel (IP prefix change
            heuristic &mdash; IPv4 /16, IPv6 /48 within 1 hour),
            high-frequency access (&gt;100 actions/min), new user agent
            flagging, known bad IP blocking. Configurable risk weights.
            Results feed into security audit events.{" "}
            <strong style={{ color: "var(--amber)" }}>
              No real GeoIP integration yet
            </strong>{" "}
            &mdash; uses IP prefix comparison, not geographic distance.
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
        The SIEM adapter is built but not wired. Audit service coverage
        expanded to pages, drives, permissions, settings, account, files,
        and export routes (#868-870) but not yet 100%. Agent-level security
        is missing entirely.
      </p>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="amber">
          <h4>SecurityAuditService: expanded but not 100%</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Hash chain audit service with advisory lock serialization and
            35 event types. Now wired to auth, pages, drives, permissions,
            settings, account, files, and export routes (#868-870).
            Remaining: admin actions, trash, invitations, and other
            secondary routes.
          </p>
        </Card>
        <Card accent="red">
          <h4>SIEM adapter: built, not connected</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Full SIEM adapter in <code>apps/processor</code>: webhook +
            syslog (TCP/UDP), HMAC-SHA256 signatures, RFC 5424 format,
            batched delivery, retry with backoff, AI attribution in output.
            Zero production callers. <code>deliverToSiem()</code> is never
            invoked from the audit pipeline.
          </p>
        </Card>
      </div>
      <Card accent="red" style={{ marginBottom: 8 }}>
        <h4>No agent-specific audit trails</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Security audit is user-centric. When an agent makes a change,
          it&apos;s attributed to the user who triggered it, not the agent.
          Activity logs track <code>isAiGenerated</code> and AI model,
          but can&apos;t answer: &ldquo;what did agent X do across all
          conversations?&rdquo;
        </p>
      </Card>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="amber">
          <h4>Capability gates: tools + pages, no budgets</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Agents have per-agent <code>enabledTools</code> whitelists
            and page-level access controls (read-only vs read-write).
            Missing: token/cost budgets, automatic pause on spend limits,
            runtime enforcement of tool boundaries across delegation chains.
          </p>
        </Card>
        <Card accent="amber">
          <h4>Processor sandboxing is partial</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Non-root user (UID 1000), path traversal protection, MIME
            filtering. But no read-only filesystem mount, no tmpfs
            for <code>/tmp</code>, no <code>noexec</code>/<code>nosuid</code>.
            Security is application-level, not OS-level isolation.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>GDPR gaps</h3>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="red">
          <h4>No cookie consent</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Session cookies used, external scripts loaded (Google One Tap,
            Stripe.js). No consent banner or consent management system.
            Required for EU users under ePrivacy Directive.
          </p>
        </Card>
        <Card accent="red">
          <h4>No data residency</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            US-based cloud infrastructure. No region selection for data
            storage. AI requests not region-pinnable. Blocks EU customers
            with strict residency requirements. On-prem solves this for
            self-hosted deployments.
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
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The roadmap runs: operationalize what exists &rarr; per-org
        isolation (AWS migration) &rarr; agent-level security &rarr;
        container auth. Security follows the infrastructure dependency
        chain in the roadmap &mdash; you can&apos;t do container auth
        without containers, can&apos;t do per-agent budgets without
        a runtime.
      </p>

      <h3 style={{ marginBottom: 12 }}>Operationalize what exists</h3>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--cyan)"
          name="100% audit coverage"
          description="SecurityAuditService now covers auth, pages, drives, permissions, settings, account, files, and export (#868-870). Remaining: admin actions, trash, invitations, and secondary routes."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Connect SIEM"
          description="Wire the existing SIEM adapter to the audit pipeline. Audit events stream to external SIEM in real time. The adapter code is fully built (webhook + syslog + RFC 5424) &mdash; it just needs callers."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="GeoIP anomaly detection"
          description="Replace IP prefix heuristic in anomaly detection with real GeoIP integration. Geographic distance-based impossible travel detection instead of /16 and /48 prefix comparison."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Per-org isolation (requires AWS migration)</h3>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--cyan)"
          name="Per-org compliance controls"
          description="Org-level data retention policies, data residency requirements, audit access controls. Schema split (~40 global + ~45 per-org tables) enables per-org security boundaries."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Secrets management"
          description="AWS Secrets Manager replaces .env files on disk. Per-tenant secrets rotation. Integration tokens encrypted in transit and at rest. No secrets on the filesystem."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Harden processor"
          description="Read-only filesystem with tmpfs for /tmp (noexec, nosuid). OS-level sandboxing on top of existing application-level protections. Dedicated per-org processor instances."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Agent-level security (requires runtime)</h3>
      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--cyan)"
          name="Agent audit trails"
          description="Every agent action tracked with agent ID, not just user ID. Query: what did this agent do, across all conversations, with what tools, at what cost."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Budget enforcement"
          description="Per-agent token/hour and cost ceilings on top of existing tool whitelists and page access. Automatic pause when limits hit. Delegation chains inherit caller's budget cap."
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
          description="Hardware-level VM isolation (KVM). Not namespace isolation (Docker). Each branch gets its own micro-VM. No kernel sharing. Depends on AWS infrastructure."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Full GDPR compliance</h3>
      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--cyan)"
          name="Cookie consent system"
          description="GDPR-compliant consent banner with granular controls. Consent tracked per purpose (analytics, AI processing, third-party scripts). Withdrawal support."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Data residency"
          description="EU deployment option with regional AI routing. Data stays in-region. Regional Postgres, regional object storage. On-prem already solves this for self-hosted."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Wire PII scrubber"
          description="Integrate existing scrubPII() into AI logging pipeline as defense-in-depth. The utility exists and catches email, phone, SSN, credit card &mdash; just needs wiring into the logging path."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Formal retention schedules"
          description="Documented retention period per data class with legal basis. Configurable per org. Make AI log purge thresholds (30/90 days) configurable via env vars. Automated enforcement via existing retention engine."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>
    </div>
  );
}
