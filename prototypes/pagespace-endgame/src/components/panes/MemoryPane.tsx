import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function MemoryPane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        The page tree is already a{" "}
        <span className="hl">knowledge base.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        PageSpace agents can already build LLM knowledge bases &mdash; the
        pattern Karpathy describes of ingesting raw documents and having an
        LLM &ldquo;compile&rdquo; a wiki with summaries, backlinks, and
        cross-references. The page tree IS the directory structure. Agents
        have the tools to do this today.
      </p>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Conversations persist in PostgreSQL. Page tree and agent lists are
        cached in Redis. Drive prompts provide workspace-level context.
        Agent-to-agent delegation preserves conversation history.
      </p>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Pages as knowledge</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Agents can <code>create_page</code> (documents, folders),
            <code> update_page</code> (edit content), <code>move_page</code>
            (reorganize), <code>rename_page</code>. They can ingest raw sources,
            create summaries, organize into folders, and build wiki-like
            structures &mdash; all within the page tree.
          </p>
        </Card>
        <Card accent="green">
          <h4>Backlinks + mentions</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            The <code>mentions</code> table tracks page-to-page references
            (sourcePageId &rarr; targetPageId). <code>userMentions</code>
            tracks @-mentions of people. Cross-referencing between pages
            already works &mdash; the wiki linking layer exists.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Domain agents in-tree</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            AI_CHAT pages can be placed anywhere in the tree with domain-specific
            system prompts. A &ldquo;Research Agent&rdquo; in a research folder sees
            that subtree&apos;s context. Each agent has its own scope and expertise.
            Agents consult each other via <code>ask_agent</code>.
          </p>
        </Card>
        <Card accent="green">
          <h4>File processing pipeline</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Uploaded files are processed automatically: OCR for images/scans,
            text extraction from PDFs and Word docs, content-addressed storage
            with dedup. Raw sources go in, structured text comes out &mdash;
            ready for agents to read and summarize.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Conversations are searchable</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Full conversation history in PostgreSQL. The <code>regex_search</code>
            tool searches both documents AND conversations by default &mdash;
            agents can query across all AI_CHAT message history in their drive.
            This means past agent reasoning is already part of the searchable
            knowledge base.
          </p>
        </Card>
        <Card accent="green">
          <h4>Drive prompts</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Drive owners set custom AI instructions that inject into every
            agent&apos;s system prompt in that workspace. Project conventions,
            domain context, and behavioral rules &mdash; persistent workspace
            memory that all agents share.
          </p>
        </Card>
      </div>

      <Card style={{ marginBottom: 24, padding: "20px 24px" }}>
        <pre>
          <span className="t">Page Tree</span>
          {" (the knowledge base)\n"}
          {"|\n"}
          {"+-- FOLDER: Research/\n"}
          {"|   +-- AI_CHAT: Research Agent (domain-specific prompt)\n"}
          {"|   +-- DOCUMENT: Summary of Paper X (agent-compiled)\n"}
          {"|   +-- DOCUMENT: Key Concepts (backlinked)\n"}
          {"|   +-- FILE: paper-x.pdf (OCR processed)\n"}
          {"|\n"}
          <span className="s">PostgreSQL</span>
          {" (conversations + mentions + versions)\n"}
          {"|\n"}
          {"+-- conversations + messages (full agent history)\n"}
          {"+-- mentions (page-to-page backlinks)\n"}
          {"+-- pageVersions (30-day retention)\n"}
          {"|\n"}
          <span className="k">Redis</span>
          {" (caches)\n"}
          {"|\n"}
          {"+-- Page tree (5min TTL)\n"}
          {"+-- Agent list (5min TTL)\n"}
          {"+-- Permissions (invalidate on change)"}
        </pre>
      </Card>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Knowledge lives in pages, not in the agent.{" "}
        <span className="hl">No structured memory layer.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The page tree works as a knowledge base, but it&apos;s unstructured &mdash;
        agents have to search for what they need instead of having relevant
        context automatically surfaced. There&apos;s no scoped memory, no
        semantic search, no way for agents to accumulate learnings across
        conversations without manually writing them to pages.
      </p>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--red)"
          name="No scoped memory"
          description="Everything dies with the conversation. No task-level, plan-level, or global memory. Each interaction is isolated — agents can't build on previous work."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No semantic search"
          description={"Can't search memories by meaning. No vector embeddings on agent knowledge. Can't ask &quot;what did agents learn about auth?&quot; across all conversations."}
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No knowledge graphs"
          description="No entity relationships between memories. Can't trace how knowledge was acquired, which agent learned what, or how concepts relate to each other."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No cross-agent sharing"
          description="Agents can't share what they've learned. Each agent's knowledge is locked inside its own conversation. No institutional memory across the team."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="red">
          <h4>No Turso sync</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            No container-local database for rapid-fire agent queries. Every
            memory lookup hits PostgreSQL over the network. Too slow for
            agents inside execution loops making dozens of lookups per second.
          </p>
        </Card>
        <Card accent="red">
          <h4>No surviving memory</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Memory doesn&apos;t survive across tasks or plans. An agent that
            spent hours learning about a codebase loses everything when the
            conversation ends. The next agent starts from scratch.
          </p>
        </Card>
        <Card accent="red">
          <h4>Can&apos;t learn from history</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Agents can&apos;t learn from past conversations. No way to extract
            patterns, best practices, or common mistakes from historical
            interactions and feed them into future runs.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        PostgreSQL + Turso sync.{" "}
        <span className="hl">Authority meets speed.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        A single database can&apos;t serve both use cases well. PostgreSQL is
        great for teams &mdash; search, RBAC, cross-agent queries &mdash; but
        too slow for agents inside containers making rapid-fire queries.
        SQLite is fast locally but has no team search, no cross-agent queries,
        no RBAC on memories.
      </p>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The answer: <strong>PostgreSQL as source of truth, Turso/SQLite synced
        into containers.</strong> Agents get local-speed reads. Writes sync back
        asynchronously. Teams get full PostgreSQL-powered search and analytics
        across all agent memory.
      </p>

      <ArchDiagram>
        <ArchRow label="Source" labelSub="truth" style={{ marginBottom: 8 }}>
          <ArchNode
            title="PostgreSQL"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="30+ tables &middot; Drizzle ORM<br>All structured data: pages, conversations, permissions<br>Full-text search + vector extensions (pgvector)<br>The canonical store for all team-visible data"
          />
        </ArchRow>

        <ArchConnector text="Turso sync &middot; replicate to edge" />

        <ArchRow label="Edge" labelSub="speed" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Turso / SQLite (per container)"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Local database inside each Firecracker VM<br>Synced from PostgreSQL &middot; low-latency reads<br>Writes buffer locally, sync back async<br>Agent working memory + context cache"
          />
        </ArchRow>

        <ArchConnector text="scoped access &middot; 4 memory levels" />

        <ArchRow label="Scope" labelSub="access">
          <ArchNode
            title="Context"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Dies with conversation<br>Working state for current task<br>Scratch pad, intermediate results<br>Not persisted beyond session"
          />
          <ArchNode
            title="Task"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Shared across retries of same task<br>What went wrong last time<br>Accumulated learnings<br>Enables swarm retry intelligence"
          />
          <ArchNode
            title="Plan"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Shared across all tasks in a plan<br>Project-level knowledge<br>Architectural decisions, patterns found<br>Cross-task coordination"
          />
          <ArchNode
            title="Global"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Persists across everything<br>Institutional knowledge<br>Team learnings, best practices<br>The system gets smarter over time"
          />
        </ArchRow>
      </ArchDiagram>

      <div className="sl">Search Capabilities</div>
      <h2>
        Lexical + semantic +{" "}
        <span className="hl">knowledge graph.</span>
      </h2>

      <FeatureRow>
        <Feature
          nameColor="var(--green)"
          name="Lexical search"
          description='Exact-match queries: "Mutations that touched auth middleware". PostgreSQL full-text search with faceting by entity type. Fast, precise, team-scoped.'
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--blue)"
          name="Semantic search"
          description='Meaning-based: "Times agents struggled with async errors". Vector embeddings via pgvector. Hybrid ranking (lexical + semantic). Cross-agent queries.'
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--violet)"
          name="Knowledge graph"
          description="Entity relationships: Agent A learned X from task Y. Triple store (subject, predicate, object). Enables reasoning about what the system knows and how it learned it."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2">
        <Card accent="green">
          <h4>PostgreSQL + multi-tenant</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            All three search types backed by PostgreSQL with proper permissions
            and multi-tenant isolation. Team queries, RBAC on memories,
            cross-agent visibility &mdash; capabilities that single-user
            SQLite-only architectures cannot provide.
          </p>
        </Card>
        <Card accent="cyan">
          <h4>Better than pure PostgreSQL</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Pure PostgreSQL is too slow for agent working memory (rapid-fire
            KV lookups inside execution loops). Turso sync gives agents
            local-speed reads while keeping PostgreSQL as the team-wide
            source of truth.
          </p>
        </Card>
      </div>
    </div>
  );
}
