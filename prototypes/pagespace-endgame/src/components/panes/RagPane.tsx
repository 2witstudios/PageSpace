import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";
import { Svc } from "../ui/InfraHelpers";

export function RagPane() {
  return (
    <div className="pane">
      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 1: Current architecture                        */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">RAG &amp; Search</div>
      <h2>
        How agents find and use{" "}
        <span className="hl">knowledge today.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        PageSpace assembles a context window of ~3,000&ndash;6,000 tokens for
        every agent turn. Beyond that, agents must explicitly search and read.
        There are no embeddings, no vector search, and no automatic context
        discovery. RAG is manual &mdash; the agent has to know what to look for.
      </p>

      <h3 style={{ marginBottom: 12 }}>Context assembly pipeline</h3>
      <ArchDiagram>
        <ArchRow label="System prompt" labelSub="~3-6k tokens">
          <ArchNode
            title="Base prompt"
            detail="Role, capabilities, tool instructions"
            borderColor="var(--blue)"
          />
          <ArchNode
            title="Timestamp"
            detail="Current date/time for temporal grounding"
          />
          <ArchNode
            title="Drive prompt"
            detail="Custom instructions set by workspace admin"
            borderColor="var(--green)"
          />
        </ArchRow>
        <ArchConnector text="assembled at request time" />
        <ArchRow label="Awareness">
          <ArchNode
            title="Page tree"
            detail="Full drive hierarchy &middot; max 200 nodes &middot; Redis cached 5min"
            borderColor="var(--cyan)"
          />
          <ArchNode
            title="Agent awareness"
            detail="Visible AI_CHAT pages with definitions &middot; cached per-drive"
            borderColor="var(--violet)"
          />
          <ArchNode
            title="Inline instructions"
            detail="Page-specific context injected for current page"
            borderColor="var(--amber)"
          />
        </ArchRow>
        <ArchConnector text="agent must explicitly call tools below" />
        <ArchRow label="Tools">
          <ArchNode
            title="read_page"
            detail="Fetch full page content on demand &middot; permission-filtered"
            titleColor="var(--green)"
            borderColor="var(--green)"
          />
          <ArchNode
            title="regex_search"
            detail="ILIKE pattern matching across page content"
            titleColor="var(--blue)"
            borderColor="var(--blue)"
          />
          <ArchNode
            title="glob_search"
            detail="Structural search by page path patterns"
            titleColor="var(--blue)"
            borderColor="var(--blue)"
          />
          <ArchNode
            title="multi_drive_search"
            detail="Cross-workspace search across accessible drives"
            titleColor="var(--cyan)"
            borderColor="var(--cyan)"
          />
        </ArchRow>
        <ArchRow label="External" style={{ marginTop: 8 }}>
          <ArchNode
            title="Brave web search"
            detail="External info with domain and recency filtering"
            titleColor="var(--amber)"
            borderColor="var(--amber)"
          />
        </ArchRow>
      </ArchDiagram>

      <h3 style={{ marginBottom: 12 }}>Current search tools</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 28 }}>
        <Svc name="regex_search" detail="ILIKE pattern matching across titles and content" color="var(--blue)" />
        <Svc name="glob_search" detail="Structural: find pages by path pattern" color="var(--blue)" />
        <Svc name="multi_drive_search" detail="Cross-workspace: search multiple drives" color="var(--cyan)" />
        <Svc name="Brave search" detail="External web search with domain/recency filters" color="var(--amber)" />
      </div>

      <FeatureRow columns={3}>
        <Feature
          name="Permission-filtered"
          nameColor="var(--green)"
          description="Every search result and page read is filtered through RBAC. Agents only see what the user (or agent scope) allows."
        />
        <Feature
          name="Explicit access"
          nameColor="var(--blue)"
          description="Agents see the page tree structure but must call <code>read_page</code> to access content. No automatic content injection beyond the system prompt."
        />
        <Feature
          name="Cached hierarchy"
          nameColor="var(--cyan)"
          description="Page tree is Redis-cached for 5 minutes. Agent awareness list is cached per-drive. Reduces DB load on every agent turn."
        />
      </FeatureRow>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 2: Gaps                                        */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Gaps</div>
      <h2>
        Search is lexical.{" "}
        <span className="hl">Context is manual.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        Every search in PageSpace today is string matching &mdash; ILIKE
        patterns or regex. There are no embeddings, no semantic understanding,
        and no way for the system to proactively surface relevant context.
        Agents have to know what to search for before they can find it.
      </p>

      <FeatureRow columns={2}>
        <Feature
          icon="&#x1F50D;"
          name="No vector / semantic search"
          nameColor="var(--red)"
          description="All search is ILIKE or regex. No embeddings on page content. Searching for 'auth middleware' won't find a page titled 'JWT session handler' &mdash; there's no meaning-based matching."
        />
        <Feature
          icon="&#x1F9E0;"
          name="No automatic context discovery"
          nameColor="var(--red)"
          description="Agents only see what's explicitly in scope (page tree, drive prompt) or what they actively search for. The system doesn't pre-load relevant context based on the task."
        />
      </FeatureRow>
      <FeatureRow columns={2}>
        <Feature
          icon="&#x1F4AC;"
          name="No cross-agent knowledge sharing"
          nameColor="var(--red)"
          description="Agents can search past conversations via regex, but there's no structured cross-agent memory. Knowledge sharing requires manual search &mdash; nothing is automatically surfaced from what other agents learned."
        />
        <Feature
          icon="&#x1F4CA;"
          name="No relevance ranking"
          nameColor="var(--amber)"
          description="Search results are unranked beyond lexical matching. No recency weighting, no semantic similarity scoring, no frequency signals. The agent gets a flat list."
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 28 }}>
        <Card accent="red">
          <h4 style={{ color: "var(--red)" }}>RAG is manual</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            The agent has to know what to search for, construct the right
            pattern, and read each page individually. There is no system
            that surfaces relevant context automatically. Page tree shows
            structure but the agent still reads pages one at a time.
          </p>
        </Card>
        <Card accent="amber">
          <h4 style={{ color: "var(--amber)" }}>Structural but not semantic</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            The page tree provides excellent structural awareness &mdash;
            agents know what exists and where. But they can't search by
            meaning, only by pattern. The gap is semantic, not structural.
          </p>
        </Card>
      </div>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 3: End game                                    */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">End game</div>
      <h2>
        Semantic search.{" "}
        <span className="hl">Automatic context. Knowledge graph.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The target is a system where agents find relevant knowledge by meaning,
        context is pre-loaded based on the task, and knowledge flows across
        agents, conversations, and time. Hybrid search that combines lexical
        precision with semantic recall.
      </p>

      <FeatureRow columns={3}>
        <Feature
          icon="&#x1F9EC;"
          name="pgvector embeddings"
          nameColor="var(--cyan)"
          description="Embeddings on all page content, conversations, and agent memories. Stored in pgvector alongside existing Postgres data. Incremental updates on page save."
        />
        <Feature
          icon="&#x1F50D;"
          name="Semantic search"
          nameColor="var(--blue)"
          description="'Find everything related to auth middleware' returns relevant pages by meaning, not just string match. Similarity search across the entire workspace."
        />
        <Feature
          icon="&#x26A1;"
          name="Automatic context injection"
          nameColor="var(--green)"
          description="Runtime pre-loads relevant context based on the current task. Agent starts with the right pages already in scope &mdash; no manual searching required."
        />
      </FeatureRow>
      <FeatureRow columns={3}>
        <Feature
          icon="&#x1F4AC;"
          name="Cross-agent queries"
          nameColor="var(--violet)"
          description="Search across what other agents have learned. One agent's discoveries become available to the whole workspace. Knowledge persists beyond conversations."
        />
        <Feature
          icon="&#x1F4CA;"
          name="Hybrid ranking"
          nameColor="var(--amber)"
          description="Lexical + semantic + recency. Results ranked by a combination of exact match, meaning similarity, and freshness. Tunable per-query."
        />
        <Feature
          icon="&#x1F578;"
          name="Knowledge graph"
          nameColor="var(--red)"
          description="Entity relationships enabling multi-hop reasoning. 'What pages reference the billing module?' traverses connections, not just content."
        />
      </FeatureRow>

      <Card accent="cyan" style={{ marginBottom: 12 }}>
        <h4 style={{ color: "var(--cyan)" }}>Turso-synced vector index</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Execution containers get a local Turso/SQLite replica with a synced
          vector index for local-speed similarity search. Agents inside VMs
          can do semantic lookups without round-tripping to the central
          Postgres &mdash; same data, local latency.
        </p>
      </Card>

      <Card style={{ borderColor: "var(--border2)" }}>
        <h4 style={{ color: "var(--blue)" }}>From manual RAG to automatic knowledge</h4>
        <p style={{ fontSize: 12 }}>
          Today: agent searches by pattern, reads pages one by one, forgets
          everything when the conversation ends. Target: the system
          understands what's relevant, pre-loads it, ranks it, and makes
          every agent's learning available to every other agent. The workspace
          itself becomes intelligent.
        </p>
      </Card>
    </div>
  );
}
