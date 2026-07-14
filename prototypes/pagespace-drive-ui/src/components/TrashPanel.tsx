import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { PageSpaceClient } from "@pagespace/sdk";
import { describeError, type TrashedPage } from "../lib/pagespace";

interface TrashPanelProps {
  client: PageSpaceClient;
  driveId: string;
  onRestored: () => void;
}

export function TrashPanel({ client, driveId, onRestored }: TrashPanelProps) {
  const [nodes, setNodes] = useState<TrashedPage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // pages.listTrash is owner/admin-only (drive:admin) — a drive-scoped
  // non-admin key will 403 here, surfaced via describeError below rather
  // than treated as a bug.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.pages.listTrash({ driveId });
      setNodes(result as unknown as TrashedPage[]);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [client, driveId]);

  useEffect(() => {
    load();
  }, [load]);

  const restore = async (pageId: string) => {
    setBusyId(pageId);
    setError(null);
    try {
      await client.pages.restore({ pageId });
      await load();
      onRestored();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  };

  const renderNode = (node: TrashedPage, depth: number): ReactNode => (
    <div key={node.id} style={{ marginLeft: depth * 16 }}>
      <div className="tree-row">
        <span className="tree-type-badge">{node.type}</span>
        <span className="tree-title-static">{node.title ?? "Untitled"}</span>
        <span className="muted">trashed {node.trashedAt ?? "?"}</span>
        <button type="button" onClick={() => restore(node.id)} disabled={busyId === node.id}>
          {busyId === node.id ? "Restoring…" : "Restore"}
        </button>
      </div>
      {node.children.map((child) => renderNode(child, depth + 1))}
    </div>
  );

  return (
    <section className="trash-panel">
      <div className="page-tree-header">
        <h2>Trash</h2>
        <button type="button" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>
      {loading && <p className="muted">Loading trash…</p>}
      {error && <p className="error-text">{error}</p>}
      {!loading && !error && nodes?.length === 0 && <p className="muted">Trash is empty.</p>}
      {nodes?.map((node) => renderNode(node, 0))}
    </section>
  );
}
