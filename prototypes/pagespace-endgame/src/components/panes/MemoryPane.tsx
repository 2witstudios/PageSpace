import type { CSSProperties } from "react";
import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";
import { FeatureRow, Feature } from "../ui/FeatureRow";

const cellTd: CSSProperties = {
  padding: "8px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  fontSize: 12,
  verticalAlign: "top",
};

export function MemoryPane() {
  return (
    <div className="pane-wide">
      {/* ── Current: The page tree IS memory ── */}
      <div className="sl">Current</div>
      <h2>
        The page tree is the{" "}
        <span className="hl">memory system.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        Pages are memory. Folders are scope. Index pages are routing. Agents
        write what they learn to pages, organize it into folders, and build
        wiki-like structures with summaries, backlinks, and cross-references
        &mdash; the Karpathy pattern of LLM-compiled knowledge bases. The
        page tree IS the directory structure, and agents already have every
        tool they need to read, write, search, and reorganize it.
      </p>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        On top of this, a memory discovery pipeline learns user preferences
        from conversation history and injects them into every agent turn.
        Conversations persist in PostgreSQL. A two-tier cache keeps hot data
        fast. Drive prompts set workspace-level AI behavior. This is a
        working memory system &mdash; what it needs is better retrieval and
        metadata, not a different storage model.
      </p>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Pages as memory storage</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Agents <code>create_page</code>, <code>update_page</code>,
            <code> move_page</code>, <code>rename_page</code>. An agent that
            learns something writes it to a page. An agent that needs to
            organize knowledge creates folders and index pages. The page tree
            is both the filesystem and the knowledge graph &mdash; just one
            that&apos;s navigated by structure, not by meaning. Yet.
          </p>
        </Card>
        <Card accent="green">
          <h4>Folders as memory scope</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            A Research folder scopes research knowledge. A Project folder
            scopes project context. AI_CHAT pages placed inside a folder see
            that subtree. Agents consult each other via <code>ask_agent</code>.
            The tree hierarchy IS the scoping mechanism &mdash; it just
            needs tagging and metadata to make it queryable beyond path matching.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Memory discovery + compaction</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            An LLM-powered pipeline scans the last 7 days of conversations
            and activity, discovering user insights across four dimensions:
            worldview, projects, communication style, and preferences.
            Discoveries merge into the <code>userPersonalization</code> profile
            (bio, writingStyle, rules). When a field exceeds 20KB, a compaction
            pass reorganizes it while preserving key insights.
          </p>
        </Card>
        <Card accent="green">
          <h4>Personalization injection</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Every AI turn assembles a system prompt that includes the
            user&apos;s personalization profile &mdash; expertise, writing
            style, explicit rules. Combined with drive prompts (workspace-level
            AI instructions), agents get persistent context about who
            they&apos;re working with and how to behave. This is working
            semantic memory &mdash; scoped to the user.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Backlinks + mentions</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            The <code>mentions</code> table tracks page-to-page references
            (sourcePageId &rarr; targetPageId). <code>userMentions</code>
            tracks @-mentions of people. This is a primitive relationship
            graph &mdash; pages already reference each other. What&apos;s
            missing is entity-level relationships and semantic connections.
          </p>
        </Card>
        <Card accent="green">
          <h4>File processing pipeline</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Uploaded files are processed automatically: OCR for images/scans,
            text extraction from PDFs and Word docs, content-addressed storage
            with SHA-256 dedup. Raw sources go in, structured text comes out
            &mdash; ready for agents to read, summarize, and write to pages.
          </p>
        </Card>
      </div>

      {/* ── Retrieval: how agents find knowledge ── */}
      <h3 style={{ marginBottom: 12, marginTop: 20 }}>How agents retrieve memory today</h3>
      <p style={{ marginBottom: 16, maxWidth: 720, fontSize: 13 }}>
        Two distinct context paths. <strong>Page AI agents</strong> (AI_CHAT pages)
        get scoped context: their location in the tree, page type, drive, task
        linkage, and a custom system prompt set by the user.{" "}
        <strong>The global assistant</strong> (dashboard/drive sidebar)
        gets workspace-level or cross-workspace context. Both share the same
        base prompt, personalization, awareness layers, and search tools.
      </p>
      <ArchDiagram>
        <ArchRow label="Shared" labelSub="all agents get this">
          <ArchNode
            title="Base prompt"
            detail="Role, capabilities, behavior guidelines, page type reference"
            borderColor="var(--blue)"
          />
          <ArchNode
            title="Personalization"
            detail="User bio, writing style, custom rules &middot; opt-in toggle"
            borderColor="var(--amber)"
          />
          <ArchNode
            title="Awareness (cached)"
            detail="Page tree (5min TTL) + visible agents (5min TTL) &middot; L1+L2 cache"
            borderColor="var(--cyan)"
          />
        </ArchRow>
        <ArchConnector text="then diverges by context" />
        <ArchRow label="Context" labelSub="page AI vs global assistant">
          <ArchNode
            title="Page AI (AI_CHAT)"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Scoped to page location, type, and drive<br>Custom system prompt set by user<br>Task linkage awareness<br>&ldquo;Here&rdquo; = this page and subtree"
          />
          <ArchNode
            title="Global Assistant"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            detail="Dashboard: cross-workspace, uses list_drives<br>Drive sidebar: scoped to current workspace<br>Task management focus<br>&ldquo;Here&rdquo; = this drive or all drives"
          />
        </ArchRow>
        <ArchConnector text="both use the same search tools" />
        <ArchRow label="Search" labelSub="permission-filtered">
          <ArchNode
            title="regex_search"
            detail="PostgreSQL ~ operator &middot; pages + conversations &middot; 50 results &middot; ReDoS-protected"
            titleColor="var(--green)"
            borderColor="var(--green)"
          />
          <ArchNode
            title="glob_search"
            detail="Path/title pattern matching &middot; 100 results &middot; 7 page types"
            titleColor="var(--green)"
            borderColor="var(--green)"
          />
          <ArchNode
            title="multi_drive_search"
            detail="Cross-workspace &middot; ILIKE or regex &middot; 20 results/drive"
            titleColor="var(--green)"
            borderColor="var(--green)"
          />
          <ArchNode
            title="read_page"
            detail="Fetch full page content on demand"
            titleColor="var(--green)"
            borderColor="var(--green)"
          />
        </ArchRow>
      </ArchDiagram>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Two-tier caching</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Hybrid in-memory (L1) + Redis (L2) caching across four domains:
            conversations (30min TTL, 300 entries, optimistic append),
            permissions (60s TTL, 1000 entries), page trees (5min TTL),
            and agent awareness (5min TTL). Graceful degradation when Redis
            is unavailable. Metrics tracking for hits, misses, evictions.
          </p>
        </Card>
        <Card accent="green">
          <h4>Conversations are searchable memory</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Full conversation history in PostgreSQL. <code>regex_search</code>
            covers AI_CHAT messages by default &mdash; past agent reasoning
            is part of the searchable knowledge base. ROW_NUMBER() windowing
            for line numbers. Agents can query across all conversation history
            in their drive.
          </p>
        </Card>
      </div>

      <Card style={{ marginBottom: 24, padding: "20px 24px" }}>
        <pre>
          <span className="t">Page Tree</span>
          {" (the memory system)\n"}
          {"|\n"}
          {"+-- FOLDER: Research/ (scope)\n"}
          {"|   +-- AI_CHAT: Research Agent (domain prompt)\n"}
          {"|   +-- DOCUMENT: Research Index (routing page)\n"}
          {"|   +-- DOCUMENT: Summary of Paper X (agent-compiled)\n"}
          {"|   +-- DOCUMENT: Key Concepts (backlinked)\n"}
          {"|   +-- FILE: paper-x.pdf (OCR processed)\n"}
          {"|\n"}
          {"+-- FOLDER: Engineering/ (scope)\n"}
          {"|   +-- AI_CHAT: Code Agent (engineering prompt)\n"}
          {"|   +-- DOCUMENT: Architecture Decisions (index)\n"}
          {"|   +-- DOCUMENT: Auth Middleware Notes (learned)\n"}
          {"|\n"}
          <span className="s">PostgreSQL</span>
          {" (structured memory)\n"}
          {"|\n"}
          {"+-- conversations + messages (agent reasoning history)\n"}
          {"+-- mentions (page-to-page relationships)\n"}
          {"+-- userPersonalization (bio, writingStyle, rules)\n"}
          {"+-- pageVersions (30-day retention)\n"}
          {"|\n"}
          <span className="k">Two-Tier Cache</span>
          {" (L1 in-memory + L2 Redis)\n"}
          {"|\n"}
          {"+-- Conversations (30min TTL · optimistic append)\n"}
          {"+-- Page tree (5min TTL · invalidate on structure change)\n"}
          {"+-- Agent awareness (5min TTL · per-drive)\n"}
          {"+-- Permissions (60s TTL · invalidate on change)\n"}
          {"|\n"}
          <span className="t">Memory Pipeline</span>
          {" (LLM-powered)\n"}
          {"|\n"}
          {"+-- Discovery (4 parallel passes · 7-day lookback)\n"}
          {"+-- Integration (evaluate + append to profile)\n"}
          {"+-- Compaction (summarize when > 20KB)"}
        </pre>
      </Card>

      <hr />

      {/* ── Competitive Context ── */}
      <div className="sl">Landscape</div>
      <h2>
        Agent memory is a{" "}
        <span className="hl">production discipline.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The industry has converged on three memory types &mdash; episodic
        (what happened), semantic (what is known), and procedural (how to do
        things). Graph memory moved from experimental to production in early
        2026. The gap between PageSpace and competitors isn&apos;t in storage
        (the page tree is a strong foundation) &mdash; it&apos;s in
        retrieval, metadata, and automatic context surfacing.
      </p>

      <Card style={{ overflow: "auto", marginBottom: 16, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "15%" }}>
                Platform
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "30%" }}>
                Memory + Retrieval
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "30%" }}>
                Key Approach
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "25%" }}>
                PageSpace Comparison
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--amber)" }}>OpenFang</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Embedded SQLite with vector embeddings. 4-layer memory: episodic, semantic, procedural, canonical. LLM-based session compaction. 12MB/agent</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Local-first. Single binary, zero network hops. Proves agent memory at ~1.2GB for 100 agents vs 8.4GB CrewAI</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Single-user, no RBAC, no multi-tenant. PageSpace has the team layer they don&apos;t</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--green)" }}>OpenClaw</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Markdown-as-truth memory. Milvus vector DB + BM25. GraphRAG knowledge graphs. Activation/decay for relevance</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Files are the source of truth &mdash; closest to PageSpace&apos;s page-tree approach. &ldquo;Dreaming&rdquo; for background consolidation</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Similar storage model (files = memory), but they added semantic retrieval and knowledge graphs on top</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--violet)" }}>Viktor</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>&ldquo;Skills&rdquo; system: structured files that accumulate IDs, tips, and learnings from observed conversations. One agent&apos;s discovery benefits all future agents</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Institutional memory without explicit save. Learns from Slack conversations. 3,000+ tool integrations</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>PageSpace agents could do this today with pages &mdash; missing the automatic accumulation pattern</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--cyan)" }}>Notion AI</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Turbopuffer vector search at massive scale. Span-level chunking with xxHash change detection. Cross-tool search (Drive, Slack, Jira)</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Offline batch (Spark) + real-time (Kafka). Sub-minute indexing latency. Self-hosted embedding models</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>PageSpace has richer page types and AI tools, but no vector infrastructure yet</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--blue)", borderBottom: "none" }}>Cursor</td>
              <td style={{ ...cellTd, color: "var(--mid)", borderBottom: "none" }}>AST-aware chunking (tree-sitter). Merkle tree change detection. Turbopuffer embeddings. Incremental re-indexing</td>
              <td style={{ ...cellTd, color: "var(--mid)", borderBottom: "none" }}>Code-semantic chunking: splits at function boundaries, not mid-line. Privacy-first: embeddings remote, code local</td>
              <td style={{ ...cellTd, color: "var(--mid)", borderBottom: "none" }}>Relevant for the IDE lens &mdash; AST-aware search is table stakes for code workspaces</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="cyan">
          <h4 style={{ color: "var(--cyan)" }}>Emerging patterns</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            <strong>Hybrid retrieval</strong> (vector + keyword) is becoming
            standard &mdash; vector for conceptual matches, BM25/ILIKE for
            exact tokens.<br />
            <strong>Knowledge graphs</strong> differentiate agent platforms
            (OpenFang, OpenClaw) from document platforms (Notion, Coda).<br />
            <strong>Automatic accumulation</strong> (Viktor&apos;s skills,
            OpenClaw&apos;s dreaming) means agents get smarter without
            explicit instructions to save.<br />
            <strong>Content-hash indexing</strong> (Notion xxHash, Cursor
            Merkle) avoids re-embedding unchanged content.
          </p>
        </Card>
        <Card accent="green">
          <h4 style={{ color: "var(--green)" }}>PageSpace advantage</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            PageSpace already has what most competitors bolt on: RBAC
            permission filtering, structural awareness (page tree), cross-agent
            conversation search, and a working memory storage model (pages).
            OpenClaw&apos;s file-first approach validates our direction. The
            gap is purely in retrieval intelligence &mdash; adding semantic
            search and metadata to an already permission-aware, structurally
            rich platform.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Storage works. Retrieval is{" "}
        <span className="hl">the gap.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Agents can write knowledge to pages, organize it into folders, and
        search across content and conversations using regex and ILIKE.
        But all search is pattern-based &mdash; there are no embeddings, no
        entity extraction, no tagging metadata. Agents have to know the
        right pattern to find what they need. The memory storage works.
        The search tools work. What&apos;s missing is meaning-based
        retrieval and structured metadata.
      </p>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--red)"
          name="No semantic search"
          description="All search is regex or ILIKE. No vector embeddings on any content. No pgvector. Searching for &lsquo;auth middleware&rsquo; won't find a page titled &lsquo;JWT session handler&rsquo;."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No tagging / metadata"
          description="Pages have titles and tree position but no structured tags, categories, or custom metadata. No way to query &lsquo;all pages tagged architecture-decision&rsquo; or filter by entity type."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No knowledge graph"
          description="The mentions table tracks page-to-page references, but there's no entity extraction, no typed relationships, no multi-hop traversal. Can't ask &lsquo;what depends on the billing module?&rsquo;"
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No auto-context"
          description="Agents see the page tree structure but the system doesn't pre-load relevant pages based on the current task. No retrieval scoring, no reranking, no proactive context assembly."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="amber">
          <h4>No relevance ranking</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Search results are unranked. No recency weighting, no similarity
            scoring, no frequency signals. regex_search and glob_search
            return flat lists. Finding the right page among 50+ results is
            entirely on the agent.
          </p>
        </Card>
        <Card accent="amber">
          <h4>No stemming / fuzzy matching</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Search is exact-pattern. &ldquo;authenticate&rdquo; won&apos;t
            match &ldquo;authentication&rdquo; unless the agent writes the
            regex for it. PostgreSQL tsvector/GIN and pg_trgm could add
            stemming and typo tolerance on existing infrastructure.
          </p>
        </Card>
        <Card accent="red">
          <h4>No container-local retrieval</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Every search hits PostgreSQL over the network. No container-local
            index for rapid-fire lookups. Too slow for agents inside execution
            loops making dozens of queries per second during autonomous work.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        Same storage. Intelligent{" "}
        <span className="hl">retrieval.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        The page tree stays the memory system. What changes is how agents
        find and surface knowledge within it. Three stages: enhance existing
        search with indexed FTS, stemming, and metadata; then add pgvector
        embeddings for meaning-based retrieval; then a knowledge graph for
        entity relationships and multi-hop reasoning. Each stage adds
        intelligence to the retrieval layer without changing the storage model.
      </p>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        <strong>PostgreSQL stays the authority</strong> &mdash; team-wide
        search, RBAC, cross-agent queries. <strong>Turso/SQLite syncs into
        Firecracker VMs</strong> so agents get local-speed retrieval during
        execution loops. Tagging and metadata make the page tree queryable by
        structure AND by meaning. The workspace gets smarter every time an
        agent writes a page.
      </p>

      <ArchDiagram>
        <ArchRow label="Stage 1" labelSub="enhance existing search" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Indexed FTS + stemming"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Add tsvector/GIN indexes to existing content search.<br>Word stemming, ts_rank scoring, partial matching.<br>Enhances regex_search &mdash; zero new infrastructure."
          />
          <ArchNode
            title="Fuzzy matching"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="pg_trgm for typo tolerance and similarity scoring.<br>&lsquo;authentcation&rsquo; finds &lsquo;authentication&rsquo;.<br>Complements exact regex with approximate matching."
          />
          <ArchNode
            title="Page tags + metadata"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Structured tags and custom metadata on pages.<br>Query by type, category, entity, status.<br>Makes the page tree filterable, not just navigable."
          />
        </ArchRow>

        <ArchConnector text="AWS migration enables dedicated compute for embeddings" />

        <ArchRow label="Stage 2" labelSub="embeddings + hybrid" style={{ marginBottom: 8 }}>
          <ArchNode
            title="pgvector embeddings"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Embeddings on page content, conversations, and metadata.<br>Incremental: content-hash change detection,<br>only re-embed what changed."
          />
          <ArchNode
            title="Hybrid retrieval"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Vector similarity + BM25/FTS keyword scoring.<br>Semantic recall for concepts,<br>lexical precision for exact terms and identifiers."
          />
          <ArchNode
            title="Auto context injection"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="System pre-loads relevant pages based on the task.<br>Agent starts with the right context in scope &mdash;<br>no manual searching required."
          />
        </ArchRow>

        <ArchConnector text="knowledge graph enables multi-hop reasoning across the page tree" />

        <ArchRow label="Stage 3" labelSub="knowledge graph">
          <ArchNode
            title="Entity extraction"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="LLM-based entity and relationship extraction on page save.<br>People, projects, concepts, dependencies &mdash;<br>structured knowledge from page content."
          />
          <ArchNode
            title="Graph queries"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Multi-hop: &lsquo;What pages reference billing?&rsquo;<br>traverses relationships, not just content.<br>Builds on existing mentions table."
          />
          <ArchNode
            title="Memory accumulation"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Viktor-style: agent discoveries automatically surface<br>for other agents. Activation/decay keeps relevance<br>fresh. The workspace gets smarter over time."
          />
        </ArchRow>
      </ArchDiagram>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--green)"
          name="Per-org isolation"
          description="Embeddings and graph live in per-org Postgres (RDS). Search boundaries match permission boundaries by architecture, not by filter. Multi-tenant from day one."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Turso-synced retrieval"
          description="Firecracker VMs get a local Turso/SQLite replica with synced vector index. Agents do semantic lookups at local speed during execution loops. Authority in Postgres, speed at the edge."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--violet)"
          name="Pages stay canonical"
          description="The page tree remains the memory system. Embeddings, tags, and graph are indexes on pages &mdash; not a parallel store. One source of truth. Multiple ways to find it."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <Card accent="blue">
        <h4 style={{ color: "var(--blue)" }}>The OS metaphor completes</h4>
        <p style={{ fontSize: 12 }}>
          The page tree is the filesystem. Agents are processes. They already
          have <code>grep</code> (regex_search), <code>find</code>
          (glob_search), <code>cat</code> (read_page), and cross-mount
          search (multi_drive_search). What&apos;s missing is{" "}
          <code>locate</code> (indexed search), semantic understanding
          (search by meaning, not pattern), and a knowledge graph (entity
          relationships across pages). Same filesystem. Same processes. Smarter
          retrieval. The workspace becomes a system that gets smarter every
          time an agent writes a page.
        </p>
      </Card>
    </div>
  );
}
