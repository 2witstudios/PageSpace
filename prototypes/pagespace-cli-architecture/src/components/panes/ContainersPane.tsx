import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import { HorizontalPath, PathStep } from "../ui/HorizontalPath";

export function ContainersPane() {
  return (
    <div className="pane">
      <div className="sl">Containers</div>
      <h2>
        Each branch is its own{" "}
        <span className="hl">isolated environment.</span>{" "}
        <StatusBadge variant="planned" />
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        BRANCH is a new page type. When you create one in a drive (repo),
        PageSpace spins up a cloud container with that branch checked out. The
        container has a real filesystem, env vars, processes, and the{" "}
        <strong>Pagespace CLI pre-installed</strong>. AI_CHAT pages created as
        children of the BRANCH run their agents inside that container.
      </p>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        This is PageSpace's existing page type pattern — a CHANNEL behaves
        differently from a DOCUMENT, a FILE is backed by S3. A BRANCH is
        backed by a container. Same tree, same permissions, different backing
        store.
      </p>

      <div className="sl">Container Lifecycle</div>
      <HorizontalPath>
        <PathStep
          number="01"
          label="Branch"
          note="Create branch<br>from base."
          color="blue"
          isFirst
        />
        <PathStep
          number="02"
          label="Container"
          note="Spin up container.<br>Copy env."
          color="violet"
        />
        <PathStep
          number="03"
          label="Work"
          note="Run agents,<br>terminals, tests."
          color="cyan"
        />
        <PathStep
          number="04"
          label="Merge"
          note="PR back to base.<br>Review + gate."
          color="green"
        />
        <PathStep
          number="05"
          label="Clean"
          note="Destroy container.<br>Delete branch."
          color="amber"
          isLast
        />
      </HorizontalPath>

      <div className="sl">What Lives Inside a Container</div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4>Git state</h4>
          <p style={{ fontSize: 12, marginTop: 6, lineHeight: 1.8 }}>
            Full repo checkout on the branch. Agents commit, push, and PR from
            inside the container. Standard git workflow — no custom VCS.
          </p>
        </Card>
        <Card accent="violet">
          <h4>Agents + Terminals</h4>
          <p style={{ fontSize: 12, marginTop: 6, lineHeight: 1.8 }}>
            Multiple agents run in parallel inside one container. Each agent is
            an AI_CHAT child page of the BRANCH. Terminals provide shell access.
            Each agent process has full shell power.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 24 }}>
        <Card accent="green">
          <h4>Environment</h4>
          <p style={{ fontSize: 12, marginTop: 6, lineHeight: 1.8 }}>
            Copied from the repo's env files on container creation. Isolated —
            changes to env in one container don't affect others. Dependencies
            installed per container.
          </p>
        </Card>
        <Card accent="cyan">
          <h4>Pagespace CLI</h4>
          <p style={{ fontSize: 12, marginTop: 6, lineHeight: 1.8 }}>
            Pre-installed in every container. Agents call{" "}
            <code>ps page read</code>, <code>ps search</code>,{" "}
            <code>ps task update</code>, <code>ps agent ask</code>,{" "}
            <code>ps memory write</code> to access PageSpace. Token-authenticated.
            The bridge between execution and persistence.
          </p>
        </Card>
      </div>

      <div className="sl">Multi-Repo</div>
      <div className="g2">
        <Card accent="cyan">
          <h4>Multiple repos in one workspace</h4>
          <p style={{ fontSize: 12, marginTop: 6, lineHeight: 1.8 }}>
            Each drive is a repo. PageSpace's sidebar shows all drives with
            their BRANCH pages and agents. Agents in different repos can run
            simultaneously. Cross-repo work (e.g., API + client changes)
            happens in parallel with full visibility.
          </p>
        </Card>
        <Card accent="amber">
          <h4>Repo = top-level scope</h4>
          <p style={{ fontSize: 12, marginTop: 6, lineHeight: 1.8 }}>
            Repos map to PageSpace drives. Each repo gets its own branch tree,
            containers, and agent history. Plans can span multiple repos when
            tasks require coordinated changes.
          </p>
        </Card>
      </div>
    </div>
  );
}
