import type { CSSProperties, ReactNode } from "react";
import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import { FeatureRow, Feature } from "../ui/FeatureRow";

/* ── tree primitives ── */

function N({
  title, color, detail, status, style,
}: {
  title: string; color: string; detail: string;
  status?: ReactNode; style?: CSSProperties;
}) {
  return (
    <div style={{
      background: "var(--s2)", borderRadius: 8, padding: "10px 14px",
      border: `1px solid ${color}33`, minWidth: 130, flexShrink: 0, ...style,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 2 }}>
        {title} {status}
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--dim)", lineHeight: 1.6 }}
        dangerouslySetInnerHTML={{ __html: detail }} />
    </div>
  );
}

function Arr({ color = "var(--border)" }: { color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 3px" }}>
      <div style={{ width: 18, height: 1, background: color }} />
      <div style={{
        width: 0, height: 0,
        borderLeft: `5px solid ${color}`,
        borderTop: "3px solid transparent",
        borderBottom: "3px solid transparent",
      }} />
    </div>
  );
}

/* A trunk node that can have branches dropping below it */
function Fork({
  children, branches, color = "var(--border)",
}: {
  children: ReactNode; branches?: ReactNode; color?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        {children}
      </div>
      {branches && (
        <div style={{
          borderLeft: `2px solid ${color}`,
          marginLeft: 20,
          paddingLeft: 14,
          paddingTop: 8,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}>
          {branches}
        </div>
      )}
    </div>
  );
}

/* A single branch row (horizontal chain) with a label */
function Branch({
  label, color, note, children,
}: {
  label: string; color: string; note?: string; children: ReactNode;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <div style={{
          width: 14, height: 1, background: color, flexShrink: 0,
          marginLeft: -15,
        }} />
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: 1,
          textTransform: "uppercase" as const, color, flexShrink: 0,
        }}>
          {label}
        </span>
        {note && (
          <span style={{
            fontSize: 8, fontFamily: "var(--mono)", color: "var(--dim)",
            fontStyle: "italic",
          }}>
            {note}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        {children}
      </div>
    </div>
  );
}

/* ── component ── */

export function RoadmapPane() {
  return (
    <div className="pane-wide">
      <div className="sl">Revenue Unlocks</div>
      <h2>
        Each capability{" "}
        <span className="hl">enables the next.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        Read left to right. The trunk is what enables everything.
        Branches fork down from the node they depend on. Each branch is
        its own roadmap &mdash; trace any path from foundation to leaf to
        see the full dependency chain.
      </p>

      {/* ═══ THE TREE ═══ */}
      <div style={{
        background: "var(--s1)", border: "1px solid var(--border)",
        borderRadius: 14, padding: "28px 24px", marginBottom: 24,
        overflowX: "auto",
      }}>

        {/* Trunk: flows left → right, branches fork down at each node */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 0 }}>

          {/* Foundation */}
          <N
            title="Foundation"
            color="var(--green)"
            status={<StatusBadge variant="live" />}
            detail="Workspace &middot; 9 page types<br>33+ tools &middot; 100+ models<br>Stripe billing &middot; on-prem"
            style={{ border: "2px solid rgba(61,214,140,0.4)" }}
          />
          <Arr color="var(--green)" />

          {/* Agent Runtime — Marketplace forks from here */}
          <Fork color="var(--violet)" branches={
            <Branch label="Marketplace" color="var(--violet)" note="grows with ecosystem">
              <N title="Skills + Integrations" color="var(--violet)"
                status={<StatusBadge variant="planned" />}
                detail="Skill catalog &middot; marketplace<br>Pages-as-skills &middot; discovery" />
              <Arr color="var(--violet)" />
              <N title="MCP Server" color="var(--violet)"
                status={<StatusBadge variant="planned" />}
                detail="PageSpace tools for Claude,<br>Cursor, VS Code, any client<br>Revenue: <strong style='color:var(--violet)'>commission + API</strong>" />
            </Branch>
          }>
            <N
              title="Agent Runtime"
              color="var(--blue)"
              status={<StatusBadge variant="planned" />}
              detail="Autonomous loops &middot; memory<br>Observability &middot; budgets<br>Revenue: <strong style='color:var(--blue)'>metered AI usage</strong>"
            />
            <Arr color="var(--blue)" />
          </Fork>

          {/* Architecture — Enterprise forks here (independent of containers) */}
          <Fork color="var(--amber)" branches={
            <Branch label="Enterprise" color="var(--amber)" note="independent &mdash; not blocked by containers">
              <N title="SSO + Orgs" color="var(--amber)"
                status={<StatusBadge variant="planned" />}
                detail="SAML/OIDC &middot; org hierarchy<br>Team layer above drives" />
              <Arr color="var(--amber)" />
              <N title="Compliance" color="var(--amber)"
                status={<StatusBadge variant="planned" />}
                detail="Full audit coverage &middot; SIEM<br>SLAs &middot; data residency" />
              <Arr color="var(--amber)" />
              <N title="Org Contracts" color="var(--amber)"
                status={<StatusBadge variant="planned" />}
                detail="Annual commitments<br>Dedicated infrastructure<br>Revenue: <strong style='color:var(--amber)'>enterprise contracts</strong>" />
            </Branch>
          }>
            <N
              title="Architecture"
              color="var(--violet)"
              status={<StatusBadge variant="planned" />}
              detail="Per-org isolation &middot; containers<br>Firecracker VMs<br><em>Capability, not scale</em>"
            />
            <Arr color="var(--violet)" />
          </Fork>

          {/* IDE — CMS, CRM, and Franchise all fork from here */}
          <Fork color="var(--cyan)" branches={<>
            <Branch label="CMS" color="var(--green)" note="publishable pages can start now &mdash; hosted sites need containers">
              <N title="Publishable Pages" color="var(--green)"
                status={<StatusBadge variant="planned" />}
                detail="Pages + drives become content<br>Blogs, courses, docs" />
              <Arr color="var(--green)" />
              <N title="Hosted Sites" color="var(--green)"
                status={<StatusBadge variant="planned" />}
                detail="Custom domains &middot; SSL<br>Executable pages<br>Revenue: <strong style='color:var(--green)'>hosting</strong>" />
            </Branch>

            <Branch label="CRM" color="var(--amber)" note="longest dependency chain">
              <N title="Pages as CRM" color="var(--amber)"
                status={<StatusBadge variant="in-progress" />}
                detail="Pages = contacts in file tree<br>Sidebar = navigation<br>Works rough today" />
              <Arr color="var(--amber)" />
              <N title="Custom Interfaces" color="var(--amber)"
                status={<StatusBadge variant="planned" />}
                detail="CRM needs its own views<br>Beyond page tree nav<br>Depends on interface system" />
              <Arr color="var(--amber)" />
              <N title="Full CRM" color="var(--amber)"
                status={<StatusBadge variant="planned" />}
                detail="Email, Slack, calendar<br>External integrations<br>Most bottlenecked" />
            </Branch>

            <Branch label="Franchise" color="var(--violet)" note="custom interfaces on the engine">
              <N title="PageSpace as Engine" color="var(--violet)"
                status={<StatusBadge variant="planned" />}
                detail="Configurable workflows<br>Industry-specific philosophy" />
              <Arr color="var(--violet)" />
              <N title="Industry Partners" color="var(--violet)"
                status={<StatusBadge variant="planned" />}
                detail="Partners optimize for vertical<br>Resell for their market<br>Revenue: <strong style='color:var(--violet)'>franchise licensing</strong>" />
            </Branch>
          </>}>
            <N
              title="IDE Lens"
              color="var(--cyan)"
              status={<StatusBadge variant="planned" />}
              detail="BRANCH pages &middot; terminal &middot; git<br>Agents code in containers<br>Revenue: <strong style='color:var(--cyan)'>AI usage</strong>"
            />
          </Fork>

        </div>
      </div>

      <hr />

      <div className="sl">Sequencing</div>
      <h2>
        Why this{" "}
        <span className="hl">shape.</span>
      </h2>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4 style={{ color: "var(--green)", marginBottom: 6 }}>Foundation is already live</h4>
          <p style={{ fontSize: 12, color: "var(--mid)" }}>
            The Workspace lens proves the product works. Revenue is
            flowing. The question is how to expand.
          </p>
        </Card>
        <Card accent="blue">
          <h4 style={{ color: "var(--blue)", marginBottom: 6 }}>Agents are the multiplier</h4>
          <p style={{ fontSize: 12, color: "var(--mid)" }}>
            Every lens is more valuable with autonomous agents. An IDE
            without agents is just another cloud IDE. A CMS with agents
            writes and publishes itself.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="violet">
          <h4 style={{ color: "var(--violet)", marginBottom: 6 }}>Architecture is capability, not scale</h4>
          <p style={{ fontSize: 12, color: "var(--mid)" }}>
            Per-org isolation and containers are about what PageSpace can
            do &mdash; run code, host sites, execute pages, support custom
            interfaces. The architecture shift makes PageSpace an engine.
          </p>
        </Card>
        <Card accent="amber">
          <h4 style={{ color: "var(--amber)", marginBottom: 6 }}>Each branch has its own pace</h4>
          <p style={{ fontSize: 12, color: "var(--mid)" }}>
            CMS publishable pages can start now. Enterprise is independent.
            CRM is the longest chain &mdash; custom interfaces plus
            external integrations. Trace any branch to see what gates it.
          </p>
        </Card>
      </div>

      <hr />

      <div className="sl">Revenue Streams</div>
      <h2>
        How each branch{" "}
        <span className="hl">generates revenue.</span>
      </h2>

      <FeatureRow columns={3} style={{ marginBottom: 0 }}>
        <Feature
          nameColor="var(--green)"
          name="Subscriptions"
          status={<StatusBadge variant="live" />}
          description="Per-user tiers gated by AI calls, storage, and features. The foundation &mdash; every user starts here."
        />
        <Feature
          nameColor="var(--blue)"
          name="AI Usage"
          description="Metered billing for agent compute. Agents coding in containers, maintaining content, managing pipelines. Scales with value delivered."
        />
        <Feature
          nameColor="var(--green)"
          name="Hosting + Publishing"
          description="Publishable pages become blogs, courses, sites. Custom domains and hosting create recurring infrastructure revenue."
        />
      </FeatureRow>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--amber)"
          name="Enterprise Contracts"
          description="Org-level agreements with annual commitments. SSO, compliance, dedicated infrastructure, SLAs."
        />
        <Feature
          nameColor="var(--violet)"
          name="Marketplace Commission"
          description="Skills, integrations, and templates sold through the platform. MCP server opens API access."
        />
        <Feature
          nameColor="var(--violet)"
          name="Franchise Licensing"
          description="Industry partners build optimized PageSpace for their vertical &mdash; configured workflows, tailored interfaces. Per-tenant licensing."
        />
      </FeatureRow>
    </div>
  );
}
