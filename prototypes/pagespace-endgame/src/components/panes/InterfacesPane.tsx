import { Card } from "../ui/Card";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function InterfacesPane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        One web app, 10 page types.{" "}
        <span className="hl">Rich editors, no code execution.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        Today, PageSpace is a Next.js 15 App Router application with specialized
        editors for each page type: TipTap for documents, Monaco for code,
        custom engines for sheets and canvas. Desktop (Electron) and mobile
        (Capacitor) wrappers provide native-feeling experiences on all platforms.
      </p>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Agent conversations happen in AI_CHAT pages within drive-scoped
        workspaces. Navigation is sidebar-driven. There is no terminal access,
        no git integration, and no build pipelines &mdash; pages are documents,
        not deployable content.
      </p>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--green)"
          name="10 page types"
          description="Document, Code, Sheet, Canvas, Task List, Channel, AI Chat, File, Folder, and more. Each with a specialized editor optimized for its content type."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Rich editors"
          description="TipTap (rich text with 30+ extensions), Monaco (code with language support), custom sheet engine, custom canvas with shapes and connections."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Multi-platform"
          description="Web (Next.js), Desktop (Electron for macOS, Windows, Linux), Mobile (Capacitor for iOS, Android). Same codebase, native wrappers."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Drive-scoped workspaces</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Each drive is a workspace with its own page tree, members, roles,
            and system prompt. Sidebar navigation, favorites, recent pages,
            search scoped to the drive. RBAC at the drive and page level.
          </p>
        </Card>
        <Card accent="green">
          <h4>Agent interface</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            AI_CHAT pages are the agent interface. Configurable model, system
            prompt, temperature. 33+ tools for page CRUD, search, navigation,
            and integrations. Streaming responses via Vercel AI SDK.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Pages are documents, not deployable.{" "}
        <span className="hl">No code execution in the browser.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Without code execution, terminals, and git, PageSpace is a content
        management tool &mdash; not a platform that can build and deploy
        software. Every gap below prevents the transition from &quot;edit
        documents&quot; to &quot;build and ship.&quot;
      </p>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--red)"
          name="Can&apos;t run code"
          description="No code execution from PageSpace. Monaco editor for viewing/editing code, but no way to run it, test it, or see output. Code pages are static files."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No terminal"
          description="No shell in the browser. Can't run commands, install packages, debug processes. Agents have no execution environment beyond API-level tool calls."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No git integration"
          description="No clone, branch, commit, push, or PR workflows. No diff views. No merge conflict resolution. Code collaboration requires external tools."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No build pipelines"
          description="No CI/CD, no deployment workflows. Pages can't be built into websites. Drives can't be deployed as applications. Content stays inside PageSpace."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="red">
          <h4>No generated interfaces</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Can&apos;t generate or launch custom interfaces from PageSpace.
            The UI is fixed &mdash; one experience for all users. No ability
            for agents to build new views or tools within the platform.
          </p>
        </Card>
        <Card accent="red">
          <h4>One UI fits all</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            No ICP-specific views. A developer, a content marketer, and a
            sales rep all see the same sidebar-driven workspace. No way to
            tailor the interface to different workflows or roles.
          </p>
        </Card>
        <Card accent="red">
          <h4>Pages aren&apos;t deployable</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            A Document page is just content inside PageSpace. It can&apos;t
            become a blog post on a live website. A drive can&apos;t become
            a deployed application. Content has no path to production.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        IDE is the foundation.{" "}
        <span className="hl">CMS and CRM emerge from it.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        The IDE/Coder interface isn&apos;t just one view among many &mdash; it&apos;s
        the <strong>foundational capability</strong> that enables everything
        else. Without code execution and a real filesystem, pages are just
        documents. With it, pages become deployable blog posts, drives become
        website repos, and the platform becomes a CMS. CRM follows from CMS.
      </p>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The build order matters: <strong>IDE first</strong>, because it unlocks
        CMS (pages + publishing + deployment), which unlocks CRM (contacts +
        workflows + automation). Each layer emerges from the one before it.
      </p>

      <ArchDiagram>
        <ArchRow label="Foundation" labelSub="build first" style={{ marginBottom: 8 }}>
          <ArchNode
            title="IDE"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.4)"
            style={{ border: "2px solid rgba(34,211,238,0.5)" }}
            detail="Code execution &middot; terminals &middot; git &middot; file system<br>Drive = repo container &middot; Branch = branch container<br>Agent-assisted coding &middot; deploy from PageSpace<br><strong style='color:var(--cyan)'>This is what makes everything else possible</strong>"
          />
        </ArchRow>

        <ArchConnector text="IDE enables &rarr; pages become publishable &rarr; drives become deployable sites" />

        <ArchRow label="Emerges" labelSub="from IDE" style={{ marginBottom: 8 }}>
          <ArchNode
            title="CMS"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Pages = blog posts, docs, landing pages<br>Drive = website repo with real build pipeline<br>Publishing workflows &middot; content scheduling<br>Media management &middot; SEO &middot; version history"
          />
        </ArchRow>

        <ArchConnector text="CMS enables &rarr; contact management &rarr; workflow automation" />

        <ArchRow label="Emerges" labelSub="from CMS">
          <ArchNode
            title="CRM"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            detail="Contacts &middot; pipelines &middot; deal tracking<br>Email sequences &middot; outreach automation<br>Agent-driven lead scoring &middot; follow-ups<br>Built on pages + workflows + agents"
          />
        </ArchRow>
      </ArchDiagram>

      <div className="sl">Why IDE First</div>
      <h2>
        Code execution is the{" "}
        <span className="hl">unlock for everything.</span>
      </h2>

      <FeatureRow>
        <Feature
          nameColor="var(--cyan)"
          name="Pages become deployable"
          description="A Document page is just content. But with a repo container and build pipeline, that document becomes a blog post that deploys to a live site. The IDE makes pages real."
        />
        <Feature
          nameColor="var(--green)"
          name="Drives become websites"
          description="A drive is just a folder. But with git, a build pipeline, and deployment &mdash; the drive IS the website repo. The page tree maps to the site structure. Same RBAC, same collaboration."
        />
        <Feature
          nameColor="var(--violet)"
          name="Agents can build"
          description="Without code execution, agents can only write text. With it, they can write code, run tests, deploy features, fix bugs. The IDE makes agents useful beyond chat."
        />
      </FeatureRow>

      <div className="sl">All Interfaces</div>
      <h2>
        Same backend, different views.{" "}
        <span className="hl">Generated on demand.</span>
      </h2>

      <ArchDiagram>
        <ArchRow label="Backend" labelSub="shared" style={{ marginBottom: 8 }}>
          <ArchNode
            title="PageSpace Core"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Universal agent file system &middot; Memory<br>Permission boundaries &middot; RBAC / per-page overrides<br>Teams/Users &middot; Containers &middot; PostgreSQL<br>Runtime &middot; Search &middot; Billing"
          />
        </ArchRow>

        <ArchConnector text="same backend, different views per ICP" />

        <ArchRow label="Interfaces" labelSub="per ICP">
          <ArchNode
            title="IDE / Coder"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.4)"
            style={{ border: "2px solid rgba(34,211,238,0.4)" }}
            detail="Terminals &middot; git &middot; file browser &middot; Monaco editor<br>Agent-in-container workflows<br>Build/test/deploy pipelines<br>THE FOUNDATION &mdash; build first"
          />
          <ArchNode
            title="CMS"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Pages = publishable content<br>Drive = website repo<br>Publishing workflows &middot; scheduling<br>Emerges from IDE capabilities"
          />
          <ArchNode
            title="CRM"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            detail="Contacts &middot; pipelines &middot; automation<br>Agent-driven outreach &middot; follow-ups<br>Lead scoring &middot; email sequences<br>Emerges from CMS capabilities"
          />
          <ArchNode
            title="[Custom]"
            titleColor="var(--dim)"
            borderColor="var(--border)"
            detail="Research &middot; Ops &middot; Analytics &middot; Support<br>Agent generates the UI on demand<br>From the initial PageSpace bootstrap<br>The system builds its own front-ends"
          />
        </ArchRow>
      </ArchDiagram>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="cyan">
          <h4>IDE</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Terminal multiplexing, git worktree management, swarm status,
            prompt templates. These become PageSpace web UI components.
            Same backend, optimized for coding.
          </p>
        </Card>
        <Card accent="green">
          <h4>CMS from PageSpace</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            PageSpace already has rich text editing (TipTap), code editing
            (Monaco), file uploads, version history. Adding a build/deploy
            pipeline turns this into a real CMS. Pages become blog posts.
            Drives become sites.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)" }}>
        <h4 style={{ color: "var(--blue)" }}>The bootstrap principle</h4>
        <p style={{ fontSize: 12 }}>
          The IDE interface is what lets PageSpace build its own future
          interfaces. Once you have code execution + agents + content
          management, the system can generate new views for new ICPs.
          The initial IDE is the bootstrap &mdash; the first interface
          that enables all others.
        </p>
      </Card>
    </div>
  );
}
