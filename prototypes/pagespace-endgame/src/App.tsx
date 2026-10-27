import { useState, type ReactNode } from "react";
import { Header } from "./components/layout/Header";
import { Nav, type PaneId } from "./components/layout/Nav";
import { VisionPane } from "./components/panes/VisionPane";
import { StoryPane } from "./components/panes/StoryPane";
import { RuntimePane } from "./components/panes/RuntimePane";
import { MemoryPane } from "./components/panes/MemoryPane";
import { GovernancePane } from "./components/panes/GovernancePane";
import { CompliancePane } from "./components/panes/CompliancePane";
import { ObservabilityPane } from "./components/panes/ObservabilityPane";
import { IntegrationsPane } from "./components/panes/IntegrationsPane";
import { DatabasePane } from "./components/panes/DatabasePane";
import { InterfacesPane } from "./components/panes/InterfacesPane";
import { GdprPane } from "./components/panes/GdprPane";
import { Soc2Pane } from "./components/panes/Soc2Pane";
import { HipaaPane } from "./components/panes/HipaaPane";
import { UserStoriesPane } from "./components/panes/UserStoriesPane";
import { ConvergencePane } from "./components/panes/ConvergencePane";

import { AgentToolsPane } from "./components/panes/AgentToolsPane";


const panes: Record<PaneId, () => ReactNode> = {
  vision: VisionPane,
  story: StoryPane,
  runtime: RuntimePane,
  memory: MemoryPane,
  governance: GovernancePane,
  security: CompliancePane,
  observability: ObservabilityPane,
  integrations: IntegrationsPane,
  database: DatabasePane,
  interfaces: InterfacesPane,
  "agent-tools": AgentToolsPane,

  gdpr: GdprPane,
  soc2: Soc2Pane,
  hipaa: HipaaPane,
  stories: UserStoriesPane,
  convergence: ConvergencePane,
};

export function App() {
  const [active, setActive] = useState<PaneId>("vision");
  const ActivePane = panes[active];

  return (
    <>
      <Header />
      <Nav active={active} onSelect={setActive} />
      <ActivePane key={active} />
    </>
  );
}
