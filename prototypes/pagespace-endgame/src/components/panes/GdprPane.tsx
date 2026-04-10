import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function GdprPane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        Strong GDPR foundation.{" "}
        <span className="hl">Data rights are real, not aspirational.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        PageSpace has production implementations for the core GDPR data subject
        rights: access, portability, erasure, and retention. These aren&apos;t
        stubs &mdash; they&apos;re tested, rate-limited, and documented.
      </p>

      <h3 style={{ marginBottom: 12 }}>
        Right to Access &amp; Portability (Art. 15/20)
      </h3>
      <div className="g2" style={{ marginBottom: 16 }}>
        <Card accent="green">
          <h4>User DSAR export</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            <code>GET /api/account/export</code> &mdash; returns a ZIP archive
            with JSON files covering all user data: profile, drives, pages,
            messages (AI chat, channels, DMs), files metadata, activity logs,
            AI usage logs, and tasks. Rate-limited to 1 export per 24 hours.
            Machine-readable JSON format for portability.
          </p>
        </Card>
        <Card accent="green">
          <h4>Admin DSAR endpoint</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            <code>GET /api/admin/users/[userId]/export</code> &mdash; admin-only
            endpoint for processing data subject access requests. Returns same
            data as user export. Logs which admin accessed which user&apos;s
            data for audit trail.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>
        Right to Erasure (Art. 17)
      </h3>
      <div className="g2" style={{ marginBottom: 16 }}>
        <Card accent="green">
          <h4>Account deletion</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Email-confirmed deletion. Checks for multi-member owned drives
            (must transfer ownership first). Auto-deletes solo-owned drives.
            Deletes AI usage logs. Logged to activity trail before anonymization
            (audit record of who requested deletion).
          </p>
        </Card>
        <Card accent="green">
          <h4>Activity log anonymization</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            On account deletion, activity logs are anonymized &mdash; not
            deleted. Actor email replaced with deterministic SHA-256 hash
            (<code>deleted_user_&lt;12-char-hex&gt;</code>). Display name set
            to &ldquo;Deleted User.&rdquo; Preserves audit trail while removing
            PII. Same user always maps to same anonymized ID.
          </p>
        </Card>
      </div>

      <Card accent="green" style={{ marginBottom: 16 }}>
        <h4>Message deletion: two-stage hard-delete</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Messages use a two-stage deletion path: soft-delete via{" "}
          <code>isActive</code> flag, then a 30-day purge cron hard-deletes
          the rows. On account deletion, FK cascade removes user-owned
          messages immediately. Note: shared-page assistant messages stored
          with <code>userId: null</code> may survive account deletion.
        </p>
      </Card>

      <h3 style={{ marginBottom: 12 }}>Data Retention &amp; Minimization</h3>
      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--green)"
          name="Retention engine"
          description="TTL-based cleanup for sessions, tokens, AI logs, page versions, drive backups, page permissions. Runs on cron schedule. Configurable via env vars."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="AI log lifecycle"
          description="Phase 1: anonymize prompt/completion content at 30 days (metadata preserved). Phase 2: purge entire rows at 90 days. Configurable via AI_LOG_RETENTION_DAYS."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="PII scrubber"
          description="Defense-in-depth redaction on AI logs before storage. Catches email, phone, SSN, credit card (Luhn-validated). Applied to prompt/completion content."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="File orphan cleanup"
          description="Cron job detects orphaned files (zero references), attempts physical deletion via processor service, then removes DB records only for successfully deleted files. Content-addressed store cleanup."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Privacy policy</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Comprehensive privacy policy at <code>/privacy</code> covering data
            collection, AI provider data flows (Anthropic, OpenAI, Google, xAI,
            OpenRouter listed explicitly), security measures, user rights, data
            retention, and international transfers. Terms of service tracked via
            <code> tosAcceptedAt</code> field.
          </p>
        </Card>
        <Card accent="green">
          <h4>On-prem data sovereignty</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Self-hosted deployment with local AI (Ollama/LM Studio) means
            no data leaves the customer&apos;s infrastructure. Full control
            over data residency, retention, and processing. Documented in
            on-prem deployment guide.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Core rights work.{" "}
        <span className="hl">Cookie consent and residency don&apos;t.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Data subject rights (access, erasure, portability) are solid. AI
        provider consent is handled via TOS &mdash; PageSpace is an AI product.
        The remaining gaps are cookie consent and data residency.
      </p>

      <FeatureRow columns={2}>
        <Feature
          nameColor="var(--red)"
          name="No cookie consent"
          description="Session cookies used, external scripts loaded (Google One Tap, Stripe.js). No consent banner or consent management system. Required for EU users."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No data residency"
          description="US-based cloud infrastructure. No region selection for data storage. AI requests not region-pinnable. Blocks EU customers with strict residency requirements."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <Card accent="green" style={{ marginBottom: 12 }}>
        <h4>Activity log hash chain &mdash; Fixed</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Both security audit and activity log hash chains are now GDPR-safe.
          PII fields excluded from hash computation (#541, #866) so
          anonymization preserves chain integrity. Activity log writes
          serialized with <code>pg_advisory_xact_lock</code> (#867),
          preventing chain forking on concurrent writes.
        </p>
      </Card>

      <Card accent="green" style={{ marginBottom: 12 }}>
        <h4>Export rate limit &mdash; Fixed</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          DSAR export rate limit migrated to distributed Redis (#865).
          Shared across instances, survives deploys/restarts. Matches
          existing auth rate limiter pattern.
        </p>
      </Card>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        Full GDPR compliance.{" "}
        <span className="hl">Consent, residency, and scale.</span>
      </h2>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--cyan)"
          name="Cookie consent system"
          description="GDPR-compliant consent banner with granular controls. Track consent per purpose (analytics, AI processing, third-party scripts). Withdrawal support."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Formal retention schedules"
          description="Documented retention period per data class (content, messages, activity logs, AI logs, security audit, files) with legal basis. Configurable per org. Automated enforcement via existing retention engine."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Data residency options"
          description="EU deployment option with regional AI routing. Data stays in-region. Regional Postgres, regional object storage. On-prem already solves this for self-hosted."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2">
        <Card accent="green">
          <h4>Hard-delete for messages &mdash; Done</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Implemented: 30-day purge cron hard-deletes soft-deleted messages.
            FK cascade on account deletion removes user-owned messages
            immediately. Remaining gap: shared-page assistant messages with{" "}
            <code>userId: null</code> may persist.
          </p>
        </Card>
        <Card accent="green">
          <h4>Hash-chain-safe anonymization &mdash; Done</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Implemented: PII fields excluded from hash computation in both
            security audit (#541) and activity log (#866) chains. Activity
            log writes serialized with advisory locks (#867). Anonymization
            preserves chain integrity.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)", marginTop: 12 }}>
        <h4 style={{ color: "var(--dim)" }}>
          AI consent is already handled
        </h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          PageSpace is an AI product &mdash; AI processing is the core function,
          not an add-on. The privacy policy explicitly lists all AI providers,
          and users consent via TOS acceptance on signup. No separate AI consent
          flow needed. On-prem with local AI (Ollama) avoids external data
          flows entirely.
        </p>
      </Card>
    </div>
  );
}
