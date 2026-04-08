import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";

export function GovernancePane() {
  return (
    <div className="pane">
      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 1: Current governance                          */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Governance</div>
      <h2>
        Permissions, rate limits, and{" "}
        <span className="hl">agent boundaries.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        PageSpace has production-grade RBAC with drive membership, page-level
        permissions, cached resolution, tamper-evident audit logging,
        distributed rate limiting, per-agent tool gates, and encrypted
        integration credential governance. What&apos;s missing is the layer
        above &mdash; org hierarchy, per-agent budget <em>enforcement</em>,
        and scope inheritance through agent delegation chains.
      </p>

      <h3 style={{ marginBottom: 12 }}>Permission resolution flow</h3>
      <ArchDiagram>
        <ArchRow label="Access check">
          <ArchNode
            title="Drive owner?"
            detail="Full access to all pages in drive"
            titleColor="var(--green)"
            borderColor="var(--green)"
          />
          <ArchNode
            title="Drive admin?"
            detail="Full access except ownership transfer"
            titleColor="var(--green)"
            borderColor="var(--green)"
          />
          <ArchNode
            title="Direct page perms?"
            detail="canView / canEdit / canShare / canDelete + expiration"
            titleColor="var(--blue)"
            borderColor="var(--blue)"
          />
          <ArchNode
            title="No access"
            detail="Default: denied (fail-closed)"
            titleColor="var(--red)"
            borderColor="var(--red)"
          />
        </ArchRow>
        <ArchConnector text="checked left to right, first match wins" />
        <ArchRow label="Caching">
          <ArchNode
            title="L1 memory cache"
            detail="In-process Map &middot; 1000 max entries"
            borderColor="var(--cyan)"
          />
          <ArchNode
            title="L2 Redis cache"
            detail="60-second TTL &middot; shared across instances"
            borderColor="var(--cyan)"
          />
          <ArchNode
            title="L3 database"
            detail="Source of truth &middot; Postgres query"
          />
        </ArchRow>
      </ArchDiagram>

      <FeatureRow columns={3}>
        <Feature
          icon="&#x1F464;"
          name="Drive membership"
          nameColor="var(--green)"
          description="Three roles: <strong style='color:var(--text)'>Owner</strong> (full control), <strong style='color:var(--text)'>Admin</strong> (manage members + content), <strong style='color:var(--text)'>Member</strong> (read/write within page-level grants). Custom role templates via <code>drive_roles</code> table."
        />
        <Feature
          icon="&#x1F4C4;"
          name="Page permissions"
          nameColor="var(--blue)"
          description="Granular: canView, canEdit, canShare, canDelete. Each can have an <code>expiresAt</code> date &mdash; expired permissions are denied at query time. Granted-by tracking for audit."
        />
        <Feature
          icon="&#x1F916;"
          name="Agent tool gates"
          nameColor="var(--violet)"
          description="Each AI_CHAT page has an <code>enabledTools</code> array. Tools are validated against the available set. Read-only mode filters write tools globally. <code>MAX_AGENT_DEPTH=2</code> prevents recursion."
        />
      </FeatureRow>
      <FeatureRow columns={3}>
        <Feature
          icon="&#x1F6E1;"
          name="Security audit log"
          nameColor="var(--amber)"
          description="SHA-256 hash chain with <code>FOR UPDATE</code> locking to prevent forking. 47 event types. Chain verifier with break-point detection. Separate integration audit log for every external API call."
        />
        <Feature
          icon="&#x26A1;"
          name="Distributed rate limiting"
          nameColor="var(--cyan)"
          description="Redis-based sliding window with 16 predefined configs (login, signup, API, file upload, passkeys, etc.). Fail-closed in production &mdash; denies requests when Redis is unavailable."
        />
        <Feature
          icon="&#x1F50C;"
          name="Integration credentials"
          nameColor="var(--red)"
          description="User-scoped or drive-scoped (enforced by CHECK constraint). AES-256-GCM encrypted. Per-agent grants with <code>allowedTools</code>, <code>deniedTools</code>, <code>readOnly</code>, and <code>rateLimitOverride</code>."
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Per-user agent isolation</h3>
      <Card accent="green" style={{ marginBottom: 8 }}>
        <h4>Agents run with the requesting user&apos;s permissions</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          When two users share an agent in the same drive, each invocation
          runs with <strong>that user&apos;s permissions</strong> &mdash; in
          PageSpace and in connected integrations (Slack, GitHub, etc.).
          Same agent, different access. Enforced at the tool execution layer,
          not just the UI. <strong>Fail-closed:</strong> no explicit permission
          grant = no access.
        </p>
      </Card>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Private drives = per-user workspace</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            A private drive is single-owner. An agent in your private drive
            is unreachable by anyone else entirely. Your agent, your data,
            your Slack/GitHub tokens. Complete isolation.
          </p>
        </Card>
        <Card accent="green">
          <h4>Shared drives = shared skills, not shared data</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Both users can invoke the same agent in a shared drive. But when
            User B invokes it, the agent can only read what User B has access
            to. The agent is shared, the access is not.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>AI usage metering</h3>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4 style={{ color: "var(--blue)" }}>Every AI call is logged</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            <code>aiUsageLogs</code> table records input/output/total tokens,
            dollar cost, provider, model, userId, pageId, driveId, duration,
            context size, and truncation strategy. Cost calculated from
            real-time per-model pricing (100+ models across 11 providers).
          </p>
        </Card>
        <Card accent="amber">
          <h4 style={{ color: "var(--amber)" }}>Subscription tier enforcement</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Four tiers: <strong>free</strong> (500 MB / 20 MB files),{" "}
            <strong>pro</strong> (2 GB / 50 MB),{" "}
            <strong>founder</strong> (10 GB / 50 MB),{" "}
            <strong>business</strong> (50 GB / 100 MB).
            Storage quotas, concurrent upload limits, and file counts
            enforced at upload time with warning levels at 80% and 95%.
          </p>
        </Card>
      </div>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 2: Gaps                                        */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Gaps</div>
      <h2>
        Org layer unmerged.{" "}
        <span className="hl">No budget enforcement. No scope inheritance.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The current system governs <em>access</em> and <em>tools</em> well.
        AI usage is metered comprehensively. The org layer is built but
        unmerged. The metering has no enforcement &mdash; no spending caps,
        no per-agent budgets. And there&apos;s no scope narrowing when agents
        delegate to other agents.
      </p>

      <FeatureRow columns={2}>
        <Feature
          icon="&#x1F3E2;"
          name="Org layer in progress"
          nameColor="var(--amber)"
          description="Schema, API routes, auth middleware, Stripe per-seat billing, and guardrails implemented on <code>ppg/orgs-billing</code> branch (~60 commits ahead). Tables: <code>organizations</code>, <code>orgMembers</code>, <code>orgDrives</code>, <code>orgSubscriptions</code>. Guardrails for AI provider allowlists, storage limits, domain restrictions. Not yet merged to master."
        />
        <Feature
          icon="&#x1F4B0;"
          name="No budget enforcement"
          nameColor="var(--red)"
          description="AI usage is tracked per-user with full cost attribution (tokens, dollars, provider, model). But there are no spending caps &mdash; no per-agent limits, no per-org budgets, no circuit breaker on runaway agents. Metering exists, enforcement doesn't."
        />
      </FeatureRow>
      <FeatureRow columns={2}>
        <Feature
          icon="&#x1F517;"
          name="No scope inheritance"
          nameColor="var(--red)"
          description="MAX_DEPTH=2 prevents infinite recursion, but when Agent A calls Agent B via <code>ask_agent</code>, Agent B doesn't inherit A's permission boundary. No scope narrowing through delegation chains. OWASP identifies this as 'cascading failures' risk."
        />
        <Feature
          icon="&#x1F512;"
          name="No Enterprise SSO"
          nameColor="var(--red)"
          description="No SAML 2.0 or OIDC for Okta, Azure AD, or OneLogin. Session infrastructure supports scoped tokens (service, MCP, device types) but no external identity federation. Mid-market enterprise sales blocker."
        />
      </FeatureRow>

      <Card accent="amber" style={{ marginBottom: 12 }}>
        <h4 style={{ color: "var(--amber)" }}>The metering-to-enforcement gap</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          PageSpace already knows what every AI call costs (per-user, per-model,
          per-page, per-drive). The infrastructure to <em>record</em> cost is
          production-grade. What&apos;s missing is the policy layer that says
          &ldquo;this agent has a $50/month budget&rdquo; and stops it when
          it&apos;s spent. The org guardrails branch has <code>maxAITokensPerDay</code>{" "}
          on the org schema &mdash; but enforcement at the AI call boundary
          hasn&apos;t been wired up yet.
        </p>
      </Card>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 4: End game                                    */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">End game</div>
      <h2>
        Org hierarchy.{" "}
        <span className="hl">Budget enforcement. Scope inheritance.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The roadmap requires per-org isolation before containers can exist.
        Governance rides the same dependency chain: orgs enable team-level
        budgets, which enable per-agent spending caps, which enable autonomous
        agents that run in loops without human babysitting. The org branch
        is close &mdash; merge it, wire up budget enforcement on the existing
        metering, and add scope inheritance to <code>ask_agent</code>.
      </p>

      <h3 style={{ marginBottom: 12 }}>Two-tier role model</h3>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4 style={{ color: "var(--blue)" }}>Org roles = governance</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Org-level roles control <strong>policy</strong>: who manages
            billing, who sets AI budgets, who configures SSO, who approves
            provider allowlists. These are the roles that determine what
            the organization <em>allows</em>. Think GitHub org owners vs
            members &mdash; it&apos;s about governance, not content.
          </p>
          <p style={{ marginTop: 6, fontSize: 11, color: "var(--dim)" }}>
            Owner &middot; Admin &middot; Member &mdash; controls budget
            ceilings, SSO policy, AI provider access, domain restrictions
          </p>
        </Card>
        <Card accent="cyan">
          <h4 style={{ color: "var(--cyan)" }}>Drive roles = titles</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Drive-level roles are more like <strong>Discord roles</strong>
            &mdash; flexible titles that determine what you can do within
            a specific drive. Content access, tool configuration, agent
            invocation rights. The <code>drive_roles</code> custom role
            templates already support this pattern.
          </p>
          <p style={{ marginTop: 6, fontSize: 11, color: "var(--dim)" }}>
            Custom per-drive &middot; assignable permissions bundles &middot;
            canView / canEdit / canShare per role template
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>Target governance stack</h3>
      <ArchDiagram>
        <ArchRow label="Org" labelSub="governance roles">
          <ArchNode
            title="Org: Acme Corp"
            detail="AI budget: $500/mo &middot; SSO: Okta &middot; provider allowlist &middot; domain restrictions"
            titleColor="var(--blue)"
            borderColor="var(--blue)"
          />
          <ArchNode
            title="Org: Side Project"
            detail="AI budget: $50/mo &middot; personal &middot; fewer controls"
            titleColor="var(--blue)"
            borderColor="var(--blue)"
          />
        </ArchRow>
        <ArchConnector text="org roles set budget + policy ceiling" />
        <ArchRow label="Drive" labelSub="title roles">
          <ArchNode
            title="Platform Dev"
            detail="Roles: Maintainer, Reviewer, Contributor &middot; custom tool access per role"
            borderColor="var(--cyan)"
          />
          <ArchNode
            title="Marketing"
            detail="Roles: Editor, Publisher, Viewer &middot; CMS creds &middot; read-only code"
            borderColor="var(--cyan)"
          />
          <ArchNode
            title="Support KB"
            detail="Roles: Author, Responder &middot; Zendesk integration"
            borderColor="var(--cyan)"
          />
        </ArchRow>
        <ArchConnector text="drive roles scope content access + tools" />
        <ArchRow label="Agent" labelSub="within drive scope">
          <ArchNode
            title="Agent: deploy-bot"
            detail="Budget: $5/day &middot; tools: shell, git &middot; approval: deploys"
            titleColor="var(--violet)"
            borderColor="var(--violet)"
          />
          <ArchNode
            title="Agent: reviewer"
            detail="Budget: $10/day &middot; tools: read_page, search &middot; read-only"
            titleColor="var(--violet)"
            borderColor="var(--violet)"
          />
          <ArchNode
            title="Agent: researcher"
            detail="Budget: $3/day &middot; tools: web_search, create_page &middot; no integrations"
            titleColor="var(--violet)"
            borderColor="var(--violet)"
          />
        </ArchRow>
        <ArchConnector text="child agents inherit parent's scope ceiling" />
        <ArchRow label="Delegation">
          <ArchNode
            title="Spawned sub-agent"
            detail="Scope &le; parent &middot; budget &le; parent's remaining &middot; tools &sube; parent's tools"
            titleColor="var(--dim)"
            borderColor="var(--border2)"
          />
        </ArchRow>
      </ArchDiagram>

      <FeatureRow columns={3}>
        <Feature
          icon="&#x1F3E2;"
          name="Org roles + budget"
          nameColor="var(--green)"
          description="Org roles govern policy: billing, AI budgets, SSO, provider allowlists, domain restrictions. Budget enforcement wired to existing AI metering &mdash; agents that hit their cap get denied, not just logged. Circuit breaker for runaway loops."
        />
        <Feature
          icon="&#x1F3AD;"
          name="Drive role titles"
          nameColor="var(--cyan)"
          description="Discord-style roles per drive. Custom permission bundles: Maintainer, Reviewer, Editor, Publisher &mdash; whatever the drive needs. Extends existing <code>drive_roles</code> table with richer semantics beyond Owner/Admin/Member."
        />
        <Feature
          icon="&#x1F517;"
          name="Scope inheritance"
          nameColor="var(--violet)"
          description="Child agents inherit parent's permission ceiling. Scope only narrows, never widens, down the delegation chain. Budget draws from parent's remaining allocation. Org budget &rarr; drive budget &rarr; agent budget &rarr; sub-agent budget."
        />
      </FeatureRow>
      <FeatureRow columns={3}>
        <Feature
          icon="&#x1F512;"
          name="Enterprise SSO"
          nameColor="var(--blue)"
          description="SAML 2.0 + OIDC for Okta, Azure AD, OneLogin. Email domain routing (user@acme.com &rarr; Acme's Okta). Per-org SSO enforcement. Builds on existing session infrastructure (scoped tokens, resource binding)."
        />
        <Feature
          icon="&#x2705;"
          name="Approval gates"
          nameColor="var(--green)"
          description="Human-in-the-loop for high-risk operations. Configurable per-agent: which tools require approval, timeout behavior, risk levels. Workspace-level enforcement at the tool execution boundary."
        />
        <Feature
          icon="&#x1F6E1;"
          name="OWASP coverage"
          nameColor="var(--red)"
          description="Systematic coverage of all 10 OWASP agentic risks. Goal hijacking (scope gates), tool misuse (capability enforcement), identity abuse (per-user isolation), cascading failures (scope inheritance), rogue agents (budget + kill switch)."
        />
      </FeatureRow>

      <Card style={{ borderColor: "var(--border2)", marginTop: 12 }}>
        <h4 style={{ color: "var(--blue)" }}>Why two tiers, not one</h4>
        <p style={{ fontSize: 12 }}>
          Org roles and drive roles serve different purposes. An org admin
          sets the AI budget ceiling and configures SSO &mdash; they don&apos;t
          need edit access to every drive. A drive &ldquo;Maintainer&rdquo;
          can merge PRs and configure agents &mdash; they don&apos;t need
          billing access. Collapsing these into one role system forces
          over-permissioning at one level to satisfy the other. Two tiers
          means governance scales independently from content access.
        </p>
      </Card>
    </div>
  );
}
