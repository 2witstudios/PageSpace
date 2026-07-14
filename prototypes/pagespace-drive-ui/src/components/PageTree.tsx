import { useEffect, useState } from "react";
import type { PageSpaceClient } from "@pagespace/sdk";
import { describeError, type PageRow, type PageType } from "../lib/pagespace";
import { usePageChildren } from "../hooks/usePageChildren";
import { NewPageForm } from "./NewPageForm";
import { PageTreeNode } from "./PageTreeNode";

interface PageTreeProps {
  client: PageSpaceClient;
  driveId: string;
  selectedPageId: string | null;
  onSelect: (page: PageRow) => void;
  onMoveRequest: (page: PageRow) => void;
}

export function PageTree({ client, driveId, selectedPageId, onSelect, onMoveRequest }: PageTreeProps) {
  const { children, loading, error, load, addChild, removeChild, renameChild } = usePageChildren(client, driveId, null);
  const [creatingRoot, setCreatingRoot] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  const submitCreateRoot = async (title: string, type: PageType) => {
    setRootError(null);
    try {
      const created = await client.pages.create({ driveId, title, type });
      const row: PageRow = { id: created.id, title: created.title, type: created.type, hasChildren: false, isTaskLinked: false };
      addChild(row);
      setCreatingRoot(false);
      // Open the new page immediately — a row silently appearing in a long
      // tree is easy to miss; jumping straight to it is the only feedback
      // that's unmissable regardless of tree scroll position.
      onSelect(row);
    } catch (e) {
      setRootError(describeError(e));
    }
  };

  return (
    <section className="page-tree">
      <div className="page-tree-header">
        <h2>Pages</h2>
        <button type="button" onClick={load} disabled={loading}>
          Refresh
        </button>
        <button type="button" onClick={() => setCreatingRoot((v) => !v)}>
          + New page
        </button>
      </div>

      {rootError && <p className="error-text">{rootError}</p>}
      {creatingRoot && <NewPageForm onSubmit={submitCreateRoot} onCancel={() => setCreatingRoot(false)} />}

      {loading && <p className="muted">Loading pages…</p>}
      {error && <p className="error-text">{error}</p>}
      {!loading && children?.length === 0 && <p className="muted">No pages yet — create one above.</p>}

      <div className="tree-root">
        {children?.map((page) => (
          <PageTreeNode
            key={page.id}
            client={client}
            driveId={driveId}
            page={page}
            depth={0}
            selectedPageId={selectedPageId}
            onSelect={onSelect}
            onMoveRequest={onMoveRequest}
            onRemoved={() => removeChild(page.id)}
            onRenamed={(title) => renameChild(page.id, title)}
          />
        ))}
      </div>
    </section>
  );
}
