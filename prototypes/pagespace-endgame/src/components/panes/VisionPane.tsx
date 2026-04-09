import type { CSSProperties } from "react";
import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";

const cellTd: CSSProperties = {
  padding: "8px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  fontSize: 12,
  verticalAlign: "top",
};

export function VisionPane() {
  return (
    <div className="pane-wide">
      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 1: Hero                                        */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">SaaS as a Service</div>
      <h2>
        Your entire SaaS.{" "}
        <span className="hl">One interface.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Not just the software &mdash; the customers, the content, the billing,
        the team. PageSpace is a cloud operating system where the page tree is
        the filesystem. Interfaces are just lenses on it, adapted to whoever
        is looking. A developer sees an IDE. A marketer sees a CMS. A
        salesperson sees a CRM. Same pages. Same data. Same agents. One OS.
      </p>

      <Card accent="cyan">
        <p style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
          Every SaaS needs the same primitives: auth, billing, database,
          permissions, real-time, AI, file processing. PageSpace has all of
          them natively. Agents build and operate the rest. That&apos;s SaaS as
          a Service.
        </p>
      </Card>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 2: One OS, Many Lenses                          */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">The OS</div>
      <h2>
        The page tree is the filesystem.{" "}
        <span className="hl">Interfaces are just views.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        Every interface is a different way of seeing the same underlying OS.
        The data doesn&apos;t move. The permissions don&apos;t change. The
        agents work across all of them. You don&apos;t switch tools &mdash;
        you switch lenses.
      </p>

      <ArchDiagram>
        <ArchRow label="Core" labelSub="the OS">
          <ArchNode
            title="PageSpace OS"
            titleColor="var(--text)"
            borderColor="rgba(226,226,239,0.2)"
            style={{ border: "2px solid rgba(226,226,239,0.2)", flex: 2 }}
            detail="<strong style='color:var(--green)'>Filesystem</strong> &mdash; pages, drives, tree hierarchy, version history<br><strong style='color:var(--green)'>Permissions</strong> &mdash; RBAC, page-level access, drive scoping<br><strong style='color:var(--green)'>Processes</strong> &mdash; agents with 33+ tools, delegation, scheduling<br><strong style='color:var(--green)'>Storage</strong> &mdash; Postgres, 89 tables, file pipeline, search<br><strong style='color:var(--green)'>Networking</strong> &mdash; real-time collaboration, presence, streaming"
          />
        </ArchRow>

        <ArchConnector text="same data, different views" />

        <ArchRow label="Lenses" labelSub="interfaces">
          <ArchNode
            title="IDE"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.3)"
            detail="The developer sees:<br>Code files, terminals, git, branches<br>Build pipelines, deploy targets<br>Agent pair programmers in containers"
          />
          <ArchNode
            title="CMS"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="The marketer sees:<br>Blog posts, landing pages, docs<br>Content calendar, publishing workflows<br>Custom domains, SEO, media library"
          />
          <ArchNode
            title="CRM"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            detail="The salesperson sees:<br>Contacts, companies, deal pipelines<br>Email sequences, outreach automation<br>Agent-driven follow-ups and scoring"
          />
          <ArchNode
            title="Dashboard"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            detail="The ops lead sees:<br>Revenue metrics, usage analytics<br>Agent budgets, cost tracking<br>Monitoring, alerts, audit logs"
          />
          <ArchNode
            title="Workspace"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="Everyone sees:<br>Documents, spreadsheets, tasks<br>Chat channels, direct messages<br>Calendar, file storage, AI chat"
          />
        </ArchRow>
      </ArchDiagram>

      <Card style={{ borderColor: "var(--border2)" }}>
        <p style={{ fontSize: 12 }}>
          All five lenses share the same auth, the same database, the same
          permissions, the same agents. Not five products stitched together.
          One platform. The lens changes &mdash; the OS doesn&apos;t.
        </p>
      </Card>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 3: The Agent Layer                              */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">The Agent Layer</div>
      <h2>
        Agents don&apos;t see interfaces.{" "}
        <span className="hl">They see the OS.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Humans need lenses. Agents don&apos;t. An agent traverses the full
        page tree &mdash; it builds the code, writes the blog post, follows up
        the lead, checks the metrics, and messages the team. One agent, one
        OS, every capability. They&apos;re employees that work across every
        department.
      </p>

      <FeatureRow columns={3} style={{ marginBottom: 0 }}>
        <Feature
          nameColor="var(--cyan)"
          name="Engineering"
          description="Build features, write tests, review code, deploy. Agents operate in containers with real shells, real git, real filesystems. They ship."
        />
        <Feature
          nameColor="var(--green)"
          name="Marketing"
          description="Write blog posts, manage the content calendar, publish to your site. Agents create and deploy directly from the page tree."
        />
        <Feature
          nameColor="var(--amber)"
          name="Sales"
          description="Follow up leads, manage pipelines, send outreach, score prospects. Agents work your CRM data and automate the funnel."
        />
      </FeatureRow>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--blue)"
          name="Operations"
          description="Monitor uptime, track costs, manage billing, optimize spend. Agents watch dashboards and escalate when something breaks."
        />
        <Feature
          nameColor="var(--violet)"
          name="Support"
          description="Respond to customers, triage issues, route escalations, build knowledge base. Agents work across every channel."
        />
        <Feature
          nameColor="var(--text)"
          name="Strategy"
          description="Analyze usage patterns, surface insights, recommend priorities. Agents connect data across all lenses and find what humans miss."
        />
      </FeatureRow>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 4: What you stop paying for                     */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">One Platform</div>
      <h2>
        Stop stitching.{" "}
        <span className="hl">Start shipping.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Every SaaS company assembles the same stack of a dozen tools.
        PageSpace replaces the stack.
      </p>

      <Card style={{ overflow: "auto", marginBottom: 24, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "30%" }}>
                What you need
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                Built into PageSpace
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Authentication</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Passkeys, OAuth, opaque sessions, RBAC &mdash; production-grade from day one</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Billing</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Stripe checkout, customer portal, subscription tiers, usage metering</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Database</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Postgres with 89 tables, Drizzle ORM, typed schema, migrations</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Hosting &amp; Deploy</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Containers, custom domains, SSL, build pipelines &mdash; deploy from the page tree</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>CMS</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Pages publish as websites. Rich editor, version history, media processing</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>CRM</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Contacts, pipelines, deal tracking, agent-driven outreach and scoring</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Project Management</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Task lists, calendars, real-time collaboration, agent delegation</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>AI &amp; Agents</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>100+ models, 33+ tools, autonomous loops, cross-agent delegation</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Monitoring</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Tamper-evident audit logs, dashboards, anomaly detection, SIEM-ready</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Real-time</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Socket.IO with per-event auth, presence, live cursors, streaming</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)", borderBottom: "none" }}>File Storage</td>
              <td style={{ ...cellTd, color: "var(--mid)", borderBottom: "none" }}>Upload pipeline, OCR, image optimization, S3-backed, per-org isolation</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 5: The close                                    */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">The End Game</div>
      <h2>
        The last platform{" "}
        <span className="hl">you need.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        A team opens PageSpace. They see whatever they need to see &mdash;
        code, content, customers, metrics. Agents work across all of it. The
        platform isn&apos;t a tool you use alongside your business. It IS the
        business. One OS. Every interface. SaaS as a Service.
      </p>
    </div>
  );
}
