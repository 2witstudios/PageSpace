import type { CSSProperties } from "react";
import { Card } from "../ui/Card";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";
import { FeatureRow, Feature } from "../ui/FeatureRow";
import { Pill } from "../ui/Pill";

const cellTd: CSSProperties = {
  padding: "8px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  fontSize: 12,
  verticalAlign: "top",
};

export function InterfacesPane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        10 page types, 4 platforms.{" "}
        <span className="hl">Every editor is real.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        PageSpace ships specialized editors for all 10 page types in the
        enum &mdash; none are stubs. TipTap for documents, Monaco for code
        (25+ languages), a 2,168-line custom spreadsheet engine, an
        HTML/CSS canvas with live ShadowDOM preview, a Gridland TUI terminal
        (UI-ready, awaiting shell backend), and 16 tool-call renderers in
        the AI chat. Desktop is a full Electron app with auto-update and MCP
        integration. Mobile wraps the web build via Capacitor.
      </p>

      <Card style={{ overflow: "auto", marginBottom: 16, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                Page type
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                Editor / engine
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Document</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>TipTap &mdash; 11 extensions (StarterKit, CodeBlockShiki, Markdown, tables, mentions, pagination)</td>
              <td style={cellTd}><Pill variant="green">live</Pill></td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Code</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Monaco &mdash; 25+ languages, custom SudoLang, minimap, folding, read-only mode</td>
              <td style={cellTd}><Pill variant="green">live</Pill></td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Sheet</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Custom engine (2,168 LOC) &mdash; formula eval, cross-sheet refs, AI suggestions, undo history</td>
              <td style={cellTd}><Pill variant="green">live</Pill></td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Canvas</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>HTML/CSS editor (Monaco) + ShadowDOM live preview &mdash; sanitized, nav-aware</td>
              <td style={cellTd}><Pill variant="green">live</Pill></td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>AI Chat</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>800+ LOC &mdash; multi-model, streaming, 16 tool-call renderers, voice mode, MCP</td>
              <td style={cellTd}><Pill variant="green">live</Pill></td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Channel</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Real-time messaging (511 LOC) &mdash; reactions, rich input, threaded</td>
              <td style={cellTd}><Pill variant="green">live</Pill></td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Task List</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>List view + Kanban view &mdash; drag-and-drop, status tracking</td>
              <td style={cellTd}><Pill variant="green">live</Pill></td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>File</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>5 viewers &mdash; PDF, DOCX, code, image, generic. Format auto-detection</td>
              <td style={cellTd}><Pill variant="green">live</Pill></td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Folder</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Grid + list views, hierarchical navigation, page tree</td>
              <td style={cellTd}><Pill variant="green">live</Pill></td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)", borderBottom: "none" }}>Terminal</td>
              <td style={{ ...cellTd, color: "var(--mid)", borderBottom: "none" }}>Gridland TUI framework (504 LOC) &mdash; command input, history, themes. Shell backend not connected</td>
              <td style={{ ...cellTd, borderBottom: "none" }}><Pill variant="amber">UI only</Pill></td>
            </tr>
          </tbody>
        </table>
      </Card>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--green)"
          name="Desktop"
          description="Full Electron app (3,391 LOC). Auto-update, MCP server integration, auth sessions, media permissions, fetch proxy for offline. Builds for macOS, Windows, Linux with code signing and notarization."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Mobile"
          description="Capacitor hybrid apps wrapping the web build. iOS (Swift keychain plugin, Apple/Google social login, push notifications) and Android (secure storage plugin). Not native — WebView with native bridges."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Navigation"
          description="Left sidebar (2,368 LOC): drive tree, favorites, recents, workspace switcher. Right sidebar: AI assistant with chat, history, settings, activity tabs. Global + inline search with debounced results."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Drive-scoped workspaces</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Each drive is a workspace with its own page tree, members, roles,
            and system prompt. Sidebar navigation, favorites, recents,
            search scoped to the drive. RBAC at the drive and page level.
          </p>
        </Card>
        <Card accent="green">
          <h4>Agent interface</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            AI_CHAT pages with configurable model, system prompt, temperature.
            33+ tools for page CRUD, search, navigation. 16 specialized
            tool-call renderers. Streaming via Vercel AI SDK. Voice mode.
            MCP protocol integration for external tool servers.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Rich editors, no execution.{" "}
        <span className="hl">Pages are documents, not programs.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Every page type has a real editor, but the platform has no way to
        run code, manage repositories, or deploy anything. The Terminal page
        type exists in the UI but has no shell backend. Real-time sync works
        for content updates, but there are no presence indicators or live
        cursors. Every interface gap below blocks the transition from
        &quot;collaboration tool&quot; to &quot;operating system.&quot;
      </p>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--red)"
          name="No shell backend"
          description="Terminal page renders a Gridland TUI, accepts input, and tracks history &mdash; but outputs 'Shell connection not yet configured.' The UI is ready. The backend isn't."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No code execution"
          description="Monaco edits code in 25+ languages, but there's no way to run it, test it, or see output. Code pages are static text. The Canvas previews HTML/CSS but can't execute scripts."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No git integration"
          description="No clone, branch, commit, push, or PR workflows. No diff views. No merge conflict resolution. Code collaboration requires external tools entirely."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No build pipelines"
          description="No CI/CD. No deployment workflows. Pages can't become websites. Drives can't become deployed applications. Content stays inside PageSpace."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="red">
          <h4>No presence layer</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            WebSocket sync delivers content updates in real-time, and
            useEditingStore prevents SWR from clobbering in-progress edits.
            But there are no user presence indicators, no live cursors, no
            awareness of who else is on the page. Collaboration is async.
          </p>
        </Card>
        <Card accent="red">
          <h4>No generated interfaces</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            The UI is fixed &mdash; one experience for all users. No ability
            for agents to build new views or tools within the platform. No
            agent-to-user interface protocol. No dynamic surfaces.
          </p>
        </Card>
        <Card accent="red">
          <h4>Canvas is not a design tool</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Canvas pages are HTML/CSS editors with a live preview, not a
            visual design surface with shapes, connections, or diagramming.
            No whiteboard or freeform drawing. Closer to CodePen than Figma.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Competitive Landscape ── */}
      <div className="sl">Landscape</div>
      <h2>
        Three deployment models.{" "}
        <span className="hl">Local, cloud, and messaging.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        OpenFang and OpenClaw run on the user&apos;s computer &mdash; they
        own the filesystem, the shell, every file on disk. They excel at
        code execution, autonomous agents, and full system access. PageSpace
        excels at team collaboration, permissions, and multi-tenancy. Viktor
        takes a third approach &mdash; team-native in Slack, but owns nothing.
        These are complementary deployment models, not competing products.
      </p>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--cyan)"
          name="OpenFang &mdash; Agent OS"
          description="Rust single-binary on your machine. 'Hands': autonomous agents that run on schedules, accumulate knowledge graphs, own the filesystem. 40 channel adapters. WASM sandboxing. Strong local runtime with code execution and autonomous loops."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--violet)"
          name="OpenClaw &mdash; A2UI"
          description="60K+ GitHub stars. Runs locally, owns the whole computer. A2UI protocol lets agents construct UIs declaratively. Canvas renders agent-generated interfaces live. Browser automation, 50+ integrations. Local-first personal agent with full machine access."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Viktor &mdash; AI coworker"
          description="Lives in Slack &mdash; team-native but owns nothing. Persistent workspace context for weeks/months. Proactive monitoring without prompting. 3,000+ integrations. Pushes artifacts to Notion, Linear. Layer on top of other platforms."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <Card style={{ overflow: "auto", marginBottom: 16, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                Dimension
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                OpenFang
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                OpenClaw
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                Viktor
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--green)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                PageSpace
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Runs where</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Your machine</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Your machine</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Slack (cloud)</td>
              <td style={{ ...cellTd, color: "var(--green)" }}>Cloud OS</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Owns content?</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Yes &mdash; the whole filesystem</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Yes &mdash; the whole computer</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>No &mdash; pushes to Notion, Linear</td>
              <td style={{ ...cellTd, color: "var(--green)" }}>Yes &mdash; page tree is the data</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Code execution</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Yes &mdash; WASM + native</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Yes &mdash; full shell access</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>No</td>
              <td style={{ ...cellTd, color: "var(--amber)" }}>Not yet &mdash; in progress</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Team collaboration</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>No &mdash; single user</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>No &mdash; personal assistant</td>
              <td style={{ ...cellTd, color: "var(--green)", fontWeight: 600 }}>Yes &mdash; Slack-native teams</td>
              <td style={{ ...cellTd, color: "var(--green)", fontWeight: 600 }}>Yes &mdash; RBAC, drives, real-time</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)", borderBottom: "none" }}>Steal this</td>
              <td style={{ ...cellTd, color: "var(--violet)", borderBottom: "none" }}>Autonomous Hands (scheduled agents)</td>
              <td style={{ ...cellTd, color: "var(--cyan)", borderBottom: "none" }}>A2UI (agents generate UI)</td>
              <td style={{ ...cellTd, color: "var(--amber)", borderBottom: "none" }}>Proactive monitoring + long memory</td>
              <td style={{ ...cellTd, color: "var(--green)", borderBottom: "none", fontWeight: 600 }}>Close the execution gap &mdash; team layer is the differentiator</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <Card accent="cyan">
        <h4 style={{ color: "var(--cyan)" }}>The convergence</h4>
        <p style={{ fontSize: 12 }}>
          OpenFang and OpenClaw bring code execution, autonomous agent loops,
          and full system access. PageSpace brings team collaboration,
          permissions, multi-tenancy, and a structured content layer. These
          are complementary strengths across different deployment models
          &mdash; local-first and cloud-team. The IDE lens closes
          PageSpace&apos;s execution gap while preserving the team
          collaboration that makes it unique.
        </p>
      </Card>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        IDE is the bootstrap.{" "}
        <span className="hl">Lenses emerge from the engine.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        The roadmap is: infrastructure (per-org isolation, AWS), then runtime
        (agent loops + containers), then the IDE lens (terminals, git, build
        pipelines). The IDE is the bootstrap &mdash; once agents can write
        and execute code inside PageSpace, they can build every subsequent
        interface. CMS, CRM, and custom verticals are lenses on the same OS,
        not separate products.
      </p>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The Terminal page type already has its UI. The Canvas already
        previews HTML/CSS in ShadowDOM isolation. The sheet engine already
        evaluates formulas. These are the raw materials. The unlock is
        connecting a shell backend, adding containers, and letting agents
        operate autonomously inside them.
      </p>

      <ArchDiagram>
        <ArchRow label="Today" labelSub="live" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Workspace Lens"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.4)"
            style={{ border: "2px solid rgba(61,214,140,0.4)" }}
            detail="10 page types with real editors &middot; 33+ agent tools<br>Desktop + mobile + web &middot; Drive-scoped workspaces<br>Global search &middot; Left sidebar + AI right sidebar<br>Real-time sync (no presence) &middot; Terminal UI (no shell)"
          />
        </ArchRow>

        <ArchConnector text="shell backend + containers + agent loops = the unlock" />

        <ArchRow label="Bootstrap" labelSub="build first" style={{ marginBottom: 8 }}>
          <ArchNode
            title="IDE Lens"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.4)"
            style={{ border: "2px solid rgba(34,211,238,0.5)" }}
            detail="Terminal page &rarr; real shell via container backend<br>Code page &rarr; run, test, see output<br>Git integration &rarr; branch, commit, PR, diff views<br>Build pipelines &rarr; deploy from the page tree<br><strong style='color:var(--cyan)'>Agents can now write code AND execute it</strong>"
          />
        </ArchRow>

        <ArchConnector text="agents write code &rarr; agents build interfaces &rarr; lenses on demand" />

        <ArchRow label="Lenses" labelSub="same OS, different views">
          <ArchNode
            title="CMS"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Pages = publishable content (blogs, docs, landing pages)<br>Drive = website repo with build pipeline<br>Custom domains &middot; SSL &middot; CDN<br>Content calendar &middot; agent-maintained SEO"
          />
          <ArchNode
            title="CRM"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            detail="Pages as contacts &middot; drives as pipelines<br>Email sequences &middot; outreach automation<br>Agent-driven lead scoring + follow-ups<br>Viktor-style proactive monitoring, native"
          />
          <ArchNode
            title="[Generated]"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="OpenClaw-style A2UI: agents construct UIs declaratively<br>Industry verticals &middot; custom dashboards<br>The platform builds its own new front-ends<br>Every ICP gets a lens tailored to their workflow"
          />
        </ArchRow>
      </ArchDiagram>

      <div className="sl">What changes per lens</div>
      <h2>
        Same backend. Same agents.{" "}
        <span className="hl">Different surfaces.</span>
      </h2>

      <FeatureRow columns={2}>
        <Feature
          nameColor="var(--cyan)"
          name="What the IDE lens adds"
          description="Shell backend for Terminal pages. Git operations (clone, branch, commit, push, PR). Build/test/deploy pipelines triggered from the page tree. BRANCH pages that spawn containers. Diff views in the editor. Agent pair programming inside VMs."
        />
        <Feature
          nameColor="var(--green)"
          name="What CMS/CRM add"
          description="Publishing workflows and content scheduling. Custom domain routing and CDN. Contact management and pipeline views. Email sequences and outreach. These are interface layers &mdash; the data model (pages, drives, permissions) is already the OS."
        />
      </FeatureRow>
      <FeatureRow columns={2}>
        <Feature
          nameColor="var(--violet)"
          name="Agent-generated interfaces"
          description="A2UI-style protocol: agents build interactive surfaces within pages, not just text responses. Dashboard widgets, form builders, data visualizations &mdash; generated on demand from the page tree. The Canvas page type (ShadowDOM isolation) is the prototype."
        />
        <Feature
          nameColor="var(--blue)"
          name="Presence + collaboration layer"
          description="Live cursors, user indicators, collaborative editing. The WebSocket infrastructure exists. useEditingStore prevents write conflicts. The gap is the awareness layer &mdash; who is here, where their cursor is, what they're editing. Foundation is in place."
        />
      </FeatureRow>

      <Card style={{ borderColor: "var(--border2)" }}>
        <h4 style={{ color: "var(--cyan)" }}>The bootstrap principle</h4>
        <p style={{ fontSize: 12 }}>
          OpenFang and OpenClaw prove the model works &mdash; agents with
          full system access and autonomous loops become an OS. PageSpace
          brings the team layer they don&apos;t target: permissions, multi-tenancy,
          structured content, real-time collaboration. The IDE lens
          completes the picture &mdash; once agents can execute code inside
          the same platform where teams collaborate, PageSpace becomes the
          cloud-native version of what the local-first tools already are.
          And then it builds its own future interfaces from the inside.
        </p>
      </Card>
    </div>
  );
}
