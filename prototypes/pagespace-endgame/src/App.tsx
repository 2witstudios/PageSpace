import { useState, type ReactNode } from "react";
import { Header } from "./components/layout/Header";
import { Nav, type PaneId } from "./components/layout/Nav";
import { StoryPane } from "./components/panes/StoryPane";
import { RuntimePane } from "./components/panes/RuntimePane";
import { MemoryPane } from "./components/panes/MemoryPane";
import { RagPane } from "./components/panes/RagPane";
import { GovernancePane } from "./components/panes/GovernancePane";
import { DatabasePane } from "./components/panes/DatabasePane";
import { InterfacesPane } from "./components/panes/InterfacesPane";
import { RoadmapPane } from "./components/panes/RoadmapPane";
import { EpicsPane } from "./components/panes/EpicsPane";

const panes: Record<PaneId, () => ReactNode> = {
  story: StoryPane,
  runtime: RuntimePane,
  memory: MemoryPane,
  rag: RagPane,
  governance: GovernancePane,
  database: DatabasePane,
  interfaces: InterfacesPane,
  roadmap: RoadmapPane,
  epics: EpicsPane,
};

export function App() {
  const [active, setActive] = useState<PaneId>("story");
  const ActivePane = panes[active];

  return (
    <>
      <Header />
      <Nav active={active} onSelect={setActive} />
      <ActivePane key={active} />
    </>
  );
}
