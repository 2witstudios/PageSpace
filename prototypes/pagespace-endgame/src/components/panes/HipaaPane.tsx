import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";

export function HipaaPane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        On-prem HIPAA path exists.{" "}
        <span className="hl">Cloud is closer than it looks.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        PageSpace has a documented on-premises deployment path that satisfies
        HIPAA technical safeguards. Local AI via Ollama means no PHI leaves the
        customer&apos;s infrastructure. Cloud HIPAA is more achievable than it
        appears &mdash; most of the vendor BAA chain is already available.
      </p>

      <h3 style={{ marginBottom: 12 }}>HIPAA deployment model</h3>
      <ArchDiagram>
        <ArchRow label="On-Prem" labelSub="HIPAA-eligible">
          <ArchNode
            title="Customer infrastructure"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="All PageSpace services on customer hardware<br>Encrypted PostgreSQL (LUKS/FileVault)<br>Network isolation &middot; no external egress<br>Full data sovereignty"
          />
          <ArchNode
            title="Local AI (Ollama)"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="AI inference on local hardware<br>No PHI sent to external providers<br>Models run in-process<br>Zero external data flows"
          />
        </ArchRow>
        <ArchConnector text="vs." />
        <ArchRow label="Cloud" labelSub="close &mdash; 2 gaps remain">
          <ArchNode
            title="PageSpace Cloud"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            detail="AI: BAAs available (Azure OpenAI, Anthropic, AWS Bedrock)<br>Payments: Stripe doesn't touch PHI &mdash; no BAA needed<br>Email: Resend has no BAA &mdash; swap to AWS SES or SendGrid<br>Missing: PageSpace BAA offering to customers"
          />
        </ArchRow>
      </ArchDiagram>

      <h3 style={{ marginBottom: 12 }}>
        Technical Safeguards (164.312)
      </h3>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--green)"
          name="Access control (a)(1)"
          description="RBAC with drive membership (Owner/Admin/Member). Page-level permissions (canView/canEdit/canShare/canDelete). Per-user agent isolation at tool execution layer. Fail-closed."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Audit controls (b)"
          description="Tamper-evident SHA-256 hash chain for security events. 26+ operation types in activity logs. Daily chain verification via cron. AI attribution on all changes."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Integrity (c)(1)"
          description="AES-256-GCM encryption for integration credentials. Content versioning with rollback. Hash chain integrity verification. Processor sandboxing."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--green)"
          name="Transmission (e)(1)"
          description="TLS required for all connections. Documented in on-prem guide with nginx TLS configuration example. Session tokens never sent in plaintext."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Auto logoff (a)(2)(iii)"
          description="Configurable idle timeout (15-minute default). Session expiry enforcement. Token version tracking for instant revocation of all sessions."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Authentication (d)"
          description="Passkeys (WebAuthn) with counter-based replay detection. Max 10 per user. 5-minute challenge expiry. Device type tracking. Account lockout after 10 failed attempts."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>
        Administrative Safeguards (164.308)
      </h3>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>AI log retention</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            <code>AI_LOG_RETENTION_DAYS</code> environment variable (90-day
            default). HIPAA-aware auto-expiry via <code>expiresAt</code> column.
            Two-phase cleanup: anonymize prompt/completion at 30 days, purge
            rows at 90 days. Configurable per deployment.
          </p>
        </Card>
        <Card accent="green">
          <h4>PII scrubbing</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Defense-in-depth redaction on AI logs: email, phone, SSN, credit
            card (Luhn-validated). Applied before storage. Minimizes PHI
            exposure in logs even if prompt content contains sensitive data.
          </p>
        </Card>
      </div>

      <Card accent="green" style={{ marginBottom: 12 }}>
        <h4>On-prem deployment guide</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          HIPAA compliance checklist (6 technical + 7 administrative/physical
          safeguards), PostgreSQL encryption at rest (LUKS/FileVault),
          TLS configuration, network isolation, backup and recovery procedures
          with audit chain verification. Covers Azure OpenAI as BAA-covered
          cloud AI option.
        </p>
      </Card>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Vendor BAA chain is mostly solved.{" "}
        <span className="hl">Two gaps remain.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The on-prem path covers HIPAA technical safeguards today. For cloud,
        the vendor landscape is better than expected: AI providers offer BAAs,
        Stripe doesn&apos;t need one (it never touches PHI), and BAA-ready
        email providers are commodity. The real gaps are PageSpace offering
        its own BAA and a few technical items.
      </p>

      <h3 style={{ marginBottom: 12 }}>BAA chain status</h3>
      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--green)"
          name="AI providers: solved"
          description="Azure OpenAI (GPT-4o, GPT-4), Anthropic (Claude), AWS Bedrock, Google Vertex AI all offer BAAs. Multiple providers, multiple models, all BAA-covered."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Payments: not an issue"
          description="Stripe processes payment data, not PHI. No BAA needed or available. Every HIPAA-compliant SaaS (SimplePractice, Doxy.me, Jane App, Healthie) uses Stripe. Just don't put health info in invoice metadata."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Email: swap Resend"
          description="Resend doesn't offer a BAA. AWS SES, SendGrid, and Postmark all do. Standard swap — same transactional email, BAA-covered provider. Small migration."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="PageSpace BAA"
          description="PageSpace itself doesn't offer a BAA to customers. Healthcare orgs need this before storing PHI. This is a business/legal step, not a technical one."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Technical gaps</h3>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="red">
          <h4>No application-level encryption</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Page content stored as plaintext in Postgres (by design &mdash;
            enables search). DB-level encryption (TDE) is the practical path.
            Integration credentials ARE AES-256-GCM encrypted. Cloud hosting
            (AWS RDS) provides TDE by default.
          </p>
        </Card>
        <Card accent="red">
          <h4>No TOTP/SMS 2FA</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Passkeys are the only strong auth factor. No TOTP authenticator
            app or SMS backup. Some HIPAA implementations require a backup
            2FA method beyond biometrics.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        Two HIPAA paths.{" "}
        <span className="hl">On-prem today, cloud is close.</span>
      </h2>

      <ArchDiagram>
        <ArchRow label="Path 1" labelSub="available now">
          <ArchNode
            title="On-prem HIPAA tier"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Self-hosted on customer infrastructure<br>Local AI (Ollama) or Azure OpenAI (BAA)<br>Encrypted volumes &middot; network isolation<br>Zero external PHI data flows"
          />
        </ArchRow>
        <ArchConnector text="short path to cloud" />
        <ArchRow label="Path 2" labelSub="swap email + offer BAA">
          <ArchNode
            title="Cloud HIPAA tier"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            detail="AI: Azure OpenAI / Anthropic / AWS Bedrock (BAA)<br>Payments: Stripe (no PHI, no BAA needed)<br>Email: AWS SES or SendGrid (BAA)<br>PageSpace offers BAA to customers"
          />
        </ArchRow>
      </ArchDiagram>

      <h3 style={{ marginBottom: 12 }}>What&apos;s needed for cloud HIPAA</h3>
      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--cyan)"
          name="PageSpace BAA"
          description="Draft and offer a Business Associate Agreement. This is a legal/business step. Template from healthcare SaaS peers. Required before any healthcare customer can store PHI."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Swap Resend for SES"
          description="Replace Resend with AWS SES or SendGrid (both BAA-covered). Small migration — same transactional email API pattern. Only change needed in the vendor chain."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="TDE + TOTP"
          description="Database encryption at rest (TDE on RDS, automatic on AWS). TOTP authenticator as passkey backup. Standard technical work."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="PHI data flow docs"
          description="Document exactly where PHI travels. Ensure no PHI in Stripe metadata. Ensure no PHI in log content (PII scrubber already handles AI logs). Compliance officer-ready diagrams."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <Card style={{ borderColor: "var(--border2)", marginTop: 12 }}>
        <h4 style={{ color: "var(--dim)" }}>Why this is closer than it looks</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          The standard HIPAA SaaS pattern is well-established: AWS/Azure
          infrastructure (BAA), AI via Azure OpenAI or Bedrock (BAA), Stripe
          for payments (no BAA needed &mdash; no PHI), BAA-covered email
          (SES/SendGrid). SimplePractice, Doxy.me, Jane App, and Healthie
          all follow this exact pattern. PageSpace&apos;s remaining work is
          a Resend swap, a BAA document, and standard technical hardening.
          The vendor ecosystem has solved the hard parts.
        </p>
      </Card>
    </div>
  );
}
