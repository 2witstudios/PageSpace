import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import { EntityCard, EntityField } from "../ui/EntityCard";
import {
  RelationGraph,
  RelSection,
  RelRow,
  RelEntity,
  RelArrow,
  RelLabel,
  RelNote,
} from "../ui/RelationGraph";
import { DataTable, TraceRow } from "../ui/DataTable";

export function DataModelPane() {
  return (
    <div className="pane">
      <div className="sl">Data Model</div>
      <h2>
        Everything is an entity. Every change is{" "}
        <span className="hl">tracked.</span>{" "}
        <StatusBadge variant="planned" />
      </h2>
      <p style={{ marginBottom: 10, maxWidth: 720 }}>
        Code files, plans, conversations, commits, reviews, scores — they're all
        entities in a structured data model. The entity definitions below are
        implementation-agnostic — they could be Drizzle tables in PageSpace's
        existing PostgreSQL, an ECS via{" "}
        <a href="https://github.com/adobe/data">@adobe/data</a>, SQLite via
        Turso in containers, or a hybrid. The state layer is an{" "}
        <strong>open question</strong> (see Decisions tab).
      </p>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        The target architecture captures all changes as revisions. The entity
        definitions below describe the logical model — the relationships and
        traceability that must exist regardless of which storage layer
        implements them.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        <EntityCard name="Plan" badge="source of truth">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="scope" type="String" />
          <EntityField name="description" type="String" />
          <EntityField name="status" type="PlanStatus" typeKind="enum" />
          <EntityField name="rubric" type="&rarr; Rubric" fieldKind="rel" />
          <EntityField name="tasks" type="&rarr; [Task]" fieldKind="rel" />
          <EntityField name="prs" type="&rarr; [PR]" fieldKind="rel" />
        </EntityCard>

        <EntityCard name="Task" badge="scoped work unit">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="status" type="TaskStatus" typeKind="enum" />
          <EntityField name="plan" type="&rarr; Plan" fieldKind="rel" />
          <EntityField name="contexts" type="&rarr; [AgentCtx]" fieldKind="rel" />
          <EntityField name="mutations" type="&rarr; [Mutation]" fieldKind="rel" />
          <EntityField name="commits" type="&rarr; [Commit]" fieldKind="rel" />
          <EntityField name="ratings" type="&rarr; [Rating]" fieldKind="rel" />
        </EntityCard>

        <EntityCard name="AgentContext" badge="= chat history">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="type" type="ContextType" typeKind="enum" />
          <EntityField name="messages" type="&rarr; [Message]" fieldKind="rel" />
          <EntityField name="sandbox_id" type="String" />
          <EntityField name="status" type="AgentStatus" typeKind="enum" />
          <EntityField name="parent" type="&rarr; AgentCtx?" fieldKind="rel" />
          <EntityField name="task" type="&rarr; Task" fieldKind="rel" />
          <EntityField name="mutations" type="&rarr; [Mutation]" fieldKind="rel" />
          <EntityField name="memory" type="&rarr; [Memory]" fieldKind="rel" />
        </EntityCard>

        <EntityCard name="ChatMessage" badge="conversation log">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="context" type="&rarr; AgentCtx" fieldKind="rel" />
          <EntityField name="role" type="Role" typeKind="enum" />
          <EntityField name="content" type="String" />
          <EntityField name="tool_calls" type="[ToolCall]?" />
          <EntityField name="turn_log" type="&rarr; TurnLog" fieldKind="rel" />
          <EntityField name="mutations" type="&rarr; [Mutation]?" fieldKind="rel" />
          <EntityField name="timestamp" type="DateTime" />
        </EntityCard>

        <EntityCard name="TurnLog" badge="exact LLM context">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="message" type="&rarr; Message" fieldKind="rel" />
          <EntityField name="system_prompt" type="String" />
          <EntityField name="messages_sent" type="[Message]" />
          <EntityField name="model" type="String" />
          <EntityField name="provider" type="String" />
          <EntityField name="temperature" type="f32" />
          <EntityField name="token_count" type="TokenUsage" />
          <EntityField name="latency_ms" type="u64" />
          <EntityField name="response_raw" type="String" />
          <EntityField name="timestamp" type="DateTime" />
        </EntityCard>

        <EntityCard name="AgentMemory" badge="persistent knowledge">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="context" type="&rarr; AgentCtx" fieldKind="rel" />
          <EntityField name="scope" type="MemoryScope" typeKind="enum" />
          <EntityField name="key" type="String" />
          <EntityField name="value" type="String" />
          <EntityField name="source_turn" type="&rarr; TurnLog?" fieldKind="rel" />
          <EntityField name="created_at" type="DateTime" />
          <EntityField name="expires_at" type="DateTime?" />
        </EntityCard>

        <EntityCard name="Mutation" badge="append-only">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="file" type="&rarr; File" fieldKind="rel" />
          <EntityField name="diff" type="String" />
          <EntityField name="authored_by" type="&rarr; AgentCtx" fieldKind="rel" />
          <EntityField name="plan_node" type="&rarr; Plan" fieldKind="rel" />
          <EntityField name="commit" type="&rarr; Commit?" fieldKind="rel" />
          <EntityField name="rating" type="&rarr; Rating?" fieldKind="rel" />
          <EntityField name="timestamp" type="DateTime" />
        </EntityCard>

        <EntityCard name="GitCommit" badge="captured event">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="sha" type="String" />
          <EntityField name="message" type="String" />
          <EntityField name="mutations" type="&rarr; [Mutation]" fieldKind="rel" />
          <EntityField name="authored_by" type="&rarr; AgentCtx" fieldKind="rel" />
          <EntityField name="task" type="&rarr; Task" fieldKind="rel" />
          <EntityField name="pr" type="&rarr; PR?" fieldKind="rel" />
        </EntityCard>

        <EntityCard name="PR" badge="scoped changeset">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="status" type="PRStatus" typeKind="enum" />
          <EntityField name="plan_node" type="&rarr; Plan" fieldKind="rel" />
          <EntityField name="commits" type="&rarr; [Commit]" fieldKind="rel" />
          <EntityField name="review" type="&rarr; AgentCtx" fieldKind="rel" />
          <EntityField name="rating" type="&rarr; Rating" fieldKind="rel" />
          <EntityField name="base" type="&rarr; Snapshot" fieldKind="rel" />
        </EntityCard>

        <EntityCard name="Rating" badge="scored output">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="target" type="&rarr; Mut|PR" fieldKind="rel" />
          <EntityField name="rubric" type="&rarr; Rubric" fieldKind="rel" />
          <EntityField name="produced_by" type="&rarr; AgentCtx" fieldKind="rel" />
          <EntityField name="scores" type="Map&lt;Dim,f32&gt;" />
          <EntityField name="verdict" type="Verdict" typeKind="enum" />
        </EntityCard>

        <EntityCard name="Rubric" badge="scoring criteria">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="plan" type="&rarr; Plan" fieldKind="rel" />
          <EntityField name="dimensions" type="[Dimension]" />
          <EntityField name="threshold" type="f32" />
        </EntityCard>

        <EntityCard name="Snapshot" badge="point-in-time">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="name" type="String" />
          <EntityField name="entities" type="&rarr; [State]" fieldKind="rel" />
          <EntityField name="plan" type="&rarr; Plan" fieldKind="rel" />
        </EntityCard>

        <EntityCard name="File" badge="code artifact">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="path" type="String" />
          <EntityField name="language" type="String" />
          <EntityField name="mutations" type="&rarr; [Mutation]" fieldKind="rel" />
        </EntityCard>

        <EntityCard name="Trigger" badge="event &rarr; actions">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="source" type="TriggerSource" typeKind="enum" />
          <EntityField name="condition" type="Expression" />
          <EntityField name="actions" type="[Action]" />
          <EntityField name="enabled" type="bool" />
          <EntityField name="priority" type="u32" />
        </EntityCard>

        <EntityCard name="Skill" badge="reusable capability">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="name" type="String" />
          <EntityField name="system_prompt" type="String" />
          <EntityField name="tools" type="[ToolDef]" />
          <EntityField name="context_reqs" type="[ContextReq]" />
          <EntityField name="output_schema" type="Schema?" />
          <EntityField name="model_pref" type="String?" />
        </EntityCard>

        <EntityCard name="ParallelRun" badge="ensemble analysis">
          <EntityField name="id" type="EntityID" fieldKind="pk" />
          <EntityField name="mode" type="ParallelMode" typeKind="enum" />
          <EntityField name="contexts" type="&rarr; [AgentCtx]" fieldKind="rel" />
          <EntityField name="input" type="&rarr; Mut|PR|Plan" fieldKind="rel" />
          <EntityField name="skills" type="&rarr; [Skill]" fieldKind="rel" />
          <EntityField name="synthesis" type="&rarr; AgentCtx" fieldKind="rel" />
          <EntityField name="consensus" type="ConsensusMap" />
        </EntityCard>
      </div>

      <hr />
      <div className="sl">Traceability</div>
      <h3>
        Every artifact links back to{" "}
        <span style={{ color: "var(--blue)" }}>why it exists.</span>
      </h3>
      <p style={{ marginBottom: 10, maxWidth: 720 }}>
        In a typical codebase, code exists but the reasoning behind it doesn't.
        The plan that motivated it, the discussion that shaped it, the review
        that approved it — scattered across Slack, Jira, and people's heads.
      </p>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        In Pagespace CLI,{" "}
        <strong>
          every entity is linked to every other entity it touches.
        </strong>{" "}
        The entire chain from intent to code to review is one query.
      </p>

      <RelationGraph>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--dim)",
            marginBottom: 20,
            textAlign: "center",
          }}
        >
          every link is bidirectional and queryable
        </div>

        <RelSection title="Plan &rarr; Work">
          <RelRow>
            <RelEntity type="plan">Plan</RelEntity>
            <RelArrow />
            <RelLabel>decomposes into</RelLabel>
            <RelArrow />
            <RelEntity type="task">Task</RelEntity>
            <RelArrow />
            <RelLabel>spawns</RelLabel>
            <RelArrow />
            <RelEntity type="ctx">AgentContext</RelEntity>
            <RelNote color="var(--blue)">=</RelNote>
            <RelEntity type="ctx">Chat History</RelEntity>
          </RelRow>
          <RelRow>
            <RelEntity type="plan">Plan</RelEntity>
            <RelArrow />
            <RelLabel>defines</RelLabel>
            <RelArrow />
            <RelEntity type="rate">Rubric</RelEntity>
            <RelArrow />
            <RelLabel>inherited by</RelLabel>
            <RelArrow />
            <RelEntity type="task">Task</RelEntity>
          </RelRow>
        </RelSection>

        <RelSection title="Work &rarr; Code">
          <RelRow>
            <RelEntity type="ctx">AgentContext</RelEntity>
            <RelArrow />
            <RelLabel>produces</RelLabel>
            <RelArrow />
            <RelEntity type="mut">Mutation</RelEntity>
            <RelArrow />
            <RelLabel>captured as</RelLabel>
            <RelArrow />
            <RelEntity type="commit">GitCommit</RelEntity>
          </RelRow>
          <RelRow>
            <RelEntity type="mut">Mutation</RelEntity>
            <RelArrow />
            <RelLabel>links to</RelLabel>
            <RelArrow />
            <RelEntity type="plan">PlanNode</RelEntity>
            <RelNote color="var(--amber)">
              "why this code exists"
            </RelNote>
          </RelRow>
          <RelRow>
            <RelEntity type="mut">Mutation</RelEntity>
            <RelArrow />
            <RelLabel>authored by</RelLabel>
            <RelArrow />
            <RelEntity type="ctx">AgentContext</RelEntity>
            <RelArrow />
            <RelLabel>child of</RelLabel>
            <RelArrow />
            <RelEntity type="ctx">Supervisor</RelEntity>
          </RelRow>
        </RelSection>

        <RelSection title="Code &rarr; Review">
          <RelRow>
            <RelEntity type="commit">Commit[]</RelEntity>
            <RelArrow />
            <RelLabel>grouped into</RelLabel>
            <RelArrow />
            <RelEntity type="pr">PR</RelEntity>
            <RelArrow />
            <RelLabel>scoped by</RelLabel>
            <RelArrow />
            <RelEntity type="plan">PlanNode</RelEntity>
          </RelRow>
          <RelRow>
            <RelEntity type="pr">PR</RelEntity>
            <RelArrow />
            <RelLabel>reviewed by</RelLabel>
            <RelArrow />
            <RelEntity type="ctx">ReviewContext</RelEntity>
            <RelArrow />
            <RelLabel>produces</RelLabel>
            <RelArrow />
            <RelEntity type="rate">Rating</RelEntity>
          </RelRow>
          <RelRow>
            <RelEntity type="rate">Rating</RelEntity>
            <RelArrow />
            <RelLabel>scored against</RelLabel>
            <RelArrow />
            <RelEntity type="rate">Rubric</RelEntity>
            <RelArrow />
            <RelLabel>defined on</RelLabel>
            <RelArrow />
            <RelEntity type="plan">Plan</RelEntity>
            <RelNote color="var(--green)">full circle</RelNote>
          </RelRow>
        </RelSection>

        <RelSection title="Review &rarr; Outcome">
          <RelRow>
            <RelEntity type="rate">Rating verdict</RelEntity>
            <RelArrow />
            <RelLabel>triggers</RelLabel>
            <RelArrow />
            <RelEntity type="task">Task transition</RelEntity>
            <RelArrow />
            <RelLabel>advances</RelLabel>
            <RelArrow />
            <RelEntity type="plan">Plan</RelEntity>
          </RelRow>
          <RelRow>
            <RelEntity type="pr">All PRs</RelEntity>
            <RelArrow />
            <RelLabel>coherence check</RelLabel>
            <RelArrow />
            <RelEntity type="ctx">MetaReview</RelEntity>
            <RelArrow />
            <RelLabel>approves</RelLabel>
            <RelArrow />
            <RelEntity type="snap">Snapshot</RelEntity>
          </RelRow>
        </RelSection>

        <RelSection title="Chat Nesting">
          <RelRow>
            <RelEntity type="ctx">Supervisor Chat</RelEntity>
            <RelArrow />
            <RelLabel>parent of</RelLabel>
            <RelArrow />
            <RelEntity type="ctx">Agent Chat A</RelEntity>
            <RelEntity type="ctx">Agent Chat B</RelEntity>
          </RelRow>
          <RelRow>
            <RelEntity type="ctx">Review Chat</RelEntity>
            <RelArrow />
            <RelLabel>isolated from</RelLabel>
            <RelArrow />
            <RelEntity type="ctx">Impl Chats</RelEntity>
            <RelNote color="var(--red)">no shared reasoning</RelNote>
          </RelRow>
        </RelSection>

        <RelSection title="Context Logging &amp; Memory" style={{ marginBottom: 0 }}>
          <RelRow>
            <RelEntity type="ctx">ChatMessage</RelEntity>
            <RelArrow />
            <RelLabel>logged as</RelLabel>
            <RelArrow />
            <RelEntity type="commit">TurnLog</RelEntity>
            <RelNote color="var(--cyan)">
              exact prompt + response + model + tokens
            </RelNote>
          </RelRow>
          <RelRow>
            <RelEntity type="commit">TurnLog</RelEntity>
            <RelArrow />
            <RelLabel>may create</RelLabel>
            <RelArrow />
            <RelEntity type="snap">AgentMemory</RelEntity>
            <RelArrow />
            <RelLabel>scoped to</RelLabel>
            <RelArrow />
            <RelEntity type="ctx">Context</RelEntity>
            <span style={{ margin: "0 2px" }}>|</span>
            <RelEntity type="task">Task</RelEntity>
            <span style={{ margin: "0 2px" }}>|</span>
            <RelEntity type="plan">Plan</RelEntity>
            <span style={{ margin: "0 2px" }}>|</span>
            <RelEntity type="snap">Global</RelEntity>
          </RelRow>
        </RelSection>
      </RelationGraph>

      <div className="sl">Complete Relationship Table</div>
      <Card style={{ overflow: "auto", marginBottom: 24, padding: 0 }}>
        <DataTable headers={["From", "Rel", "To", "Meaning"]}>
          <TraceRow from="Plan" rel="has_many" to="Task" desc="Plan breaks into independently executable work units" />
          <TraceRow from="Plan" rel="has_one" to="Rubric" desc="Scoring criteria all downstream work is measured against" />
          <TraceRow from="Plan" rel="has_many" to="PR" desc="Completed work rolls up into plan-scoped changesets" />
          <TraceRow from="Task" rel="has_many" to="AgentCtx" desc="Supervisor + sub-agents, each a visible conversation" />
          <TraceRow from="Task" rel="has_many" to="Mutation" desc="All code changes produced for this task" />
          <TraceRow from="Task" rel="has_many" to="Commit" desc="Git commits that bundled task mutations" />
          <TraceRow from="Task" rel="has_many" to="Rating" desc="Scores from independent reviews" />
          <TraceRow from="AgentCtx" rel="is_a" to="ChatHistory" desc="Every context IS a conversation with messages + tool calls" />
          <TraceRow from="AgentCtx" rel="has_parent" to="AgentCtx" desc="Supervisor &rarr; sub-agent tree (visible as nested chats)" />
          <TraceRow from="AgentCtx" rel="has_many" to="Mutation" desc="Code changes produced during execution" />
          <TraceRow from="Message" rel="has_many" to="Mutation" desc="One message's tool calls can produce multiple changes" />
          <TraceRow from="Mutation" rel="belongs_to" to="Plan" desc="Every change links to the plan that justified it" />
          <TraceRow from="Mutation" rel="authored_by" to="AgentCtx" desc="Which conversation produced this change" />
          <TraceRow from="Mutation" rel="captured_as" to="Commit" desc="Git SHA stored when the agent commits" />
          <TraceRow from="Mutation" rel="has_one" to="Rating" desc="Quality score from independent review" />
          <TraceRow from="Commit" rel="authored_by" to="AgentCtx" desc="Which agent chat produced this commit" />
          <TraceRow from="Commit" rel="grouped_into" to="PR" desc="Same-task commits form a changeset" />
          <TraceRow from="PR" rel="scoped_by" to="Plan" desc="Plan node defines the PR's scope and purpose" />
          <TraceRow from="PR" rel="reviewed_by" to="ReviewCtx" desc="Independent agent scored without seeing implementation" />
          <TraceRow from="Rating" rel="scored_against" to="Rubric" desc="Which criteria and weights were used" />
          <TraceRow from="Rating" rel="produced_by" to="ReviewCtx" desc="Which review conversation generated the score" />
          <TraceRow from="Rating" rel="triggers" to="Task state" desc="Verdict determines pass, partial fix, or full retry" />
          <TraceRow from="Snapshot" rel="produced_by" to="MetaReview" desc="Created when coherence check approves" />
          <TraceRow from="Message" rel="has_one" to="TurnLog" desc="Exact system prompt, messages, model, tokens, latency for that LLM call" />
          <TraceRow from="TurnLog" rel="belongs_to" to="Message" desc="What the agent saw when it made this decision" />
          <TraceRow from="TurnLog" rel="records" to="Model + Provider" desc="Which model via which OpenRouter provider handled this turn" />
          <TraceRow from="Memory" rel="created_by" to="TurnLog" desc="Which turn produced this memory entry" />
          <TraceRow from="Memory" rel="scoped_to" to="Ctx|Task|Plan|Global" desc="Persistence level — dies with context or lives forever" />
          <TraceRow from="ParallelRun" rel="has_many" to="AgentCtx" desc="N independent contexts, each a readable conversation" />
          <TraceRow from="ParallelRun" rel="analyzed" to="Mut|PR|Plan" desc="What all N agents were independently evaluating" />
          <TraceRow from="ParallelRun" rel="synthesized_by" to="AgentCtx" desc="The consensus agent that compared all N outputs" />
          <TraceRow from="Skill" rel="invoked_by" to="Trigger" desc="Which event triggered this skill execution" />
        </DataTable>
      </Card>

      <div className="sl">What You Can Query</div>
      <div className="g2">
        <Card accent="blue">
          <h4>"Why does this code exist?"</h4>
          <pre>
            <span className="c">{"// From any file"}</span>
            {"\n"}
            {"file."}
            <span className="t">mutations</span>
            {"."}
            <span className="t">map</span>
            {"(m => m."}
            <span className="t">plan_node</span>
            {")      "}
            <span className="c">{"// → the plan"}</span>
            {"\n"}
            {"file."}
            <span className="t">mutations</span>
            {"."}
            <span className="t">map</span>
            {"(m => m."}
            <span className="t">authored_by</span>
            {")   "}
            <span className="c">{"// → the chat"}</span>
            {"\n"}
            {"file."}
            <span className="t">mutations</span>
            {"."}
            <span className="t">map</span>
            {"(m => m."}
            <span className="t">rating</span>
            {")        "}
            <span className="c">{"// → the score"}</span>
            {"\n"}
            {"file."}
            <span className="t">mutations</span>
            {"."}
            <span className="t">map</span>
            {"(m => m."}
            <span className="t">commit</span>
            {"."}
            <span className="t">pr</span>
            {")   "}
            <span className="c">{"// → the PR"}</span>
            {"\n\n"}
            <span className="c">
              {"// What did the agent see when it wrote this?"}
            </span>
            {"\n"}
            {"mutation."}
            <span className="t">message</span>
            {"."}
            <span className="t">turn_log</span>
            {"."}
            <span className="t">messages_sent</span>
            {"\n  "}
            <span className="c">
              {"// → exact context window for that decision"}
            </span>
          </pre>
        </Card>
        <Card accent="amber">
          <h4>"What did this plan produce?"</h4>
          <pre>
            <span className="c">{"// From any plan"}</span>
            {"\n"}
            {"plan."}
            <span className="t">tasks</span>
            {"."}
            <span className="t">flatMap</span>
            {"(t => t."}
            <span className="t">contexts</span>
            {")     "}
            <span className="c">{"// → all chats"}</span>
            {"\n"}
            {"plan."}
            <span className="t">tasks</span>
            {"."}
            <span className="t">flatMap</span>
            {"(t => t."}
            <span className="t">commits</span>
            {")     "}
            <span className="c">{"// → all commits"}</span>
            {"\n"}
            {"plan."}
            <span className="t">prs</span>
            {"."}
            <span className="t">map</span>
            {"(pr => pr."}
            <span className="t">rating</span>
            {")          "}
            <span className="c">{"// → all scores"}</span>
            {"\n"}
            {"plan."}
            <span className="t">prs</span>
            {"."}
            <span className="t">map</span>
            {"(pr => pr."}
            <span className="t">review</span>
            {"."}
            <span className="t">messages</span>
            {") "}
            <span className="c">{"// → review reasoning"}</span>
          </pre>
        </Card>
      </div>
      <hr />
      <Card accent="green">
        <h4>Automatic documentation</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Teams spend hours writing docs about why code exists. This system
          produces that as a byproduct. Every commit auto-documents its plan
          origin, the agent reasoning that produced it, the review that scored
          it, and the PR that grouped it. The traceability graph IS the
          documentation.
        </p>
      </Card>
    </div>
  );
}
