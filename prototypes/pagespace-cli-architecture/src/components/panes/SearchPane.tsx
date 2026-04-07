import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";

export function SearchPane() {
  return (
    <div className="pane">
      <div className="sl">Search &amp; Indexing</div>
      <h2>
        Search across your entire{" "}
        <span className="hl">development history.</span>{" "}
        <StatusBadge variant="planned" />
      </h2>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        Every entity is structured data. Indexing it enables questions no
        existing tool can answer. <strong>Lexical search</strong> finds exact
        matches. <strong>Semantic search</strong> finds meaning. Combined, they
        query across every layer simultaneously.
      </p>

      <div className="g2" style={{ marginBottom: 20 }}>
        <Card accent="green">
          <h4>Lexical</h4>
          <p style={{ marginTop: 6, fontSize: 12, lineHeight: 1.8 }}>
            "Mutations that touched auth middleware."
            <br />
            "Tasks with gate failures on error_handling."
            <br />
            "Turns where token count exceeded 80k."
            <br />
            "All turns that used claude-sonnet."
          </p>
        </Card>
        <Card accent="violet">
          <h4>Semantic</h4>
          <p style={{ marginTop: 6, fontSize: 12, lineHeight: 1.8 }}>
            "Times agents struggled with async errors."
            <br />
            "Patterns that produce high security scores."
            <br />
            "System prompts that led to scope creep."
            <br />
            "What context was the agent seeing when it chose to refactor
            instead of patch?"
          </p>
        </Card>
      </div>
      <div className="g3">
        <Card accent="amber">
          <h4>Smarter decomposition</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>
            Search past tasks to learn what scope boundaries and rubric weights
            worked best.
          </p>
        </Card>
        <Card accent="red">
          <h4>Agent profiles</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>
            Ratings accumulate per config. Dispatch auto-selects agents with
            the best track record.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Institutional memory</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>
            Agent reasoning is permanently indexed. Knowledge that used to walk
            out the door stays.
          </p>
        </Card>
      </div>
      <hr />
      <Card accent="cyan">
        <h4>The compounding asset</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Anyone can wire up agents to write code. Nobody else has a searchable,
          scored history of how AI built a codebase — down to the exact context
          window every decision was made in. Turn logs let you replay any agent
          decision with the same inputs. Memory lets the system learn across
          tasks. This data compounds with every task completed.
        </p>
      </Card>
    </div>
  );
}
