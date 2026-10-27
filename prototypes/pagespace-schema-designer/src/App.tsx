import { useCallback, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import schemaJson from "./data/schema.json";
import type { SchemaDoc, TableNodeData } from "./lib/types";
import { getDomain, getAllDomains } from "./lib/domains";
import { layoutNodes } from "./lib/layout";
import TableNode from "./components/TableNode";
import Toolbar from "./components/Toolbar";
import Legend from "./components/Legend";

const schema = schemaJson as unknown as SchemaDoc;

const nodeTypes: NodeTypes = { table: TableNode };

function buildInitialNodes(
  collapsed: Set<string>,
  dimmed: Set<string>,
  onToggleCollapse: (id: string) => void,
): Node<TableNodeData>[] {
  return schema.tables.map((t) => ({
    id: t.name,
    type: "table",
    position: { x: 0, y: 0 },
    data: {
      table: t,
      domain: getDomain(t.file),
      collapsed: collapsed.has(t.name),
      dimmed: dimmed.has(t.name),
      onToggleCollapse,
    },
  }));
}

function buildEdges(): Edge[] {
  return schema.foreignKeys.map((fk) => {
    const isSelf = fk.sourceTable === fk.targetTable;
    return {
      id: fk.id,
      source: fk.sourceTable,
      sourceHandle: `${fk.sourceColumn}-s`,
      target: fk.targetTable,
      targetHandle: `${fk.targetColumnProp}-t`,
      type: isSelf ? "default" : "smoothstep",
      animated: false,
      label: fk.onDelete ?? undefined,
      labelBgStyle: { fill: "transparent" },
      labelStyle: { fill: "#5b5b72", fontSize: 10, fontFamily: "JetBrains Mono, monospace" },
      style: { stroke: "#4d8eff", strokeWidth: 1.2, opacity: 0.7 },
    };
  });
}

function Canvas() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [activeDomain, setActiveDomain] = useState<string | null>(null);

  const dimmed = useMemo(() => {
    const s = search.trim().toLowerCase();
    const set = new Set<string>();
    for (const t of schema.tables) {
      const domainKey = getDomain(t.file).key;
      const matchesDomain = !activeDomain || domainKey === activeDomain;
      const matchesSearch =
        !s ||
        t.name.toLowerCase().includes(s) ||
        t.columns.some((c) => c.name.toLowerCase().includes(s));
      if (!(matchesDomain && matchesSearch)) set.add(t.name);
    }
    return set;
  }, [search, activeDomain]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const initialEdges = useMemo(() => buildEdges(), []);

  const [nodes, setNodes] = useState<Node<TableNodeData>[]>(() => {
    const initial = buildInitialNodes(new Set(), new Set(), toggleCollapse);
    return layoutNodes(initial, initialEdges);
  });

  const mergedNodes = useMemo<Node<TableNodeData>[]>(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          collapsed: collapsed.has(n.id),
          dimmed: dimmed.has(n.id),
          onToggleCollapse: toggleCollapse,
        },
      })),
    [nodes, collapsed, dimmed, toggleCollapse],
  );

  const edges = useMemo<Edge[]>(
    () =>
      initialEdges.map((e) => {
        const isDim = dimmed.has(e.source) || dimmed.has(e.target);
        return {
          ...e,
          style: { ...e.style, opacity: isDim ? 0.12 : 0.7 },
        };
      }),
    [initialEdges, dimmed],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<TableNodeData>>[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  const { fitView } = useReactFlow();

  const handleAutoLayout = useCallback(() => {
    setNodes((nds) => layoutNodes(nds, initialEdges));
    setTimeout(() => fitView({ duration: 400, padding: 0.1 }), 50);
  }, [initialEdges, fitView]);

  const handleFitView = useCallback(() => fitView({ duration: 400, padding: 0.1 }), [fitView]);

  const handleCollapseAll = useCallback(() => setCollapsed(new Set(schema.tables.map((t) => t.name))), []);
  const handleExpandAll = useCallback(() => setCollapsed(new Set()), []);

  return (
    <>
      <Toolbar
        search={search}
        onSearch={setSearch}
        domains={getAllDomains()}
        activeDomain={activeDomain}
        onDomainChange={setActiveDomain}
        onAutoLayout={handleAutoLayout}
        onFitView={handleFitView}
        onCollapseAll={handleCollapseAll}
        onExpandAll={handleExpandAll}
        stats={{ tables: schema.stats.tableCount, fks: schema.stats.foreignKeyCount }}
      />
      <div className="canvas-wrap">
        <ReactFlow
          nodes={mergedNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          fitView
          fitViewOptions={{ padding: 0.1 }}
          minZoom={0.1}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2a2a3d" />
          <Controls position="bottom-right" showInteractive={false} />
          <MiniMap
            position="bottom-left"
            nodeColor={(n) => (n.data as TableNodeData)?.domain.color ?? "#4d8eff"}
            nodeStrokeColor="#09090f"
            maskColor="rgba(9,9,15,0.6)"
            pannable
            zoomable
          />
        </ReactFlow>
        <Legend />
      </div>
    </>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
