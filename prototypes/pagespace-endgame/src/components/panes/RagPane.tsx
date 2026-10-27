import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";
import { Svc } from "../ui/InfraHelpers";
import type { CSSProperties } from "react";

const cellTd: CSSProperties = {
  padding: "8px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  fontSize: 12,
  verticalAlign: "top",
};

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
        PageSpace assembles a multi-section system prompt for every agent
        turn &mdash; base instructions, page tree, agent awareness, drive
        prompt, user personalization, and inline instructions. Beyond that,
        agents must explicitly call search tools. All search is lexical
        &mdash; ILIKE, regex, or glob patterns. There are no embeddings, no
        vector search, and no full-text indexes. RAG is manual: the agent
        has to know what to look for.
      </p>

      <h3 style={{ marginBottom: 12 }}>Context assembly pipeline</h3>
      <ArchDiagram>
        <ArchRow label="System prompt" labelSub="assembled at request time">
          <ArchNode
            title="Base prompt"
            detail="Role, capabilities, tool instructions, behavior guidelines"
            borderColor="var(--blue)"
          />
          <ArchNode
            title="Timestamp"
            detail="Current date/time for temporal grounding"
          />
          <ArchNode
            title="Personalization"
            detail="User bio, writing style, custom rules &middot; opt-in toggle"
            borderColor="var(--amber)"
          />
        </ArchRow>
        <ArchConnector text="+ awareness layers" />
        <ArchRow label="Awareness" labelSub="cached per-drive &middot; 5min TTL">
          <ArchNode
            title="Page tree"
            detail="Full drive hierarchy &middot; max 200 nodes &middot; two-tier cache (L1 memory + L2 Redis)"
            borderColor="var(--cyan)"
          />
          <ArchNode
            title="Agent awareness"
            detail="Visible AI_CHAT agents with definitions &middot; cached per-drive &middot; L1+L2"
            borderColor="var(--violet)"
          />
          <ArchNode
            title="Drive prompt"
            detail="Workspace-level custom AI instructions &middot; opt-in per agent"
            borderColor="var(--green)"
          />
          <ArchNode
            title="Inline instructions"
            detail="Page-specific context: title, type, location, task rules"
            borderColor="var(--amber)"
          />
        </ArchRow>
        <ArchConnector text="agent must explicitly call tools below" />
        <ArchRow label="Internal tools" labelSub="permission-filtered">
          <ArchNode
            title="read_page"
            detail="Fetch full page content on demand"
            titleColor="var(--green)"
            borderColor="var(--green)"
          />
          <ArchNode
            title="regex_search"
            detail="PostgreSQL ~ operator &middot; searches pages + conversations &middot; 3s timeout"
            titleColor="var(--blue)"
            borderColor="var(--blue)"
          />
          <ArchNode
            title="glob_search"
            detail="Path/title pattern matching &middot; max 200 results"
            titleColor="var(--blue)"
            borderColor="var(--blue)"
          />
          <ArchNode
            title="multi_drive_search"
            detail="Cross-workspace &middot; ILIKE or regex &middot; 20 results/drive"
            titleColor="var(--cyan)"
            borderColor="var(--cyan)"
          />
        </ArchRow>
        <ArchRow label="External" style={{ marginTop: 8 }}>
          <ArchNode
            title="web_search"
            detail="Brave Search API &middot; domain + recency filtering &middot; 10-20 results"
            titleColor="var(--amber)"
            borderColor="var(--amber)"
          />
          <ArchNode
            title="MCP tools"
            detail="Model Context Protocol &middot; desktop-only &middot; per-chat server toggles"
            titleColor="var(--violet)"
            borderColor="var(--violet)"
          />
        </ArchRow>
      </ArchDiagram>

      <h3 style={{ marginBottom: 12 }}>Search tool details</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <Svc name="regex_search" detail="PostgreSQL ~ operator &middot; pages + AI_CHAT messages &middot; max 100 results &middot; 5 line previews &middot; 500-char pattern limit &middot; 3s statement timeout (ReDoS protection)" color="var(--blue)" />
        <Svc name="glob_search" detail="Glob-to-regex conversion &middot; matches path and title &middot; max 200 results &middot; 7 page types searchable" color="var(--blue)" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 28 }}>
        <Svc name="multi_drive_search" detail="Cross-workspace &middot; ILIKE (text) or regex modes &middot; 20 results per drive &middot; Set-based O(1) permission lookups" color="var(--cyan)" />
        <Svc name="web_search" detail="Brave Search API &middot; recency filters (day/week/month/year) &middot; site: domain scoping &middot; title, URL, description, snippets" color="var(--amber)" />
      </div>

      <FeatureRow columns={4}>
        <Feature
          name="Permission-filtered"
          nameColor="var(--green)"
          description="Every search result and page read goes through RBAC. Agents only see what the user or agent scope allows. <code>excludeFromSearch</code> flag on pages."
        />
        <Feature
          name="ReDoS-protected"
          nameColor="var(--blue)"
          description="3-second PostgreSQL statement timeout on all regex queries. 500-character pattern limit. Line extraction only on literal patterns &mdash; no user-controlled regex execution."
        />
        <Feature
          name="Two-tier cache"
          nameColor="var(--cyan)"
          description="Page tree and agent awareness use L1 in-memory (500 entries) + L2 Redis cache. 5-minute TTL. Cache invalidation on create/delete/move/reorder."
        />
        <Feature
          name="Conversation search"
          nameColor="var(--violet)"
          description="regex_search covers AI_CHAT messages &mdash; not just pages. ROW_NUMBER() windowing for line numbers. Cross-agent knowledge is searchable, but only by pattern."
        />
      </FeatureRow>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 2: Competitive context                         */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Competitive Context</div>
      <h2>
        Where the market is{" "}
        <span className="hl">already moving.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Every serious knowledge platform now treats semantic search and
        structured memory as table stakes. The gap between PageSpace&apos;s
        lexical search and what competitors ship is widening.
      </p>

      <Card style={{ overflow: "auto", marginBottom: 16, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "18%" }}>
                Platform
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "28%" }}>
                Search / RAG
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "28%" }}>
                Memory / Knowledge
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "26%" }}>
                Key Differentiator
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--cyan)" }}>Notion AI</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Vector search at massive scale (Turbopuffer). Span-level chunking with xxHash change detection. Cross-tool search (Drive, Slack, Jira)</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Offline batch (Spark) + real-time (Kafka). Sub-minute indexing latency. Self-hosted embedding models</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Scale: billions of spans, 10x capacity at 90% less cost over 2 years</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--green)" }}>OpenClaw</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Hybrid vector + BM25 keyword search. sqlite-vec for cosine similarity, FTS5 for exact tokens</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Markdown-as-truth memory. GraphRAG knowledge graphs. Activation/decay system for relevance</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Hybrid retrieval: vector for concepts, BM25 for exact matches like error codes</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--amber)" }}>OpenFang</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Vector embeddings in SQLite. Semantic similarity search. Single-binary, no external vector DB</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>4-layer memory: episodic, semantic, procedural, canonical. LLM-based session compaction</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Self-contained: embedding + knowledge graph in one 32MB binary</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--violet)" }}>Coda Brain</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Permission-aware RAG. Snowflake Cortex vectorization + NL-to-SQL for structured data queries</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>500+ data connectors. Returns live, filterable tables alongside text answers</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Structured + unstructured in one RAG: query Salesforce in natural language</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--blue)", borderBottom: "none" }}>Cursor</td>
              <td style={{ ...cellTd, color: "var(--mid)", borderBottom: "none" }}>AST-aware chunking (tree-sitter). Merkle tree change detection. Embeddings on Turbopuffer</td>
              <td style={{ ...cellTd, color: "var(--mid)", borderBottom: "none" }}>Privacy-first: embeddings remote, code local. Incremental re-indexing on file changes only</td>
              <td style={{ ...cellTd, color: "var(--mid)", borderBottom: "none" }}>Code-semantic chunking: splits between functions, not mid-line</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <div className="g2" style={{ marginBottom: 28 }}>
        <Card accent="cyan">
          <h4 style={{ color: "var(--cyan)" }}>Emerging patterns</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            <strong>Hybrid retrieval</strong> (vector + keyword) is becoming
            best practice &mdash; vector for conceptual matches, BM25/ILIKE for
            exact tokens.<br />
            <strong>Knowledge graphs</strong> are a differentiator among agent
            platforms (OpenFang, OpenClaw), not yet offered by Notion or Coda.<br />
            <strong>Permission-aware RAG</strong> is table stakes for
            enterprise (Notion, Coda both emphasize deeply).<br />
            <strong>Incremental indexing</strong> via content hashing (Notion
            xxHash, Cursor Merkle tree) avoids re-embedding unchanged content.
          </p>
        </Card>
        <Card accent="green">
          <h4 style={{ color: "var(--green)" }}>PageSpace advantage</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            PageSpace already has what most competitors bolt on: RBAC
            permission filtering, page tree structural awareness, conversation
            search across agents, and MCP integration. The gap is purely
            semantic &mdash; adding embeddings and hybrid search to an already
            permission-aware, structurally-rich platform is a stronger
            foundation than competitors building permissions on top of vector
            stores.
          </p>
        </Card>
      </div>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 3: Gaps                                        */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Gaps</div>
      <h2>
        Search is lexical.{" "}
        <span className="hl">Context is manual.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        Every search in PageSpace today is string matching &mdash; PostgreSQL
        regex, ILIKE patterns, or glob conversion. There are no embeddings,
        no full-text search indexes (no GIN, no tsvector), no semantic
        understanding, and no way for the system to proactively surface
        relevant context. Agents have to know what to search for before they
        can find it.
      </p>

      <FeatureRow columns={2}>
        <Feature
          icon="&#x1F50D;"
          name="No vector / semantic search"
          nameColor="var(--red)"
          description="All search is regex or ILIKE. No embeddings on page content. No pgvector. Searching for &lsquo;auth middleware&rsquo; won&rsquo;t find a page titled &lsquo;JWT session handler&rsquo;. No meaning-based matching exists anywhere in the stack."
        />
        <Feature
          icon="&#x1F9E0;"
          name="No automatic context discovery"
          nameColor="var(--red)"
          description="Agents see the page tree structure and their configured awareness. But the system doesn&rsquo;t pre-load relevant content based on the task. No chunking, no retrieval scoring, no reranking pipeline."
        />
      </FeatureRow>
      <FeatureRow columns={2}>
        <Feature
          icon="&#x1F4AC;"
          name="No structured cross-agent memory"
          nameColor="var(--red)"
          description="Agents CAN search past conversations via regex_search (which covers AI_CHAT messages). But there&rsquo;s no structured memory layer &mdash; no entity extraction, no knowledge graph, no activation/decay. Pattern matching is the only discovery path."
        />
        <Feature
          icon="&#x1F4CA;"
          name="No relevance ranking"
          nameColor="var(--amber)"
          description="Search results are unranked beyond lexical matching. No recency weighting, no similarity scoring, no frequency signals, no boost configuration. The API route does basic exact-title-first ordering, but tools return flat lists."
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 28 }}>
        <Card accent="red">
          <h4 style={{ color: "var(--red)" }}>No full-text search infrastructure</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            PostgreSQL has powerful built-in full-text search (tsvector,
            tsquery, GIN indexes, trigram matching) that PageSpace doesn&apos;t
            use. Before jumping to vector search, adding PostgreSQL FTS would
            dramatically improve keyword search quality with minimal
            infrastructure cost &mdash; word stemming, ranking, partial
            matches, all within existing Postgres.
          </p>
        </Card>
        <Card accent="amber">
          <h4 style={{ color: "var(--amber)" }}>Structural but not semantic</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            The page tree provides excellent structural awareness &mdash;
            agents know what exists and where. Permission filtering is
            production-grade. The gap is purely semantic: meaning-based
            retrieval and automatic context assembly. The foundation is strong;
            the intelligence layer is missing.
          </p>
        </Card>
      </div>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 4: End game                                    */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">End Game</div>
      <h2>
        Hybrid search.{" "}
        <span className="hl">Automatic context. Knowledge graph.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The target is a three-stage evolution: first, PostgreSQL full-text
        search on existing infrastructure. Then pgvector embeddings with
        hybrid retrieval. Finally, a knowledge graph for multi-hop reasoning.
        Each stage builds on the permission-aware, structurally-rich
        foundation that already exists. The roadmap aligns with the AWS
        migration and per-org isolation &mdash; semantic search is scoped to
        org boundaries from day one.
      </p>

      <ArchDiagram>
        <ArchRow label="Stage 1" labelSub="PostgreSQL FTS">
          <ArchNode
            title="tsvector + GIN indexes"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Add full-text search indexes on page content and titles.<br>Word stemming, partial matching, ts_rank scoring.<br>Zero new infrastructure &mdash; uses existing Postgres."
          />
          <ArchNode
            title="Trigram indexes"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="pg_trgm for fuzzy matching and similarity scoring.<br>&lsquo;authentcation&rsquo; finds &lsquo;authentication&rsquo;.<br>Typo tolerance without embeddings."
          />
        </ArchRow>

        <ArchConnector text="requires AWS migration for dedicated compute" />

        <ArchRow label="Stage 2" labelSub="embeddings + hybrid">
          <ArchNode
            title="pgvector embeddings"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.3)"
            detail="Embeddings on all page content and conversations.<br>Incremental updates: content-hash change detection<br>(like Notion&apos;s xxHash), only re-embed what changed."
          />
          <ArchNode
            title="Hybrid retrieval"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            detail="Vector similarity + BM25/FTS keyword scoring.<br>Best of both: semantic recall for concepts,<br>lexical precision for exact terms and identifiers."
          />
          <ArchNode
            title="Auto context injection"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Runtime pre-loads relevant pages based on the task.<br>Agent starts with the right context already in scope<br>&mdash; no manual searching required."
          />
        </ArchRow>

        <ArchConnector text="knowledge graph enables multi-hop reasoning" />

        <ArchRow label="Stage 3" labelSub="knowledge graph">
          <ArchNode
            title="Entity extraction"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="LLM-based entity and relationship extraction on page save.<br>People, projects, concepts, dependencies &mdash;<br>structured knowledge from unstructured content."
          />
          <ArchNode
            title="Graph queries"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="Multi-hop reasoning: &lsquo;What pages reference the billing<br>module?&rsquo; traverses relationships, not just content.<br>Enables cross-agent knowledge discovery."
          />
          <ArchNode
            title="Cross-agent memory"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="Agent discoveries become graph entities.<br>One agent&apos;s learnings surface for others.<br>Activation/decay keeps relevance fresh."
          />
        </ArchRow>
      </ArchDiagram>

      <FeatureRow columns={3}>
        <Feature
          icon="&#x1F50D;"
          name="Semantic search"
          nameColor="var(--cyan)"
          description="&lsquo;Find everything related to auth middleware&rsquo; returns relevant pages by meaning, not just string match. Similarity search scoped to the org&apos;s permission boundaries."
        />
        <Feature
          icon="&#x1F4CA;"
          name="Hybrid ranking"
          nameColor="var(--blue)"
          description="Lexical + semantic + recency + structural proximity. Results ranked by a tunable combination of exact match, meaning similarity, freshness, and page tree distance."
        />
        <Feature
          icon="&#x26A1;"
          name="Per-org isolation"
          nameColor="var(--green)"
          description="Embeddings live in per-org Postgres (RDS) alongside existing data. No shared vector store across tenants. Search boundaries match permission boundaries &mdash; by architecture, not by filter."
        />
      </FeatureRow>

      <Card accent="cyan" style={{ marginBottom: 12 }}>
        <h4 style={{ color: "var(--cyan)" }}>Turso-synced vector index in execution containers</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Execution containers (Firecracker VMs from the runtime layer) get a
          local Turso/SQLite replica with a synced vector index. Agents inside
          VMs can do semantic lookups at local speed without round-tripping to
          org Postgres. Same data, same permissions, local latency. This
          aligns with the per-org architecture: each org&apos;s VMs sync from
          that org&apos;s dedicated RDS instance.
        </p>
      </Card>

      <Card style={{ borderColor: "var(--border2)" }}>
        <h4 style={{ color: "var(--blue)" }}>From manual RAG to automatic knowledge</h4>
        <p style={{ fontSize: 12 }}>
          Today: agent searches by pattern, reads pages one by one, forgets
          everything when the conversation ends. Stage 1: better keyword
          search with zero new infrastructure. Stage 2: the system
          understands what&apos;s relevant and pre-loads it. Stage 3: a
          knowledge graph makes every agent&apos;s learning available to every
          other agent. The workspace itself becomes intelligent &mdash; and
          it&apos;s built on the permission-aware, structurally-rich
          foundation that already exists.
        </p>
      </Card>
    </div>
  );
}
