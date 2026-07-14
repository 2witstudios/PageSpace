import { useEffect, useState } from "react";
import type { PageSpaceClient } from "@pagespace/sdk";
import { describeError, iconForType, type PageRow } from "../lib/pagespace";
import { usePageChildren } from "../hooks/usePageChildren";

interface MovePickerNodeProps {
  client: PageSpaceClient;
  driveId: string;
  page: PageRow;
  depth: number;
  excludePageId: string;
  onPick: (parentId: string) => void;
}

// A read-only, selection-only variant of the main tree (no rename/trash/create)
// used inside the move modal to pick a destination parent. Lazy-loaded the
// same way as PageTreeNode, but kept separate since its interaction model
// (click row = pick destination) is entirely different.
function MovePickerNode({ client, driveId, page, depth, excludePageId, onPick }: MovePickerNodeProps) {
  const { children, loading, error, load } = usePageChildren(client, driveId, page.id);
  const [expanded, setExpanded] = useState(false);

  if (page.id === excludePageId) return null;

  const toggleExpand = async () => {
    if (!page.hasChildren) return;
    if (!expanded && children === null) await load();
    setExpanded((v) => !v);
  };

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div className="tree-row">
        <button type="button" className="tree-toggle" onClick={toggleExpand} disabled={!page.hasChildren}>
          {page.hasChildren ? (expanded ? "▾" : "▸") : "·"}
        </button>
        <span className="tree-icon">{iconForType(page.type)}</span>
        <button type="button" className="tree-title" onClick={() => onPick(page.id)}>
          {page.title ?? "Untitled"}
        </button>
      </div>
      {expanded && (
        <div>
          {loading && <p className="muted">Loading…</p>}
          {error && <p className="error-text">{error}</p>}
          {children?.map((child) => (
            <MovePickerNode
              key={child.id}
              client={client}
              driveId={driveId}
              page={child}
              depth={depth + 1}
              excludePageId={excludePageId}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface MovePagePickerProps {
  client: PageSpaceClient;
  driveId: string;
  page: PageRow;
  onClose: () => void;
  onMoved: () => void;
}

export function MovePagePicker({ client, driveId, page, onClose, onMoved }: MovePagePickerProps) {
  const root = usePageChildren(client, driveId, null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    root.load();
  }, [root.load]);

  const moveTo = async (newParentId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await client.pages.move({ pageId: page.id, newParentId, newPosition: 0 });
      onMoved();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Move "{page.title ?? "Untitled"}"</h3>
        <p className="muted">Pick a new parent page.</p>
        {error && <p className="error-text">{error}</p>}
        <div className="move-picker-tree">
          <button type="button" className="tree-title" disabled={busy} onClick={() => moveTo(null)}>
            📁 Drive root
          </button>
          {root.loading && <p className="muted">Loading…</p>}
          {root.error && <p className="error-text">{root.error}</p>}
          {root.children?.map((p) => (
            <MovePickerNode key={p.id} client={client} driveId={driveId} page={p} depth={0} excludePageId={page.id} onPick={moveTo} />
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
