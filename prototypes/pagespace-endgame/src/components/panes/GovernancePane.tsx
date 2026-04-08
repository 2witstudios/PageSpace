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
        Permissions, access control, and{" "}
        <span className="hl">agent boundaries.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        PageSpace has production-grade RBAC with drive membership, page-level
        permissions, Redis-cached resolution, and security audit logging.
        Agent scope is determined by the page tree. What's missing is the
        layer above &mdash; org/team governance, per-agent budgets, and
        capability gates.
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
            detail="Default: denied"
            titleColor="var(--red)"
            borderColor="var(--red)"
          />
        </ArchRow>
        <ArchConnector text="checked left to right, first match wins" />
        <ArchRow label="Caching">
          <ArchNode
            title="L1 memory cache"
            detail="In-process &middot; fastest path"
            borderColor="var(--cyan)"
          />
          <ArchNode
            title="L2 Redis cache"
            detail="5-minute TTL &middot; shared across instances"
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
          description="Three roles: <strong style='color:var(--text)'>Owner</strong> (full control), <strong style='color:var(--text)'>Admin</strong> (manage members + content), <strong style='color:var(--text)'>Member</strong> (read/write within permissions). Assigned per-drive."
        />
        <Feature
          icon="&#x1F4C4;"
          name="Page permissions"
          nameColor="var(--blue)"
          description="Granular: canView, canEdit, canShare, canDelete. Each can have an expiration date. Permissions are on specific pages, not entire trees."
        />
        <Feature
          icon="&#x1F916;"
          name="Agent scope"
          nameColor="var(--violet)"
          description="Page tree determines what agents can see. <code>ask_agent</code> has MAX_DEPTH=2 to prevent recursion. Tools are configurable per AI_CHAT page."
        />
      </FeatureRow>
      <FeatureRow columns={3}>
        <Feature
          icon="&#x1F6E1;"
          name="Security audit log"
          nameColor="var(--amber)"
          description="Hash chain verification for tamper detection. Audit entries are cryptographically linked. Verified on a cron schedule."
        />
        <Feature
          icon="&#x1F50C;"
          name="Redis-cached resolution"
          nameColor="var(--cyan)"
          description="Two-layer cache: in-memory (L1) + Redis (L2) with 5-minute TTL. Permission checks are fast even under high agent concurrency."
        />
        <Feature
          icon="&#x1F527;"
          name="Configurable tools"
          nameColor="var(--red)"
          description="Each AI_CHAT page has an enabled tools list. Admins control which of the 33+ tools an agent can access. No global tool access."
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
            to. The agent is shared, the access is not. This is how you get
            shared skills without shared PII.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)", marginBottom: 12 }}>
        <h4 style={{ color: "var(--dim)" }}>Why this matters</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          Competing platforms use &ldquo;shared team memory&rdquo; models where
          the AI agent has access to everything in the workspace. This means
          an agent asked to build a company directory can surface PII from
          private DMs. PageSpace&apos;s per-user permission enforcement at the
          tool layer prevents this by design &mdash; the agent never sees data
          the requesting user can&apos;t see.
        </p>
      </Card>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 2: Gaps                                        */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Gaps</div>
      <h2>
        No org layer.{" "}
        <span className="hl">No agent budgets. No capability gates.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The current system governs <em>access</em> well but doesn't govern
        <em> cost</em>, <em>scope</em>, or <em>organizational hierarchy</em>.
        There's no way to group drives under teams, limit what agents spend,
        or enforce fine-grained capability boundaries at runtime.
      </p>

      <FeatureRow columns={2}>
        <Feature
          icon="&#x1F3E2;"
          name="No org/team layer"
          nameColor="var(--red)"
          description="Drives exist in isolation. No GitHub-style orgs to group drives, manage team billing, or share integration credentials. Users can't see all their orgs from one dashboard."
        />
        <Feature
          icon="&#x1F4B0;"
          name="No per-agent budgets"
          nameColor="var(--red)"
          description="No token/hour limits, no cost ceilings per agent. A single runaway agent can exhaust the workspace's AI budget with no safeguard."
        />
      </FeatureRow>
      <FeatureRow columns={2}>
        <Feature
          icon="&#x1F6AB;"
          name="No capability gates"
          nameColor="var(--red)"
          description="Agents can call any enabled tool without rate or scope limits. No runtime enforcement of 'this agent can only read, never write' or 'max 10 tool calls per turn'."
        />
        <Feature
          icon="&#x1F512;"
          name="No Enterprise SSO"
          nameColor="var(--red)"
          description="No SAML 2.0 or OIDC for Okta, Azure AD, or OneLogin. Mid-market enterprise sales blocker. Depends on Organizations epic (#590), which has no dependencies and can start immediately."
        />
      </FeatureRow>
      <FeatureRow columns={2}>
        <Feature
          icon="&#x1F511;"
          name="No container-level auth"
          nameColor="var(--amber)"
          description="No scoped service tokens for agents running inside VMs. When containers exist, agents will need a way to authenticate back to the PageSpace API with limited permissions."
        />
        <Feature
          icon="&#x1F441;"
          name="Page AI visibility not discoverable"
          nameColor="var(--amber)"
          description="visibleToGlobalAssistant and excludeFromSearch columns exist and work. UI toggle exists but isn't discoverable. 'Hide from humans' not implemented."
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 28 }}>
        <Card accent="red">
          <h4 style={{ color: "var(--red)" }}>No integration credential governance</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Integration credentials (GitHub OAuth, API keys, MCP server
            configs) are per-drive. No team-level credential management,
            no shared vault, no rotation policies.
          </p>
        </Card>
        <Card accent="amber">
          <h4 style={{ color: "var(--amber)" }}>AI billing not separated</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            AI usage costs are not tracked separately from platform billing.
            No per-org AI budgets, no per-agent cost attribution, no way
            to see which agent spent how much.
          </p>
        </Card>
      </div>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 3: End game                                    */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">End game</div>
      <h2>
        Org hierarchy.{" "}
        <span className="hl">Budget controls. Scoped tokens.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The target is GitHub-style organizational governance extended to
        AI agents. Teams own drives, orgs control budgets, agents get
        scoped permissions, and every layer has cost and capability
        boundaries enforced at runtime.
      </p>

      <h3 style={{ marginBottom: 12 }}>Target org hierarchy</h3>
      <ArchDiagram>
        <ArchRow label="User">
          <ArchNode
            title="User dashboard"
            detail="Aggregates all orgs &middot; single view across everything"
            titleColor="var(--green)"
            borderColor="var(--green)"
          />
        </ArchRow>
        <ArchConnector text="user belongs to multiple orgs" />
        <ArchRow label="Org">
          <ArchNode
            title="Org: Acme Corp"
            detail="AI budget: $500/mo &middot; API keys &middot; integration credentials &middot; team management"
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
        <ArchConnector text="orgs contain teams with multiple drives" />
        <ArchRow label="Team">
          <ArchNode
            title="Engineering"
            detail="3 drives &middot; shared credentials &middot; team AI budget slice"
            borderColor="var(--cyan)"
          />
          <ArchNode
            title="Design"
            detail="2 drives &middot; separate tool config"
            borderColor="var(--cyan)"
          />
          <ArchNode
            title="Marketing"
            detail="1 drive &middot; read-only integrations"
            borderColor="var(--cyan)"
          />
        </ArchRow>
        <ArchConnector text="drives contain pages + agents" />
        <ArchRow label="Agent">
          <ArchNode
            title="Agent: deploy-bot"
            detail="Budget: 10k tokens/hr &middot; tools: shell, git &middot; scoped token"
            titleColor="var(--violet)"
            borderColor="var(--violet)"
          />
          <ArchNode
            title="Agent: reviewer"
            detail="Budget: 50k tokens/hr &middot; tools: read_page, search &middot; read-only"
            titleColor="var(--violet)"
            borderColor="var(--violet)"
          />
        </ArchRow>
      </ArchDiagram>

      <FeatureRow columns={3}>
        <Feature
          icon="&#x1F3E2;"
          name="Org layer"
          nameColor="var(--green)"
          description="Teams with multiple drives, like GitHub orgs. AI billing budgets, API keys, and integration credentials managed per-org. Teams share credentials without exposing secrets to individuals."
        />
        <Feature
          icon="&#x1F4CA;"
          name="User aggregation"
          nameColor="var(--blue)"
          description="Dashboard shows all orgs a user belongs to &mdash; not workspace switching. One view across all teams, drives, and activity."
        />
        <Feature
          icon="&#x1F4B0;"
          name="Per-agent budgets"
          nameColor="var(--amber)"
          description="Token/hour limits and cost ceilings per agent. Runtime enforces spending limits. Runaway agents get stopped, not just logged."
        />
      </FeatureRow>
      <FeatureRow columns={3}>
        <Feature
          icon="&#x1F6E1;"
          name="Capability gates"
          nameColor="var(--cyan)"
          description="Declare what tools an agent can use and with what limits. Runtime enforces: 'read-only agent', 'max 20 tool calls', 'no external search'. Not just configuration &mdash; enforcement."
        />
        <Feature
          icon="&#x1F512;"
          name="Enterprise SSO"
          nameColor="var(--violet)"
          description="SAML 2.0 + OIDC for Okta, Azure AD, OneLogin. Org admins configure SSO via UI. Email domain routing (user@acme.com &rarr; Acme's Okta). Per-org SSO enforcement."
        />
        <Feature
          icon="&#x1F517;"
          name="Scope inheritance"
          nameColor="var(--red)"
          description="Child agents inherit parent's permission boundary. An agent spawned by a read-only agent can't write. Scope only narrows, never widens, down the delegation chain."
        />
      </FeatureRow>

      <Card style={{ borderColor: "var(--border2)", marginTop: 12 }}>
        <h4 style={{ color: "var(--blue)" }}>From access control to full governance</h4>
        <p style={{ fontSize: 12 }}>
          Today: who can see what. Target: who can see what, how much they
          can spend, what actions they can take, and how those boundaries
          cascade through agent hierarchies. The same RBAC engine, extended
          with cost controls, capability gates, and organizational hierarchy.
        </p>
      </Card>
    </div>
  );
}
