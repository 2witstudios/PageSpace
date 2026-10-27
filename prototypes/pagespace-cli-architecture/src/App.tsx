import { useState, type ReactNode } from "react";
import { Header } from "./components/layout/Header";
import { Nav, type PaneId } from "./components/layout/Nav";
import { ProductPane } from "./components/panes/ProductPane";
import { ArchitecturePane } from "./components/panes/ArchitecturePane";
import { WorkspacePane } from "./components/panes/WorkspacePane";
import { ContainersPane } from "./components/panes/ContainersPane";
import { DataModelPane } from "./components/panes/DataModelPane";
import { ProjectsPane } from "./components/panes/ProjectsPane";
import { AgentIsolationPane } from "./components/panes/AgentIsolationPane";
import { ParallelPane } from "./components/panes/ParallelPane";
import { ScoringPane } from "./components/panes/ScoringPane";
import { WorkflowPane } from "./components/panes/WorkflowPane";
import { EventsPane } from "./components/panes/EventsPane";
import { SearchPane } from "./components/panes/SearchPane";
import { DecisionsPane } from "./components/panes/DecisionsPane";

const panes: Record<PaneId, () => ReactNode> = {
  product: ProductPane,
  architecture: ArchitecturePane,
  workspace: WorkspacePane,
  containers: ContainersPane,
  entities: DataModelPane,
  projects: ProjectsPane,
  contexts: AgentIsolationPane,
  parallel: ParallelPane,
  rubric: ScoringPane,
  workflow: WorkflowPane,
  rules: EventsPane,
  search: SearchPane,
  decisions: DecisionsPane,
};

export function App() {
  const [active, setActive] = useState<PaneId>("product");
  const ActivePane = panes[active];

  return (
    <>
      <Header />
      <Nav active={active} onSelect={setActive} />
      <ActivePane key={active} />
    </>
  );
}
