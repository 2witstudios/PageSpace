import { useEffect, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  codebaseGraph,
  kernelCore,
  kernelSatellites,
  operationalCurrents,
  overviewStats,
  runtimeGraph,
  runtimeOnlyEntities,
  systems,
  type AtlasEntity,
  type AtlasSystem,
  type AtlasTone,
  type EdgeKind,
  type GraphDefinition,
  type GraphNodeDefinition,
  type GraphZoneDefinition,
  type PositionName,
} from './architecture-data';

const EDGE_COLORS: Record<EdgeKind, string> = {
  request: '#245b79',
  events: '#cd6a29',
  storage: '#2e6b47',
  dependency: '#6b5e43',
  external: '#8d5524',
  ops: '#8d3d3d',
};

const TONE_LABELS: Record<AtlasTone, string> = {
  client: 'Client',
  app: 'App',
  service: 'Service',
  shared: 'Shared',
  kernel: 'Kernel',
  data: 'State',
  external: 'External',
};

const SECTION_LINKS = [
  { id: 'overview', label: 'Overview' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'currents', label: 'Currents' },
  { id: 'codebase', label: 'Codebase' },
  { id: 'kernel', label: 'Kernel' },
  { id: 'systems', label: 'Systems' },
];

const runtimeGraphCompact: GraphDefinition = {
  ...runtimeGraph,
  zones: [
    {
      id: 'runtime-compact-clients',
      title: 'Client Edge',
      subtitle: 'Humans, desktop, and mobile wrappers entering the product.',
      tone: 'client',
      position: { x: 0, y: 10 },
      width: 290,
      height: 680,
    },
    {
      id: 'runtime-compact-surfaces',
      title: 'Web Surfaces',
      subtitle: 'Marketing and the main authenticated app surface.',
      tone: 'app',
      position: { x: 300, y: 10 },
      width: 320,
      height: 360,
    },
    {
      id: 'runtime-compact-services',
      title: 'Service Plane',
      subtitle: 'Realtime, processor, and cron around the main app.',
      tone: 'service',
      position: { x: 300, y: 390 },
      width: 320,
      height: 580,
    },
    {
      id: 'runtime-compact-state',
      title: 'State Plane',
      subtitle: 'Postgres plus local volumes.',
      tone: 'data',
      position: { x: 640, y: 10 },
      width: 300,
      height: 400,
    },
    {
      id: 'runtime-compact-external',
      title: 'External Contracts',
      subtitle: 'AI, billing, and Google integrations outside the repo.',
      tone: 'external',
      position: { x: 640, y: 430 },
      width: 300,
      height: 600,
    },
  ],
  nodes: [
    { ...runtimeGraph.nodes.find((node) => node.id === 'browser-client')!, position: { x: 30, y: 40 }, width: 250 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'desktop-shell')!, position: { x: 30, y: 235 }, width: 250 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'mobile-shells')!, position: { x: 30, y: 430 }, width: 250 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'marketing')!, position: { x: 330, y: 30 }, width: 260 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'web')!, position: { x: 330, y: 200 }, width: 270 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'realtime')!, position: { x: 330, y: 430 }, width: 260 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'processor')!, position: { x: 330, y: 620 }, width: 260 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'cron')!, position: { x: 330, y: 810 }, width: 260 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'postgres')!, position: { x: 670, y: 20 }, width: 250 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'file-storage')!, position: { x: 670, y: 210 }, width: 250 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'ai-providers')!, position: { x: 670, y: 460 }, width: 250 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'stripe')!, position: { x: 670, y: 650 }, width: 250 },
    { ...runtimeGraph.nodes.find((node) => node.id === 'google-services')!, position: { x: 670, y: 840 }, width: 250 },
  ],
};

const codebaseGraphCompact: GraphDefinition = {
  ...codebaseGraph,
  zones: [
    {
      id: 'codebase-compact-delivery',
      title: 'Delivery Shells',
      subtitle: 'Marketing plus native wrappers that package the product.',
      tone: 'app',
      position: { x: 0, y: 20 },
      width: 300,
      height: 840,
    },
    {
      id: 'codebase-compact-apps',
      title: 'Product Apps',
      subtitle: 'Web, realtime, and processor make up the runtime app plane.',
      tone: 'service',
      position: { x: 330, y: 120 },
      width: 330,
      height: 780,
    },
    {
      id: 'codebase-compact-lib',
      title: 'Shared Services',
      subtitle: 'Cross-cutting shared logic consumed by the product apps.',
      tone: 'shared',
      position: { x: 680, y: 20 },
      width: 320,
      height: 210,
    },
    {
      id: 'codebase-compact-kernel',
      title: 'Sacred Boundary',
      subtitle: 'The page kernel sits between apps and shared contracts.',
      tone: 'kernel',
      position: { x: 680, y: 250 },
      width: 320,
      height: 300,
    },
    {
      id: 'codebase-compact-db',
      title: 'Schema Contract',
      subtitle: 'Database schema and client shared across the whole system.',
      tone: 'shared',
      position: { x: 680, y: 570 },
      width: 320,
      height: 260,
    },
  ],
  nodes: [
    { ...codebaseGraph.nodes.find((node) => node.id === 'marketing')!, position: { x: 30, y: 40 }, width: 260 },
    { ...codebaseGraph.nodes.find((node) => node.id === 'desktop-shell')!, position: { x: 30, y: 305 }, width: 260 },
    { ...codebaseGraph.nodes.find((node) => node.id === 'mobile-shells')!, position: { x: 30, y: 570 }, width: 260 },
    { ...codebaseGraph.nodes.find((node) => node.id === 'web')!, position: { x: 360, y: 160 }, width: 280 },
    { ...codebaseGraph.nodes.find((node) => node.id === 'realtime')!, position: { x: 360, y: 425 }, width: 270 },
    { ...codebaseGraph.nodes.find((node) => node.id === 'processor')!, position: { x: 360, y: 690 }, width: 270 },
    { ...codebaseGraph.nodes.find((node) => node.id === 'page-kernel')!, position: { x: 700, y: 270 }, width: 290 },
    { ...codebaseGraph.nodes.find((node) => node.id === 'packages-lib')!, position: { x: 700, y: 40 }, width: 270 },
    { ...codebaseGraph.nodes.find((node) => node.id === 'packages-db')!, position: { x: 700, y: 600 }, width: 270 },
  ],
};

function positionToFlow(position?: PositionName) {
  switch (position) {
    case 'top':
      return Position.Top;
    case 'bottom':
      return Position.Bottom;
    case 'left':
      return Position.Left;
    case 'right':
    default:
      return Position.Right;
  }
}

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function GraphNodeCard({
  node,
  active,
}: {
  node: GraphNodeDefinition;
  active: boolean;
}) {
  return (
    <div className={`atlas-flow-node tone-${node.tone} ${active ? 'is-active' : ''}`}>
      <div className="atlas-flow-node__eyebrow">
        <span>{TONE_LABELS[node.tone]}</span>
        <span>{node.subtitle}</span>
      </div>
      <div className="atlas-flow-node__title">{node.title}</div>
      <p className="atlas-flow-node__description">{node.description}</p>
    </div>
  );
}

function GraphZoneCard({ zone }: { zone: GraphZoneDefinition }) {
  return (
    <div className={`atlas-flow-zone tone-${zone.tone}`}>
      <div className="atlas-flow-zone__eyebrow">{TONE_LABELS[zone.tone]}</div>
      <div>
        <div className="atlas-flow-zone__title">{zone.title}</div>
        <p className="atlas-flow-zone__subtitle">{zone.subtitle}</p>
      </div>
    </div>
  );
}

function GraphSection({
  graph,
  activeId,
  onActivate,
  canvasHeight,
}: {
  graph: GraphDefinition;
  activeId: string;
  onActivate: (id: string) => void;
  canvasHeight: number;
}) {
  const graphHasActive = graph.nodes.some((node) => node.id === activeId);
  const focusId = graphHasActive ? activeId : graph.defaultFocus;
  const nodeLookup = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));

  const zoneNodes: Node[] = (graph.zones ?? []).map((zone) => ({
    id: `zone-${zone.id}`,
    position: zone.position,
    data: {
      label: <GraphZoneCard zone={zone} />,
    },
    draggable: false,
    selectable: false,
    deletable: false,
    connectable: false,
    style: {
      width: zone.width,
      height: zone.height,
      border: 'none',
      background: 'transparent',
      padding: 0,
      boxShadow: 'none',
    },
    zIndex: 0,
  }));

  const contentNodes: Node[] = graph.nodes.map((node) => ({
    id: node.id,
    position: node.position,
    data: {
      label: (
        <GraphNodeCard
          node={node}
          active={node.id === focusId}
        />
      ),
    },
    sourcePosition: positionToFlow(node.sourcePosition),
    targetPosition: positionToFlow(node.targetPosition ?? 'left'),
    draggable: false,
    selectable: false,
    deletable: false,
    connectable: false,
    style: {
      width: node.width ?? 240,
      border: 'none',
      background: 'transparent',
      padding: 0,
      boxShadow: 'none',
    },
    zIndex: 2,
  }));

  const nodes: Node[] = [...zoneNodes, ...contentNodes];

  const edges: Edge[] = graph.edges.map((edge) => {
    const emphasized = edge.source === focusId || edge.target === focusId;

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      animated: emphasized && (edge.kind === 'events' || edge.kind === 'ops'),
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: EDGE_COLORS[edge.kind],
      },
      style: {
        stroke: EDGE_COLORS[edge.kind],
        strokeWidth: emphasized ? 2.3 : 1.55,
        opacity: emphasized ? 0.98 : 0.18,
      },
    };
  });

  const relationships = graph.edges
    .filter((edge) => edge.source === focusId || edge.target === focusId)
    .map((edge) => {
      const sourceTitle = nodeLookup[edge.source]?.title ?? edge.source;
      const targetTitle = nodeLookup[edge.target]?.title ?? edge.target;

      return {
        id: edge.id,
        kind: edge.kind,
        line: `${sourceTitle} -> ${targetTitle}`,
        label: edge.label,
      };
    });

  return (
    <div className="atlas-flow-shell">
      <div className="atlas-flow-shell__header">
        <div>
          <p className="atlas-section__eyebrow">Diagram</p>
          <h3 className="atlas-flow-shell__title">{graph.title}</h3>
          <p className="atlas-flow-shell__subtitle">{graph.subtitle}</p>
        </div>
        <div className="atlas-flow-shell__hint">Tap a node to highlight its direct relationships.</div>
      </div>
      <div className="atlas-flow-shell__canvas" style={{ height: `${canvasHeight}px` }}>
        <ReactFlow
          key={`${graph.title}-${canvasHeight}`}
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: graphHasActive ? 0.16 : 0.14 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          onNodeClick={(_, node) => {
            if (!node.id.startsWith('zone-')) {
              onActivate(node.id);
            }
          }}
          panOnDrag
          zoomOnScroll={false}
          panOnScroll={false}
          zoomOnPinch
          minZoom={0.45}
          maxZoom={1.3}
          proOptions={{ hideAttribution: true }}
          colorMode="light"
        >
          <Background color="rgba(26, 43, 64, 0.08)" gap={24} size={1} />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      </div>
      <div className="atlas-flow-shell__relations">
        <div className="atlas-mini-label">Focused relationships</div>
        <div className="atlas-relation-list">
          {relationships.map((relationship) => (
            <div className={`atlas-relation tone-${graph.nodes.find((node) => node.id === focusId)?.tone ?? 'shared'}`} key={relationship.id}>
              <span className="atlas-relation__line">{relationship.line}</span>
              <span className={`atlas-relation__kind tone-${relationship.kind === 'external' ? 'external' : relationship.kind === 'storage' ? 'data' : relationship.kind === 'request' ? 'app' : relationship.kind === 'events' ? 'service' : 'shared'}`}>
                {relationship.kind}
              </span>
              <span className="atlas-relation__label">{relationship.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Inspector({
  entity,
  canJump,
}: {
  entity: AtlasEntity;
  canJump: boolean;
}) {
  return (
    <div className={`atlas-inspector tone-${entity.tone}`}>
      <div className="atlas-inspector__eyebrow">
        <span>{entity.eyebrow}</span>
        <span>{TONE_LABELS[entity.tone]}</span>
      </div>
      <h2 className="atlas-inspector__title">{entity.title}</h2>
      <p className="atlas-inspector__summary">{entity.summary}</p>
      <div className="atlas-inspector__block">
        <div className="atlas-mini-label">Boundary</div>
        <p>{entity.boundary}</p>
      </div>
      <div className="atlas-inspector__grid">
        <div className="atlas-inspector__block">
          <div className="atlas-mini-label">Owns</div>
          <div className="atlas-chip-list">
            {entity.owns.map((item) => (
              <span className="atlas-chip" key={item}>
                {item}
              </span>
            ))}
          </div>
        </div>
        <div className="atlas-inspector__block">
          <div className="atlas-mini-label">Depends On</div>
          <div className="atlas-chip-list">
            {entity.dependsOn.map((item) => (
              <span className="atlas-chip atlas-chip--muted" key={item}>
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="atlas-inspector__block">
        <div className="atlas-mini-label">Touchpoints</div>
        <div className="atlas-chip-list">
          {entity.touchpoints.map((item) => (
            <span className="atlas-chip atlas-chip--mono" key={item}>
              {item}
            </span>
          ))}
        </div>
      </div>
      {canJump ? (
        <button className="atlas-button" onClick={() => scrollToId(entity.id)} type="button">
          Jump To System Tree
        </button>
      ) : null}
    </div>
  );
}

function CurrentCard({
  title,
  caption,
  steps,
  tone,
}: {
  title: string;
  caption: string;
  steps: string[];
  tone: AtlasTone;
}) {
  return (
    <article className={`atlas-current tone-${tone}`}>
      <div className="atlas-current__header">
        <div className="atlas-current__title">{title}</div>
        <p className="atlas-current__caption">{caption}</p>
      </div>
      <div className="atlas-current__track">
        {steps.map((step, index) => (
          <div className="atlas-current__segment" key={step}>
            <div className="atlas-current__step">{step}</div>
            {index < steps.length - 1 ? <div className="atlas-current__arrow" /> : null}
          </div>
        ))}
      </div>
    </article>
  );
}

function KernelOrbit({ onActivate }: { onActivate: (id: string) => void }) {
  const satelliteBySlot = Object.fromEntries(
    kernelSatellites.map((satellite) => [satellite.slot, satellite])
  );

  const renderSatellite = (slot: keyof typeof satelliteBySlot) => {
    const satellite = satelliteBySlot[slot];
    if (!satellite) return <div className="atlas-orbit-grid__empty" />;

    return (
      <button
        className="atlas-orbit-grid__satellite tone-kernel"
        key={satellite.id}
        onClick={() => onActivate('page-kernel')}
        type="button"
      >
        <div className="atlas-mini-label">{satellite.path}</div>
        <div className="atlas-orbit__satellite-title">{satellite.title}</div>
        <p>{satellite.summary}</p>
      </button>
    );
  };

  return (
    <div className="atlas-orbit-wrap">
      <div className="atlas-orbit-grid">
        {renderSatellite('top-left')}
        {renderSatellite('top-center')}
        {renderSatellite('top-right')}
        {renderSatellite('middle-left')}
        <div className="atlas-orbit-grid__core-shell">
          <div className="atlas-orbit-grid__ring atlas-orbit-grid__ring--outer" />
          <div className="atlas-orbit-grid__ring atlas-orbit-grid__ring--inner" />
          <button
            className="atlas-orbit__core tone-kernel"
            onClick={() => onActivate('page-kernel')}
            type="button"
          >
            <div className="atlas-orbit__eyebrow">{kernelCore.eyebrow}</div>
            <h3>{kernelCore.title}</h3>
            <p>{kernelCore.summary}</p>
          </button>
        </div>
        {renderSatellite('middle-right')}
        {renderSatellite('bottom-left')}
        {renderSatellite('bottom-center')}
        {renderSatellite('bottom-right')}
      </div>
      <div className="atlas-orbit-list">
        {kernelSatellites.map((satellite) => (
          <button
            className="atlas-orbit-list__item tone-kernel"
            key={satellite.id}
            onClick={() => onActivate('page-kernel')}
            type="button"
          >
            <div className="atlas-mini-label">{satellite.path}</div>
            <div className="atlas-orbit__satellite-title">{satellite.title}</div>
            <p>{satellite.summary}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function TreeNode({ node }: { node: AtlasSystem['tree'][number] }) {
  return (
    <div className="atlas-tree__node">
      <div className="atlas-tree__content">
        <div className="atlas-tree__label">{node.label}</div>
        {node.path ? <div className="atlas-tree__path">{node.path}</div> : null}
        <p className="atlas-tree__note">{node.note}</p>
      </div>
      {node.children?.length ? (
        <div className="atlas-tree__children">
          {node.children.map((child) => (
            <TreeNode key={`${child.label}-${child.path ?? child.note}`} node={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SystemCard({
  system,
  active,
  onActivate,
}: {
  system: AtlasSystem;
  active: boolean;
  onActivate: (id: string) => void;
}) {
  return (
    <article
      className={`atlas-system tone-${system.tone} ${active ? 'is-active' : ''}`}
      id={system.id}
      onClick={() => onActivate(system.id)}
    >
      <div className="atlas-system__header">
        <div>
          <div className="atlas-system__eyebrow">
            <span>{system.eyebrow}</span>
            <span>{system.shortLabel}</span>
          </div>
          <h3 className="atlas-system__title">{system.title}</h3>
        </div>
        <div className="atlas-system__group">{system.group}</div>
      </div>
      <p className="atlas-system__summary">{system.summary}</p>
      <div className="atlas-system__body">
        <div className="atlas-system__meta">
          <div className="atlas-mini-label">Boundary</div>
          <p>{system.boundary}</p>
        </div>
        <div className="atlas-system__split">
          <div className="atlas-system__meta">
            <div className="atlas-mini-label">Owns</div>
            <div className="atlas-chip-list">
              {system.owns.map((item) => (
                <span className="atlas-chip" key={item}>
                  {item}
                </span>
              ))}
            </div>
          </div>
          <div className="atlas-system__meta">
            <div className="atlas-mini-label">Depends On</div>
            <div className="atlas-chip-list">
              {system.dependsOn.map((item) => (
                <span className="atlas-chip atlas-chip--muted" key={item}>
                  {item}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="atlas-system__meta">
          <div className="atlas-mini-label">Touchpoints</div>
          <div className="atlas-chip-list">
            {system.touchpoints.map((item) => (
              <span className="atlas-chip atlas-chip--mono" key={item}>
                {item}
              </span>
            ))}
          </div>
        </div>
        <div className="atlas-tree">
          {system.tree.map((node) => (
            <TreeNode key={`${node.label}-${node.path ?? node.note}`} node={node} />
          ))}
        </div>
      </div>
    </article>
  );
}

export default function App() {
  const [activeId, setActiveId] = useState('web');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1600 : window.innerWidth
  );

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);

    window.addEventListener('resize', updateViewportWidth);
    return () => window.removeEventListener('resize', updateViewportWidth);
  }, []);

  const diagramWidthEstimate =
    viewportWidth > 1180 ? Math.max(920, viewportWidth - 420) : Math.max(320, viewportWidth - 48);
  const useCompactGraphs = diagramWidthEstimate < 1400;
  const useTallGraphs = diagramWidthEstimate < 1220;
  const runtimeGraphView = useCompactGraphs ? runtimeGraphCompact : runtimeGraph;
  const codebaseGraphView = useCompactGraphs ? codebaseGraphCompact : codebaseGraph;
  const runtimeCanvasHeight = viewportWidth < 900 ? 1120 : useTallGraphs ? 1540 : useCompactGraphs ? 1400 : 780;
  const codebaseCanvasHeight = viewportWidth < 900 ? 940 : useTallGraphs ? 1180 : useCompactGraphs ? 1040 : 760;

  const entityLookup = Object.fromEntries(
    [...runtimeOnlyEntities, ...systems].map((entity) => [entity.id, entity])
  ) as Record<string, AtlasEntity>;

  const activeEntity = entityLookup[activeId] ?? entityLookup.web;
  const activeSystemIds = new Set(systems.map((system) => system.id));

  const groupedSystems = systems.reduce<Record<string, AtlasSystem[]>>((groups, system) => {
    if (!groups[system.group]) {
      groups[system.group] = [];
    }
    groups[system.group].push(system);
    return groups;
  }, {});

  return (
    <div className="atlas-page">
      <div className="atlas-page__glow atlas-page__glow--one" />
      <div className="atlas-page__glow atlas-page__glow--two" />
      <div className="atlas-page__glow atlas-page__glow--three" />

      <div className={`atlas-layout ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
        <button
          className="atlas-sidebar-toggle"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          type="button"
          title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        >
          {sidebarCollapsed ? '→' : '←'}
        </button>
        <aside className={`atlas-rail ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
          <div className="atlas-rail__brand">
            <div className="atlas-rail__eyebrow">PageSpace</div>
            <div className="atlas-rail__title">Architecture Atlas</div>
            <p className="atlas-rail__copy">
              A standalone map of the runtime, the repo, and the sacred page kernel.
            </p>
          </div>

          <div className="atlas-rail__section">
            <div className="atlas-mini-label">Jump To</div>
            <div className="atlas-rail__links">
              {SECTION_LINKS.map((link) => (
                <button
                  className="atlas-nav-pill"
                  key={link.id}
                  onClick={() => scrollToId(link.id)}
                  type="button"
                >
                  {link.label}
                </button>
              ))}
            </div>
          </div>

          <div className="atlas-rail__section">
            <div className="atlas-mini-label">System Focus</div>
            <div className="atlas-rail__links atlas-rail__links--systems">
              {systems.map((system) => (
                <button
                  className={`atlas-nav-pill ${activeId === system.id ? 'is-active' : ''}`}
                  key={system.id}
                  onClick={() => {
                    setActiveId(system.id);
                    scrollToId(system.id);
                  }}
                  type="button"
                >
                  {system.title}
                </button>
              ))}
            </div>
          </div>

          <Inspector entity={activeEntity} canJump={activeSystemIds.has(activeEntity.id)} />
        </aside>

        <main className="atlas-main">
          <header className="atlas-hero" id="overview">
            <div className="atlas-section__eyebrow">Standalone map</div>
            <h1 className="atlas-hero__title">
              PageSpace as an explorable system atlas instead of a feature checklist.
            </h1>
            <p className="atlas-hero__subtitle">
              Start with the runtime. Drop into the codebase. Orbit the page kernel. Then drill down through
              each major boundary without needing the app or services running beside it.
            </p>

            <div className="atlas-legend">
              {(['client', 'app', 'service', 'shared', 'kernel', 'data', 'external'] as AtlasTone[]).map(
                (tone) => (
                  <div className={`atlas-legend__item tone-${tone}`} key={tone}>
                    <span className="atlas-legend__swatch" />
                    <span>{TONE_LABELS[tone]}</span>
                  </div>
                )
              )}
            </div>

            <div className="atlas-stats">
              {overviewStats.map((stat) => (
                <article className="atlas-stat" key={stat.label}>
                  <div className="atlas-stat__value">{stat.value}</div>
                  <div className="atlas-stat__label">{stat.label}</div>
                  <p className="atlas-stat__note">{stat.note}</p>
                </article>
              ))}
            </div>
          </header>

          <section className="atlas-section" id="runtime">
            <GraphSection
              activeId={activeId}
              canvasHeight={runtimeCanvasHeight}
              graph={runtimeGraphView}
              onActivate={setActiveId}
            />
          </section>

          <section className="atlas-section" id="currents">
            <div className="atlas-section__header">
              <div>
                <p className="atlas-section__eyebrow">Operational currents</p>
                <h2 className="atlas-section__title">How work actually moves</h2>
              </div>
              <p className="atlas-section__subtitle">
                These are the high-level motion lines worth holding in your head while reading the rest of
                the map.
              </p>
            </div>

            <div className="atlas-current-grid">
              {operationalCurrents.map((current) => (
                <CurrentCard
                  caption={current.caption}
                  key={current.id}
                  steps={current.steps}
                  title={current.title}
                  tone={current.tone}
                />
              ))}
            </div>
          </section>

          <section className="atlas-section" id="codebase">
            <GraphSection
              activeId={activeId}
              canvasHeight={codebaseCanvasHeight}
              graph={codebaseGraphView}
              onActivate={setActiveId}
            />
          </section>

          <section className="atlas-section" id="kernel">
            <div className="atlas-section__header">
              <div>
                <p className="atlas-section__eyebrow">Kernel cross-section</p>
                <h2 className="atlas-section__title">What everything bends around</h2>
              </div>
              <p className="atlas-section__subtitle">
                The page primitive is the composability center. The orbit below shows the subsystems that
                pull directly on it or must pass through it.
              </p>
            </div>

            <KernelOrbit onActivate={setActiveId} />
          </section>

          <section className="atlas-section" id="systems">
            <div className="atlas-section__header">
              <div>
                <p className="atlas-section__eyebrow">System trees</p>
                <h2 className="atlas-section__title">Grouped drill-downs by boundary</h2>
              </div>
              <p className="atlas-section__subtitle">
                Each card is a navigable tree: what the system owns, what it depends on, and which folders
                make the boundary real in the repo.
              </p>
            </div>

            {Object.entries(groupedSystems).map(([group, items]) => (
              <section className="atlas-group" key={group}>
                <div className="atlas-group__header">
                  <div className="atlas-group__rule" />
                  <h3>{group}</h3>
                </div>
                <div className="atlas-system-grid">
                  {items.map((system) => (
                    <SystemCard
                      active={system.id === activeId}
                      key={system.id}
                      onActivate={setActiveId}
                      system={system}
                    />
                  ))}
                </div>
              </section>
            ))}
          </section>
        </main>
      </div>
    </div>
  );
}
