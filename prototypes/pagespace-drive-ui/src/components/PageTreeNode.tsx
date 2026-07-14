import { useState } from "react";
import type { PageSpaceClient } from "@pagespace/sdk";
import { describeError, iconForType, type PageRow, type PageType } from "../lib/pagespace";
import { usePageChildren } from "../hooks/usePageChildren";
import { NewPageForm } from "./NewPageForm";

interface PageTreeNodeProps {
  client: PageSpaceClient;
  driveId: string;
  page: PageRow;
  depth: number;
  selectedPageId: string | null;
  onSelect: (page: PageRow) => void;
  onMoveRequest: (page: PageRow) => void;
  onRemoved: () => void;
  onRenamed: (title: string) => void;
}

export function PageTreeNode({
  client,
  driveId,
  page,
  depth,
  selectedPageId,
  onSelect,
  onMoveRequest,
  onRemoved,
  onRenamed,
}: PageTreeNodeProps) {
  const { children, loading, error, load, addChild, removeChild, renameChild } = usePageChildren(client, driveId, page.id);
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(page.title ?? "");
  const [creatingChild, setCreatingChild] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const expandable = page.hasChildren || (children?.length ?? 0) > 0;

  const toggleExpand = async () => {
    if (!expandable) return;
    if (!expanded && children === null) {
      await load();
    }
    setExpanded((v) => !v);
  };

  const submitRename = async () => {
    if (!renameValue.trim()) return;
    setBusy(true);
    setRowError(null);
    try {
      await client.pages.rename({ pageId: page.id, title: renameValue.trim() });
      onRenamed(renameValue.trim());
      setRenaming(false);
    } catch (e) {
      setRowError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const submitTrash = async () => {
    const confirmMessage = page.hasChildren
      ? `Trash "${page.title ?? "Untitled"}" and all of its children? This cannot be undone from this UI.`
      : `Trash "${page.title ?? "Untitled"}"?`;
    if (!window.confirm(confirmMessage)) return;
    setBusy(true);
    setRowError(null);
    try {
      await client.pages.trash({ pageId: page.id, trash_children: true });
      onRemoved();
    } catch (e) {
      setRowError(describeError(e));
      setBusy(false);
    }
  };

  const submitCreateChild = async (title: string, type: PageType) => {
    try {
      const created = await client.pages.create({ driveId, parentId: page.id, title, type });
      const row: PageRow = { id: created.id, title: created.title, type: created.type, hasChildren: false, isTaskLinked: false };
      addChild(row);
      setCreatingChild(false);
      setExpanded(true);
      onSelect(row);
    } catch (e) {
      setRowError(describeError(e));
    }
  };

  const isSelected = selectedPageId === page.id;

  return (
    <div className="tree-node" style={{ marginLeft: depth * 16 }}>
      <div className={`tree-row${isSelected ? " tree-row-selected" : ""}`}>
        <button type="button" className="tree-toggle" onClick={toggleExpand} disabled={!expandable}>
          {expandable ? (expanded ? "▾" : "▸") : "·"}
        </button>
        <span className="tree-icon">{iconForType(page.type)}</span>
        {!renaming ? (
          <button type="button" className="tree-title" onClick={() => onSelect(page)}>
            {page.title ?? "Untitled"}
          </button>
        ) : (
          <input
            className="tree-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenaming(false);
              }
            }}
          />
        )}

        <div className="tree-actions">
          {!renaming ? (
            <button type="button" className="icon-button" title="Rename" onClick={() => setRenaming(true)} disabled={busy}>
              ✏️
            </button>
          ) : (
            <>
              <button
                type="button"
                className="icon-button"
                title="Save"
                onClick={submitRename}
                disabled={busy || !renameValue.trim()}
              >
                ✓
              </button>
              <button type="button" className="icon-button" title="Cancel" onClick={() => setRenaming(false)} disabled={busy}>
                ✕
              </button>
            </>
          )}
          <button type="button" className="icon-button" title="Move" onClick={() => onMoveRequest(page)} disabled={busy}>
            📦
          </button>
          <button
            type="button"
            className="icon-button"
            title="New child page"
            onClick={() => setCreatingChild((v) => !v)}
            disabled={busy}
          >
            +
          </button>
          <button type="button" className="icon-button danger" title="Trash" onClick={submitTrash} disabled={busy}>
            🗑
          </button>
        </div>
      </div>

      {rowError && (
        <p className="error-text" style={{ marginLeft: depth * 16 + 24 }}>
          {rowError}
        </p>
      )}

      {creatingChild && (
        <div style={{ marginLeft: depth * 16 + 24 }}>
          <NewPageForm onSubmit={submitCreateChild} onCancel={() => setCreatingChild(false)} />
        </div>
      )}

      {expanded && (
        <div className="tree-children">
          {loading && <p className="muted">Loading…</p>}
          {error && <p className="error-text">{error}</p>}
          {children?.map((child) => (
            <PageTreeNode
              key={child.id}
              client={client}
              driveId={driveId}
              page={child}
              depth={depth + 1}
              selectedPageId={selectedPageId}
              onSelect={onSelect}
              onMoveRequest={onMoveRequest}
              onRemoved={() => removeChild(child.id)}
              onRenamed={(title) => renameChild(child.id, title)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
